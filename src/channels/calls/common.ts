import type { Author, CallInfo } from "../../core/model.js";
import type { ApplyContext, ApplySummary, ChannelAdapter, ChannelCaps, ChannelEvent, DownloadResult } from "../../server/channel.js";
import { sha1Hex, sha256Hex } from "../../server/crypto.js";
import { fetchFile } from "../../server/download.js";
import type { ChatStore, ContactHint } from "../../server/store.js";

/* Общее для подключений телефонии (общий вебхук любой АТС, Zadarma): как звонок становится строкой в ленте клиента
   и как к ней приходит запись разговора.

   - Клиент — по номеру телефона (ContactHint: source «calls», externalId — номер в международном виде, канал «call»).
     Номер звонящего определяет телефонная сеть, а не называет собеседник, — он «подлинный» (phoneTrusted): звонок
     встаёт к уже известному клиенту с этим номером (например, писавшему в WhatsApp). Оговорка про подмену номера —
     в docs/channels/calls.md.
   - Строку звонка записывает ingest (событие call): пропущенный входящий — клиент ждёт ответа, разговор — ответ.
   - Запись разговора часто готова позже звонка (Zadarma сообщает о ней отдельным уведомлением, другие АТС присылают
     ссылку повторным запросом). Повтор звонка ingest пропускает целиком — поэтому запись приходит своим особым
     событием «calls:record»: подключение само (apply) проверяет, что строка звонка есть, а записи у неё ещё нет,
     и после ответа телефонии (ctx.later) скачивает запись и прикрепляет её к строке звонка.
   - Отвечать через телефонию нельзя: звонки — только приём. */

/** Звонки только принимаются: ни текста, ни файлов, ни паузы бота, ни статусов */
export const CALLS_CAPS: ChannelCaps = { text: false, files: false, pause: false, mute: false, start: false, statuses: false };

/** Ответ на попытку отправить сообщение через телефонию */
export const CALLS_SEND_ERROR = "Звонки — только приём: отвечайте в мессенджере или перезвоните";

/** Запись разговора больше этого не скачиваем (по умолчанию 25 МБ: записи длинных разговоров весят десятки мегабайт) */
export const MAX_RECORD_BYTES = 25 * 1024 * 1024;

/** Особое событие «запись разговора готова» — раскладывает apply подключения */
export const RECORD_EVENT = "calls:record";

/** Подключение телефонии: download и apply есть всегда */
export type CallsAdapter = ChannelAdapter & Required<Pick<ChannelAdapter, "download" | "apply">>;

/** Клиент звонка — по номеру телефона в международном виде («+996555000001») */
export function callContact(phone: string): ContactHint {
  return { source: "calls", externalId: phone, channel: "call", phone, phoneTrusted: true };
}

/** Кто из команды говорил: имя сотрудника по внутреннему номеру из настроек проекта, иначе имя от АТС, иначе
 *  «внутр. 101». Нет ни номера, ни имени — null */
export function managerName(
  managers: Readonly<Record<string, string>> | undefined, extension: string | null | undefined, name?: string | null | undefined
): string | null {
  const ext = String(extension ?? "").trim().slice(0, 32);
  // Только свои поля объекта: внутренний номер «constructor» не должен найти служебное свойство
  const known = ext && managers && Object.hasOwn(managers, ext) ? managers[ext] : undefined;
  if (typeof known === "string" && known.trim()) return known.trim();
  const given = String(name ?? "").trim();
  if (given) return given.slice(0, 100);
  return ext ? `внутр. ${ext}` : null;
}

/* ── Время ─────────────────────────────────────────────────────────────────────────────────────────────────── */

const zoneFormats = new Map<string, Intl.DateTimeFormat | null>();

function zoneFormat(timeZone: string): Intl.DateTimeFormat | null {
  if (!zoneFormats.has(timeZone)) {
    let f: Intl.DateTimeFormat | null = null;
    try {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
      });
    } catch {
      f = null; // неизвестный пояс
    }
    zoneFormats.set(timeZone, f);
  }
  return zoneFormats.get(timeZone) ?? null;
}

