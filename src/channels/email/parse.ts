import type { Delivery } from "../../core/model.js";
import type { ChannelEvent } from "../../server/channel.js";
import { sha1Hex } from "../../server/crypto.js";
import { decodeMimeWords } from "./text.js";

/* Входящее письмо — из вебхука Postmark (Inbound) или из универсального JSON набора (любой мост: Cloudflare Email
   Worker, свой опрос ящика по IMAP). Оба вида приводятся к одному (ParsedMail); какой пришёл — видно по полям.

   Универсальный JSON (все поля, кроме from, — по желанию):
     { "from": { "email": "client@example.com", "name": "Клиент Тест" },   // или строкой «Клиент Тест <client@example.com>»
       "to": ["hello@company.example"], "subject": "Вопрос", "text": "…", "html": "<p>…</p>",
       "messageId": "<abc@mail.example>", "inReplyTo": "<…>", "references": ["<…>"], "date": "2026-09-27T08:00:00Z",
       "headers": { "auto-submitted": "auto-replied" },
       "attachments": [{ "name": "Договор.pdf", "mime": "application/pdf", "contentBase64": "JVBERi0…" },
                       { "name": "Фото.jpg", "mime": "image/jpeg", "url": "https://files.example/1.jpg" }] }
   Статус нашего письма тем же адресом: { "event": "status", "messageId": "<…>", "status": "delivered", "error": "…" }. */

/** Адрес почты и имя */
export type MailAddress = { email: string; name?: string | null | undefined };

/** Вложение входящего письма: содержимое base64 (Postmark, мост) или ссылка (мост) */
export type MailPart = {
  name: string;
  mime: string;
  /** Содержимое base64 */
  content?: string | undefined;
  /** Ссылка на файл (универсальный JSON) */
  url?: string | undefined;
  /** Картинка внутри письма: её номер (cid:…) в HTML */
  contentId?: string | null | undefined;
  /** Размер в байтах, если известен */
  size?: number | null | undefined;
};

/** Входящее письмо в одном виде */
export type ParsedMail = {
  format: "postmark" | "json";
  from: MailAddress | null;
  to: string[];
  subject: string;
  /** Текст письма (text/plain) целиком */
  text: string;
  html: string;
  /** Ответ без цитаты, который уже вырезал почтовый сервис (Postmark StrippedTextReply — только английский) */
  strippedReply: string | null;
  /** Номер письма (заголовок Message-ID) без угловых скобок */
  messageId: string | null;
  /** На какое письмо это ответ (In-Reply-To) */
  inReplyTo: string | null;
  /** Цепочка (References) — от первого письма к последнему */
  references: string[];
  /** Когда отправлено (ISO) — из заголовка Date */
  date: string | null;
  /** Заголовки: имя маленькими буквами → значение */
  headers: Record<string, string>;
  attachments: MailPart[];
  /** Номер письма у почтового сервиса (Postmark MessageID) */
  providerId?: string | null | undefined;
};

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d{1,12}$/.test(v) ? Number(v) : null;
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(obj).filter((x): x is Record<string, unknown> => !!x) : []);

/* ── Адреса ──────────────────────────────────────────────────────────────────────────────────────────────── */

const EMAIL = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\].]{2,}$/;

/** Адрес почты маленькими буквами — или null, если на адрес не похоже */
export function normalizeEmail(v: string | null | undefined): string | null {
  const e = String(v ?? "").trim().replace(/^mailto:/i, "").replace(/^<|>$/g, "").toLowerCase();
  return e.length <= 254 && EMAIL.test(e) ? e : null;
}

