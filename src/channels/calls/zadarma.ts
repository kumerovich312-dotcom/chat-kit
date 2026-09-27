import { createHash, createHmac } from "node:crypto";
import { normalizePhone } from "../../core/phone.js";
import type { ChannelEvent, DownloadResult, IncomingCall, ReceiveResult, WebhookInput } from "../../server/channel.js";
import { safeEqual, sha1Hex } from "../../server/crypto.js";
import type { KeyValue } from "../../server/store.js";
import {
  applyRecord, CALLS_CAPS, CALLS_SEND_ERROR, callContact, fetchRecording, managerName, MAX_RECORD_BYTES, recordEvent, zonedIso,
  type CallsAdapter, type RecordJob,
} from "./common.js";

/* Подключение Zadarma — облачная АТС, распространённая в СНГ.

   Zadarma → CRM: уведомления о звонках POST-запросом на адрес из кабинета, поля — как у HTML-формы
   (application/x-www-form-urlencoded). Подпись — заголовок Signature: base64 от HMAC-SHA1 строки подписи секретом API,
   причём HMAC берётся в шестнадцатеричном виде (так делают библиотеки Zadarma: base64_encode(hash_hmac('sha1', …)) в PHP,
   b64encode(hexdigest) в Python). Строка подписи — несколько полей подряд, у каждого события свои (ZADARMA_SIGNED):
     NOTIFY_START, NOTIFY_INTERNAL, NOTIFY_END — caller_id + called_did + call_start;
     NOTIFY_ANSWER — caller_id + destination + call_start;
     NOTIFY_OUT_START, NOTIFY_OUT_END — internal + destination + call_start;
     NOTIFY_RECORD — pbx_call_id + call_id_with_rec.
   Остальные поля (длительность, итог, внутренний номер, номер звонка) подписью не закрыты — так устроено у Zadarma.
   Секрет — только в окружении проекта; без него Zadarma не подписывает уведомления, а набор неподписанные не берёт.

   - Строка в ленте — в конце звонка: NOTIFY_END (входящий), NOTIFY_OUT_END (исходящий). Итог «answered» — разговор,
     остальное (busy, no answer, cancel, failed…) — пропущенный. Внутренний номер (internal) → сотрудник (managers).
   - Начало звонка и ответ сотрудника (NOTIFY_START, NOTIFY_INTERNAL, NOTIFY_ANSWER, NOTIFY_OUT_START) — подпись
     проверяем и пропускаем. Незнакомые уведомления (голосовое меню, SMS…) — пропускаем, ничего не записывая.
   - Запись разговора Zadarma готовит после звонка и сообщает о ней NOTIFY_RECORD, где нет номера клиента. Поэтому звонок
     с записью (is_recorded=1) запоминаем в «ключ → значение» (state), пока не придёт запись. Ссылку на файл выдаёт только
     запрос к API с ключом и подписью (zadarmaRecordingLink): в событии запись — «zadarma-record:call:<номер записи>»,
     а download сам получает ссылку и скачивает файл.
   - Проверка адреса: при сохранении ссылки в кабинете Zadarma открывает её с ?zd_echo=<слово> и ждёт это слово
     в ответе — маршрут проекта отвечает zadarmaEcho / zadarmaEchoResponse. */

export type ZadarmaOptions = {
  /** Ключ API из кабинета Zadarma — для ссылок на записи разговоров (из окружения проекта) */
  key: string;
  /** Секрет API — им Zadarma подписывает уведомления (из окружения проекта) */
  secret: string;
  /** Телефонный код страны компании («+996»): номер без «+» читается по правилам этой страны */
  countryCode?: string | undefined;
  /** Внутренний номер АТС → имя сотрудника: { "101": "Айгерим" } */
  managers?: Readonly<Record<string, string>> | undefined;
  /** Пояс времени из кабинета Zadarma (IANA: «Asia/Bishkek») — call_start приходит без пояса. Не задано — начало
   *  звонка = приход уведомления минус длительность */
  timeZone?: string | undefined;
  /** Где помнить звонок, пока Zadarma готовит запись: «ключ → значение» проекта (store.state). Не задано — память
   *  процесса: не годится, если у проекта несколько копий сервера или «бессерверный» хостинг */
  state?: KeyValue | undefined;
  /** Запись разговора больше этого не скачиваем (по умолчанию 25 МБ) */
  maxRecordBytes?: number | undefined;
  fetch?: typeof fetch | undefined;
  now?: (() => number) | undefined;
  /** Адрес API Zadarma (по умолчанию https://api.zadarma.com) */
  apiUrl?: string | undefined;
};