/** На сколько миллисекунд часы пояса впереди Гринвича в этот момент */
function zoneOffset(f: Intl.DateTimeFormat, utc: number): number {
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(new Date(utc))) if (x.type !== "literal") p[x.type] = Number(x.value);
  const wall = Date.UTC(p.year ?? 1970, (p.month ?? 1) - 1, p.day ?? 1, (p.hour ?? 0) % 24, p.minute ?? 0, p.second ?? 0);
  return wall - Math.floor(utc / 1000) * 1000;
}

/** «2026-09-27 14:00:00» по часам пояса АТС («Asia/Bishkek») → ISO по Гринвичу. Неверная запись или пояс — null */
export function zonedIso(local: string, timeZone: string): string | null {
  const m = local.trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  const f = zoneFormat(timeZone);
  if (!m || !f) return null;
  const [y, mo, d, h, mi, s] = [1, 2, 3, 4, 5, 6].map((i) => Number(m[i] ?? 0)) as [number, number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  let utc = wall - zoneOffset(f, wall);
  // Около перевода часов сдвиг в найденный момент бывает другим — уточняем один раз
  const again = wall - zoneOffset(f, utc);
  if (again !== utc) utc = again;
  return new Date(utc).toISOString();
}

/** Начало звонка: ISO 8601 с поясом («2026-09-27T14:00:00+06:00», «…Z»), Unix-время в секундах (или миллисекундах),
 *  время без пояса — по часам timeZone. Не узнали — null (ingest поставит время приёма) */
export function parseStartedAt(v: unknown, timeZone?: string | undefined): string | null {
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v <= 0) return null;
    return new Date(v > 1e12 ? v : v * 1000).toISOString();
  }
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.trim();
  if (/^\d{9,13}$/.test(s)) return parseStartedAt(Number(s), timeZone);
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    // «2026-09-27 14:00:00+0600» → «2026-09-27T14:00:00+06:00»: так Date.parse понимает везде
    const t = Date.parse(s.replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, "$1T$2").replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  return timeZone ? zonedIso(s, timeZone) : null;
}

/* ── Запись разговора ──────────────────────────────────────────────────────────────────────────────────────── */

/** Скачать запись по ссылке АТС — с защитами fetchFile (размер, перенаправления проверяются, внутренние адреса
 *  сервера недоступны), тип — по содержимому. Берём только звук: mp3, wav, ogg, m4a, amr */
export async function fetchRecording(
  url: string,
  o: { maxBytes?: number | undefined; fetch?: typeof fetch | undefined; allowHost?: ((host: string) => boolean) | undefined; timeoutMs?: number | undefined } = {}
): Promise<DownloadResult> {
  // Запись длинного разговора качается дольше фото — минута вместо 20 секунд
  const got = await fetchFile(url, { maxBytes: o.maxBytes ?? MAX_RECORD_BYTES, fetch: o.fetch, allowHost: o.allowHost, timeoutMs: o.timeoutMs ?? 60_000 });
  if (got.ok && !got.mime.startsWith("audio/")) return { ok: false, reason: "bad" };
  return got;
}

/** Что нужно, чтобы забрать запись и прикрепить её к строке звонка */
export type RecordJob = {
  /** Ключ повтора строки звонка (IncomingCall.externalId): «call:…» */
  callExternalId: string;
  /** Где взять запись — по порядку: ссылки https или ссылки подключения («zadarma-record:call:…») */
  urls: string[];
  /** Сведения звонка — для переходника без updateMessage: тогда запись встаёт отдельной строкой сразу за звонком */
  direction: "in" | "out";
  at?: string | null | undefined;
  missed?: boolean | undefined;
  durationSec?: number | null | undefined;
  manager?: string | null | undefined;
};

/** Событие «запись разговора готова» — тот же клиент, что у звонка */
export function recordEvent(contact: ContactHint, job: RecordJob): Extract<ChannelEvent, { type: "custom" }> {
  return { type: "custom", name: RECORD_EVENT, contact, data: job };
}

