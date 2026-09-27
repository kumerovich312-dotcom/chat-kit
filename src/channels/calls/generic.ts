import { normalizePhone } from "../../core/phone.js";
import type { ChannelEvent, IncomingCall, ReceiveResult, WebhookInput } from "../../server/channel.js";
import { safeEqual, sha256Hex } from "../../server/crypto.js";
import { bearerKey } from "../../server/request.js";
import {
  applyRecord, CALLS_CAPS, CALLS_SEND_ERROR, callContact, fetchRecording, managerName, MAX_RECORD_BYTES, parseStartedAt, recordEvent,
  type CallsAdapter,
} from "./common.js";

/* Звонки от любой АТС — общий вебхук JSON. Интеграция АТС (её вебхук, скрипт на сервере АТС, сервис-посредник)
   после каждого звонка присылает POST на адрес проекта:
     Authorization: Bearer <ключ приёма>
     { "id": "a1", "direction": "in", "from": "+996555000001", "to": "+996555000009", "startedAt": "2026-09-27T14:00:00+06:00",
       "answered": true, "durationSec": 185, "manager": { "name": "Айгерим", "extension": "101" }, "recordUrl": "https://…/a1.mp3" }
   Поля подробно — в docs/channels/calls.md и в типе CallWebhookBody.

   - Ключ сверяем за одно и то же время (отпечатки ключей, safeEqual); без ключа или с чужим — 401.
   - Клиент — номер «from» у входящего, «to» у исходящего (или clientPhone), в международном виде по коду страны
     компании. Номер скрыт или это не телефон (внутренний «101») — звонок пропускаем: карточку не к чему привязать.
   - Повтор того же id — одна строка (ключ «call:<id>»). Запись разговора — особым событием: та же АТС может прислать
     звонок ещё раз со ссылкой на запись, когда та будет готова, — строка не задвоится, запись прикрепится. */

export type CallsOptions = {
  /** Ключ приёма: АТС шлёт его в заголовке Authorization: Bearer <ключ> (или X-Api-Key). Случайная строка от 16 знаков,
   *  из окружения проекта */
  token: string;
  /** Телефонный код страны компании («+996»): номер без «+» читается по правилам этой страны */
  countryCode?: string | undefined;
  /** Внутренний номер → имя сотрудника: { "101": "Айгерим" } — кто говорил */
  managers?: Readonly<Record<string, string>> | undefined;
  /** Пояс часов АТС (IANA: «Asia/Bishkek») — для startedAt без пояса */
  timeZone?: string | undefined;
  /** Запись разговора больше этого не скачиваем (по умолчанию 25 МБ) */
  maxRecordBytes?: number | undefined;
  /** Откуда можно скачивать записи (адрес АТС). Не задано — любые публичные адреса, но не внутренние */
  allowRecordHost?: ((host: string) => boolean) | undefined;
  fetch?: typeof fetch | undefined;
};

/** Тело вебхука — один звонок, после его окончания */
export type CallWebhookBody = {
  /** Номер звонка у АТС — ключ повтора */
  id: string | number;
  /** in — звонил клиент, out — звонили мы */
  direction: "in" | "out";
  /** Кто звонил (у входящего — клиент) */
  from?: string | number | null | undefined;
  /** Куда звонили (у исходящего — клиент) */
  to?: string | number | null | undefined;
  /** Номер клиента явно — тогда from и to не читаем */
  clientPhone?: string | number | null | undefined;
  /** Начало звонка: ISO 8601 с поясом или Unix-время в секундах */
  startedAt?: string | number | null | undefined;
  /** Состоялся ли разговор. Нет поля — читаем status */
  answered?: boolean | null | undefined;
  /** Длительность разговора, секунды */
  durationSec?: number | null | undefined;
  /** Кто из команды говорил (у исходящего — кто звонил) */
  manager?: { name?: string | null | undefined; extension?: string | number | null | undefined } | null | undefined;
  /** Ссылка на запись разговора (https) */
  recordUrl?: string | null | undefined;
  /** Итог звонка словами АТС: answered, busy, no answer, failed… — только если нет answered */
  status?: string | null | undefined;
};

/** Ключ приёма короче этого не принимаем: короткий ключ легко подобрать */
const MIN_TOKEN = 16;

/** Ключ сверяем по отпечаткам: сравнение за одно и то же время, и по времени не узнать даже длину ключа */
function tokenMatches(want: string, got: string): boolean {
  return !!got && safeEqual(sha256Hex(want), sha256Hex(got));
}

/** Строка или число → строка без пробелов по краям; пусто — null */
const text = (v: unknown): string | null =>
  typeof v === "string" ? v.trim() || null : typeof v === "number" && Number.isFinite(v) ? String(v) : null;

/** Номер звонка: строка или число, без управляющих знаков, до 200 знаков */
function callIdOf(v: unknown): string | null {
  const s = text(v);
  return s && s.length <= 200 && !/[\u0000-\u001f\u007f]/.test(s) ? s : null;
}