function cleanName(raw: string, email: string): string | null {
  const n = decodeMimeWords(raw.slice(0, 1000)).replace(/\\(["\\])/g, "$1").replace(/^[\s"']+|[\s"']+$/g, "").replace(/\s+/g, " ").trim().slice(0, 100);
  return n && n.toLowerCase() !== email ? n : null;
}

/** «"Клиент Тест" <client@example.com>», «client@example.com (Клиент Тест)», { email | Email | address, name } → адрес и имя */
export function parseAddress(v: unknown): MailAddress | null {
  const o = obj(v);
  if (o) {
    const email = normalizeEmail(str(o.email) || str(o.Email) || str(o.address) || str(o.Address));
    return email ? { email, name: cleanName(str(o.name) || str(o.Name), email) } : null;
  }
  // Адрес с именем длиннее тысячи знаков не бывает — дальше не читаем
  const s = decodeMimeWords(str(v).slice(0, 1000)).trim();
  if (!s) return null;
  const angle = s.match(/^(.*?)<([^<>]+)>\s*$/);
  if (angle) {
    const email = normalizeEmail(angle[2]);
    return email ? { email, name: cleanName(angle[1] ?? "", email) } : null;
  }
  const paren = s.match(/^(\S+@\S+)\s*\((.*)\)\s*$/);
  if (paren) {
    const email = normalizeEmail(paren[1]);
    return email ? { email, name: cleanName(paren[2] ?? "", email) } : null;
  }
  const email = normalizeEmail(s);
  return email ? { email, name: null } : null;
}

/** Запятые вне кавычек и угловых скобок: «"Иванов, Иван" <a@example.com>, b@example.com» — два адреса */
function splitAddresses(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let angle = false;
  for (const ch of s) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "<" && !quoted) angle = true;
    else if (ch === ">" && !quoted) angle = false;
    if ((ch === "," || ch === ";") && !quoted && !angle) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** Адреса получателей: строкой через запятую или массивом (строк или { email, name }) */
export function parseAddressList(v: unknown): string[] {
  const items: unknown[] = Array.isArray(v) ? v : typeof v === "string" ? splitAddresses(v.slice(0, 20_000)) : v ? [v] : [];
  return items.slice(0, 100).map(parseAddress).filter((a): a is MailAddress => !!a).map((a) => a.email);
}

/** Адрес для заголовка From: «Компания <hello@company.example>»; имя со знаками препинания — в кавычках */
export function formatAddress(a: MailAddress): string {
  const name = String(a.name ?? "").replace(/[\r\n]+/g, " ").trim();
  if (!name) return a.email;
  return /[",;:<>@()[\]\\]/.test(name) ? `"${name.replace(/(["\\])/g, "\\$1")}" <${a.email}>` : `${name} <${a.email}>`;
}

/* ── Номера писем и время ─────────────────────────────────────────────────────────────────────────────────── */

/** Номер письма без угловых скобок: «<abc@mail.example>» → «abc@mail.example» */
export function cleanMessageId(v: string | null | undefined): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const m = s.match(/<([^<>\s]+)>/);
  const id = (m?.[1] ?? s.split(/\s+/)[0] ?? "").replace(/^<|>$/g, "");
  return id ? id.slice(0, 998) : null;
}

/** Все номера из In-Reply-To и References: «<a@x> <b@y>» → [a@x, b@y] */
export function messageIds(v: string | null | undefined): string[] {
  const s = String(v ?? "");
  const inAngles = [...s.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1] ?? "").filter(Boolean);
  return inAngles.length ? inAngles : s.split(/[\s,]+/).map((x) => x.trim()).filter((x) => x.includes("@"));
}

/** Ключ повтора письма у набора: «mail:<номер письма>». Слишком длинный номер — отпечатком (в базе ключ — строка) */
export function mailKey(messageId: string): string {
  const id = cleanMessageId(messageId) ?? messageId;
  return `mail:${id.length > 250 ? `${sha1Hex(id)}@long-message-id.invalid` : id}`;
}

/** Номер письма по ключу повтора («mail:…») — для заголовков In-Reply-To и References ответа. Ключ-отпечаток — null */
export function messageIdFromKey(key: string | null | undefined): string | null {
  const k = String(key ?? "").trim();
  return k.startsWith("mail:") && k.length > 5 && !k.endsWith(".invalid") ? k.slice(5) : null;
}

const ZONES: Readonly<Record<string, string>> = {
  UT: "+0000", UTC: "+0000", GMT: "+0000", Z: "+0000", EST: "-0500", EDT: "-0400", CST: "-0600", CDT: "-0500",
  MST: "-0700", MDT: "-0600", PST: "-0800", PDT: "-0700", MSK: "+0300",
};

/** Время письма: заголовок Date («Sat, 27 Sep 2026 14:00:00 +0600 (+06)») или ISO → ISO; непонятное — null */
export function parseMailDate(v: string | null | undefined): string | null {
  // Заголовок Date короткий: дальше двухсот знаков не читаем
  const s = String(v ?? "")
    .slice(0, 200)
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s(UT|UTC|GMT|Z|EST|EDT|CST|CDT|MST|MDT|PST|PDT|MSK)$/i, (m, z: string) => ` ${ZONES[z.toUpperCase()] ?? z}`);
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/* ── Заголовки ────────────────────────────────────────────────────────────────────────────────────────────── */

/** Заголовки: [{ Name, Value }] (Postmark), [{ key | name, value }] (мосты), { имя: значение } → имя маленькими буквами →
 *  значение (первое, если имя повторяется) */
export function headerMap(v: unknown): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  const put = (k: unknown, val: unknown) => {
    const name = str(k).trim().toLowerCase();
    const value = Array.isArray(val) ? val.map(str).join(", ") : typeof val === "number" ? String(val) : str(val);
    if (name && !(name in out)) out[name] = value;
  };
  if (Array.isArray(v)) {
    for (const h of list(v)) put(h.Name ?? h.name ?? h.key ?? h.Key, h.Value ?? h.value);
  } else {
    const o = obj(v);
    if (o) for (const [k, val] of Object.entries(o)) put(k, val);
  }
  return out;
}

/* ── Postmark ─────────────────────────────────────────────────────────────────────────────────────────────── */

/** Похоже на вебхук Postmark Inbound */
export function isPostmarkInbound(b: Record<string, unknown>): boolean {
  return !!obj(b.FromFull) || (typeof b.From === "string" && ("TextBody" in b || "HtmlBody" in b || "MessageID" in b));
}

/** Вебхук Postmark Inbound → письмо. Номер письма — из заголовка Message-ID (на него ссылаются ответы), без него — номер
 *  Postmark (он один и тот же при повторной доставке вебхука) */
export function parsePostmarkInbound(b: Record<string, unknown>): ParsedMail {
  const headers = headerMap(b.Headers);
  const full = obj(b.FromFull);
  const from = parseAddress(full && str(full.Email) ? { email: str(full.Email), name: str(full.Name) || str(b.FromName) } : b.From);
  return {
    format: "postmark",
    from,
    to: parseAddressList(Array.isArray(b.ToFull) ? b.ToFull : b.To),
    subject: str(b.Subject),
    text: str(b.TextBody),
    html: str(b.HtmlBody),
    strippedReply: str(b.StrippedTextReply).trim() || null,
    messageId: cleanMessageId(headers["message-id"]) ?? cleanMessageId(str(b.MessageID)),
    inReplyTo: messageIds(headers["in-reply-to"])[0] ?? null,
    references: messageIds(headers["references"]),
    date: parseMailDate(str(b.Date) || headers["date"]),
    headers,
    attachments: list(b.Attachments).map((a) => ({
      name: str(a.Name), mime: str(a.ContentType), content: str(a.Content) || undefined, contentId: str(a.ContentID) || null, size: num(a.ContentLength),
    })),
    providerId: str(b.MessageID) || null,
  };
}

/* ── Универсальный JSON ───────────────────────────────────────────────────────────────────────────────────── */

/** Похоже на письмо в универсальном JSON: есть отправитель from */
export function isJsonMail(b: Record<string, unknown>): boolean {
  return b.from !== undefined && b.from !== null && b.event !== "status";
}

export function parseJsonMail(b: Record<string, unknown>): ParsedMail {
  const headers = headerMap(b.headers);
  const refs = Array.isArray(b.references) ? b.references.flatMap((r) => messageIds(str(r))) : messageIds(str(b.references) || headers["references"]);
  return {
    format: "json",
    from: parseAddress(b.from),
    to: parseAddressList(b.to),
    subject: decodeMimeWords((str(b.subject) || headers["subject"] || "").slice(0, 2000)),
    text: str(b.text),
    html: str(b.html),
    strippedReply: null,
    messageId: cleanMessageId(str(b.messageId) || headers["message-id"]),
    inReplyTo: messageIds(str(b.inReplyTo) || headers["in-reply-to"])[0] ?? null,
    references: refs,
    date: parseMailDate(str(b.date) || headers["date"]),
    headers,
    attachments: list(b.attachments).map((a) => ({
      name: decodeMimeWords(str(a.name) || str(a.filename)),
      mime: str(a.mime) || str(a.contentType) || str(a.mimeType),
      content: str(a.contentBase64) || undefined,
      url: str(a.url) || undefined,
      contentId: str(a.contentId) || null,
      size: num(a.size),
    })),
  };
}

/** Статус в универсальном JSON: { "event": "status", "messageId": "<…>", "status": "delivered" } */
export function isJsonStatus(b: Record<string, unknown>): boolean {
  return b.event === "status";
}

const JSON_STATUS: Readonly<Record<string, Delivery>> = {
  sent: "sent", delivered: "delivered", read: "read", opened: "read", failed: "failed", bounced: "failed",
};

/** Статус письма от моста: sent / delivered / read / failed (с причиной) → событие набора */
export function jsonStatusEvents(b: Record<string, unknown>): ChannelEvent[] {
  const id = cleanMessageId(str(b.messageId));
  const key = str(b.status).trim().toLowerCase();
  const delivery = Object.hasOwn(JSON_STATUS, key) ? JSON_STATUS[key] : undefined;
  if (!id || !delivery) return [];
  const error = delivery === "failed" ? str(b.error).trim().slice(0, 300) || "Письмо не доставлено" : null;
  return [{ type: "status", externalId: mailKey(id), delivery, error }];
}

/* ── Не письмо клиента ────────────────────────────────────────────────────────────────────────────────────── */

const AUTO_SUBJECT = /^(?:auto(?:matic)?[ -]?reply|autoreply|out of (?:the )?office|автоответ|автоматический ответ|undeliver(?:ed|able)|delivery status notification|mail delivery (?:failed|failure|system|subsystem)|returned mail|failure notice|недоставленное|не доставлено|сообщение не доставлено)/iu;

/** Автоответ, отчёт о недоставке, рассылка — не письмо клиента: причина словами или null */
export function autoReplyReason(m: ParsedMail): string | null {
  const h = m.headers;
  const auto = (h["auto-submitted"] ?? "").trim().toLowerCase();
  if (auto && auto !== "no") return "Автоответ почты (Auto-Submitted) — в переписку не добавляем";
  if (h["x-autoreply"] !== undefined || h["x-autorespond"] !== undefined || h["x-autoresponse"] !== undefined) return "Автоответ почты — в переписку не добавляем";
  const precedence = (h["precedence"] ?? "").trim().toLowerCase();
  if (["bulk", "junk", "list", "auto_reply", "auto-reply"].includes(precedence)) return `Рассылка или автоответ (Precedence: ${precedence}) — в переписку не добавляем`;
  if (h["list-id"] !== undefined || h["list-unsubscribe"] !== undefined) return "Рассылка (письмо со ссылкой «отписаться») — в переписку не добавляем";
  const local = m.from?.email.split("@")[0] ?? "";
  if (
    h["x-failed-recipients"] !== undefined || /multipart\/report/i.test(h["content-type"] ?? "") || (h["return-path"] ?? "").trim() === "<>"
    || /^(?:mailer-daemon|postmaster)$/i.test(local)
  ) return "Отчёт почтового сервера о недоставке — в переписку не добавляем";
  if (AUTO_SUBJECT.test(m.subject.trim())) return "Автоответ или отчёт о недоставке (по теме письма) — в переписку не добавляем";
  return null;
}

/** Почтовый сервис пометил письмо как спам (X-Spam-Status: Yes, X-Spam-Flag: YES) */
export function isSpam(m: ParsedMail): boolean {
  return /^\s*yes\b/i.test(m.headers["x-spam-status"] ?? "") || /^\s*yes\b/i.test(m.headers["x-spam-flag"] ?? "");
}
