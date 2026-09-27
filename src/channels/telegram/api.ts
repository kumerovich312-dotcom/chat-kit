/* Bot API Telegram: вызов метода, ошибки Telegram словами для сотрудника CRM, настройка вебхука, чтение файлов.
   Ключ бота (токен от @BotFather) стоит в адресе каждого запроса — поэтому ни адрес, ни ключ не попадают в тексты
   ошибок и журналы. */

export const TELEGRAM_API = "https://api.telegram.org";

/** Ключ бота: «123456789:AA…» — номер бота, двоеточие, секретная часть */
const TOKEN_RE = /^\d+:[A-Za-z0-9_-]+$/;
/** Секрет вебхука — правило Telegram: от 1 до 256 знаков, латинские буквы, цифры, «_» и «-» */
const SECRET_RE = /^[A-Za-z0-9_-]{1,256}$/;

export type TelegramApiOptions = {
  /** Ключ бота от @BotFather — только из окружения проекта */
  token: string;
  fetch?: typeof fetch | undefined;
  /** Адрес Bot API: свой сервер Bot API или поддельный в проверках. По умолчанию https://api.telegram.org */
  apiBase?: string | undefined;
};

/** Ответ метода: результат — или ошибка словами для сотрудника CRM */
export type TelegramReply<T> =
  | { ok: true; result: T }
  | {
      ok: false;
      /** Причина по-русски — для строки «не доставлено: …» */
      error: string;
      /** Сбой связи, перегрузка, «подождите» — можно повторить позже */
      retryable: boolean;
      /** HTTP-код ответа Telegram; 0 — ответа не было (нет связи) */
      status: number;
      /** Описание ошибки от Telegram (по-английски) — для журнала и разбора */
      description: string;
      /** Через сколько секунд Telegram разрешит повторить (ответ 429) */
      retryAfterSec?: number | undefined;
    };

export const telegramApiBase = (o: Pick<TelegramApiOptions, "apiBase">): string => (o.apiBase ?? TELEGRAM_API).replace(/\/+$/, "");

/** Ошибка Telegram → короткая причина по-русски и можно ли повторить. description — текст Telegram по-английски */
export function telegramError(status: number, description: string, retryAfterSec?: number | null): { error: string; retryable: boolean } {
  const d = description.toLowerCase();
  if (status === 429) {
    return { error: `Telegram просит подождать${retryAfterSec ? ` ${retryAfterSec} с` : ""}: слишком много сообщений подряд`, retryable: true };
  }
  if (status >= 500) return { error: `Telegram временно не отвечает (ошибка ${status}) — попробуйте позже`, retryable: true };
  // 401 — ключ отозван или неверный, 404 — ключ записан с ошибкой (Telegram не узнаёт адрес бота)
  if (status === 401 || status === 404) return { error: "Ключ бота Telegram не подходит — проверьте токен от @BotFather", retryable: false };
  if (d.includes("blocked by the user")) return { error: "Клиент заблокировал бота — сообщение не дошло", retryable: false };
  if (d.includes("user is deactivated")) return { error: "Аккаунт клиента в Telegram удалён", retryable: false };
  if (d.includes("can't initiate conversation") || d.includes("bots can't send messages to bots")) {
    return { error: "Клиент ещё не писал боту — первым бот написать не может", retryable: false };
  }
  if (d.includes("chat not found")) return { error: "Чат не найден: клиент не писал этому боту или номер чата неверный", retryable: false };
  if (d.includes("message is too long") || d.includes("caption is too long")) return { error: "Сообщение слишком длинное для Telegram", retryable: false };
  if (d.includes("kicked") || d.includes("not a member")) return { error: "Бот не состоит в этом чате Telegram", retryable: false };
  if (d.includes("can't parse entities")) return { error: "Telegram не понял разметку сообщения", retryable: false };
  if (d.includes("http url") || d.includes("web page") || d.includes("failed to get") || d.includes("file identifier") || d.includes("remote file")) {
    return { error: "Telegram не смог забрать файл по ссылке", retryable: false };
  }
  if (status === 413 || d.includes("too big") || d.includes("too large")) return { error: "Файл слишком большой для Telegram", retryable: false };
  if (d.includes("photo") || d.includes("image_process")) return { error: "Telegram не принял фото", retryable: false };
  return { error: `Telegram не принял запрос (${status}${description ? `: ${description}` : ""})`, retryable: false };
}

/** Вызвать метод Bot API. params — JSON или FormData (загрузка файла) */
export async function telegramCall<T>(
  o: TelegramApiOptions, method: string, params: Record<string, unknown> | FormData = {}, timeoutMs = 15_000
): Promise<TelegramReply<T>> {
  if (!TOKEN_RE.test(o.token)) {
    return { ok: false, error: "Ключ бота Telegram не задан или записан неверно (вид: 123456789:AA…)", retryable: false, status: 0, description: "" };
  }
  const doFetch = o.fetch ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const form = params instanceof FormData;
    // Без перенаправлений: запрос с ключом бота в адресе никуда не уводим
    const res = await doFetch(`${telegramApiBase(o)}/bot${o.token}/${method}`, {
      method: "POST", signal: ctrl.signal, cache: "no-store", redirect: "manual",
      ...(form ? { body: params } : { headers: { "content-type": "application/json" }, body: JSON.stringify(params) }),
    });
    const data = (await res.json().catch(() => null)) as
      | { ok?: unknown; result?: T; error_code?: unknown; description?: unknown; parameters?: { retry_after?: unknown } }
      | null;
    if (res.ok && data?.ok === true) return { ok: true, result: data.result as T };
    const status = typeof data?.error_code === "number" ? data.error_code : res.status;
    const description = typeof data?.description === "string" ? data.description : "";
    const wait = data?.parameters?.retry_after;
    const retryAfterSec = typeof wait === "number" && wait > 0 ? Math.ceil(wait) : undefined;
    return { ok: false, ...telegramError(status, description, retryAfterSec), status, description, ...(retryAfterSec ? { retryAfterSec } : {}) };
  } catch {
    const error = ctrl.signal.aborted ? `Telegram не ответил за ${Math.round(timeoutMs / 1000)} с` : "Нет связи с Telegram";
    return { ok: false, error, retryable: true, status: 0, description: "" };
  } finally {
    clearTimeout(timer);
  }
}

