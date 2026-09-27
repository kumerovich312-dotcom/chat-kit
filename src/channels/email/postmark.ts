import { Buffer } from "node:buffer";
import type { ChannelEvent } from "../../server/channel.js";
import { fetchBytes, sizeWords } from "./files.js";
import { cleanMessageId, mailKey } from "./parse.js";
import { MailSendError, type MailSender, type OutgoingMail } from "./send.js";

/* Postmark — почтовый сервис: принимает письма клиентов (Inbound → вебхук, разбирает parse.ts), отправляет ответы
   (API /email) и сообщает о доставке (вебхуки Delivery, Bounce, SpamComplaint, Open).

   Номер письма. Postmark ставит письму заголовок Message-ID, который мы передали (ответ клиента сошлётся на него —
   так ответ ложится в ту же цепочку и в ленте видно, на что ответили). Вебхуки же доставки называют письмо своим номером
   (MessageID) — поэтому наш номер уходит ещё и в Metadata письма: Postmark возвращает её в каждом вебхуке. */

export const POSTMARK_API = "https://api.postmarkapp.com/email";
/** Ключ Metadata, в котором Postmark вернёт наш номер письма */
export const POSTMARK_METADATA_KEY = "ck-message-id";
/** Postmark принимает письмо до 10 МБ вместе с файлами (base64 — на треть больше самих файлов) */
const POSTMARK_MAX_REQUEST = 10 * 1024 * 1024;

export type PostmarkSenderOptions = {
  /** Ключ сервера Postmark (Server API token) — из окружения проекта */
  serverToken: string;
  /** Адрес отправителя, подтверждённый в Postmark (Sender Signature или домен); по умолчанию — from письма */
  from?: string | undefined;
  /** Поток писем Postmark; по умолчанию «outbound» */
  messageStream?: string | undefined;
  /** Считать открытия письма (вебхук Open → «прочитано»). По умолчанию нет: в письмо добавляется невидимая картинка */
  trackOpens?: boolean | undefined;
  /** Файл по ссылке больше этого не отправляем (по умолчанию 7 МБ) */
  maxFileBytes?: number | undefined;
  /** С каких адресов можно забирать файлы по ссылке; по умолчанию — любые публичные */
  allowHost?: ((host: string) => boolean) | undefined;
  fetch?: typeof fetch | undefined;
  /** Сколько ждать ответа Postmark, мс (по умолчанию 20 000) */
  timeoutMs?: number | undefined;
};

/** Ошибка Postmark → причина словами (коды — из описания API Postmark) */
export function postmarkErrorText(status: number, code: number | null, message: string): { text: string; retryable: boolean } {
  const detail = message ? ` (${message.slice(0, 150)})` : "";
  if (status === 401 || code === 10) return { text: "Postmark не принял ключ сервера — проверьте ключ в окружении проекта", retryable: false };
  if (status === 413) return { text: "Письмо вместе с файлами больше 10 МБ — Postmark такое не принимает", retryable: false };
  if (status === 429) return { text: "Postmark просит подождать: слишком много писем подряд — повторите позже", retryable: true };
  if (status >= 500) return { text: "Postmark временно недоступен — повторите позже", retryable: true };
  switch (code) {
    case 300: return { text: `Postmark не принял письмо: проверьте адрес клиента и текст${detail}`, retryable: false };
    case 400:
    case 401: return { text: "Адрес отправителя не подтверждён в Postmark — подтвердите его (Sender Signatures) или домен", retryable: false };
    case 405: return { text: "Postmark не разрешает отправку: проверьте баланс и состояние аккаунта", retryable: false };
    case 406: return { text: "Postmark больше не отправляет писем на этот адрес: раньше письмо не дошло или клиент пожаловался на спам", retryable: false };
    case 411: return { text: "Postmark не принимает файл такого типа", retryable: false };
    case 412: return { text: "Аккаунт Postmark ещё на проверке: пока можно писать только на адреса своего домена", retryable: false };
    case 413: return { text: "Аккаунт Postmark не одобрен для отправки писем", retryable: false };
    case 1235:
    case 1236: return { text: "Поток писем (Message Stream) не найден в Postmark — проверьте настройку messageStream", retryable: false };
    case 1480: return { text: "Postmark не разрешает отправку с адреса этого сервера", retryable: false };
    default: return { text: `Postmark не принял письмо (код ${code ?? status})${detail}`, retryable: false };
  }
}

