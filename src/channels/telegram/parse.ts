import { fileExt, fmtSize } from "../../core/files.js";
import type { Author } from "../../core/model.js";
import { fmtPhone, normalizePhone } from "../../core/phone.js";
import type { IncomingMessage, ReceiveResult, RemoteFile } from "../../server/channel.js";
import { MAX_FILE_BYTES } from "../../server/download.js";
import type { ContactHint } from "../../server/store.js";

/* Уведомление Telegram (Update) → события набора. Без сети и без базы: годится и для вебхука (receive), и для опроса
   getUpdates, если проекту так удобнее.

   - message — сообщение клиента: текст или подпись, фото (самый большой размер), документ, голосовое, аудио, видео,
     «кружок», GIF, стикер, геопозиция и место, контакт, кубик, опрос. Файлы — ссылками «tg-file:<file_id>»: подключение
     скачает их само (getFile) после ответа Telegram. Файл, который набор не сохранит (архив, программа, больше лимита),
     не пропадает молча: в тексте сообщения остаётся строка, что пришло и почему не сохранено.
   - edited_message — клиент изменил сообщение: служебная строка «Клиент изменил сообщение: «…»», одна на каждую правку.
     Прежний текст в переписке не меняется: менеджер мог уже ответить на него. Трансляция геопозиции приходит правками
     каждые несколько секунд — такие правки пропускаем.
   - my_chat_member — клиент заблокировал или разблокировал бота: служебная строка, одна на каждую смену.
   - остальное (кнопки, платежи, каналы, Telegram Business) — пропускаем ответом 200, чтобы Telegram не присылал снова. */

/* ── Объекты Telegram (только нужные поля) ─────────────────────────────────────────────────────────────── */

export type TgUser = { id: number; is_bot?: boolean | undefined; first_name?: string | undefined; last_name?: string | undefined; username?: string | undefined };
export type TgChat = {
  id: number;
  /** private — личный чат с ботом; group, supergroup, channel */
  type: string;
  title?: string | undefined;
  username?: string | undefined;
  first_name?: string | undefined;
  last_name?: string | undefined;
};
/** Разметка текста: нам нужны только слова-ссылки (text_link) */
export type TgEntity = { type: string; offset: number; length: number; url?: string | undefined };
export type TgFileRef = { file_id: string; file_unique_id?: string | undefined; file_size?: number | undefined };
export type TgPhotoSize = TgFileRef & { width?: number | undefined; height?: number | undefined };
export type TgDocument = TgFileRef & { file_name?: string | undefined; mime_type?: string | undefined };
export type TgAudio = TgDocument & { performer?: string | undefined; title?: string | undefined };
export type TgSticker = TgFileRef & { emoji?: string | undefined };
export type TgLocation = { latitude: number; longitude: number; live_period?: number | undefined };
export type TgContact = { phone_number?: string | undefined; first_name?: string | undefined; last_name?: string | undefined; user_id?: number | undefined };
/** Откуда переслано: пользователь, скрытый пользователь, группа, канал */
export type TgOrigin = {
  type: string;
  sender_user?: TgUser | undefined;
  sender_user_name?: string | undefined;
  sender_chat?: TgChat | undefined;
  chat?: TgChat | undefined;
};

export type TgMessage = {
  message_id: number;
  /** Время отправки — секунды Unix */
  date: number;
  edit_date?: number | undefined;
  chat: TgChat;
  from?: TgUser | undefined;
  sender_chat?: TgChat | undefined;
  forward_origin?: TgOrigin | undefined;
  /** Пересылка в старом виде (до Bot API 7.0) */
  forward_date?: number | undefined;
  reply_to_message?: TgMessage | undefined;
  /** Клиент процитировал часть сообщения */
  quote?: { text?: string | undefined } | undefined;
  text?: string | undefined;
  entities?: TgEntity[] | undefined;
  caption?: string | undefined;
  caption_entities?: TgEntity[] | undefined;
  /** Одно фото в нескольких размерах */
  photo?: TgPhotoSize[] | undefined;
  document?: TgDocument | undefined;
  /** GIF (Telegram переводит их в mp4). Для совместимости у такого сообщения заполнен и document */
  animation?: TgDocument | undefined;
  audio?: TgAudio | undefined;
  video?: TgDocument | undefined;
  /** Видеосообщение — «кружок» */
  video_note?: TgFileRef | undefined;
  voice?: TgDocument | undefined;
  sticker?: TgSticker | undefined;
  location?: TgLocation | undefined;
  /** Место (кафе, адрес): у такого сообщения заполнена и location */
  venue?: { location?: TgLocation | undefined; title?: string | undefined; address?: string | undefined } | undefined;
  contact?: TgContact | undefined;
  dice?: { emoji?: string | undefined; value?: number | undefined } | undefined;
  poll?: { question?: string | undefined; options?: { text?: string | undefined }[] | undefined } | undefined;
  story?: unknown;
  game?: unknown;
  invoice?: unknown;
  paid_media?: unknown;
  checklist?: unknown;
  giveaway?: unknown;
};