/** Запись этого звонка уже скачивается в этом процессе: повтор уведомления не скачает её второй раз */
const inFlight = new Set<string>();

/** Запись уже прикреплена: у строки звонка есть файл или рядом стоит строка «Запись разговора» */
async function hasRecord(store: ChatStore, contactId: string, ext: string): Promise<boolean> {
  if (store.findMessages) {
    const found = await store.findMessages(contactId, { externalIds: [ext, `${ext}:record`] });
    if (found.some((m) => m.fileId)) return true;
  }
  return store.messageExists ? !!(await store.messageExists(`${ext}:record`)) : false;
}

/** Время звонка — как у ingest: время АТС, но не позже «сейчас» */
function callAt(at: string | null | undefined, now: number): string {
  const t = at ? Date.parse(at) : NaN;
  return new Date(Number.isFinite(t) ? Math.min(t, now) : now).toISOString();
}

/** apply для «calls:record»: строка звонка этого клиента есть, записи у неё ещё нет — после ответа телефонии
 *  (ctx.later) скачать запись и прикрепить к строке звонка (updateMessage); у переходника без updateMessage — запись
 *  отдельной строкой «Запись разговора» сразу за звонком. Уже прикреплена — повтор (duplicate) */
export async function applyRecord(
  download: (url: string) => Promise<DownloadResult>, event: Extract<ChannelEvent, { type: "custom" }>, ctx: ApplyContext
): Promise<ApplySummary> {
  const none: ApplySummary = { messageIds: [], added: 0 };
  const job = event.data as RecordJob | null | undefined;
  if (event.name !== RECORD_EVENT || !job?.callExternalId || !Array.isArray(job.urls) || !job.urls.length) return none;
  const { store, contactId } = ctx;
  const ext = job.callExternalId;
  // Звонок должен быть у этого же клиента: запись к чужой строке не прикрепляем
  if (store.messageExists) {
    const call = await store.messageExists(ext);
    if (!call || call.contactId !== contactId) return none;
  }
  if (await hasRecord(store, contactId, ext)) return { ...none, duplicate: true };

  const at = callAt(job.at, ctx.now);
  const author: Author = job.direction === "in" ? { type: "client" } : { type: "operator_phone", name: job.manager ?? null };
  const call: CallInfo = { direction: job.direction, missed: !!job.missed, durationSec: job.durationSec ?? null, manager: job.manager ?? null };
  ctx.later(async () => {
    const key = `${contactId}|${ext}|${job.urls.join(" ")}`;
    if (inFlight.has(key)) return;
    inFlight.add(key);
    try {
      // Пока ждали ответа телефонии, запись мог забрать повтор уведомления
      if (await hasRecord(store, contactId, ext)) return;
      let reason = "";
      for (const url of job.urls) {
        const got = await download(url);
        if (!got.ok) {
          reason = got.reason;
          continue;
        }
        const file = await store.saveFile(contactId, {
          data: got.data, mime: got.mime, ext: got.ext, name: "Запись разговора", sha1: sha1Hex(got.data), sha256: sha256Hex(got.data),
          sourceUrl: url, fromClient: job.direction === "in",
        });
        if (store.updateMessage) await store.updateMessage({ externalId: ext }, { fileId: file.fileId });
        else {
          await store.saveMessage(contactId, {
            kind: "call", author, channel: "call", text: "Запись разговора", at: new Date(Date.parse(at) + 1).toISOString(),
            externalId: `${ext}:record`, fileId: file.fileId, call,
          });
        }
        await store.notify({ contactId, kind: "file" });
        return;
      }
      // Ссылку в журнал не пишем: в ней бывает ключ доступа к записи
      console.warn(`[chat-kit calls] запись разговора ${ext} не забрана: ${reason === "retry" ? "нет связи или АТС не ответила" : reason === "bad" ? "не звук или слишком большая" : "нет файла"}`);
    } finally {
      inFlight.delete(key);
    }
  });
  return none;
}
