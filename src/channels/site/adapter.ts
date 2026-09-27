import type { ChannelAdapter, ChannelCaps, ChannelEvent, DownloadResult, IngestSummary, ReceiveResult, SendResult, Target, WebhookInput } from "../../server/channel.js";
import { sniffFile } from "../../server/sniff.js";
import type { ContactHint } from "../../server/store.js";
import {
  CLIENT_MSG_ID_RE, cleanText, decodeBase64, hasProfile, introText, readPage, readProfile, readSiteFile, SITE_MAX_FILE_BYTES,
  SITE_MAX_TEXT, siteDataUrl, siteFileAllowed,
} from "./input.js";
import { siteMessagePrefix } from "./public.js";
import { newVisitorId, siteSecretProblem, siteToken, siteVisitor, VISITOR_ID_RE } from "./token.js";

/* Подключение «чат на сайте»: виджет на сайте компании (src/widget) → свой адрес проекта (handleSiteRequest) → это
   подключение → ingest → переходник проекта. Посетитель — клиент с каналом «site» и адресом у подключения
   «site:<номер посетителя>»; сопоставлений хранить не нужно — клиент каждый раз находится по ContactHint.

   Ответ менеджера никуда не отправляется: проект уже записал его в свою базу, а виджет посетителя забирает новые
   сообщения сам (опрос раз в 3 с, пока чат открыт). Поэтому send только подтверждает, статусов доставки нет, написать
   первым нельзя — посетитель на сайте анонимен, пока не напишет сам.

   receive принимает два запроса виджета (действие — последняя часть адреса):
   - start с формой перед чатом — клиент заводится сразу, в переписке строка «Чат на сайте: страница … · представился …»;
   - message — сообщение посетителя (текст и файл base64), та же строка — перед первым сообщением, если формы не было.
   Ключ посетителя проверяется и здесь: подключение можно звать через ingest и без handleSiteRequest. */

export type SiteAdapterOptions = {
  /** Секрет подписи посетителей — из окружения проекта, не короче 16 знаков */
  secret: string;
  /** Телефонный код страны компании («+996»): номер из формы, записанный по-местному, — в международный вид */
  phoneCode?: string | undefined;
  /** Самый большой файл от посетителя (по умолчанию 5 МБ) */
  maxFileBytes?: number | undefined;
  /** Самое длинное сообщение (по умолчанию 4000 знаков) */
  maxTextLength?: number | undefined;
};

export const SITE_CAPS: ChannelCaps = { text: true, files: true, pause: false, mute: false, start: false, statuses: false };

export type SiteAdapter = ChannelAdapter & {
  /** Новый посетитель: номер и ключ */
  issue(): { visitorId: string; token: string };
  /** Номер посетителя по заголовку Authorization — если ключ верный */
  visitor(headers: Record<string, string | undefined>): string | null;
  /** Ключ посетителя */
  token(visitorId: string): string;
};

/** Действие — последняя часть пути адреса: «/api/site-chat/message» → «message» */
export function siteAction(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url, "http://site.invalid").pathname.split("/").filter(Boolean).pop() ?? "";
  } catch {
    return "";
  }
}

