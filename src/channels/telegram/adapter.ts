import { fileExt } from "../../core/files.js";
import { formatForChannel, stripRich } from "../../core/markup.js";
import type { ChannelAdapter, ChannelCaps, DownloadResult, Outgoing, ReceiveResult, SendResult, Target, WebhookInput } from "../../server/channel.js";
import { safeEqual } from "../../server/crypto.js";
import { isPrivateHost, MAX_FILE_BYTES } from "../../server/download.js";
import { sniffFile, type Sniffed } from "../../server/sniff.js";
import { telegramApiBase, telegramCall, type TelegramReply } from "./api.js";
import { telegramUpdateEvents, tgMessageId, tgMessageKey, type TelegramTexts, type TgUpdate } from "./parse.js";
import { TELEGRAM_CAPTION_LIMIT, TELEGRAM_DOCUMENT, telegramEscape, telegramFileMethod, telegramFileMime, splitTelegramText, TELEGRAM_UPLOAD_LIMIT, TELEGRAM_URL_DOCUMENTS, type TelegramFileMethod } from "./send.js";

/* Подключение Telegram-бота (Bot API): клиент пишет боту компании, сообщения приходят в переписку CRM, менеджер
   отвечает из CRM — клиент получает ответ от бота.

   Telegram → CRM: вебхук. Каждое уведомление несёт секрет в заголовке X-Telegram-Bot-Api-Secret-Token — тот, что
   проект передал в setWebhook (telegramSetWebhook); без него или с чужим — 401. Разбор уведомлений — parse.ts.
   Ключ повтора — «tg:<чат>:<номер сообщения>»: Telegram повторяет уведомление, если CRM не ответила 200, — второй раз
   сообщение не запишется. Файлы — ссылками «tg-file:<file_id>», их скачивает download (getFile) после ответа Telegram.

   CRM → Telegram: sendMessage с разметкой HTML. Ответ бота (Markdown) переводится в HTML (formatForChannel), текст
   человека уходит как набран (знаки < > & экранируются). Длинный текст режется на части по 4096 знаков, файл уходит
   своим методом (фото, голосовое, аудио, видео, документ) — ссылкой или загрузкой.

   Чего бот не умеет: написать первым тому, кто не нажимал «Старт»; узнать, прочитано ли сообщение. */

export type TelegramOptions = {
  /** Ключ бота от @BotFather («123456789:AA…») — только из окружения проекта */
  token: string;
  /** Секрет вебхука (1–256 знаков: латинские буквы, цифры, «_», «-») — тот же, что передан в telegramSetWebhook */
  secretToken: string;
  fetch?: typeof fetch | undefined;
  /** Адрес Bot API: свой сервер Bot API или поддельный в проверках. По умолчанию https://api.telegram.org */
  apiBase?: string | undefined;
  /** Только личные чаты с ботом (по умолчанию да): сообщения групп пропускаются, каналы — всегда */
  privateOnly?: boolean | undefined;
  /** Файл клиента больше этого не качаем (по умолчанию 10 МБ; облачный Bot API отдаёт ботам файлы до 20 МБ) */
  maxFileBytes?: number | undefined;
  /** Свои слова служебных строк: «Пациент заблокировал бота…» */
  texts?: Partial<TelegramTexts> | undefined;
};

/** Текст и файлы — да. Паузы и «не отвечать» нет: бот здесь только доставляет сообщения (свой ИИ проект ставит сам).
 *  Написать первым нельзя: Telegram разрешает боту писать только тем, кто уже нажал «Старт». Статусов нет: Telegram
 *  не сообщает боту ни о доставке, ни о прочтении */
export const TELEGRAM_CAPS: ChannelCaps = { text: true, files: true, pause: false, mute: false, start: false, statuses: false };

/** Итог отправки; retryAfterSec — через сколько секунд Telegram разрешит повторить (ответ 429) */
export type TelegramSendResult = SendResult & { retryAfterSec?: number | undefined };

export type TelegramAdapter = Omit<ChannelAdapter, "send" | "download"> & {
  send(to: Target, out: Outgoing): Promise<TelegramSendResult>;
  download(url: string): Promise<DownloadResult>;
  /** Любой метод Bot API с ключом этого бота — для особых случаев (sendChatAction «печатает…», setMyCommands) */
  call<T = unknown>(method: string, params?: Record<string, unknown> | FormData): Promise<TelegramReply<T>>;
};

/** Ответ Telegram на отправку: номер сообщения и чат */
type TgSent = { message_id?: unknown; chat?: { id?: unknown } | undefined };
type Failure = Extract<TelegramReply<unknown>, { ok: false }>;