/** Смена положения бота в чате. В личном чате: member → kicked — клиент заблокировал бота, kicked → member — разблокировал */
export type TgMemberUpdate = {
  chat: TgChat;
  from?: TgUser | undefined;
  date: number;
  old_chat_member?: { status?: string | undefined } | undefined;
  new_chat_member?: { status?: string | undefined } | undefined;
};

export type TgUpdate = {
  update_id: number;
  message?: TgMessage | undefined;
  edited_message?: TgMessage | undefined;
  my_chat_member?: TgMemberUpdate | undefined;
  [kind: string]: unknown;
};

/* ── Слова служебных строк ─────────────────────────────────────────────────────────────────────────────── */

/** Строки, которые подключение записывает в переписку. Слово «клиент» проект может заменить своим (пациент, кандидат) */
export type TelegramTexts = {
  /** Клиент заблокировал бота */
  blocked: string;
  /** Клиент разблокировал бота */
  unblocked: string;
  /** Клиент изменил текст сообщения; {text} — новый текст */
  edited: string;
  /** Клиент изменил сообщение без текста (заменил вложение) */
  editedMedia: string;
  /** Клиент поделился своим номером; {phone} — номер */
  ownPhone: string;
};

export const TELEGRAM_TEXTS: TelegramTexts = {
  blocked: "Клиент заблокировал бота в Telegram — сообщения ему не дойдут, пока он не разблокирует бота",
  unblocked: "Клиент разблокировал бота в Telegram — сообщения снова доходят",
  edited: "Клиент изменил сообщение: «{text}»",
  editedMedia: "Клиент изменил вложение в сообщении",
  ownPhone: "Клиент поделился своим номером: {phone}",
};

const put = (text: string, vars: Record<string, string>) => text.replace(/\{(\w+)\}/g, (all, k: string) => vars[k] ?? all);

/* ── Ключи и ссылки ────────────────────────────────────────────────────────────────────────────────────── */

/** Ключ повтора сообщения: «tg:<чат>:<номер сообщения>». Отправленные нами сообщения получают тот же вид (SendResult) —
 *  цитата клиента на наше сообщение находит его */
export const tgMessageKey = (chatId: number | string, messageId: number | string): string => `tg:${chatId}:${messageId}`;

/** Номер сообщения из ключа повтора: «tg:<чат>:<номер>» и «tg:<чат>:<номер>:file:0» (вложение того же сообщения) */
export function tgMessageId(externalId: string | null | undefined, chatId?: string | undefined): number | null {
  const m = String(externalId ?? "").match(/^tg:(-?\d+):(\d+)(?::|$)/);
  if (!m || (chatId !== undefined && m[1] !== chatId)) return null;
  const id = Number(m[2]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Ссылка на файл для RemoteFile: подключение скачает его через getFile */
export const tgFileUrl = (fileId: string): string => `tg-file:${fileId}`;

/* ── Разбор сообщения ──────────────────────────────────────────────────────────────────────────────────── */

const fullName = (first?: string | undefined, last?: string | undefined) =>
  [first, last].map((s) => (typeof s === "string" ? s.trim() : "")).filter(Boolean).join(" ");

/** Не длиннее n знаков (эмодзи не режем пополам) */
function clip(s: string, n: number): string {
  const chars = [...s];
  return chars.length > n ? `${chars.slice(0, n - 1).join("").trimEnd()}…` : s;
}

/** Имя файла без путей и служебных знаков, не длиннее 120 знаков (расширение сохраняем) */
function cleanName(raw: string | undefined): string {
  const s = String(raw ?? "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim();
  if (s.length <= 120) return s;
  const ext = fileExt(s);
  return ext ? `${s.slice(0, 119 - ext.length).trimEnd()}.${ext}` : s.slice(0, 120);
}

/** Какие файлы набор сохраняет — то, что узнаёт sniffFile (фото, PDF, Word, Excel, голосовые, видео), и простой текст.
 *  Архивы, программы, старые форматы Office не сохраняются — как во всём наборе */
const KEEP_EXT = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "pdf", "docx", "xlsx", "ogg", "oga", "opus", "mp3", "m4a", "amr", "wav",
  "mp4", "m4v", "mov", "3gp", "webm", "txt", "csv",
]);
const KEEP_MIME = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/heic", "image/heif", "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "audio/ogg", "audio/opus", "audio/mpeg", "audio/mp3", "audio/mp4", "audio/x-m4a", "audio/m4a", "audio/amr", "audio/wav", "audio/x-wav",
  "video/mp4", "video/quicktime", "video/webm", "video/3gpp", "text/plain", "text/csv",
]);

