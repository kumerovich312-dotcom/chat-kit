import { fileExt } from "../../core/files.js";
import { formatForChannel } from "../../core/markup.js";
import type { ChannelAdapter, ChannelCaps, DownloadResult, Outgoing, ReceiveResult, SendResult, Target, WebhookInput } from "../../server/channel.js";
import { safeEqual } from "../../server/crypto.js";
import { fetchFile, isPrivateHost, MAX_FILE_BYTES } from "../../server/download.js";
import { bearerKey } from "../../server/request.js";
import { greenApiChatId, greenApiInstanceId, greenApiRequest, type GreenApiAccess, type GreenApiReply } from "./api.js";
import { GREEN_API_FILE_SCHEME, parseGreenApiWebhook, type GreenApiAlert } from "./parse.js";

/* Подключение WhatsApp через GREEN-API (green-api.com). GREEN-API держит номер компании как «связанное устройство»
   WhatsApp (как WhatsApp Web): номер привязывают QR-кодом в кабинете GREEN-API, дальше CRM пишет и получает сообщения
   через API. Это не официальный WhatsApp Business API: есть риск блокировки номера за спам (docs/channels/green-api.md).

   GREEN-API → CRM: вебхук с ключом в заголовке «Authorization: Bearer <webhookUrlToken>» — без верного ключа 401,
   уведомление чужого инстанса — 403. Разбор уведомлений — parse.ts.
   CRM → GREEN-API: sendMessage (текст), sendFileByUrl (файл по ссылке проекта), sendFileByUpload (файл целиком,
   на адрес mediaUrl). Ответ бота переводится из Markdown в разметку WhatsApp, текст человека уходит как набран.
   Паузы бота и «не отвечать» у канала нет — бота здесь нет, это просто номер WhatsApp. */

export type GreenApiOptions = GreenApiAccess & {
  /** Ключ вебхука (webhookUrlToken в настройках инстанса) — только из окружения проекта. Пусто — уведомления не принимаем */
  webhookToken: string;
  /** Принимать сообщения групп WhatsApp (по умолчанию — нет: в CRM только личные чаты) */
  groups?: boolean | undefined;
  /** Уведомления про номер целиком: WhatsApp отключён / снова подключён / заблокирован, закончился лимит тарифа —
   *  показать администратору (в переписку клиента они не пишутся) */
  onAlert?: ((alert: GreenApiAlert) => void | Promise<void>) | undefined;
  /** Скачанный файл больше этого не сохраняем (по умолчанию 10 МБ) */
  maxFileBytes?: number | undefined;
};

export const GREEN_API_CAPS: ChannelCaps = { text: true, files: true, pause: false, mute: false, start: true, statuses: true };

/** Пределы GREEN-API: текст — 20 000 знаков, подпись к файлу — 1024, файл — 100 МБ */
export const GREEN_API_LIMITS = { text: 20_000, caption: 1024, fileBytes: 100 * 1024 * 1024 } as const;

/** Расширение по типу файла: GREEN-API требует имя файла с расширением */
const MIME_EXT: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "application/pdf": "pdf",
  "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/amr": "amr", "audio/wav": "wav",
  "video/mp4": "mp4", "video/quicktime": "mov", "video/3gpp": "3gp", "video/webm": "webm",
  "application/msword": "doc", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/plain": "txt", "text/csv": "csv",
};

function fileNameOf(name: string, mime: string): string {
  const n = name.trim() || "Файл";
  if (fileExt(n)) return n;
  const ext = MIME_EXT[mime.toLowerCase().split(";")[0]?.trim() ?? ""];
  return ext ? `${n}.${ext}` : n;
}

/** Номер цитируемого сообщения у GREEN-API из ключа набора: «ga:3EB0…» и «ga:3EB0…:file:0» → «3EB0…».
 *  Ключ другого канала — null (цитату не ставим) */
export function greenApiQuotedId(externalId: string | null | undefined): string | null {
  return String(externalId ?? "").match(/^ga:([A-Za-z0-9_-]+)(?::file:\d+)?$/)?.[1] ?? null;
}