/* ── Настройка бота ──────────────────────────────────────────────────────────────────────────────────────── */

/** Какие уведомления просим у Telegram: сообщения, их правки и «заблокировал / разблокировал бота» */
export const TELEGRAM_UPDATES: readonly string[] = ["message", "edited_message", "my_chat_member"];

export type TelegramDone = { ok: true } | { ok: false; error: string };

/** Подключить вебхук: Telegram будет присылать уведомления на url с секретом в заголовке
 *  X-Telegram-Bot-Api-Secret-Token. Адрес — https, открытый из интернета (порт 443, 80, 88 или 8443) */
export async function telegramSetWebhook(o: TelegramApiOptions & {
  url: string;
  secretToken: string;
  /** Какие уведомления присылать — по умолчанию TELEGRAM_UPDATES */
  allowedUpdates?: readonly string[] | undefined;
  /** Забыть уведомления, накопившиеся, пока вебхук не работал */
  dropPendingUpdates?: boolean | undefined;
  /** Сколько уведомлений Telegram шлёт одновременно (1–100, у Telegram по умолчанию 40) */
  maxConnections?: number | undefined;
}): Promise<TelegramDone> {
  let url: URL | null = null;
  try { url = new URL(o.url); } catch { /* ниже — понятная ошибка */ }
  if (!url || url.protocol !== "https:") return { ok: false, error: "Адрес вебхука должен начинаться с https:// — Telegram шлёт уведомления только по https" };
  if (!SECRET_RE.test(o.secretToken)) return { ok: false, error: "Секрет вебхука: от 1 до 256 знаков — латинские буквы, цифры, «_» и «-»" };
  const r = await telegramCall<boolean>(o, "setWebhook", {
    url: url.href, secret_token: o.secretToken, allowed_updates: [...(o.allowedUpdates ?? TELEGRAM_UPDATES)],
    ...(o.dropPendingUpdates ? { drop_pending_updates: true } : {}),
    ...(o.maxConnections ? { max_connections: o.maxConnections } : {}),
  });
  if (r.ok) return { ok: true };
  if (/bad webhook/i.test(r.description)) {
    return { ok: false, error: `Telegram не принял адрес вебхука: нужен https-адрес, открытый из интернета (порт 443, 80, 88 или 8443). Ответ Telegram: ${r.description}` };
  }
  return { ok: false, error: r.error };
}

/** Отключить вебхук (например, при смене бота). dropPendingUpdates — забыть непринятые уведомления */
export async function telegramDeleteWebhook(o: TelegramApiOptions & { dropPendingUpdates?: boolean | undefined }): Promise<TelegramDone> {
  const r = await telegramCall<boolean>(o, "deleteWebhook", o.dropPendingUpdates ? { drop_pending_updates: true } : {});
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

export type TelegramBotInfo = { id: number; username: string | null; name: string };

/** Проверка ключа: как зовут бота. Для страницы настроек — «подключён бот @имя» */
export async function telegramGetMe(o: TelegramApiOptions): Promise<{ ok: true; bot: TelegramBotInfo } | { ok: false; error: string }> {
  const r = await telegramCall<{ id?: unknown; first_name?: unknown; username?: unknown }>(o, "getMe");
  if (!r.ok) return { ok: false, error: r.error };
  const b = r.result ?? {};
  if (typeof b.id !== "number") return { ok: false, error: "Telegram ответил без данных бота" };
  return { ok: true, bot: { id: b.id, username: typeof b.username === "string" ? b.username : null, name: typeof b.first_name === "string" ? b.first_name : "" } };
}

export type TelegramWebhookInfo = {
  /** Куда Telegram шлёт уведомления; null — вебхук не подключён */
  url: string | null;
  /** Сколько уведомлений ждут доставки */
  pending: number;
  /** Последняя ошибка доставки уведомления (словами Telegram) и когда она была */
  lastError: string | null;
  lastErrorAt: string | null;
};

/** Состояние вебхука — для страницы настроек: подключён ли, сколько уведомлений ждут, последняя ошибка доставки
 *  (например, «Wrong response from the webhook: 401 Unauthorized» — секрет в Telegram и у проекта разный) */
export async function telegramWebhookInfo(o: TelegramApiOptions): Promise<{ ok: true; info: TelegramWebhookInfo } | { ok: false; error: string }> {
  const r = await telegramCall<{ url?: unknown; pending_update_count?: unknown; last_error_date?: unknown; last_error_message?: unknown }>(o, "getWebhookInfo");
  if (!r.ok) return { ok: false, error: r.error };
  const w = r.result ?? {};
  return {
    ok: true,
    info: {
      url: typeof w.url === "string" && w.url ? w.url : null,
      pending: typeof w.pending_update_count === "number" ? w.pending_update_count : 0,
      lastError: typeof w.last_error_message === "string" && w.last_error_message ? w.last_error_message : null,
      lastErrorAt: typeof w.last_error_date === "number" && w.last_error_date > 0 ? new Date(w.last_error_date * 1000).toISOString() : null,
    },
  };
}