/** Сохранит ли набор файл с таким типом и именем. Есть расширение — решает оно, нет — тип от Telegram */
export function telegramKeepsFile(mime: string | null | undefined, name: string | null | undefined): boolean {
  const ext = fileExt(name);
  if (ext) return KEEP_EXT.has(ext);
  return KEEP_MIME.has(String(mime ?? "").toLowerCase().split(";")[0]!.trim());
}

/** Самый большой размер фото, который помещается в лимит (размер неизвестен — берём) */
function bestPhoto(sizes: readonly TgPhotoSize[], max: number): TgPhotoSize | undefined {
  const area = (s: TgPhotoSize) => (s.width ?? 0) * (s.height ?? 0);
  const all = sizes.filter((s) => !!s && typeof s.file_id === "string" && !!s.file_id)
    .sort((a, b) => area(b) - area(a) || (b.file_size ?? 0) - (a.file_size ?? 0));
  return all.find((s) => !s.file_size || s.file_size <= max) ?? all[0];
}

/** Текст со «скрытыми» ссылками: у слова-ссылки (text_link) адрес дописываем в скобках — иначе он потеряется */
function withLinks(text: string, entities: readonly TgEntity[] | undefined): string {
  const links = (entities ?? [])
    .filter((e) => e?.type === "text_link" && typeof e.url === "string" && /^https?:\/\//i.test(e.url) && e.offset >= 0 && e.offset + e.length <= text.length)
    .sort((a, b) => b.offset + b.length - (a.offset + a.length));
  let out = text;
  // С конца: вставка в скобках не сдвигает места ссылок левее
  for (const e of links) {
    const end = e.offset + e.length;
    if (text.slice(e.offset, end).trim() === e.url) continue;
    out = `${out.slice(0, end)} (${e.url})${out.slice(end)}`;
  }
  return out;
}

/** Координата — до 6 знаков после точки (около 10 см), без лишних нулей */
const coord = (x: number) => String(Number(x.toFixed(6)));
const validPlace = (l: TgLocation | undefined): l is TgLocation => !!l && Number.isFinite(l.latitude) && Number.isFinite(l.longitude);
const mapLink = (l: TgLocation) => `https://maps.google.com/?q=${coord(l.latitude)},${coord(l.longitude)}`;

/** Номер из Telegram — всегда международный, но иногда без «+»: «996555000001» → «+996555000001» */
function intlPhone(raw: string | undefined): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  return normalizePhone(s.startsWith("+") ? s : `+${s}`);
}

/** Пересланное: от кого (имя, название группы или канала); "" — имя скрыто; null — сообщение не пересланное */
function forwardedFrom(m: TgMessage): string | null {
  const o = m.forward_origin;
  if (!o || typeof o !== "object") return m.forward_date ? "" : null;
  if (o.type === "user") return fullName(o.sender_user?.first_name, o.sender_user?.last_name);
  if (o.type === "hidden_user") return String(o.sender_user_name ?? "").trim();
  if (o.type === "chat") return String(o.sender_chat?.title ?? "").trim();
  if (o.type === "channel") return String(o.chat?.title ?? "").trim();
  return "";
}

/** «/start» и «/start метка» — клиент нажал «Старт» (метка — из ссылки t.me/бот?start=метка: откуда пришёл клиент) */
const START_RE = /^\/start(?:@\w+)?(?:\s+(\S{1,64}))?\s*$/;

