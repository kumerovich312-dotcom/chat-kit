import { readFile, stat } from "node:fs/promises";
import { mimeFromName } from "../../core/files.js";
import { formatForChannel } from "../../core/markup.js";
import type { ChannelAdapter, ChannelCaps, ChannelEvent, DownloadResult, IncomingMessage, Outgoing, ReceiveResult, RemoteFile, SendResult, Target, WebhookInput } from "../../server/channel.js";
import { safeEqual, sha1Hex, sha256Hex } from "../../server/crypto.js";
import { fetchFile, MAX_FILE_BYTES } from "../../server/download.js";
import { bearerKey } from "../../server/request.js";
import type { ContactHint } from "../../server/store.js";
import { base64Bytes, decodeBase64, downloadDataUrl, mailFileType, safeFileName, sizeWords, toDataUrl } from "./files.js";
import {
  autoReplyReason, formatAddress, isJsonMail, isJsonStatus, isPostmarkInbound, isSpam, jsonStatusEvents, mailKey, messageIdFromKey,
  normalizeEmail, parseAddress, parseJsonMail, parsePostmarkInbound, type MailAddress, type ParsedMail,
} from "./parse.js";
import { isPostmarkStatus, postmarkStatusEvents } from "./postmark.js";
import { mailSendFailure, newMessageId, type MailAttachment, type MailSender, type OutgoingMail } from "./send.js";
import { clip, DEFAULT_SUBJECT, htmlToText, isForwardSubject, mailHtml, splitReply } from "./text.js";

/* Подключение «почта»: письма клиентов попадают в ту же ленту переписки, ответы уходят письмом в ту же цепочку.

   Почта → CRM: вебхук почтового сервиса или моста. Понимаем два вида JSON — вебхук Postmark Inbound и универсальный
   JSON набора (его шлёт любой мост: Cloudflare Email Worker, свой опрос ящика по IMAP); какой пришёл — видно по полям.
   Ключ приёма — в заголовке «Authorization: Bearer …», паролем Basic-входа (Postmark: https://любое-имя:ключ@адрес)
   или в адресе (?token=…). Письмо с вложениями в вебхуке тяжёлое — readWebhook с EMAIL_WEBHOOK_MAX_BYTES.

   Из письма в ленту идёт только ответ клиента: прошлая переписка, подпись и «Отправлено с iPhone» отрезаются
   (Postmark сам вырезает ответ только у английских писем — остальное делает text.ts). Письмо только в HTML — читаемым
   текстом. Автоответы, отчёты о недоставке, рассылки, спам и письма с наших же адресов в переписку не попадают.

   CRM → почта: набор собирает письмо (тема «Re: …», текст и HTML, номер письма, заголовки цепочки In-Reply-To и
   References, файл), а отправляет проект — своей SMTP-библиотекой или готовым postmarkSender. Номер письма в ответе
   (externalId «mail:<номер>») проект сохраняет у сообщения: по нему придут статусы доставки и лягут ответы клиента. */

/** Тело вебхука с письмом: Postmark принимает до 35 МБ вложений, в base64 это около 47 МБ */
export const EMAIL_WEBHOOK_MAX_BYTES = 50 * 1024 * 1024;
/** Больше стольких вложений из одного письма не сохраняем */
const MAX_PARTS = 20;
/** Ответ клиента длиннее — обрезаем (в ленте нужен ответ, а не многостраничное письмо) */
const MAX_TEXT = 20_000;
/** Электронная подпись письма (S/MIME, PGP) — не файл клиента: пропускаем молча */
const SIGNATURE_TYPES = new Set(["application/pkcs7-signature", "application/x-pkcs7-signature", "application/pgp-signature"]);

export const EMAIL_CAPS: ChannelCaps = { text: true, files: true, pause: false, mute: false, start: true, statuses: true };