export const ZADARMA_API = "https://api.zadarma.com";

/** Ссылка подключения на запись разговора — её понимает download: «zadarma-record:call:<call_id>» или «…:pbx:<pbx_call_id>» */
export const ZADARMA_RECORD_SCHEME = "zadarma-record:";

/** Какие поля и в каком порядке подписаны у каждого уведомления */
const ZADARMA_SIGNED = new Map<string, readonly string[]>([
  ["NOTIFY_START", ["caller_id", "called_did", "call_start"]],
  ["NOTIFY_INTERNAL", ["caller_id", "called_did", "call_start"]],
  ["NOTIFY_END", ["caller_id", "called_did", "call_start"]],
  ["NOTIFY_ANSWER", ["caller_id", "destination", "call_start"]],
  ["NOTIFY_OUT_START", ["internal", "destination", "call_start"]],
  ["NOTIFY_OUT_END", ["internal", "destination", "call_start"]],
  ["NOTIFY_RECORD", ["pbx_call_id", "call_id_with_rec"]],
]);

/** Подписанные поля уведомления по порядку; незнакомое уведомление — null */
export function zadarmaSignedFields(event: string): readonly string[] | null {
  return ZADARMA_SIGNED.get(event) ?? null;
}

/** Подпись Zadarma: base64 от шестнадцатеричного HMAC-SHA1 */
export function zadarmaSign(data: string, secret: string): string {
  return Buffer.from(createHmac("sha1", secret).update(data).digest("hex")).toString("base64");
}

/** Подпись уведомления верна. Незнакомое уведомление, нет подписи или секрета — нет */
export function verifyZadarmaSignature(fields: URLSearchParams, signature: string | null | undefined, secret: string): boolean {
  const names = zadarmaSignedFields(fields.get("event") ?? "");
  if (!names || !secret || !signature) return false;
  return safeEqual(zadarmaSign(names.map((n) => fields.get(n) ?? "").join(""), secret), signature.trim());
}

/** Слово проверки адреса (?zd_echo=…) — ответить им простым текстом; null — это не проверка */
export function zadarmaEcho(url: string | URL | null | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(String(url), "http://localhost");
  } catch {
    return null;
  }
  const v = u.searchParams.get("zd_echo");
  // Только буквы, цифры и «-_.»: чужой текст обратно не отражаем
  return v && /^[\w.-]{1,128}$/.test(v) ? v : null;
}