/** Отправка писем через Postmark (API /email) без библиотек: заголовки цепочки (Message-ID, In-Reply-To, References),
 *  файлы base64 (файл по ссылке сначала забирается — не больше maxFileBytes), наш номер письма — в Metadata */
export function postmarkSender(o: PostmarkSenderOptions): MailSender {
  const doFetch = o.fetch ?? fetch;
  const maxFile = o.maxFileBytes ?? 7 * 1024 * 1024;
  return async (mail: OutgoingMail) => {
    if (!o.serverToken) throw new MailSendError("Не задан ключ сервера Postmark — добавьте его в окружение проекта");
    const attachments: { Name: string; Content: string; ContentType: string }[] = [];
    for (const a of mail.attachments ?? []) {
      let data = a.data;
      if (!data && a.url) {
        const got = await fetchBytes(a.url, { maxBytes: maxFile, fetch: doFetch, allowHost: o.allowHost });
        if (!got.ok) {
          throw got.reason === "big" ? new MailSendError(`Файл «${a.name}» больше ${sizeWords(maxFile)} — Postmark такое не отправит`)
            : got.reason === "retry" ? new MailSendError(`Не удалось забрать файл «${a.name}» — повторите позже`, true)
            : got.reason === "bad" ? new MailSendError(`Ссылка на файл «${a.name}» не подходит: нужна обычная ссылка http(s) на сайт, не внутренний адрес`)
            : new MailSendError(`Файл «${a.name}» не нашёлся по ссылке`);
        }
        data = got.data;
      }
      if (!data) throw new MailSendError(`Файл «${a.name}» без данных и без ссылки — отправить нечего`);
      attachments.push({ Name: a.name, Content: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64"), ContentType: a.mime || "application/octet-stream" });
    }
    const headers = [{ Name: "Message-ID", Value: mail.messageId }];
    if (mail.inReplyTo) headers.push({ Name: "In-Reply-To", Value: mail.inReplyTo });
    if (mail.references?.length) headers.push({ Name: "References", Value: mail.references.join(" ") });
    const id = cleanMessageId(mail.messageId);
    const body = {
      From: o.from ?? mail.from,
      To: mail.to,
      Subject: mail.subject.slice(0, 2000),
      TextBody: mail.text,
      HtmlBody: mail.html,
      ...(mail.replyTo ? { ReplyTo: mail.replyTo } : {}),
      Headers: headers,
      // Значение Metadata у Postmark — до 80 знаков
      ...(id && id.length <= 80 ? { Metadata: { [POSTMARK_METADATA_KEY]: id } } : {}),
      MessageStream: o.messageStream ?? "outbound",
      ...(o.trackOpens ? { TrackOpens: true } : {}),
      ...(attachments.length ? { Attachments: attachments } : {}),
    };
    const json = JSON.stringify(body);
    if (json.length > POSTMARK_MAX_REQUEST) throw new MailSendError("Письмо вместе с файлами больше 10 МБ — Postmark такое не принимает");

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 20_000);
    let res: Response;
    try {
      res = await doFetch(POSTMARK_API, {
        method: "POST", signal: ctrl.signal, cache: "no-store", redirect: "manual",
        headers: { accept: "application/json", "content-type": "application/json", "x-postmark-server-token": o.serverToken },
        body: json,
      });
    } catch {
      throw new MailSendError(ctrl.signal.aborted ? "Postmark не ответил вовремя — повторите позже" : "Нет связи с Postmark — повторите позже", true);
    } finally {
      clearTimeout(timer);
    }
    const data = (await res.json().catch(() => ({}))) as { ErrorCode?: unknown; Message?: unknown; MessageID?: unknown };
    const code = typeof data.ErrorCode === "number" ? data.ErrorCode : null;
    if (!res.ok || (code !== null && code !== 0)) {
      const e = postmarkErrorText(res.status, code, typeof data.Message === "string" ? data.Message : "");
      throw new MailSendError(e.text, e.retryable);
    }
    return { messageId: mail.messageId };
  };
}

/* ── Вебхуки доставки Postmark ─────────────────────────────────────────────────────────────────────────────── */

/** Причины недоставки (тип Bounce у Postmark) */
const BOUNCE_TEXT: Readonly<Record<string, string>> = {
  HardBounce: "адрес не существует или ящик закрыт",
  SoftBounce: "ящик клиента временно не принимает письма (переполнен или отключён)",
  BadEmailAddress: "неверный адрес почты",
  DnsError: "домен почты клиента не найден",
  Blocked: "почтовый сервер клиента заблокировал письмо",
  SpamNotification: "письмо попало в спам",
  VirusNotification: "почтовый сервер клиента счёл письмо опасным",
  ChallengeVerification: "почтовый сервер клиента просит подтвердить отправителя",
  ManuallyDeactivated: "адрес отключён в Postmark",
  Unsubscribe: "клиент отписался от писем",
  DMARCPolicy: "письмо отклонено из-за настроек DMARC домена отправителя",
  SMTPApiError: "ошибка почтового сервера",
  TemplateRenderingFailed: "ошибка шаблона письма",
  Unknown: "причина неизвестна",
};
/** «Возвраты», которые не значат недоставку: автоответ клиента, временная задержка, подписка */
const NOT_FAILED = new Set(["AutoResponder", "Transient", "Subscribe", "OpenRelayTest", "AddressChange"]);

/** Похоже на вебхук доставки Postmark (RecordType + MessageID) */
export function isPostmarkStatus(b: Record<string, unknown>): boolean {
  return typeof b.RecordType === "string" && typeof b.MessageID === "string" && b.FromFull === undefined;
}

/** Вебхук доставки Postmark → статус нашего письма. Ключ — наш номер из Metadata (так письмо записано в переписке),
 *  без него — номер Postmark. skipped — почему событие переписке не нужно (клик по ссылке, автоответ клиента) */
export function postmarkStatusEvents(b: Record<string, unknown>): { events: ChannelEvent[]; skipped: string | null } {
  const meta = b.Metadata && typeof b.Metadata === "object" ? (b.Metadata as Record<string, unknown>)[POSTMARK_METADATA_KEY] : undefined;
  const id = cleanMessageId(typeof meta === "string" ? meta : null) ?? cleanMessageId(typeof b.MessageID === "string" ? b.MessageID : null);
  if (!id) return { events: [], skipped: "В событии Postmark нет номера письма" };
  const externalId = mailKey(id);
  const type = String(b.RecordType);
  switch (type) {
    case "Delivery":
      return { events: [{ type: "status", externalId, delivery: "delivered" }], skipped: null };
    case "Open":
      return { events: [{ type: "status", externalId, delivery: "read" }], skipped: null };
    case "SpamComplaint":
      return { events: [{ type: "status", externalId, delivery: "failed", error: "Клиент пометил письмо как спам — Postmark больше не отправит ему писем" }], skipped: null };
    case "Bounce": {
      const kind = typeof b.Type === "string" ? b.Type : "Unknown";
      if (NOT_FAILED.has(kind)) return { events: [], skipped: `Postmark: ${kind} — это не недоставка` };
      const why = Object.hasOwn(BOUNCE_TEXT, kind) ? BOUNCE_TEXT[kind] : typeof b.Name === "string" && b.Name ? b.Name : kind;
      return { events: [{ type: "status", externalId, delivery: "failed", error: `Письмо не доставлено: ${why}` }], skipped: null };
    }
    default:
      return { events: [], skipped: `Событие Postmark «${type}» переписке не нужно` };
  }
}