/** Telegram не смог забрать файл по ссылке: адрес закрыт, фото больше 5 МБ, остальное больше 20 МБ, не тот тип */
const URL_PROBLEM = /http url|web page|failed to get|file identifier|remote file/i;
/** Фото не подошло как фото (слишком вытянутое, не обработалось) — уйдёт документом */
const PHOTO_PROBLEM = /photo|image_process|dimensions/i;
/** Клиент запретил присылать ему голосовые (настройка Telegram Premium) — голосовое уйдёт документом */
const VOICE_PROBLEM = /voice_messages_forbidden/i;

/** Заголовок без учёта регистра (readWebhook уже переводит имена в нижний регистр) */
function header(h: Record<string, string | undefined>, name: string): string {
  const v = h[name] ?? Object.entries(h).find(([k]) => k.toLowerCase() === name)?.[1];
  return typeof v === "string" ? v : "";
}

const sentKey = (r: TgSent | undefined, chat: string): string | null =>
  typeof r?.message_id === "number" ? tgMessageKey(typeof r.chat?.id === "number" ? r.chat.id : chat, r.message_id) : null;

const failed = (r: Failure): TelegramSendResult => ({ ok: false, error: r.error, retryable: r.retryable, ...(r.retryAfterSec ? { retryAfterSec: r.retryAfterSec } : {}) });

const replyParams = (id: number) => ({ message_id: id, allow_sending_without_reply: true });

/** Прочитать тело ответа, но не больше max байт: сервер мог не сказать размер — лишнего в памяти не держим.
 *  null — больше max */
async function readLimited(res: Response, max: number): Promise<Uint8Array | null> {
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > max) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  }
  const data = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { data.set(c, off); off += c.byteLength; }
  return data;
}

/** Простой текст (txt, csv): его первые байты ничем не отмечены — берём по расширению, если в нём нет двоичных знаков */
function plainText(data: Uint8Array, path: string): Sniffed | null {
  const ext = fileExt(path);
  if (ext !== "txt" && ext !== "csv") return null;
  for (const b of data) if (b < 0x09 || (b > 0x0d && b < 0x20) || b === 0x7f) return null;
  return { mime: ext === "csv" ? "text/csv" : "text/plain", ext };
}