/** Что Telegram умеет, а переписка не покажет: назовём словами */
const UNSHOWN: readonly (readonly ["story" | "game" | "invoice" | "paid_media" | "checklist" | "giveaway", string])[] = [
  ["story", "История Telegram"], ["game", "Игра Telegram"], ["invoice", "Счёт на оплату в Telegram"], ["paid_media", "Платное вложение Telegram"],
  ["checklist", "Список задач Telegram"], ["giveaway", "Розыгрыш Telegram"],
];

export type TelegramContent = {
  /** Текст сообщения: текст или подпись клиента, геопозиция, контакт, строки о несохранённых файлах */
  text: string;
  /** Файлы — скачать после ответа Telegram */
  files: RemoteFile[];
  /** Вложения словами («Фото», «Голосовое сообщение») — для цитаты */
  words: string[];
  /** Номер, которым клиент поделился сам (кнопка «Поделиться номером»), — подлинный */
  ownPhone: string | null;
};

/** Содержимое сообщения. null — в сообщении ничего для переписки (служебное: закреп, платёж, вход в группу) */
export function telegramContent(m: TgMessage, maxFileBytes: number = MAX_FILE_BYTES, texts: TelegramTexts = TELEGRAM_TEXTS): TelegramContent | null {
  const lines: string[] = [];
  const notes: string[] = [];
  const files: RemoteFile[] = [];
  const words: string[] = [];
  let ownPhone: string | null = null;

  /** Файл: в очередь на скачивание — или строка, почему не сохраняем. check — тип и имя для проверки (у фото,
   *  голосовых и «кружков» Telegram сам выбирает формат — их не проверяем) */
  const file = (ref: TgFileRef | undefined, what: string, caption: string | null, check?: { mime?: string | undefined; name?: string | undefined }) => {
    if (!ref || typeof ref.file_id !== "string" || !ref.file_id) return;
    words.push(what);
    if (check && !telegramKeepsFile(check.mime, check.name)) {
      notes.push(`${what}: такой вид файлов в CRM не сохраняется`);
      return;
    }
    if (typeof ref.file_size === "number" && ref.file_size > maxFileBytes) {
      notes.push(`${what} (${fmtSize(ref.file_size)}): в CRM сохраняются файлы до ${fmtSize(maxFileBytes)}`);
      return;
    }
    files.push({ urls: [tgFileUrl(ref.file_id)], caption });
  };

  const forwarded = forwardedFrom(m);
  if (forwarded !== null) lines.push(forwarded ? `Переслано от ${forwarded}:` : "Переслано:");

  const start = typeof m.text === "string" ? START_RE.exec(m.text) : null;
  if (start) lines.push(start[1] ? `Нажата кнопка «Старт» (метка ссылки: ${start[1]})` : "Нажата кнопка «Старт»");
  else if (typeof m.text === "string") lines.push(withLinks(m.text, m.entities));
  else if (typeof m.caption === "string") lines.push(withLinks(m.caption, m.caption_entities));

  if (Array.isArray(m.photo) && m.photo.length) file(bestPhoto(m.photo, maxFileBytes), "Фото", null);
  // У GIF заполнен и document — второй раз не берём
  if (m.animation) file(m.animation, "GIF-анимация", "GIF-анимация", { mime: m.animation.mime_type, name: cleanName(m.animation.file_name) });
  else if (m.document) {
    const name = cleanName(m.document.file_name);
    file(m.document, name ? `Файл «${name}»` : "Файл", name || null, { mime: m.document.mime_type, name });
  }
  if (m.audio) {
    const own = cleanName(m.audio.file_name);
    const name = own || cleanName([m.audio.performer, m.audio.title].map((s) => String(s ?? "").trim()).filter(Boolean).join(" — "));
    file(m.audio, name ? `Аудиофайл «${name}»` : "Аудиофайл", name || "Аудиофайл", { mime: m.audio.mime_type, name: own });
  }
  if (m.video) file(m.video, "Видео", null, { mime: m.video.mime_type, name: cleanName(m.video.file_name) });
  if (m.video_note) file(m.video_note, "Видеосообщение", "Видеосообщение");
  if (m.voice) file(m.voice, "Голосовое сообщение", null);

  // Стикер — словами и его эмодзи (картинку не качаем: анимированные стикеры — не картинка)
  if (m.sticker) {
    const s = `Стикер${m.sticker.emoji ? ` ${m.sticker.emoji}` : ""}`;
    lines.push(s);
    words.push(s);
  }
  const venue = m.venue;
  if (venue && validPlace(venue.location)) {
    const title = [venue.title, venue.address].map((s) => String(s ?? "").trim()).filter(Boolean).join(", ");
    lines.push(`Место: ${title ? `${title} — ` : ""}${mapLink(venue.location)}`);
    words.push("Место");
  } else if (validPlace(m.location)) {
    const l = m.location;
    lines.push(`Геопозиция${l.live_period ? " (трансляция)" : ""}: ${coord(l.latitude)}, ${coord(l.longitude)} — ${mapLink(l)}`);
    words.push("Геопозиция");
  }
  if (m.contact) {
    const c = m.contact;
    const phone = intlPhone(c.phone_number);
    // Свой номер: контакт того же человека, что пишет, и не пересланный. Такой номер Telegram подставляет сам
    // (кнопка «Поделиться номером»), назвать чужой так нельзя — поэтому он подлинный
    const own = !!phone && !!m.from && c.user_id === m.from.id && forwarded === null;
    if (own) {
      ownPhone = phone;
      lines.push(put(texts.ownPhone, { phone: fmtPhone(phone) }));
    } else {
      const shown = phone ? fmtPhone(phone) : String(c.phone_number ?? "").trim();
      lines.push(`Контакт: ${[fullName(c.first_name, c.last_name), shown].filter(Boolean).join(", ") || "без номера"}`);
    }
    words.push("Контакт");
  }
  if (m.dice) lines.push(`Бросок ${m.dice.emoji || "🎲"}: ${m.dice.value ?? "?"}`);
  if (m.poll) {
    const options = (m.poll.options ?? []).map((x) => String(x?.text ?? "").trim()).filter(Boolean).join(" / ");
    lines.push(`Опрос: ${String(m.poll.question ?? "").trim() || "без вопроса"}${options ? ` (варианты: ${options})` : ""}`);
  }
  for (const [key, label] of UNSHOWN) if (m[key] !== undefined && m[key] !== null) lines.push(`${label} — в CRM не показывается`);
  lines.push(...notes);

  const text = lines.filter((l) => l.trim()).join("\n");
  // Только «Переслано:» без содержимого — служебное (переслать можно лишь то, что уже разобрали выше)
  if (!files.length && (!text || (forwarded !== null && lines.length === 1))) return null;
  return { text, files, words, ownPhone };
}