export type EmailOptions = {
  /** Ключ приёма писем (из окружения проекта): вебхук присылает его заголовком Authorization: Bearer, паролем
   *  Basic-входа или ?token= в адресе */
  inboundToken: string;
  /** С какого адреса уходят ответы: «Компания <hello@company.example>» или { email, name } */
  from: string | MailAddress;
  /** Отправить письмо: SMTP-библиотекой проекта или postmarkSender(…). Без него — только приём */
  send?: MailSender | undefined;
  /** Адрес для ответов клиента (Reply-To), если письма принимает другой адрес, чем тот, с которого они уходят */
  replyToAddress?: string | undefined;
  /** Домен номеров писем (Message-ID); по умолчанию — домен адреса from */
  domain?: string | undefined;
  /** Тема, если проект не передал тему (Outgoing.subject) */
  defaultSubject?: string | undefined;
  /** Ещё свои адреса или домены («@company.example»): письма с них — не клиенты (копии наших писем, коллеги) */
  ownAddresses?: readonly string[] | undefined;
  /** Файл больше этого не сохраняем и не отправляем (по умолчанию 10 МБ) */
  maxFileBytes?: number | undefined;
  /** Картинки внутри письма (логотипы в подписи) меньше этого не сохраняем; 0 — сохранять все (по умолчанию 4 КБ) */
  skipInlineBelow?: number | undefined;
  /** Принимать письма, которые почтовый сервис пометил как спам (по умолчанию — нет) */
  acceptSpam?: boolean | undefined;
  /** С каких адресов можно скачивать вложения-ссылки универсального JSON; по умолчанию — любые публичные */
  allowHost?: ((host: string) => boolean) | undefined;
  fetch?: typeof fetch | undefined;
  now?: (() => number) | undefined;
};

export type EmailAdapter = ChannelAdapter & {
  download(url: string): Promise<DownloadResult>;
  /** Собрать письмо, не отправляя: что получит отправитель проекта (проверки, предпросмотр) */
  compose(to: Target, out: Outgoing): Promise<OutgoingMail | { error: string }>;
};

/** Ключ приёма из запроса: Bearer (или X-Api-Key), пароль Basic-входа, ?token= в адресе. Сравнение — за одно и то же
 *  время (отпечатки одинаковой длины) */
export function emailWebhookAuthorized(input: WebhookInput, token: string): boolean {
  if (!token) return false;
  const given: string[] = [];
  const bearer = bearerKey(input.headers);
  if (bearer) given.push(bearer);
  const auth = (input.headers["authorization"] ?? input.headers["Authorization"] ?? "").trim();
  const basic = auth.match(/^Basic\s+([A-Za-z0-9+/=_-]+)$/i)?.[1];
  const pair = basic ? decodeBase64(basic) : null;
  if (pair) {
    const s = new TextDecoder().decode(pair);
    const colon = s.indexOf(":");
    if (colon >= 0) given.push(s.slice(colon + 1));
  }
  if (input.url) {
    try {
      const q = new URL(input.url, "http://localhost").searchParams.get("token");
      if (q) given.push(q);
    } catch { /* адрес без ключа */ }
  }
  const want = sha256Hex(token);
  return given.some((g) => safeEqual(sha256Hex(g), want));
}