export function createTelegramAdapter(o: TelegramOptions): TelegramAdapter {
  const doFetch = o.fetch ?? fetch;
  const api = { token: o.token, fetch: doFetch, apiBase: o.apiBase };
  const maxFile = o.maxFileBytes ?? MAX_FILE_BYTES;
  const call = <T = unknown>(method: string, params: Record<string, unknown> | FormData = {}, timeoutMs?: number) =>
    telegramCall<T>(api, method, params, timeoutMs);

  /** Файл проекта по ссылке (signFileLink) — чтобы загрузить его в Telegram. Предосторожности как у fetchFile: только
   *  http(s), не внутренние адреса, перенаправления проверяются, не больше 50 МБ. Тип не проверяем: файл проекта */
  async function fetchOwnFile(raw: string): Promise<Uint8Array | null> {
    let url: URL;
    try { url = new URL(raw); } catch { return null; }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    try {
      for (let hop = 0; hop < 4; hop++) {
        if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || isPrivateHost(url.hostname)) return null;
        const res = await doFetch(url.href, { signal: ctrl.signal, redirect: "manual", cache: "no-store" });
        if (res.status >= 300 && res.status < 400) {
          const next = res.headers.get("location");
          await res.body?.cancel().catch(() => {});
          if (!next) return null;
          url = new URL(next, url);
          continue;
        }
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          return null;
        }
        const data = await readLimited(res, TELEGRAM_UPLOAD_LIMIT);
        return data?.byteLength ? data : null;
      }
      return null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Отправить файл один раз: ссылкой (Telegram заберёт сам) или загрузкой. Подпись — с разметкой HTML; Telegram
   *  не понял разметку — ещё раз простым текстом */
  async function postFile(
    chat: string, how: TelegramFileMethod, src: { url: string } | { data: Uint8Array; name: string; mime: string }, caption: string, bot: boolean, reply: number | null
  ): Promise<TelegramReply<TgSent>> {
    const post = (cap: Record<string, string>) => {
      const fields: Record<string, unknown> = { chat_id: chat, ...cap, ...(reply ? { reply_parameters: replyParams(reply) } : {}) };
      if ("url" in src) return call<TgSent>(how.method, { ...fields, [how.field]: src.url });
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.append(k, typeof v === "string" ? v : JSON.stringify(v));
      form.append(how.field, new Blob([new Uint8Array(src.data)], { type: src.mime }), src.name);
      return call<TgSent>(how.method, form, 60_000);
    };
    if (!caption) return post({});
    const r = await post({ caption: bot ? formatForChannel(caption, "telegram") : telegramEscape(caption), parse_mode: "HTML" });
    if (r.ok || !/can't parse entities/i.test(r.description)) return r;
    return post({ caption: bot ? stripRich(caption) : caption });
  }

  /** Файл с подписью: данные — загрузкой; ссылка — Telegram забирает сам, а если не может (документ не PDF / GIF / ZIP,
   *  большое фото, закрытый адрес) — подключение скачивает файл по ссылке и загружает. Фото, которое Telegram не принял
   *  как фото, и голосовое клиенту, который запретил голосовые, уходят документом */
  async function sendFile(chat: string, file: NonNullable<Outgoing["file"]>, caption: string, bot: boolean, reply: number | null): Promise<TelegramSendResult> {
    const mime = telegramFileMime(file.mime, file.name);
    const name = file.name.trim() || `file.${fileExt(file.url) || "bin"}`;
    let data: Uint8Array | null = file.data ?? null;
    const load = async (): Promise<Uint8Array | null> => (data ??= file.url ? await fetchOwnFile(file.url) : null);
    const upload = (bytes: Uint8Array) => ({ data: bytes, name, mime });
    if (data && data.byteLength > TELEGRAM_UPLOAD_LIMIT) return { ok: false, error: "Файл больше 50 МБ — Telegram не примет его от бота" };

    let how = telegramFileMethod(mime, data?.byteLength);
    const byUrl = !data && !!file.url && (how.method !== "sendDocument" || TELEGRAM_URL_DOCUMENTS.has(mime));
    let r: TelegramReply<TgSent>;
    if (byUrl && file.url) {
      r = await postFile(chat, how, { url: file.url }, caption, bot, reply);
      if (!r.ok && URL_PROBLEM.test(r.description)) {
        const bytes = await load();
        if (bytes) {
          how = telegramFileMethod(mime, bytes.byteLength);
          r = await postFile(chat, how, upload(bytes), caption, bot, reply);
        }
      }
    } else {
      const bytes = await load();
      if (!bytes) return { ok: false, error: file.url ? "Не удалось взять файл по ссылке для отправки в Telegram" : "Нет файла для отправки: ни данных, ни ссылки" };
      how = telegramFileMethod(mime, bytes.byteLength);
      r = await postFile(chat, how, upload(bytes), caption, bot, reply);
    }
    const asDocument = how.method === "sendPhoto" ? PHOTO_PROBLEM : how.method === "sendVoice" ? VOICE_PROBLEM : null;
    if (!r.ok && asDocument?.test(r.description)) {
      const bytes = await load();
      if (bytes) r = await postFile(chat, TELEGRAM_DOCUMENT, upload(bytes), caption, bot, reply);
    }
    return r.ok ? { ok: true, externalId: sentKey(r.result, chat) } : failed(r);
  }

  /** Текст частями по 4096 знаков; цитата — у первой части. Ключ — первой части */
  async function sendText(chat: string, text: string, bot: boolean, reply: number | null): Promise<TelegramSendResult> {
    const parts = splitTelegramText(text);
    let first: string | null = null;
    for (const [i, part] of parts.entries()) {
      const post = (body: Record<string, string>) =>
        call<TgSent>("sendMessage", { chat_id: chat, ...body, ...(i === 0 && reply ? { reply_parameters: replyParams(reply) } : {}) });
      let r = await post({ text: bot ? formatForChannel(part, "telegram") : telegramEscape(part), parse_mode: "HTML" });
      // Разметка ответа бота не разобралась — тот же текст без разметки, чтобы ответ всё-таки дошёл
      if (!r.ok && /can't parse entities/i.test(r.description)) r = await post({ text: bot ? stripRich(part) : part });
      if (!r.ok) {
        // Повтор всего сообщения задвоил бы уже ушедшие части — такую ошибку не повторяем сами
        return i === 0 ? failed(r) : { ok: false, error: `Ушла только часть сообщения (${i} из ${parts.length}): ${r.error}`, retryable: false };
      }
      first ??= sentKey(r.result, chat);
    }
    return { ok: true, externalId: first };
  }

  return {
    kind: "telegram",
    caps: TELEGRAM_CAPS,

    receive(input: WebhookInput): ReceiveResult {
      if (!o.secretToken) return { ok: false, status: 401, error: "Не задан секрет вебхука Telegram: без него уведомления не принимаем" };
      const given = header(input.headers, "x-telegram-bot-api-secret-token");
      if (!given || !safeEqual(given, o.secretToken)) return { ok: false, status: 401, error: "Неверный секрет вебхука Telegram" };
      let body: unknown;
      try {
        body = JSON.parse(input.body);
      } catch {
        return { ok: false, status: 400, error: "Тело запроса должно быть JSON" };
      }
      if (!body || typeof body !== "object" || Array.isArray(body) || typeof (body as { update_id?: unknown }).update_id !== "number") {
        return { ok: false, status: 400, error: "Это не уведомление Telegram: нет update_id" };
      }
      return telegramUpdateEvents(body as TgUpdate, { privateOnly: o.privateOnly, maxFileBytes: maxFile, texts: o.texts });
    },

    async send(to: Target, out: Outgoing): Promise<TelegramSendResult> {
      const chat = String(to.externalId ?? "").trim();
      if (!/^-?\d+$/.test(chat)) return { ok: false, error: "Клиент ещё не писал боту в Telegram — первым бот написать не может" };
      const bot = out.author?.type === "bot";
      const reply = tgMessageId(out.replyTo?.externalId, chat);
      const text = out.text.trim();
      if (out.file) {
        // Текст — только имя файла (так поле ввода подписывает файл без слов): подписью его не повторяем
        const caption = text && text !== out.file.name.trim() ? text : "";
        const fits = caption.length <= TELEGRAM_CAPTION_LIMIT;
        const f = await sendFile(chat, out.file, fits ? caption : "", bot, reply);
        if (!f.ok || fits) return f;
        // Подпись длиннее 1024 знаков — файл без подписи, текст следом отдельным сообщением
        const t = await sendText(chat, caption, bot, null);
        return t.ok ? f : { ok: false, error: `Файл ушёл, а текст к нему — нет: ${t.error}`, retryable: false };
      }
      if (!text) return { ok: false, error: "Пустое сообщение — отправлять нечего" };
      return sendText(chat, text, bot, reply);
    },

    /** Файл клиента: getFile даёт путь, файл качается по адресу с ключом бота (ссылка живёт не меньше часа).
     *  Тип — по содержимому (sniffFile), простой текст — по расширению; чужое (архив, программа) не сохраняем */
    async download(url: string): Promise<DownloadResult> {
      const id = url.startsWith("tg-file:") ? url.slice("tg-file:".length) : "";
      if (!/^[A-Za-z0-9_-]{1,512}$/.test(id)) return { ok: false, reason: "bad" };
      const info = await call<{ file_size?: unknown; file_path?: unknown }>("getFile", { file_id: id });
      if (!info.ok) {
        // Нет связи, перегрузка, неверный ключ бота (файл при этом цел) — попробовать потом
        if (info.retryable || info.status === 0 || info.status === 401 || info.status === 404) return { ok: false, reason: "retry" };
        if (/too big/i.test(info.description)) return { ok: false, reason: "bad" };
        return { ok: false, reason: /temporarily/i.test(info.description) ? "retry" : "missing" };
      }
      const size = info.result?.file_size;
      if (typeof size === "number" && size > maxFile) return { ok: false, reason: "bad" };
      const path = typeof info.result?.file_path === "string" ? info.result.file_path : "";
      // Путь у Telegram — «photos/file_12.jpg». Абсолютный путь (свой сервер Bot API в режиме --local), «..», пустые части
      // и служебные знаки не берём; части пути — в кодировке адреса
      const segments = path.split("/");
      if (!path || segments.some((s) => !s || s === "." || s === "..") || /[\u0000-\u001f\\]/.test(path)) return { ok: false, reason: "missing" };
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30_000);
      try {
        const res = await doFetch(`${telegramApiBase(api)}/file/bot${o.token}/${segments.map(encodeURIComponent).join("/")}`, {
          signal: ctrl.signal, redirect: "manual", cache: "no-store",
        });
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          return res.status >= 500 || res.status === 408 || res.status === 429 ? { ok: false, reason: "retry" } : { ok: false, reason: "missing" };
        }
        const data = await readLimited(res, maxFile);
        if (!data) return { ok: false, reason: "bad" };
        if (!data.byteLength) return { ok: false, reason: "missing" };
        const type = sniffFile(data) ?? plainText(data, path);
        return type ? { ok: true, data, mime: type.mime, ext: type.ext } : { ok: false, reason: "bad" };
      } catch {
        return { ok: false, reason: "retry" };
      } finally {
        clearTimeout(timer);
      }
    },

    call: <T = unknown>(method: string, params?: Record<string, unknown> | FormData) => call<T>(method, params ?? {}),
  };
}