function directionOf(v: unknown): "in" | "out" | null {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (s === "in" || s === "incoming" || s === "inbound") return "in";
  if (s === "out" || s === "outgoing" || s === "outbound") return "out";
  return null;
}

/** Секунды: число или строка с числом, не меньше нуля */
function secondsOf(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/** Состоялся ли разговор: answered (true / false, 1 / 0); нет его — по итогу status. Не понять — null */
function answeredOf(answered: unknown, status: unknown): boolean | null {
  if (typeof answered === "boolean") return answered;
  if (answered === 1 || answered === "1" || answered === "true") return true;
  if (answered === 0 || answered === "0" || answered === "false") return false;
  const s = typeof status === "string" ? status.trim().toLowerCase() : "";
  if (!s) return null;
  return /^(answer|answered|success|successful|complete|completed|ok)$/.test(s);
}

/** Ссылка на запись — только полная http(s); другое не качаем */
function recordUrlOf(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return /^https?:\/\//i.test(s) && s.length <= 2048 ? s : null;
}

/** Тело вебхука → события: строка звонка и, если есть ссылка, «запись готова» */
export function callWebhookEvents(body: unknown, o: Pick<CallsOptions, "countryCode" | "managers" | "timeZone"> = {}): ReceiveResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, status: 400, error: "Тело запроса должно быть JSON-объектом одного звонка" };
  const b = body as Record<string, unknown>;
  const id = callIdOf(b.id);
  if (!id) return { ok: false, status: 422, error: "Нет номера звонка (id)" };
  const direction = directionOf(b.direction);
  if (!direction) return { ok: false, status: 422, error: "Направление звонка (direction) — «in» (звонил клиент) или «out» (звонили мы)" };
  const meta = { callId: id, direction };
  const raw = text(b.clientPhone) ?? text(direction === "in" ? b.from : b.to);
  if (!raw) {
    return { ok: false, status: 422, error: direction === "in" ? "Нет номера клиента: пришлите from (кто звонил) или clientPhone" : "Нет номера клиента: пришлите to (куда звонили) или clientPhone", meta };
  }
  const answered = answeredOf(b.answered, b.status);
  if (answered === null) return { ok: false, status: 422, error: "Нет answered: состоялся ли разговор (true или false)", meta };
  const phone = normalizePhone(raw, o.countryCode ?? "");
  // Скрытый номер или внутренний («101») — не клиент, карточку не к чему привязать. 200: АТС не должна повторять
  if (!phone) return { ok: false, status: 200, ignored: true, error: "Номер клиента скрыт или не похож на телефон — звонок не записан", meta };

  const mg = b.manager;
  const m = mg && typeof mg === "object" && !Array.isArray(mg) ? (mg as Record<string, unknown>) : null;
  const who = managerName(o.managers, m ? text(m.extension) : null, m ? text(m.name) : text(mg));
  const call: IncomingCall = {
    externalId: `call:${id}`,
    at: parseStartedAt(b.startedAt, o.timeZone),
    direction,
    missed: !answered,
    // У пропущенного длительность — время звонков в трубке, а не разговор: не показываем
    durationSec: answered ? secondsOf(b.durationSec) : null,
    // У пропущенного входящего никто не говорил; у исходящего без ответа — видно, кто звонил
    manager: answered || direction === "out" ? who : null,
  };
  const contact = callContact(phone);
  const events: ChannelEvent[] = [{ type: "call", contact, call }];
  const record = recordUrlOf(b.recordUrl);
  if (record) {
    events.push(recordEvent(contact, {
      callExternalId: call.externalId, urls: [record], direction, at: call.at, missed: call.missed, durationSec: call.durationSec, manager: call.manager,
    }));
  }
  return { ok: true, events, meta };
}

export function createCallsAdapter(o: CallsOptions): CallsAdapter {
  const doFetch = o.fetch ?? fetch;
  const download = (url: string) => fetchRecording(url, { maxBytes: o.maxRecordBytes ?? MAX_RECORD_BYTES, fetch: doFetch, allowHost: o.allowRecordHost });

  return {
    kind: "calls",
    caps: CALLS_CAPS,

    receive(input: WebhookInput): ReceiveResult {
      if (input.method.toUpperCase() !== "POST") return { ok: false, status: 405, error: "Звонки принимаются POST-запросом" };
      if (!o.token || o.token.length < MIN_TOKEN) {
        return { ok: false, status: 401, error: `Ключ приёма звонков не задан в настройках проекта (нужен случайный ключ от ${MIN_TOKEN} знаков)` };
      }
      if (!tokenMatches(o.token, bearerKey(input.headers))) return { ok: false, status: 401, error: "Неверный ключ: нужен заголовок Authorization: Bearer <ключ приёма>" };
      let body: unknown;
      try {
        body = input.body ? JSON.parse(input.body) : null;
      } catch {
        return { ok: false, status: 400, error: "Тело запроса должно быть JSON" };
      }
      return callWebhookEvents(body, o);
    },

    apply: (event, ctx) => applyRecord(download, event, ctx),

    async send() {
      return { ok: false, error: CALLS_SEND_ERROR };
    },

    download,
  };
}