/** Ответ на проверку адреса для маршрута: export const GET = (req) => zadarmaEchoResponse(req) ?? new Response("ok") */
export function zadarmaEchoResponse(req: Request): Response | null {
  const echo = zadarmaEcho(req.url);
  return echo === null ? null : new Response(echo, {
    status: 200, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

/* ── API Zadarma: ссылка на запись разговора ──────────────────────────────────────────────────────────────── */

/** Как PHP http_build_query (RFC 1738): пробел — «+», всё, кроме букв, цифр и «-_.», — %XX; ключи по алфавиту.
 *  По такой записи параметров Zadarma сверяет подпись запроса */
export function zadarmaQuery(params: Readonly<Record<string, string>>): string {
  const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`).replace(/%20/g, "+");
  return Object.keys(params).sort().map((k) => `${enc(k)}=${enc(params[k] ?? "")}`).join("&");
}

/** Заголовок запроса к API: «<ключ>:<base64(hex(HMAC-SHA1(путь + параметры + md5(параметры), секрет)))>» */
export function zadarmaAuthorization(key: string, secret: string, path: string, query: string): string {
  const md5 = createHash("md5").update(query).digest("hex");
  return `${key}:${zadarmaSign(path + query + md5, secret)}`;
}

export type ZadarmaLinkResult = { ok: true; links: string[] } | { ok: false; error: string; retryable: boolean };

/** Временная ссылка на запись разговора: GET /v1/pbx/record/request/ с подписью ключом и секретом API.
 *  callId (call_id_with_rec) — одна запись; pbxCallId — все записи звонка (при переводах их несколько) */
export async function zadarmaRecordingLink(o: {
  key: string;
  secret: string;
  callId?: string | null | undefined;
  pbxCallId?: string | null | undefined;
  /** Сколько живёт ссылка, секунды (у Zadarma 180…5 184 000; не задано — её срок по умолчанию) */
  lifetimeSec?: number | undefined;
  fetch?: typeof fetch | undefined;
  apiUrl?: string | undefined;
  timeoutMs?: number | undefined;
}): Promise<ZadarmaLinkResult> {
  const path = "/v1/pbx/record/request/";
  const params: Record<string, string> = { format: "json" };
  if (o.callId) params.call_id = o.callId;
  else if (o.pbxCallId) params.pbx_call_id = o.pbxCallId;
  else return { ok: false, error: "Нужен номер записи (call_id) или номер звонка (pbx_call_id)", retryable: false };
  if (o.lifetimeSec) params.lifetime = String(Math.round(o.lifetimeSec));
  if (!o.key || !o.secret) return { ok: false, error: "Не заданы ключ и секрет API Zadarma", retryable: false };
  const query = zadarmaQuery(params);
  const doFetch = o.fetch ?? fetch;
  const timeoutMs = o.timeoutMs ?? 15_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await doFetch(`${(o.apiUrl ?? ZADARMA_API).replace(/\/+$/, "")}${path}?${query}`, {
      method: "GET", headers: { authorization: zadarmaAuthorization(o.key, o.secret, path, query) }, signal: ctrl.signal, redirect: "manual", cache: "no-store",
    });
    const data = (await res.json().catch(() => null)) as { status?: unknown; message?: unknown; link?: unknown; links?: unknown } | null;
    if (res.status === 401 || res.status === 403) return { ok: false, error: "Zadarma не приняла ключ API — проверьте ключ и секрет", retryable: false };
    if (!res.ok || data?.status !== "success") {
      const said = typeof data?.message === "string" && data.message.trim() ? `: ${data.message.trim().slice(0, 200)}` : ` (${res.status})`;
      return { ok: false, error: `Zadarma не дала ссылку на запись${said}`, retryable: res.status >= 500 || res.status === 408 || res.status === 429 };
    }
    // Только https: в ссылке — ключ доступа к записи
    const links = [data.link, ...(Array.isArray(data.links) ? data.links : [])].filter((x): x is string => typeof x === "string" && /^https:\/\//i.test(x));
    return links.length ? { ok: true, links } : { ok: false, error: "Zadarma не дала ссылку на запись", retryable: false };
  } catch {
    return { ok: false, error: ctrl.signal.aborted ? `Zadarma не ответила за ${Math.max(1, Math.round(timeoutMs / 1000))} с` : "Нет связи с Zadarma", retryable: true };
  } finally {
    clearTimeout(timer);
  }
}

/** Ссылка подключения на запись: по номеру записи (call_id_with_rec) или по номеру звонка (pbx_call_id) */
export function zadarmaRecordRef(o: { callId: string } | { pbxCallId: string }): string {
  return "callId" in o ? `${ZADARMA_RECORD_SCHEME}call:${o.callId}` : `${ZADARMA_RECORD_SCHEME}pbx:${o.pbxCallId}`;
}

/* ── Подключение ───────────────────────────────────────────────────────────────────────────────────────────── */

/** Номер у Zadarma (pbx_call_id, call_id_with_rec): без управляющих знаков, до 200 знаков */
function idOf(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  return s && s.length <= 200 && !/[\u0000-\u001f\u007f]/.test(s) ? s : null;
}

/** Секунды: число не меньше нуля */
function secondsOf(v: string | null): number | null {
  const n = v !== null && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/** Заголовок без учёта регистра: readWebhook пишет имена маленькими буквами, но вход могут собрать и вручную */
function headerOf(h: Record<string, string | undefined>, name: string): string | undefined {
  return h[name] ?? Object.entries(h).find(([k]) => k.toLowerCase() === name)?.[1];
}

/** Память процесса вместо «ключ → значение» проекта — последние 5000 звонков с записью */
const memory = new Map<string, string>();
const memoryState: KeyValue = {
  async get(key) {
    return memory.get(key) ?? null;
  },
  async set(key, value) {
    if (memory.size >= 5000 && !memory.has(key)) {
      const first = memory.keys().next().value;
      if (first !== undefined) memory.delete(first);
    }
    memory.set(key, value);
  },
};

type SavedCall = RecordJob & { phone: string };

/** Звонок, запомненный до прихода записи */
function readSaved(raw: string | null): SavedCall | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    if (typeof j.phone !== "string" || !j.phone || typeof j.callExternalId !== "string" || (j.direction !== "in" && j.direction !== "out")) return null;
    return {
      phone: j.phone, callExternalId: j.callExternalId, urls: [], direction: j.direction,
      at: typeof j.at === "string" ? j.at : null, missed: j.missed === true,
      durationSec: typeof j.durationSec === "number" ? j.durationSec : null, manager: typeof j.manager === "string" ? j.manager : null,
    };
  } catch {
    return null;
  }
}

export function createZadarmaAdapter(o: ZadarmaOptions): CallsAdapter {
  const doFetch = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const maxBytes = o.maxRecordBytes ?? MAX_RECORD_BYTES;
  const state = o.state ?? memoryState;
  // Свой раздел «ключ → значение» у каждого кабинета Zadarma: в памяти процесса звонки разных компаний не встретятся
  const ns = sha1Hex(`zadarma:${o.key}`).slice(0, 12);
  const key = (kind: "call" | "record", pbx: string) => `calls:zadarma:${ns}:${kind}:${pbx}`;

  async function download(url: string): Promise<DownloadResult> {
    if (!url.startsWith(ZADARMA_RECORD_SCHEME)) return fetchRecording(url, { maxBytes, fetch: doFetch });
    const ref = url.slice(ZADARMA_RECORD_SCHEME.length);
    const sep = ref.indexOf(":");
    const kind = sep > 0 ? ref.slice(0, sep) : "";
    const id = idOf(ref.slice(sep + 1));
    if (!id || (kind !== "call" && kind !== "pbx")) return { ok: false, reason: "bad" };
    const link = await zadarmaRecordingLink({ key: o.key, secret: o.secret, ...(kind === "call" ? { callId: id } : { pbxCallId: id }), fetch: doFetch, apiUrl: o.apiUrl });
    if (!link.ok) return { ok: false, reason: link.retryable ? "retry" : "missing" };
    let last: DownloadResult = { ok: false, reason: "missing" };
    for (const l of link.links) {
      last = await fetchRecording(l, { maxBytes, fetch: doFetch });
      if (last.ok) return last;
    }
    return last;
  }

  /** Конец звонка → строка в ленте; звонок с записью — запомнить до NOTIFY_RECORD (или забрать запись, если она уже пришла) */
  async function ended(f: URLSearchParams, direction: "in" | "out", pbx: string | null, meta: Record<string, unknown>): Promise<ReceiveResult> {
    const phone = normalizePhone((direction === "in" ? f.get("caller_id") : f.get("destination")) ?? "", o.countryCode ?? "");
    if (!phone) return { ok: false, status: 200, ignored: true, error: "Номер клиента скрыт или звонок внутренний — в переписку не записан", meta };
    const answered = (f.get("disposition") ?? "").trim().toLowerCase() === "answered";
    const duration = secondsOf(f.get("duration"));
    const manager = answered || direction === "out" ? managerName(o.managers, f.get("internal") || f.get("last_internal")) : null;
    const callStart = (f.get("call_start") ?? "").trim();
    const exact = o.timeZone && callStart ? zonedIso(callStart, o.timeZone) : null;
    // Без пояса время из call_start не узнать точно — считаем от прихода уведомления (оно приходит в конце звонка)
    const at = exact ?? new Date(now() - (duration ?? 0) * 1000).toISOString();
    // Номер звонка АТС; без него — отпечаток подписанных полей (у повтора уведомления они те же)
    const externalId = `call:zadarma:${pbx ?? sha1Hex(`${f.get("caller_id") ?? ""}|${f.get("called_did") ?? ""}|${f.get("destination") ?? ""}|${callStart}`).slice(0, 32)}`;
    const contact = callContact(phone);
    const call: IncomingCall = { externalId, at, direction, missed: !answered, durationSec: answered ? duration : null, manager };
    const events: ChannelEvent[] = [{ type: "call", contact, call }];
    if (pbx && (f.get("is_recorded") === "1" || idOf(f.get("call_id_with_rec")))) {
      const job: RecordJob = { callExternalId: externalId, urls: [], direction, at, missed: call.missed, durationSec: call.durationSec, manager };
      try {
        const early = idOf(await state.get(key("record", pbx)));
        if (early) events.push(recordEvent(contact, { ...job, urls: [zadarmaRecordRef({ callId: early })] }));
        else await state.set(key("call", pbx), JSON.stringify({ phone, ...job }));
      } catch (e) {
        // Строка звонка важнее записи: не вышло запомнить звонок — запись просто не прикрепится
        console.error("[chat-kit calls] Zadarma: не удалось запомнить звонок до прихода записи:", e);
      }
    }
    return { ok: true, events, meta };
  }

  /** Запись готова → прикрепить к звонку; звонок ещё не закончился (уведомления пришли не по порядку) — запомнить запись */
  async function recorded(f: URLSearchParams, pbx: string | null, meta: Record<string, unknown>): Promise<ReceiveResult> {
    const rec = idOf(f.get("call_id_with_rec"));
    if (!pbx || !rec) return { ok: false, status: 422, error: "Нет номера звонка (pbx_call_id) или записи (call_id_with_rec)", meta };
    const saved = readSaved(await state.get(key("call", pbx)));
    if (!saved) {
      await state.set(key("record", pbx), rec);
      return { ok: false, status: 200, ignored: true, error: "Запись разговора пришла раньше конца звонка — прикрепим её, когда звонок закончится", meta };
    }
    const { phone, ...job } = saved;
    return { ok: true, events: [recordEvent(callContact(phone), { ...job, urls: [zadarmaRecordRef({ callId: rec })] })], meta };
  }

  return {
    kind: "calls",
    caps: CALLS_CAPS,

    async receive(input: WebhookInput): Promise<ReceiveResult> {
      if (input.method.toUpperCase() !== "POST") {
        return { ok: false, status: 405, error: "Zadarma шлёт уведомления POST-запросом; проверку адреса (?zd_echo=) отвечает zadarmaEcho" };
      }
      const f = new URLSearchParams(input.body);
      const event = (f.get("event") ?? "").trim();
      const pbx = idOf(f.get("pbx_call_id"));
      const meta = { event, pbxCallId: pbx };
      if (!zadarmaSignedFields(event)) return { ok: false, status: 200, ignored: true, error: `Уведомление Zadarma «${event.slice(0, 40) || "без названия"}» переписке не нужно — пропущено`, meta };
      if (!verifyZadarmaSignature(f, headerOf(input.headers, "signature"), o.secret)) {
        return { ok: false, status: 401, error: "Подпись Zadarma неверна: проверьте секрет API в настройках проекта", meta };
      }
      if (event === "NOTIFY_END") return ended(f, "in", pbx, meta);
      if (event === "NOTIFY_OUT_END") return ended(f, "out", pbx, meta);
      if (event === "NOTIFY_RECORD") return recorded(f, pbx, meta);
      return { ok: false, status: 200, ignored: true, error: "Звонок ещё идёт — строка в переписке появится, когда он закончится", meta };
    },

    apply: (event, ctx) => applyRecord(download, event, ctx),

    async send() {
      return { ok: false, error: CALLS_SEND_ERROR };
    },

    download,
  };
}
