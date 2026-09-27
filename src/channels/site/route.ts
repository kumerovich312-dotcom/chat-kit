import type { ChatMessage } from "../../core/model.js";
import { ingest, type IngestHooks } from "../../server/ingest.js";
import { readWebhook } from "../../server/request.js";
import type { ChatStore, ContactHint } from "../../server/store.js";
import { createSiteAdapter, siteAction, type SiteAdapter } from "./adapter.js";
import { hasProfile, mbText, readProfile, SITE_MAX_FILE_BYTES } from "./input.js";
import { clientIp, createRateLimiter, DEFAULT_SITE_LIMITS, type RateLimiter, type SiteLimits } from "./limits.js";
import { toPublicMessage, visibleToVisitor, type SiteFileUrl, type SitePublicMessage } from "./public.js";
import { siteSecretProblem } from "./token.js";

/* Адрес чата на сайте в проекте — одной строкой:
     // app/api/site-chat/[[...path]]/route.ts
     const handle = (req: Request) => handleSiteRequest(req, { secret, store, history, fileUrl, origins });
     export { handle as GET, handle as POST, handle as OPTIONS };
   Действия (последняя часть адреса):
   - POST start — новый посетитель (номер и ключ) или прежний по ключу; с формой перед чатом — клиент в CRM сразу;
   - POST message — сообщение посетителя: текст и файл base64 (JSON);
   - GET messages?after=<номер> — новые сообщения его диалога, которые ему можно видеть;
   - GET (любой другой адрес) — проверка связи.
   Ключ посетителя — в каждом запросе («Authorization: Bearer <номер>.<ключ>»). Чужие сайты не пускаем (CORS: только
   сайты из origins и сам сайт CRM), частоту ограничиваем (limits.ts). */

