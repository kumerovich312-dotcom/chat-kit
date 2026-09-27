import { normalizePhone } from "../../core/phone.js";
import { isPrivateHost } from "../../server/download.js";

/* GREEN-API — запросы к API инстанса: адрес метода, ошибки словами для CRM, адреса чатов, проверка состояния
   WhatsApp и включение нужных уведомлений.

   Метод GREEN-API: {apiUrl}/waInstance{idInstance}/{метод}/{apiTokenInstance}. Ключ инстанса стоит в самом адресе (так
   устроен GREEN-API) — поэтому адреса методов нигде не показываем и не пишем в журналы, а в ссылках на файлы
   (RemoteFile.urls) ключа нет. */

/** Доступ к инстансу GREEN-API — всё из карточки инстанса в кабинете console.green-api.com */
export type GreenApiAccess = {
  /** Номер инстанса (idInstance) */
  idInstance: string | number;
  /** Ключ инстанса (apiTokenInstance) — только из окружения проекта */
  apiTokenInstance: string;
  /** Адрес API инстанса (apiUrl): https://1100.api.greenapi.com */
  apiUrl: string;
  /** Адрес для загрузки файлов (mediaUrl): https://1100.media.greenapi.com. Не задан — apiUrl */
  mediaUrl?: string | undefined;
  fetch?: typeof fetch | undefined;
};

/** Ответ метода: данные JSON или ошибка словами (retryable — сбой связи, 429, 5xx: можно повторить позже) */
export type GreenApiReply =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string; retryable: boolean; status: number | null };

export type GreenApiRequestOptions = {
  /** Тело JSON (POST) */
  body?: unknown;
  /** Тело формой с файлом (sendFileByUpload) */
  form?: FormData | undefined;
  /** Запрос на адрес загрузки файлов (mediaUrl) */
  media?: boolean | undefined;
  /** GET без тела (getStateInstance) */
  get?: boolean | undefined;
  timeoutMs?: number | undefined;
};

/** Что не так с настройками доступа — или null */
function accessProblem(a: GreenApiAccess): string | null {
  const id = String(a.idInstance ?? "").trim();
  if (!/^\d{1,20}$/.test(id) || !a.apiTokenInstance?.trim() || !a.apiUrl?.trim()) {
    return "Подключение GREEN-API не настроено: нужны idInstance, apiTokenInstance и apiUrl из кабинета GREEN-API";
  }
  for (const u of [a.apiUrl, a.mediaUrl]) {
    if (u && !/^https:\/\/[^/\s]+/i.test(u.trim())) return "Адрес API GREEN-API (apiUrl, mediaUrl) должен начинаться с https://";
  }
  return null;
}