/* ── Update → события ──────────────────────────────────────────────────────────────────────────────────── */

export type TelegramParseOptions = {
  /** Только личные чаты с ботом (по умолчанию да): сообщения групп пропускаются. Каналы не принимаются никогда */
  privateOnly?: boolean | undefined;
  /** Файлы больше этого не качаем — в тексте сообщения остаётся строка (по умолчанию 10 МБ) */
  maxFileBytes?: number | undefined;
  /** Свои слова служебных строк (например, «Пациент заблокировал бота…») */
  texts?: Partial<TelegramTexts> | undefined;
};

const isMessage = (m: unknown): m is TgMessage => {
  const x = m as TgMessage | null;
  return !!x && typeof x === "object" && typeof x.message_id === "number" && !!x.chat && typeof x.chat.id === "number" && typeof x.chat.type === "string";
};

const isoFromUnix = (sec: unknown): string | null =>
  typeof sec === "number" && Number.isFinite(sec) && sec > 0 && sec < 1e11 ? new Date(sec * 1000).toISOString() : null;

/** Клиент: чат с ботом. В личном чате — имя и ник человека, в группе (privateOnly: false) — название группы */
function hintOf(chat: TgChat, from: TgUser | undefined, phone: string | null): ContactHint {
  const own = chat.type === "private";
  const name = own ? fullName(chat.first_name, chat.last_name) || fullName(from?.first_name, from?.last_name) : String(chat.title ?? "").trim();
  const username = (own ? chat.username ?? from?.username : chat.username) ?? null;
  return {
    source: "telegram", externalId: String(chat.id), channel: "telegram", name: name || null, username,
    ...(phone ? { phone, phoneTrusted: true } : {}),
  };
}

/** Автор: клиент. В группе ещё и имя участника, который написал */
function authorOf(m: TgMessage): Author {
  if (m.chat.type === "private") return { type: "client" };
  const name = m.from ? fullName(m.from.first_name, m.from.last_name) || (m.from.username ? `@${m.from.username}` : "") : String(m.sender_chat?.title ?? "").trim();
  return { type: "client", name: name || null };
}