export type SiteRequestOptions = {
  /** Секрет подписи посетителей — из окружения проекта, не короче 16 знаков, отдельный от ключей каналов */
  secret: string;
  /** Переходник проекта — уже для своей компании */
  store: ChatStore;
  /** Сообщения диалога посетителя из базы проекта, по порядку: после сообщения afterId, а без него — последние (до 100).
   *  Всё подряд: что посетителю видно (без заметок, служебных строк, черновиков бота), набор отберёт сам */
  history: (contactId: string, afterId: string | null) => Promise<readonly ChatMessage[]>;
  /** Ссылка на файл без входа в CRM (signFileLink) — посетитель не вошёл в CRM. Нет — файлы в чате не показываются */
  fileUrl?: SiteFileUrl | undefined;
  /** Сайты, где стоит виджет, — точные адреса: ["https://example.kg", "https://www.example.kg"]. Сайт самой CRM
   *  разрешён всегда; "*" — любой сайт (только для проверок) */
  origins?: readonly string[] | undefined;
  /** Найти клиента-посетителя, не заводя нового (для опроса). Нет — findOrCreateContact переходника */
  findContact?: ((hint: ContactHint) => Promise<string | null>) | undefined;
  /** Показывать посетителю имя сотрудника под ответом (первое слово: «Айгерим») */
  showAgentNames?: boolean | undefined;
  /** Подпись под ответами бота; нет — без подписи */
  botName?: string | null | undefined;
  /** На связи ли компания — «онлайн» в шапке виджета; false — «ответим, как только сможем». Нет — виджет пишет «онлайн» */
  online?: (() => boolean | Promise<boolean>) | undefined;
  /** Обработчики приёма: новый клиент → своя заявка и т. п. */
  hooks?: IngestHooks | undefined;
  /** Телефонный код страны компании («+996») — для номера из формы перед чатом */
  phoneCode?: string | undefined;
  /** Самый большой файл от посетителя (по умолчанию 5 МБ) */
  maxFileBytes?: number | undefined;
  /** Каналы, чьи сообщения видит посетитель (по умолчанию только «site») */
  channels?: readonly string[] | undefined;
  /** Пределы частоты (limits.ts) */
  limits?: Partial<SiteLimits> | undefined;
  /** Свои счётчики частоты; нет — общие на процесс */
  limiter?: RateLimiter | undefined;
  /** Адрес IP посетителя по-своему (например, заголовок своего прокси); нет — первый из X-Forwarded-For */
  ip?: ((req: Request) => string | null) | undefined;
  /** Своё подключение (обычно не нужно) */
  adapter?: SiteAdapter | undefined;
  now?: (() => number) | undefined;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Сколько сообщений отдать за раз: без after — последние, с after — первые после него (остальное — следующим опросом) */
const LAST = 100;
const NEXT = 200;

let sharedLimiter: RateLimiter | null = null;

/** Сайт из заголовка Origin разрешён: сам сайт CRM, адрес из списка или "*" */
export function siteOriginAllowed(origin: string, self: string, list: readonly string[] | undefined): boolean {
  const norm = (v: string) => {
    try {
      const u = new URL(v);
      return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
    } catch {
      return null;
    }
  };
  const o = norm(origin);
  if (!o) return false;
  if (o === norm(self)) return true;
  return (list ?? []).some((x) => x === "*" || norm(x) === o);
}

export async function handleSiteRequest(req: Request, o: SiteRequestOptions): Promise<Response> {
  const now = o.now ?? Date.now;
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    url = new URL("http://site.invalid/");
  }
  const origin = headers["origin"];
  const allowed = !origin || siteOriginAllowed(origin, url.origin, o.origins);
  const cors: Record<string, string> = origin ? { vary: "Origin", ...(allowed ? { "access-control-allow-origin": origin } : {}) } : {};
  const reply = (status: number, body: unknown, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...cors, ...extra },
  });

  // Чужой сайт: браузер и так не покажет ему ответ, но простой запрос (без предварительной проверки) дошёл бы до CRM
  if (!allowed) return reply(403, { ok: false, error: "Этому сайту чат не разрешён: адрес сайта нужно добавить в настройки чата (origins)" });
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        ...(origin ? { "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "authorization, content-type", "access-control-max-age": "7200" } : {}),
      },
    });
  }

  const problem = siteSecretProblem(o.secret);
  if (problem) {
    console.error(`[chat-kit site] ${problem}`);
    return reply(500, { ok: false, error: "Чат на сайте не настроен" });
  }

  const L: SiteLimits = { ...DEFAULT_SITE_LIMITS, ...o.limits };
  const limiter = o.limiter ?? (sharedLimiter ??= createRateLimiter());
  const hit = (key: string, limit: number, windowMs: number) => limiter.hit(key, limit, windowMs, now());
  const tooMany = (wait: number) => reply(429, { ok: false, error: "Слишком часто — подождите немного", retryAfter: wait, retryable: true }, { "retry-after": String(wait) });
  const ip = (o.ip ? o.ip(req) : clientIp(headers)) ?? "";
  const denied = () => reply(401, { ok: false, error: "Нет доступа — начните чат заново" });
  const adapter = o.adapter ?? createSiteAdapter({ secret: o.secret, phoneCode: o.phoneCode, maxFileBytes: o.maxFileBytes });
  const onlineField = async (): Promise<{ online?: boolean }> => {
    if (!o.online) return {};
    try {
      return { online: !!(await o.online()) };
    } catch {
      return {};
    }
  };

  // Адрес неизвестен (нет прокси и заголовка) — пределы по адресу не считаем, иначе все посетители делили бы один
  if (ip) {
    const wait = hit(`ip:${ip}`, L.ipRequests, MINUTE);
    if (wait) return tooMany(wait);
  }

  const action = siteAction(url.pathname);
  try {
    if (req.method === "GET" && action === "messages") {
      const visitorId = adapter.visitor(headers);
      if (!visitorId) return denied();
      const wait = hit(`poll:${visitorId}`, L.visitorPolls, MINUTE);
      if (wait) return tooMany(wait);
      const raw = url.searchParams.get("after");
      const after = raw && raw.length <= 128 && !/[\u0000-\u001F\u007F]/.test(raw) ? raw : null;
      const hint: ContactHint = { source: "site", externalId: visitorId, channel: "site", phoneTrusted: false };
      // Виджет спрашивает ответы, только когда посетитель уже писал или представился, — клиент уже есть
      const contactId = o.findContact ? await o.findContact(hint) : (await o.store.findOrCreateContact(hint)).contactId;
      const list = contactId ? await o.history(contactId, after) : [];
      const visible = list.filter((m) => visibleToVisitor(m, visitorId, o.channels));
      const pick = after ? visible.slice(0, NEXT) : visible.slice(-LAST);
      const po = { visitorId, showAgentNames: o.showAgentNames, botName: o.botName, channels: o.channels, fileUrl: o.fileUrl };
      const messages: SitePublicMessage[] = [];
      for (const m of pick) messages.push(await toPublicMessage(m, po));
      return reply(200, { ok: true, messages, ...(await onlineField()) });
    }

    if (req.method === "GET") return reply(200, { ok: true, service: "чат на сайте", ...(await onlineField()) });

    if (req.method !== "POST") return reply(405, { ok: false, error: "Такой запрос не принимаем" }, { allow: "GET, POST, OPTIONS" });

    if (action === "start") {
      const input = await readWebhook(req, 16 * 1024);
      if (!input) return reply(413, { ok: false, error: "Слишком большой запрос" });
      let body: Record<string, unknown>;
      try {
        const v: unknown = input.body ? JSON.parse(input.body) : {};
        if (!v || typeof v !== "object" || Array.isArray(v)) return reply(400, { ok: false, error: "Тело запроса должно быть JSON-объектом" });
        body = v as Record<string, unknown>;
      } catch {
        return reply(400, { ok: false, error: "Тело запроса должно быть JSON" });
      }
      // Прежний посетитель — по ключу; ключ не подошёл (сменили секрет) или его нет — новый посетитель
      let visitorId = adapter.visitor(headers);
      const resumed = !!visitorId;
      if (!visitorId) {
        if (ip) {
          const wait = hit(`start:${ip}`, L.ipSessions, HOUR);
          if (wait) return tooMany(wait);
        }
        visitorId = adapter.issue().visitorId;
      }
      const token = adapter.token(visitorId);
      const prof = readProfile(body.profile, o.phoneCode ?? "");
      if (!prof.ok) return reply(422, { ok: false, error: prof.error, field: prof.field });
      // Форма перед чатом: клиент заводится сразу — менеджер видит, кто пришёл, ещё до первого сообщения
      if (hasProfile(prof.profile)) {
        const wait = hit(`msg:${visitorId}`, L.visitorMessages, MINUTE);
        if (wait) return tooMany(wait);
        const r = await ingest(adapter, o.store, { ...input, headers: { ...input.headers, authorization: `Bearer ${visitorId}.${token}` } }, { hooks: o.hooks, now: o.now });
        if (r.status !== 200) return reply(r.status, r.body);
      }
      return reply(200, { ok: true, visitorId, token, resumed, ...(await onlineField()) });
    }

    if (action === "message") {
      const visitorId = adapter.visitor(headers);
      if (!visitorId) return denied();
      const wait = hit(`msg:${visitorId}`, L.visitorMessages, MINUTE) || (ip ? hit(`msgip:${ip}`, L.ipMessages, MINUTE) : 0);
      if (wait) return tooMany(wait);
      const maxFile = o.maxFileBytes ?? SITE_MAX_FILE_BYTES;
      // Файл приходит base64 — на треть больше самого файла; плюс текст
      const input = await readWebhook(req, Math.ceil((maxFile * 4) / 3) + 64 * 1024);
      if (!input) return reply(413, { ok: false, error: `Файл больше ${mbText(maxFile)} МБ — отправьте поменьше`, field: "file" });
      // Без later: файл уже здесь, качать нечего — записываем до ответа, и виджет сразу увидит его в переписке
      const r = await ingest(adapter, o.store, input, { hooks: o.hooks, now: o.now });
      return reply(r.status, r.body);
    }

    return reply(404, { ok: false, error: "Нет такого действия" });
  } catch (e) {
    console.error("[chat-kit site] ошибка обработки запроса:", e);
    return reply(500, { ok: false, error: "Не получилось — попробуйте ещё раз", retryable: true });
  }
}