export function createEmailAdapter(o: EmailOptions): EmailAdapter {
  const now = o.now ?? Date.now;
  const doFetch = o.fetch ?? fetch;
  const maxBytes = o.maxFileBytes ?? MAX_FILE_BYTES;
  const inlineBelow = o.skipInlineBelow ?? 4096;
  const from = typeof o.from === "string" ? parseAddress(o.from) : parseAddress({ email: o.from.email, name: o.from.name ?? "" });
  const replyTo = o.replyToAddress ? parseAddress(o.replyToAddress) : null;
  const ownEmails = new Set([from?.email, replyTo?.email].filter((x): x is string => !!x));
  const ownDomains = new Set<string>();
  for (const a of o.ownAddresses ?? []) {
    const s = a.trim().toLowerCase();
    if (s.startsWith("@")) ownDomains.add(s.slice(1));
    else {
      const e = normalizeEmail(s);
      if (e) ownEmails.add(e);
    }
  }
  const isOwn = (email: string) => ownEmails.has(email) || ownDomains.has(email.split("@")[1] ?? "");
  const ignored = (error: string): ReceiveResult => ({ ok: false, status: 200, ignored: true, error });

  /** Вложения письма → файлы для ленты и строки о том, что не сохранили */
  function collectFiles(mail: ParsedMail): { files: RemoteFile[]; skipped: string[] } {
    const out: RemoteFile[] = [];
    const skipped: string[] = [];
    const cids = new Set([...mail.html.matchAll(/cid:([^"'\s>)]+)/gi)].map((m) => (m[1] ?? "").toLowerCase()));
    const parts = mail.attachments.slice(0, MAX_PARTS);
    for (const a of parts) {
      const name = safeFileName(a.name) || "Вложение";
      const cid = a.contentId ? a.contentId.trim().replace(/^cid:/i, "").replace(/^<|>$/g, "").toLowerCase() : "";
      const size = a.size ?? (a.content ? base64Bytes(a.content) : null);
      // Картинка внутри письма размером с логотип (подпись, значки соцсетей) и электронная подпись — не файлы клиента
      if (cid && cids.has(cid) && size !== null && size < inlineBelow) continue;
      if (SIGNATURE_TYPES.has((a.mime.split(";")[0] ?? "").trim().toLowerCase())) continue;
      if (size !== null && size > maxBytes) {
        skipped.push(`«${name}» — больше ${sizeWords(maxBytes)}`);
        continue;
      }
      if (a.content) {
        const data = decodeBase64(a.content);
        if (!data || !data.length) skipped.push(`«${name}» — файл повреждён`);
        else if (data.byteLength > maxBytes) skipped.push(`«${name}» — больше ${sizeWords(maxBytes)}`);
        else if (!mailFileType(data, a.mime, name)) skipped.push(`«${name}» — такие файлы не сохраняем (архивы, программы, страницы)`);
        else out.push({ urls: [toDataUrl(a.mime || mimeFromName(name), a.content, name)], caption: name });
      } else if (a.url && /^https?:\/\//i.test(a.url)) {
        out.push({ urls: [a.url], caption: name });
      } else {
        skipped.push(`«${name}» — нет содержимого`);
      }
    }
    const extra = mail.attachments.length - parts.length;
    if (extra > 0) skipped.push(`ещё ${extra} — больше ${MAX_PARTS} вложений из одного письма не сохраняем`);
    return { files: out, skipped };
  }

  /** Письмо → события: сообщение клиента (+ служебная строка о несохранённых вложениях) */
  function mailEvents(mail: ParsedMail): ReceiveResult {
    const sender = mail.from;
    if (!sender) return { ok: false, status: 422, error: "В письме нет адреса отправителя" };
    // Проверка вебхука из кабинета Postmark — не клиент
    if (mail.format === "postmark" && (sender.email === "support@postmarkapp.com" || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(mail.providerId ?? ""))) {
      return { ok: true, events: [{ type: "ping" }], meta: { event: "ping", format: mail.format } };
    }
    if (isOwn(sender.email)) return ignored("Письмо с нашего же адреса — в переписку не добавляем");
    const auto = autoReplyReason(mail);
    if (auto) return ignored(auto);
    if (!o.acceptSpam && isSpam(mail)) return ignored("Почтовый сервис пометил письмо как спам — в переписку не добавляем");

    const hint: ContactHint = { source: "email", externalId: sender.email, channel: "email", email: sender.email, name: sender.name ?? null };
    // Номер письма — ключ повтора: повторная доставка того же письма второй раз не запишется
    const externalId = mail.messageId
      ? mailKey(mail.messageId)
      : mailKey(`${sha1Hex([sender.email, mail.date ?? "", mail.subject, mail.text || mail.html].join("|")).slice(0, 32)}@no-message-id.invalid`);

    // Текст: ответ без прошлой переписки. Postmark уже вырезал ответ (английские письма) — берём его
    const full = mail.text.trim() ? mail.text : mail.html.trim() ? htmlToText(mail.html) : "";
    const parts = splitReply(full, { forward: isForwardSubject(mail.subject) });
    const stripped = mail.strippedReply ? splitReply(mail.strippedReply).reply || mail.strippedReply.trim() : "";
    const reply = stripped || parts.reply || full.trim();
    const { files: attached, skipped } = collectFiles(mail);
    const subject = mail.subject.replace(/\s+/g, " ").trim().slice(0, 300);
    // Письмо без текста, но с темой — строкой «(без текста)»: иначе тема потерялась бы (в ленте останутся только файлы).
    // Тысячи пробелов подряд не нужны никому, а разметку в окне заставили бы «задуматься» — оставляем 32
    const text = reply ? clip(reply, MAX_TEXT).replace(/[ \t]{33,}/g, (run) => run.slice(0, 32)) : subject || !attached.length ? "(без текста)" : "";

    const parent = mail.inReplyTo ?? mail.references[mail.references.length - 1] ?? null;
    const message: IncomingMessage = {
      externalId,
      at: mail.date,
      author: { type: "client" },
      text,
      subject: subject || null,
      files: attached,
      replyTo: parent ? { externalId: mailKey(parent), text: parts.quote || null } : null,
    };
    const events: ChannelEvent[] = [{ type: "message", contact: hint, message }];
    if (skipped.length) {
      events.push({ type: "notice", contact: hint, key: `${externalId}:skipped`, text: `Не все вложения письма сохранены: ${skipped.join("; ")}` });
    }
    return { ok: true, events, meta: { event: "message", format: mail.format, messageId: mail.messageId } };
  }

  /** Файл ответа: данные, файл на диске сервера (path) или ссылка — её заберёт отправитель */
  async function attachment(f: NonNullable<Outgoing["file"]>): Promise<MailAttachment | string> {
    const name = safeFileName(f.name) || "file";
    const mime = f.mime || mimeFromName(name);
    const tooBig = `Файл «${name}» больше ${sizeWords(maxBytes)} — письмом не отправить`;
    if (f.data) return f.data.byteLength > maxBytes ? tooBig : { name, mime, data: f.data };
    if (f.path) {
      try {
        if ((await stat(f.path)).size > maxBytes) return tooBig;
        const buf = await readFile(f.path);
        return { name, mime, data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) };
      } catch {
        return `Файл «${name}» не найден на сервере`;
      }
    }
    if (f.url) return { name, mime, url: f.url };
    return `Файл «${name}» без данных и без ссылки — отправить нечего`;
  }

  async function compose(to: Target, out: Outgoing): Promise<OutgoingMail | { error: string }> {
    if (!from) return { error: "Не задан адрес отправителя писем (from) — проверьте настройки почты" };
    const email = normalizeEmail(to.externalId);
    if (!email) return { error: "У клиента нет адреса почты — письмо отправить некуда" };
    let attachments: MailAttachment[] | undefined;
    if (out.file) {
      const a = await attachment(out.file);
      if (typeof a === "string") return { error: a };
      attachments = [a];
    }
    // Ответ бота написан разметкой Markdown: в текст письма — без разметки, в HTML — с ней. Текст человека — как набран
    const bot = out.author?.type === "bot";
    const body = (bot ? formatForChannel(out.text, "plain") : out.text).trim();
    const text = body || (out.file ? `Во вложении: ${out.file.name}` : "");
    if (!text) return { error: "Пустое письмо: нет ни текста, ни файла" };
    const parent = messageIdFromKey(out.replyTo?.externalId);
    return {
      from: formatAddress(from),
      to: email,
      ...(replyTo ? { replyTo: formatAddress(replyTo) } : {}),
      subject: (out.subject ?? "").replace(/\s+/g, " ").trim().slice(0, 300) || o.defaultSubject || DEFAULT_SUBJECT,
      text,
      html: mailHtml(bot && body ? out.text : text, { markdown: bot && !!body }),
      messageId: newMessageId(o.domain ?? from.email, out.idempotencyKey ?? null, now()),
      ...(parent ? { inReplyTo: `<${parent}>`, references: [`<${parent}>`] } : {}),
      ...(attachments ? { attachments } : {}),
    };
  }

  return {
    kind: "email",
    caps: EMAIL_CAPS,

    receive(input: WebhookInput): ReceiveResult {
      if (!emailWebhookAuthorized(input, o.inboundToken)) return { ok: false, status: 401, error: "Неверный ключ приёма писем" };
      let body: unknown;
      try {
        body = input.body ? JSON.parse(input.body) : null;
      } catch {
        return { ok: false, status: 400, error: "Тело запроса должно быть JSON" };
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, status: 400, error: "Тело запроса должно быть JSON-объектом" };
      const b = body as Record<string, unknown>;
      if (isPostmarkStatus(b) || isJsonStatus(b)) {
        const r = isJsonStatus(b) ? { events: jsonStatusEvents(b), skipped: "Нет номера письма или непонятный статус" } : postmarkStatusEvents(b);
        return r.events.length ? { ok: true, events: r.events, meta: { event: "status" } } : ignored(r.skipped ?? "Статус не нужен");
      }
      if (isPostmarkInbound(b)) return mailEvents(parsePostmarkInbound(b));
      if (isJsonMail(b)) return mailEvents(parseJsonMail(b));
      return { ok: false, status: 422, error: "Не похоже на письмо: ждём JSON вебхука Postmark или универсальный JSON набора (поля from, subject, text…)" };
    },

    async send(to: Target, out: Outgoing): Promise<SendResult> {
      if (!o.send) return { ok: false, error: "Отправка писем не настроена: подключите SMTP или почтовый сервис в настройках проекта" };
      const mail = await compose(to, out);
      if ("error" in mail) return { ok: false, error: mail.error };
      try {
        const r = await o.send(mail);
        const sent = (r && typeof r === "object" && typeof r.messageId === "string" && r.messageId.trim()) || mail.messageId;
        return { ok: true, externalId: mailKey(sent) };
      } catch (e) {
        return mailSendFailure(e);
      }
    },

    async download(url: string): Promise<DownloadResult> {
      if (url.startsWith("data:")) return downloadDataUrl(url, maxBytes);
      return fetchFile(url, { maxBytes, fetch: doFetch, allowHost: o.allowHost });
    },

    compose,
  };
}