/** Ответ на сообщение: его ключ и начало текста (процитированная часть, текст, подпись или вложение словами) */
function replyOf(m: TgMessage): IncomingMessage["replyTo"] {
  const r = m.reply_to_message;
  if (!r || typeof r !== "object" || typeof r.message_id !== "number") return null;
  const quoted = typeof m.quote?.text === "string" ? m.quote.text.trim() : "";
  const c = quoted ? null : telegramContent({ ...r, chat: r.chat ?? m.chat }, Number.POSITIVE_INFINITY);
  const text = quoted || c?.text.trim() || c?.words.join(", ") || "";
  const chatId = typeof r.chat?.id === "number" ? r.chat.id : m.chat.id;
  return { externalId: tgMessageKey(chatId, r.message_id), text: text ? clip(text, 300) : null };
}

/** Уведомление Telegram → события набора. Пропущенное — ok: false, ignored, статус 200 (иначе Telegram повторит его) */
export function telegramUpdateEvents(u: TgUpdate, o: TelegramParseOptions = {}): ReceiveResult {
  const privateOnly = o.privateOnly ?? true;
  const max = o.maxFileBytes ?? MAX_FILE_BYTES;
  const texts: TelegramTexts = { ...TELEGRAM_TEXTS, ...o.texts };
  const kind = Object.keys(u).find((k) => k !== "update_id") ?? "unknown";
  const meta = { updateId: u.update_id, kind };
  const skip = (error: string): ReceiveResult => ({ ok: false, status: 200, ignored: true, error, meta });
  const chatOk = (m: TgMessage) => (privateOnly ? m.chat.type === "private" : m.chat.type !== "channel");

  if (u.message !== undefined) {
    const m = u.message;
    if (!isMessage(m)) return skip("Сообщение Telegram без чата или номера — пропущено");
    if (!chatOk(m)) return skip("Сообщение не из личного чата с ботом — пропущено");
    const c = telegramContent(m, max, texts);
    if (!c) return skip("Служебное сообщение Telegram — в переписку не попадает");
    const message: IncomingMessage = {
      externalId: tgMessageKey(m.chat.id, m.message_id), at: isoFromUnix(m.date), author: authorOf(m), text: c.text, files: c.files, replyTo: replyOf(m),
    };
    return { ok: true, meta, events: [{ type: "message", contact: hintOf(m.chat, m.from, c.ownPhone), message }] };
  }

  if (u.edited_message !== undefined) {
    const m = u.edited_message;
    if (!isMessage(m)) return skip("Правка сообщения Telegram без чата или номера — пропущена");
    if (!chatOk(m)) return skip("Правка не из личного чата с ботом — пропущена");
    if (m.location || m.venue) return skip("Трансляция геопозиции обновилась — в переписку не пишем");
    const body = (typeof m.text === "string" ? withLinks(m.text, m.entities) : typeof m.caption === "string" ? withLinks(m.caption, m.caption_entities) : "").trim();
    return {
      ok: true, meta,
      events: [{
        type: "notice", contact: hintOf(m.chat, m.from, null),
        // Одна строка на каждую правку: повтор того же уведомления её не задвоит, следующая правка — новая строка
        key: `${tgMessageKey(m.chat.id, m.message_id)}:edit:${m.edit_date ?? m.date}`,
        text: body ? put(texts.edited, { text: body }) : texts.editedMedia,
      }],
    };
  }

  if (u.my_chat_member !== undefined) {
    const x = u.my_chat_member;
    if (!x || typeof x !== "object" || !x.chat || typeof x.chat.id !== "number") return skip("Смена участника без чата — пропущена");
    if (x.chat.type !== "private") return skip("Бота добавили в группу или убрали из неё — переписке не нужно");
    const was = x.old_chat_member?.status;
    const now = x.new_chat_member?.status;
    const blocked = now === "kicked" && was !== "kicked";
    const unblocked = was === "kicked" && now !== "kicked";
    if (!blocked && !unblocked) return skip("Положение бота в чате не изменилось — пропущено");
    return {
      ok: true, meta,
      events: [{
        type: "notice", contact: hintOf(x.chat, x.from, null),
        key: `tg:${x.chat.id}:${blocked ? "blocked" : "unblocked"}:${x.date}`,
        text: blocked ? texts.blocked : texts.unblocked,
      }],
    };
  }

  return skip(`Уведомление Telegram «${kind}» переписке не нужно — пропущено`);
}
