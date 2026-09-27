import { randomBytes } from "node:crypto";
import type { SendResult } from "../../server/channel.js";
import { sha256Hex } from "../../server/crypto.js";

/* Исходящее письмо. Набор собирает письмо (тема, текст и HTML, номер письма, заголовки цепочки, файл), а отправляет его
   проект — своей SMTP-библиотекой или API почтового сервиса (готовый способ — postmarkSender). */

/** Файл письма: данные или ссылка, по которой отправитель заберёт файл сам */
export type MailAttachment = { name: string; mime: string; data?: Uint8Array | undefined; url?: string | undefined };

/** Письмо клиенту — поля названы как у распространённых SMTP-библиотек (from, to, replyTo, messageId, inReplyTo, references) */
export type OutgoingMail = {
  /** «Компания <hello@company.example>» */
  from: string;
  /** Адрес клиента */
  to: string;
  /** Куда клиенту отвечать (Reply-To), если ответы принимает другой адрес */
  replyTo?: string | undefined;
  subject: string;
  text: string;
  html: string;
  /** Номер письма с угловыми скобками: «<ck.…@company.example>» */
  messageId: string;
  /** Ответ на письмо клиента — его номер «<…>»: почта клиента покажет ответ в той же цепочке */
  inReplyTo?: string | undefined;
  references?: string[] | undefined;
  attachments?: MailAttachment[] | undefined;
};

/** Отправить письмо способом проекта. Вернуть номер, с которым письмо ушло (у SMTP-библиотек — info.messageId);
 *  ничего не вернули — набор считает, что ушло с messageId письма. Ошибка — исключение (лучше MailSendError) */
export type MailSender = (mail: OutgoingMail) => Promise<{ messageId?: string | null | undefined } | void>;

/** Ошибка отправки, понятная сотруднику: message показывается в окне как есть; retryable — можно повторить позже */
export class MailSendError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = false) {
    super(message);
    this.name = "MailSendError";
    this.retryable = retryable;
  }
}

/** Домен для номеров писем: «компания.рф» → «xn--…» (в заголовках — только латиница) */
export function mailDomain(domain: string | null | undefined): string {
  const d = String(domain ?? "").trim().replace(/^.*@/, "");
  try {
    const host = new URL(`http://${d}`).hostname;
    if (/^[a-z0-9.-]+$/.test(host) && host.includes(".")) return host;
  } catch { /* не домен */ }
  return "localhost";
}

/** Номер нового письма (Message-ID): «<ck.…@домен>». С ключом повтора — всегда один и тот же: письмо, отправленное
 *  повторно после сбоя связи, почта клиента узнает как то же самое */
export function newMessageId(domain: string, seed?: string | null, now: number = Date.now()): string {
  const d = mailDomain(domain);
  const local = seed ? `ck.${sha256Hex(`${d}|${seed}`).slice(0, 32)}` : `ck.${now.toString(36)}.${randomBytes(8).toString("hex")}`;
  return `<${local}@${d}>`;
}

type Failure = Extract<SendResult, { ok: false }>;

/** Ошибка отправки → причина словами. MailSendError — как есть; ошибки SMTP-библиотек (nodemailer и похожих) — по коду */
export function mailSendFailure(e: unknown): Failure {
  if (e instanceof MailSendError) return { ok: false, error: e.message, retryable: e.retryable };
  const x = (e && typeof e === "object" ? e : {}) as { code?: unknown; responseCode?: unknown };
  const code = typeof x.code === "string" ? x.code : "";
  const smtp = typeof x.responseCode === "number" ? x.responseCode : 0;
  if (code === "EAUTH") return { ok: false, error: "Почтовый сервер не принял логин или пароль — проверьте настройки отправки почты" };
  if (code === "EENVELOPE" || smtp === 550 || smtp === 553 || smtp === 501) return { ok: false, error: "Почтовый сервер не принял адрес клиента — проверьте адрес" };
  if (["ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN"].includes(code)) {
    return { ok: false, error: "Нет связи с почтовым сервером — попробуйте ещё раз", retryable: true };
  }
  if (smtp >= 400 && smtp < 500) return { ok: false, error: "Почтовый сервер просит повторить позже", retryable: true };
  if (smtp >= 500) return { ok: false, error: `Почтовый сервер отказал (код ${smtp})` };
  console.error("[chat-kit email] письмо не отправилось:", e);
  return { ok: false, error: "Письмо не отправилось" };
}