export function createSiteAdapter(o: SiteAdapterOptions): SiteAdapter {
  const maxBytes = o.maxFileBytes ?? SITE_MAX_FILE_BYTES;
  const maxText = o.maxTextLength ?? SITE_MAX_TEXT;
  const phoneCode = o.phoneCode ?? "";
  const problem = siteSecretProblem(o.secret);
  const visitor = (headers: Record<string, string | undefined>) => (problem ? null : siteVisitor(o.secret, headers));

  const adapter: SiteAdapter = {
    kind: "site",
    caps: SITE_CAPS,

    receive(input: WebhookInput): ReceiveResult {
      if (problem) return { ok: false, status: 500, error: "Чат на сайте не настроен" };
      const visitorId = visitor(input.headers);
      if (!visitorId) return { ok: false, status: 401, error: "Нет доступа — начните чат заново" };
      let body: unknown;
      try {
        body = input.body ? JSON.parse(input.body) : {};
      } catch {
        return { ok: false, status: 400, error: "Тело запроса должно быть JSON" };
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, status: 400, error: "Тело запроса должно быть JSON-объектом" };
      const b = body as Record<string, unknown>;
      const meta = { visitorId };

      const prof = readProfile(b.profile, phoneCode);
      if (!prof.ok) return { ok: false, status: 422, error: prof.error, meta: { ...meta, field: prof.field } };
      const p = prof.profile;
      const hint: ContactHint = {
        source: "site", externalId: visitorId, channel: "site", phoneTrusted: false,
        ...(p.name ? { name: p.name } : {}), ...(p.phone ? { phone: p.phone } : {}), ...(p.email ? { email: p.email } : {}),
      };
      const events: ChannelEvent[] = [];
      // Где начат чат и как представился — одной строкой, один раз на посетителя (ключ повтора)
      const intro = introText(readPage(b.page), hasProfile(p) ? p : null, phoneCode);
      if (intro) events.push({ type: "notice", contact: hint, key: `${siteMessagePrefix(visitorId)}intro`, text: intro });
      if (siteAction(input.url) === "start") return { ok: true, events, meta };

      const cmid = typeof b.clientMsgId === "string" ? b.clientMsgId : "";
      if (!CLIENT_MSG_ID_RE.test(cmid)) return { ok: false, status: 400, error: "Нет номера сообщения (clientMsgId)", meta };
      const text = cleanText(b.text);
      if (text.length > maxText) {
        return { ok: false, status: 422, error: `Сообщение длиннее ${maxText} знаков — разделите его на несколько`, meta: { ...meta, field: "text" } };
      }
      let files: { urls: string[]; caption: string }[] = [];
      if (b.file !== undefined && b.file !== null) {
        const f = readSiteFile(b.file, maxBytes);
        if (!f.ok) return { ok: false, status: f.status, error: f.error, meta: { ...meta, field: "file" } };
        files = [{ urls: [siteDataUrl(f.file)], caption: f.file.name }];
      }
      if (!text && !files.length) return { ok: false, status: 422, error: "Пустое сообщение", meta: { ...meta, field: "text" } };
      events.push({
        type: "message", contact: hint,
        // Номер сообщения придумывает виджет: повтор после обрыва связи придёт с тем же номером и второй раз не запишется
        message: { externalId: `${siteMessagePrefix(visitorId)}${cmid}`, author: { type: "client" }, text, ...(files.length ? { files } : {}) },
      });
      return { ok: true, events, meta };
    },

    /** Ответ виджету: без внутренних номеров CRM */
    respond(summary: IngestSummary, status: number) {
      if (!summary.ok) {
        const field = typeof summary.meta?.field === "string" ? summary.meta.field : null;
        return { status, body: { ok: false, error: summary.error ?? "Не получилось", ...(field ? { field } : {}), ...(status >= 500 ? { retryable: true } : {}) } };
      }
      return { status, body: { ok: true, duplicate: summary.status === "duplicate" } };
    },

    async send(to: Target): Promise<SendResult> {
      if (!VISITOR_ID_RE.test(to.externalId)) return { ok: false, error: "Это не посетитель чата на сайте — ответить туда нельзя" };
      // Ответ уже в базе проекта: виджет заберёт его при следующем опросе
      return { ok: true, externalId: null };
    },

    /** Файл посетителя — «data:»-ссылка из receive. Другие адреса не качаем: ссылку из запроса мог подставить кто угодно */
    async download(url: string): Promise<DownloadResult> {
      if (!/^data:[^,]*;base64,/i.test(url)) return { ok: false, reason: "bad" };
      const dec = decodeBase64(url, maxBytes);
      if (!dec.ok || !dec.data.length) return { ok: false, reason: "bad" };
      const type = sniffFile(dec.data);
      if (!type || !siteFileAllowed(type.mime)) return { ok: false, reason: "bad" };
      return { ok: true, data: dec.data, mime: type.mime, ext: type.ext };
    },

    issue() {
      const visitorId = newVisitorId();
      return { visitorId, token: siteToken(o.secret, visitorId) };
    },
    visitor,
    token: (visitorId) => siteToken(o.secret, visitorId),
  };
  return adapter;
}