/** Вызвать метод GREEN-API. Без перенаправлений: ключ инстанса в адресе не должен уйти на чужой адрес */
export async function greenApiRequest(a: GreenApiAccess, method: string, o: GreenApiRequestOptions = {}): Promise<GreenApiReply> {
  const problem = accessProblem(a);
  if (problem) return { ok: false, error: problem, retryable: false, status: null };
  const base = ((o.media ? a.mediaUrl?.trim() : "") || a.apiUrl.trim()).replace(/\/+$/, "");
  const url = `${base}/waInstance${String(a.idInstance).trim()}/${method}/${encodeURIComponent(a.apiTokenInstance.trim())}`;
  const doFetch = a.fetch ?? fetch;
  const ms = o.timeoutMs ?? 15_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const init: RequestInit = o.form
      ? { method: "POST", body: o.form }
      : o.get
        ? { method: "GET" }
        : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(o.body ?? {}) };
    const res = await doFetch(url, { ...init, signal: ctrl.signal, redirect: "manual", cache: "no-store" });
    const raw = await res.text().catch(() => "");
    if (res.status >= 300 && res.status < 400) {
      return { ok: false, error: "GREEN-API ответил перенаправлением — проверьте адрес API (apiUrl)", retryable: false, status: res.status };
    }
    if (!res.ok) return { ok: false, ...greenApiError(res.status, raw), status: res.status };
    let data: unknown = null;
    try { data = raw ? JSON.parse(raw) : {}; } catch { /* не JSON — ниже */ }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, error: "GREEN-API ответил непонятно (не JSON) — повторите позже", retryable: true, status: res.status };
    }
    return { ok: true, data: data as Record<string, unknown> };
  } catch {
    return {
      ok: false, error: ctrl.signal.aborted ? `GREEN-API не ответил за ${Math.round(ms / 1000)} секунд` : "Нет связи с GREEN-API",
      retryable: true, status: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ── Ошибки словами ────────────────────────────────────────────────────────────────────────────────────────── */

export const GREEN_API_NOT_AUTHORIZED = "WhatsApp не подключён — отсканируйте QR в кабинете GREEN-API";

/** Текст ошибки из ответа GREEN-API: поле description / message или сам ответ — одной строкой, коротко */
function errorDetail(raw: string): string {
  let text = raw;
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const d = [j.description, j.message, j.error].find((v) => typeof v === "string" && v.trim());
    if (typeof d === "string") text = d;
  } catch { /* не JSON — как есть */ }
  const line = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/** 466 — закончился лимит тарифа: бесплатный тариф пишет только в 3 чата в месяц, у методов — месячные лимиты */
function quotaError(raw: string): string {
  let total: unknown;
  let chats = false;
  try {
    const j = JSON.parse(raw) as Record<string, Record<string, unknown> | undefined>;
    chats = !!j.correspondentsStatus;
    total = j.correspondentsStatus?.total;
  } catch { /* тело без подробностей */ }
  if (chats) {
    const n = Number(total);
    return `Закончился лимит тарифа GREEN-API: на этом тарифе переписка только с ${Number.isFinite(n) && n > 0 ? n : 3} чатами в месяц — смените тариф в кабинете GREEN-API`;
  }
  return "Закончился лимит тарифа GREEN-API — смените тариф в кабинете GREEN-API";
}

/** HTTP-ошибка GREEN-API → короткая причина по-русски; retryable — можно повторить позже (связь, 429, 5xx) */
export function greenApiError(status: number, raw = ""): { error: string; retryable: boolean } {
  const low = raw.toLowerCase();
  if (status === 401) return { error: "GREEN-API не принял ключ инстанса (apiTokenInstance) — проверьте настройки подключения", retryable: false };
  if (status === 403) return { error: "GREEN-API не узнал инстанс (idInstance) или адрес API (apiUrl) — проверьте настройки подключения", retryable: false };
  if (status === 466) return { error: quotaError(raw), retryable: false };
  if (status === 429) return { error: "GREEN-API просит отправлять реже — повторите через минуту", retryable: true };
  if (status === 413 || low.includes("max upload size") || low.includes("entity too large")) {
    return { error: "Файл слишком большой для WhatsApp (больше 100 МБ)", retryable: false };
  }
  // «instance is starting or not authorized» — тоже сюда: чаще всего WhatsApp просто отвязан от инстанса
  if (low.includes("not authorized") || low.includes("notauthorized")) return { error: GREEN_API_NOT_AUTHORIZED, retryable: false };
  if (low.includes("starting")) return { error: "GREEN-API перезапускает подключение WhatsApp — повторите через пару минут", retryable: true };
  if (low.includes("expired")) return { error: "Оплаченный срок инстанса GREEN-API закончился — продлите тариф в кабинете GREEN-API", retryable: false };
  if (low.includes("instance is deleted")) return { error: "Инстанс GREEN-API удалён — создайте новый и обновите настройки подключения", retryable: false };
  if (status === 408 || status >= 500) return { error: `GREEN-API временно не отвечает (ошибка ${status}) — повторите позже`, retryable: true };
  if (status === 400) {
    const detail = errorDetail(raw);
    return { error: detail ? `GREEN-API не принял запрос: ${detail}` : "GREEN-API не принял запрос (ошибка 400)", retryable: false };
  }
  return { error: `GREEN-API ответил ошибкой ${status}`, retryable: false };
}

/* ── Адреса чатов ──────────────────────────────────────────────────────────────────────────────────────────── */

/** Телефон или адрес чата → адрес чата GREEN-API: «+996 555 00-00-01» → «996555000001@c.us»; адрес чата
 *  (…@c.us, …@g.us, …@lid) — как есть. Не номер (местная запись без кода страны, слова) — null */
export function greenApiChatId(v: string | null | undefined): string | null {
  const s = String(v ?? "").trim();
  if (/^\d{5,20}@c\.us$/.test(s) || /^\d[\d-]{4,40}@g\.us$/.test(s) || /^\d{5,25}@lid$/.test(s)) return s;
  const phone = normalizePhone(s);
  return phone ? `${phone.slice(1)}@c.us` : null;
}

/** Адрес личного чата → телефон «+996555000001». Группа и скрытый номер (@lid) — null */
export function phoneFromChatId(chatId: string | null | undefined): string | null {
  const m = String(chatId ?? "").trim().match(/^(\d{7,15})@c\.us$/);
  return m ? `+${m[1]}` : null;
}

/** Номер инстанса из уведомления (instanceData.idInstance) — чтобы проект с несколькими компаниями нашёл, чьё оно,
 *  до проверки ключа. Тело строкой или уже разобранное. Не нашли — null */
export function greenApiInstanceId(body: string | Record<string, unknown>): string | null {
  let b: unknown = body;
  if (typeof body === "string") {
    try { b = JSON.parse(body); } catch { return null; }
  }
  const data = b && typeof b === "object" ? (b as { instanceData?: unknown }).instanceData : null;
  const id = data && typeof data === "object" ? (data as { idInstance?: unknown }).idInstance : null;
  return typeof id === "number" || (typeof id === "string" && id.trim()) ? String(id).trim() : null;
}

/* ── Состояние WhatsApp и настройки уведомлений ────────────────────────────────────────────────────────────── */

/** Состояние инстанса (getStateInstance, уведомление stateInstanceChanged) → слова для администратора */
export const GREEN_API_STATES: Readonly<Record<string, string>> = {
  authorized: "WhatsApp подключён",
  notAuthorized: GREEN_API_NOT_AUTHORIZED,
  blocked: "Номер WhatsApp заблокирован — сообщения не уходят и не приходят",
  sleepMode: "Телефон с WhatsApp выключен или без интернета — после включения связь восстановится за несколько минут",
  starting: "GREEN-API запускает подключение WhatsApp — подождите до 5 минут",
  yellowCard: "WhatsApp временно ограничил номер (подозрение на спам) — отправка приостановлена",
  suspended: "WhatsApp временно ограничил номер (подозрение на спам) — отправка приостановлена",
};

export function greenApiStateText(state: string): string {
  return GREEN_API_STATES[state] ?? `Состояние WhatsApp в GREEN-API: ${state || "неизвестно"}`;
}

export type GreenApiState =
  /** state — как у GREEN-API (authorized, notAuthorized, blocked…), text — что показать администратору */
  | { ok: true; state: string; authorized: boolean; text: string }
  | { ok: false; error: string };

/** Проверка связи для страницы настроек: подключён ли WhatsApp к инстансу */
export async function greenApiState(a: GreenApiAccess): Promise<GreenApiState> {
  const r = await greenApiRequest(a, "getStateInstance", { get: true, timeoutMs: 10_000 });
  if (!r.ok) return { ok: false, error: r.error };
  const state = typeof r.data.stateInstance === "string" ? r.data.stateInstance : "";
  return { ok: true, state, authorized: state === "authorized", text: greenApiStateText(state) };
}

/** Уведомления, которые нужны подключению (setSettings; значения «yes» / «no» — так принимает GREEN-API) */
export const GREEN_API_WEBHOOK_SETTINGS: Readonly<Record<string, string>> = {
  incomingWebhook: "yes", // входящие сообщения и файлы
  outgoingWebhook: "yes", // статусы наших сообщений: ушло, дошло, прочитано, не доставлено
  outgoingMessageWebhook: "yes", // сообщения, написанные с телефона
  outgoingAPIMessageWebhook: "yes", // сообщения, отправленные через API (в том числе самой CRM)
  stateWebhook: "yes", // WhatsApp подключён / отключён / заблокирован
  incomingCallWebhook: "yes", // звонки
  pollMessageWebhook: "yes", // опросы
  editedMessageWebhook: "yes", // исправленные сообщения
  deletedMessageWebhook: "yes", // удалённые сообщения
  markIncomingMessagesReaded: "no", // не ставить клиенту «прочитано», пока менеджер не прочитал
};

export type GreenApiWebhookSetup = GreenApiAccess & {
  /** Адрес приёма уведомлений на сайте проекта — открытый https */
  webhookUrl: string;
  /** Ключ вебхука: GREEN-API пришлёт его в заголовке «Authorization: Bearer …». Случайный, от 16 знаков */
  webhookUrlToken: string;
  /** Прочие настройки GREEN-API как есть (delaySendMessagesMilliseconds…) — поверх набора подключения */
  extra?: Record<string, string | number> | undefined;
};

/** Включить уведомления, которые нужны подключению, и указать адрес и ключ вебхука (вместо ручной настройки в кабинете) */
export async function greenApiSetSettings(s: GreenApiWebhookSetup): Promise<{ ok: true } | { ok: false; error: string }> {
  let host = "";
  try { host = new URL(s.webhookUrl).hostname; } catch { /* не адрес */ }
  if (!/^https:\/\//i.test(s.webhookUrl) || !host || isPrivateHost(host)) {
    return { ok: false, error: "Адрес вебхука должен быть открытым https-адресом сайта: GREEN-API обращается к нему из интернета" };
  }
  if (s.webhookUrlToken.trim().length < 16) return { ok: false, error: "Ключ вебхука слишком короткий — нужен случайный ключ от 16 знаков" };
  const r = await greenApiRequest(s, "setSettings", {
    body: { ...GREEN_API_WEBHOOK_SETTINGS, ...s.extra, webhookUrl: s.webhookUrl, webhookUrlToken: s.webhookUrlToken.trim() },
  });
  if (!r.ok) return { ok: false, error: r.error };
  return r.data.saveSettings === true ? { ok: true } : { ok: false, error: "GREEN-API не сохранил настройки — повторите или задайте их в кабинете GREEN-API" };
}