export function createGreenApiAdapter(o: GreenApiOptions): ChannelAdapter {
  const doFetch = o.fetch ?? fetch;
  const maxBytes = o.maxFileBytes ?? MAX_FILE_BYTES;
  const fail = (error: string, retryable = false): SendResult => ({ ok: false, error, retryable });

  return {
    kind: "green-api",
    caps: GREEN_API_CAPS,

    async receive(input: WebhookInput): Promise<ReceiveResult> {
      const want = (o.webhookToken ?? "").trim();
      // Без ключа в настройках не принимаем ничего: иначе вебхук открыт любому, кто узнал адрес
      if (!want) return { ok: false, status: 401, error: "Не задан ключ вебхука GREEN-API (webhookUrlToken) — уведомления не принимаем" };
      if (!safeEqual(bearerKey(input.headers), want)) return { ok: false, status: 401, error: "Ключ вебхука неверен" };
      let body: unknown;
      try {
        body = JSON.parse(input.body);
      } catch {
        return { ok: false, status: 400, error: "Тело запроса должно быть JSON" };
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, status: 400, error: "Тело запроса должно быть JSON-объектом" };
      const b = body as Record<string, unknown>;
      const event = typeof b.typeWebhook === "string" ? b.typeWebhook : "";
      const md = b.messageData && typeof b.messageData === "object" ? (b.messageData as Record<string, unknown>) : {};
      const meta = { event, type: typeof md.typeMessage === "string" ? md.typeMessage : null, idMessage: typeof b.idMessage === "string" ? b.idMessage : null };
      if (!event) return { ok: false, status: 400, error: "Нет вида уведомления (typeWebhook)", meta };
      if (greenApiInstanceId(b) !== String(o.idInstance).trim()) return { ok: false, status: 403, error: "Уведомление от другого инстанса GREEN-API", meta };

      const parsed = parseGreenApiWebhook(b, { groups: o.groups });
      if (parsed.kind === "skip") return { ok: false, status: 200, ignored: true, error: parsed.reason, meta };
      if (parsed.kind === "alert") {
        try {
          await o.onAlert?.(parsed.alert);
        } catch (e) {
          console.error("[chat-kit green-api] onAlert:", e);
        }
        return { ok: true, events: [], meta: { ...meta, alert: parsed.alert.text } };
      }
      return { ok: true, events: parsed.events, meta };
    },

    async send(to: Target, out: Outgoing): Promise<SendResult> {
      // Кому: адрес чата из ContactHint или телефон клиента (написать первым — номеру, который ещё не писал)
      const chatId = greenApiChatId(to.externalId);
      if (!chatId) return fail("Не знаем, куда писать в WhatsApp: нужен адрес чата (…@c.us) или телефон в международном виде (+996…)");
      // Ответ бота написан разметкой Markdown — переводим в разметку WhatsApp; текст человека — как набран
      const text = out.author?.type === "bot" ? formatForChannel(out.text ?? "", "whatsapp") : out.text ?? "";
      const quoted = greenApiQuotedId(out.replyTo?.externalId);
      let r: GreenApiReply;
      if (out.file) {
        const f = out.file;
        const fileName = fileNameOf(f.name ?? "", f.mime ?? "");
        // Текст при файле — подпись (без отдельного сообщения: у двух сообщений было бы два номера, а вернуть можно один)
        const caption = text.trim() && text.trim() !== (f.name ?? "").trim() ? text : "";
        if (caption.length > GREEN_API_LIMITS.caption) return fail("Подпись к файлу длиннее 1024 знаков — WhatsApp её не примет: отправьте текст отдельным сообщением");
        if (f.data) {
          if (f.data.byteLength > GREEN_API_LIMITS.fileBytes) return fail("Файл больше 100 МБ — WhatsApp его не примет");
          const form = new FormData();
          form.set("chatId", chatId);
          form.set("fileName", fileName);
          if (caption) form.set("caption", caption);
          if (quoted) form.set("quotedMessageId", quoted);
          form.set("file", new Blob([new Uint8Array(f.data)], { type: f.mime || "application/octet-stream" }), fileName);
          r = await greenApiRequest(o, "sendFileByUpload", { form, media: true, timeoutMs: 60_000 });
        } else if (f.url) {
          // Файл GREEN-API забирает сам — ссылка должна открываться из интернета (signFileLink с адресом сайта)
          let host = "";
          try { host = new URL(f.url).hostname; } catch { /* не адрес */ }
          if (!/^https?:\/\//i.test(f.url) || !host) return fail("Ссылка на файл должна быть полным адресом https://… — GREEN-API забирает файл по ней сам");
          if (isPrivateHost(host)) return fail("Ссылка на файл ведёт на внутренний адрес — GREEN-API не сможет его забрать: нужен открытый адрес сайта");
          r = await greenApiRequest(o, "sendFileByUrl", {
            body: { chatId, urlFile: f.url, fileName, ...(caption ? { caption } : {}), ...(quoted ? { quotedMessageId: quoted } : {}) },
            timeoutMs: 30_000,
          });
        } else {
          return fail("Файл не передан: нужна ссылка на файл (url) или его содержимое (data)");
        }
      } else {
        if (!text.trim()) return fail("Пустое сообщение — отправлять нечего");
        if (text.length > GREEN_API_LIMITS.text) return fail("Сообщение длиннее 20 000 знаков — WhatsApp его не примет: разделите его на части");
        r = await greenApiRequest(o, "sendMessage", { body: { chatId, message: text, ...(quoted ? { quotedMessageId: quoted } : {}) } });
      }
      if (!r.ok) return fail(r.error, r.retryable);
      // Номер сообщения у GREEN-API — ключ повтора «ga:<idMessage>»: по нему придут статусы, а «эхо» этой отправки
      // (outgoingAPIMessageReceived) не запишется второй раз, если проект сохранил externalId у своего сообщения
      const id = typeof r.data.idMessage === "string" ? r.data.idMessage.trim() : "";
      return { ok: true, externalId: id ? `ga:${id}` : null };
    },

    /** Файл сообщения: ссылка GREEN-API — с защитой fetchFile (только открытые адреса, предел размера, тип по
     *  содержимому); «ga-file:<чат>:<номер>» — свежая ссылка у GREEN-API (downloadFile), если прежняя устарела */
    async download(url: string): Promise<DownloadResult> {
      if (!url.startsWith(GREEN_API_FILE_SCHEME)) return fetchFile(url, { fetch: doFetch, maxBytes });
      const m = url.slice(GREEN_API_FILE_SCHEME.length).match(/^([^:\s]+):([A-Za-z0-9_-]+)$/);
      if (!m) return { ok: false, reason: "bad" };
      const r = await greenApiRequest(o, "downloadFile", { body: { chatId: m[1], idMessage: m[2] }, timeoutMs: 20_000 });
      if (!r.ok) return { ok: false, reason: r.retryable ? "retry" : "missing" };
      const link = typeof r.data.downloadUrl === "string" ? r.data.downloadUrl.trim() : "";
      return link ? fetchFile(link, { fetch: doFetch, maxBytes }) : { ok: false, reason: "missing" };
    },
  };
}
