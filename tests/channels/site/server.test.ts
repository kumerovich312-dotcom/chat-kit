import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRateLimiter, createSiteAdapter, handleSiteRequest, SITE_CAPS, siteToken, verifySiteToken, type SiteRequestOptions,
} from "../../../src/channels/site/index.js";
import type { ChatMessage } from "../../../src/core/model.js";
import { createMemoryStore, ingest, signFileLink } from "../../../src/server/index.js";
import { bytes } from "../../helpers/fake-net.js";

// Чат на сайте, серверная часть: адрес проекта (handleSiteRequest) на переходнике «в памяти». Сайты, имена, номера и
// секреты — вымышленные.

const SECRET = "test-secret-not-real-site-chat";
const BASE = "https://crm.test/api/site-chat";
const SITE = "https://shop.test";

type Reply = { status: number; headers: Headers; body: Record<string, any> };
type CallOptions = { body?: unknown; auth?: string | null; origin?: string | null; ip?: string; query?: string; headers?: Record<string, string> };

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const later = (sec: number) => new Date(Date.now() + sec * 1000).toISOString();

/** Сообщения диалога после afterId — как сделал бы проект запросом «id > afterId» */
function historyOf(store: ReturnType<typeof createMemoryStore>) {
  return async (contactId: string, afterId: string | null): Promise<ChatMessage[]> => {
    const all = store.thread(contactId);
    const i = afterId ? all.findIndex((m) => m.id === afterId) : -1;
    return i >= 0 ? all.slice(i + 1) : all;
  };
}

function setup(extra: Partial<SiteRequestOptions> = {}) {
  const store = createMemoryStore({ countryCode: "+996" });
  const opts: SiteRequestOptions = {
    secret: SECRET, store, history: historyOf(store), origins: [SITE], limiter: createRateLimiter(),
    fileUrl: (att) => signFileLink({ origin: "https://crm.test", path: `/files/${att.id}`, id: att.id, secret: "test-secret-not-real-files" }),
    ...extra,
  };
  const call = async (method: string, action: string, o: CallOptions = {}): Promise<Reply> => {
    const headers: Record<string, string> = { "x-forwarded-for": o.ip ?? "203.0.113.5", ...o.headers };
    if (o.auth) headers.authorization = `Bearer ${o.auth}`;
    if (o.origin !== null) headers.origin = o.origin ?? SITE;
    const init: RequestInit = { method, headers };
    if (o.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = typeof o.body === "string" ? o.body : JSON.stringify(o.body);
    }
    const res = await handleSiteRequest(new Request(`${BASE}${action ? `/${action}` : ""}${o.query ?? ""}`, init), opts);
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  };
  const start = async (body: unknown = {}, o: CallOptions = {}) => {
    const r = await call("POST", "start", { body, ...o });
    return { ...r, auth: `${r.body.visitorId}.${r.body.token}` };
  };
  const send = (auth: string, body: Record<string, unknown>, o: CallOptions = {}) => call("POST", "message", { auth, body, ...o });
  const poll = (auth: string, after?: string) => call("GET", "messages", { auth, ...(after ? { query: `?after=${encodeURIComponent(after)}` } : {}) });
  return { store, opts, call, start, send, poll };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("посетитель и ключ", () => {
  it("start: новый посетитель — номер и ключ HMAC; с ключом — тот же посетитель; ключ не подошёл — новый", async () => {
    const { call, start, store } = setup();
    const a = await start();
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ ok: true, resumed: false });
    expect(a.body.visitorId).toMatch(/^v_[A-Za-z0-9_-]{22}$/);
    expect(a.body.token).toBe(siteToken(SECRET, a.body.visitorId));
    expect(verifySiteToken(SECRET, a.body.visitorId, a.body.token)).toBe(true);
    // Без формы и без сообщения клиента в CRM не заводим: мало ли кто открыл чат
    expect(store.contacts.size).toBe(0);

    const again = await call("POST", "start", { body: {}, auth: a.auth });
    expect(again.body).toMatchObject({ ok: true, visitorId: a.body.visitorId, token: a.body.token, resumed: true });
    const forged = await call("POST", "start", { body: {}, auth: `${a.body.visitorId}.${"A".repeat(43)}` });
    expect(forged.body.resumed).toBe(false);
    expect(forged.body.visitorId).not.toBe(a.body.visitorId);
  });

  it("ключ обязателен: без ключа, с ключом другого посетителя, с обрезанным ключом — 401", async () => {
    const { start, send, poll, call } = setup();
    const a = await start();
    const b = await start();
    const body = { clientMsgId: "m-00000001", text: "Здравствуйте" };
    expect((await call("POST", "message", { body })).status).toBe(401);
    expect((await send(`${a.body.visitorId}.${b.body.token}`, body)).status).toBe(401);
    expect((await send(`${a.body.visitorId}.${a.body.token.slice(0, -1)}`, body)).status).toBe(401);
    expect((await poll(a.body.visitorId)).status).toBe(401);
    const r = await poll(`${b.body.visitorId}.${a.body.token}`);
    expect(r).toMatchObject({ status: 401, body: { ok: false } });
    expect(r.headers.get("access-control-allow-origin")).toBe(SITE);
  });

  it("подключение само проверяет ключ, если его зовут через ingest без handleSiteRequest", async () => {
    const store = createMemoryStore();
    const adapter = createSiteAdapter({ secret: SECRET });
    const body = JSON.stringify({ clientMsgId: "m-00000001", text: "Привет" });
    const no = await ingest(adapter, store, { method: "POST", headers: {}, body, url: `${BASE}/message` });
    expect(no.status).toBe(401);
    const { visitorId, token } = adapter.issue();
    const yes = await ingest(adapter, store, { method: "POST", headers: { authorization: `Bearer ${visitorId}.${token}` }, body, url: `${BASE}/message` });
    expect(yes).toMatchObject({ status: 200, body: { ok: true, duplicate: false } });
    expect(store.thread("1").map((m) => m.text)).toEqual(["Привет"]);
  });

  it("нет секрета или он короткий — 500, в журнале сервера — что поправить", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { start } = setup({ secret: "short" });
    expect((await start()).status).toBe(500);
    expect(String(log.mock.calls[0]?.[0])).toMatch(/секрет/);
    expect(verifySiteToken("short", "v_AAAAAAAAAAAAAAAAAAAAAA", siteToken("short", "v_AAAAAAAAAAAAAAAAAAAAAA"))).toBe(false);
  });
});

describe("сообщения посетителя", () => {
  it("сообщение → клиент «site» по номеру посетителя, строка «откуда пришёл» один раз, клиент ждёт ответа", async () => {
    const contacts: boolean[] = [];
    const { start, send, store } = setup({ hooks: { onContact: async ({ created }) => { contacts.push(created); } } });
    const s = await start();
    const page = {
      url: "https://shop.test/prices?token=secret-reset-link#top",
      referrer: "https://www.google.com/",
      landing: "https://shop.test/?utm_source=google&utm_campaign=autumn&order=15",
    };
    const r = await send(s.auth, { clientMsgId: "m-00000001", text: "  Здравствуйте!\r\nЕсть доставка?  ", page });
    expect(r).toMatchObject({ status: 200, body: { ok: true, duplicate: false } });
    expect(JSON.stringify(r.body)).not.toMatch(/contact|client_id/);

    const c = store.contacts.get("1");
    expect(c).toMatchObject({ channel: "site", identities: [`site:${s.body.visitorId}`] });
    const thread = store.thread("1");
    // Из адресов — только страница и метки utm_*: ключ сброса пароля и номер заказа в CRM не попадают
    expect(thread.map((m) => [m.kind, m.text])).toEqual([
      ["system", "Чат на сайте: страница https://shop.test/prices · пришёл с google.com · метки: utm_source=google, utm_campaign=autumn"],
      ["message", "Здравствуйте!\nЕсть доставка?"],
    ]);
    expect(thread[1]).toMatchObject({ author: { type: "client" }, channel: "site", externalId: `site:${s.body.visitorId}:m-00000001` });
    expect(store.waitingSince("1")).toBe(thread[1]?.at);
    expect(contacts[0]).toBe(true);

    await send(s.auth, { clientMsgId: "m-00000002", text: "Жду ответа", page });
    expect(store.thread("1").filter((m) => m.kind === "system")).toHaveLength(1);
    expect(store.contacts.size).toBe(1);
  });

  it("повтор с тем же номером сообщения (обрыв связи) — duplicate, второй раз не записан", async () => {
    const { start, send, store } = setup();
    const s = await start();
    const body = { clientMsgId: "m-00000001", text: "Повтор после обрыва" };
    expect((await send(s.auth, body)).body).toEqual({ ok: true, duplicate: false });
    expect((await send(s.auth, body)).body).toEqual({ ok: true, duplicate: true });
    expect(store.thread("1").map((m) => m.text)).toEqual(["Повтор после обрыва"]);
  });

  it("проверки: номер сообщения обязателен, пустое — нет, длиннее 4000 знаков — нет, управляющие знаки убраны", async () => {
    const { start, send, store } = setup();
    const s = await start();
    expect((await send(s.auth, { text: "без номера" })).status).toBe(400);
    expect((await send(s.auth, { clientMsgId: "m-1", text: "короткий номер" })).status).toBe(400);
    expect(await send(s.auth, { clientMsgId: "m-00000001", text: "   \n " })).toMatchObject({ status: 422, body: { ok: false, field: "text" } });
    const long = await send(s.auth, { clientMsgId: "m-00000002", text: "я".repeat(4001) });
    expect(long).toMatchObject({ status: 422, body: { ok: false, field: "text" } });
    expect(long.body.error).toMatch(/4000/);
    expect((await send(s.auth, { clientMsgId: "m-00000003", text: "я".repeat(4000) })).status).toBe(200);
    await send(s.auth, { clientMsgId: "m-00000004", text: "При\u0000вет\u202E ми\u0007р\u200D!" });
    expect(store.thread("1").at(-1)?.text).toBe("Привет мир\u200D!");
    expect((await send(s.auth, "{не json" as unknown as Record<string, unknown>)).status).toBe(400);
  });

  it("файл base64: фото записано файлом с типом по содержимому и именем без папок; видно посетителю по подписанной ссылке", async () => {
    const { start, send, poll, store } = setup();
    const s = await start();
    const png = bytes.png();
    const r = await send(s.auth, { clientMsgId: "m-00000001", text: "Вот фото", file: { name: "C:\\fakepath\\фото", data: `data:image/png;base64,${b64(png)}` } });
    expect(r.status).toBe(200);
    const thread = store.thread("1");
    expect(thread.map((m) => m.text)).toEqual(["Вот фото", "фото.png"]);
    expect([...store.files.values()]).toMatchObject([{ mime: "image/png", ext: "png", name: "фото.png", fromClient: true, size: png.length }]);
    expect(thread[1]).toMatchObject({ author: { type: "client" }, externalId: `site:${s.body.visitorId}:m-00000001:file:0`, attachments: [{ name: "фото.png", mime: "image/png" }] });

    const p = await poll(s.auth);
    expect(p.body.messages).toHaveLength(2);
    expect(p.body.messages[1]).toMatchObject({ from: "visitor", text: "", clientMsgId: "m-00000001", attachment: { name: "фото.png", mime: "image/png", size: png.length } });
    expect(p.body.messages[1].attachment.url).toMatch(/^https:\/\/crm\.test\/files\/f1\?exp=\d+&sig=[\w-]{32}$/);

    // Только файл, без текста; PDF с неверным именем — имя поправлено по содержимому
    await send(s.auth, { clientMsgId: "m-00000002", file: { name: "скан.jpg", data: b64(bytes.pdf()) } });
    expect(store.thread("1").at(-1)).toMatchObject({ text: "скан.jpg.pdf", attachments: [{ mime: "application/pdf" }] });
  });

  it("файл: больше предела — 413, архив и не тот тип — 415, испорченный base64 — 400; огромный запрос — 413 до разбора", async () => {
    const { start, send, store } = setup({ maxFileBytes: 1024 });
    const s = await start();
    const bigPng = new Uint8Array(2048);
    bigPng.set(bytes.png().subarray(0, 8));
    expect(await send(s.auth, { clientMsgId: "m-00000001", file: { name: "big.png", data: b64(bigPng) } })).toMatchObject({ status: 413, body: { ok: false, field: "file" } });
    expect(await send(s.auth, { clientMsgId: "m-00000002", file: { name: "a.zip", data: b64(bytes.zip()) } })).toMatchObject({ status: 415, body: { field: "file" } });
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect((await send(s.auth, { clientMsgId: "m-00000003", file: { name: "x.svg", data: b64(svg) } })).status).toBe(415);
    expect((await send(s.auth, { clientMsgId: "m-00000004", file: { name: "x.png", data: "не base64!" } })).status).toBe(400);
    expect((await send(s.auth, { clientMsgId: "m-00000005", text: "x".repeat(70_000) })).status).toBe(413);
    expect(store.contacts.size).toBe(0);
  });

  it("download подключения: только «data:»-ссылки из виджета, по сети не ходит", async () => {
    const adapter = createSiteAdapter({ secret: SECRET });
    expect(await adapter.download!("https://evil.test/photo.png")).toEqual({ ok: false, reason: "bad" });
    expect(await adapter.download!(`data:application/zip;base64,${b64(bytes.zip())}`)).toEqual({ ok: false, reason: "bad" });
    const got = await adapter.download!(`data:image/png;base64,${b64(bytes.png())}`);
    expect(got).toMatchObject({ ok: true, mime: "image/png", ext: "png" });
  });
});

describe("форма перед чатом", () => {
  it("клиент заводится сразу с именем, телефоном и почтой; телефон из формы не подлинный — к клиенту с тем же номером не привязываем", async () => {
    const { call, store } = setup({ phoneCode: "+996" });
    await store.findOrCreateContact({ source: "whatsapp", externalId: "996555000001@c.us", channel: "whatsapp", phone: "+996555000001", phoneTrusted: true, name: "Клиент Тест" });
    const r = await call("POST", "start", { body: { profile: { name: "  Айгерим ", phone: "0555 00-00-01", email: "aigerim@example.com" }, page: { url: "https://shop.test/contacts" } } });
    expect(r).toMatchObject({ status: 200, body: { ok: true, resumed: false } });
    expect(store.contacts.size).toBe(2);
    expect(store.contacts.get("2")).toMatchObject({ name: "Айгерим", phone: "+996555000001", channel: "site", identities: [`site:${r.body.visitorId}`] });
    expect(store.thread("2").map((m) => m.text)).toEqual([
      "Чат на сайте: страница https://shop.test/contacts · представился: Айгерим, +996 555 00-00-01, aigerim@example.com",
    ]);
    expect(store.thread("1")).toEqual([]);
  });

  it("телефон и почта не того вида — 422 с полем; ничего не заведено", async () => {
    const { call, store } = setup();
    expect(await call("POST", "start", { body: { profile: { name: "Айгерим", phone: "12ab" } } })).toMatchObject({ status: 422, body: { ok: false, field: "phone" } });
    expect(await call("POST", "start", { body: { profile: { email: "не почта" } } })).toMatchObject({ status: 422, body: { field: "email" } });
    expect(store.contacts.size).toBe(0);
  });
});

describe("что видит посетитель", () => {
  it("свои сообщения и наши ответы; заметки, служебное, черновики бота, недоставленное, звонки, другие каналы и чужие копии — нет", async () => {
    const { start, send, poll, store } = setup({ botName: "Помощник" });
    const s = await start();
    await send(s.auth, { clientMsgId: "m-00000001", text: "Вопрос" });
    const add = (sec: number, m: Omit<Parameters<typeof store.saveMessage>[1], "at">) => store.saveMessage("1", { ...m, at: later(sec) });
    await add(1, { kind: "note", author: { type: "operator_crm", name: "Айгерим" }, channel: "site", text: "Заметка команды" });
    await add(2, { kind: "system", author: { type: "system" }, channel: "site", text: "Служебная строка" });
    await add(3, { kind: "message", author: { type: "bot" }, channel: "site", text: "Черновик бота", shadow: true });
    await add(4, { kind: "message", author: { type: "operator_crm", name: "Айгерим" }, channel: "site", text: "Не дошло", delivery: "failed" });
    await add(5, { kind: "message", author: { type: "operator_crm" }, channel: "whatsapp", text: "Из WhatsApp" });
    await add(6, { kind: "message", author: { type: "client" }, channel: "site", text: "Копия, внесённая менеджером" });
    await add(7, { kind: "call", author: { type: "client" }, channel: "call", text: "Входящий звонок" });
    await add(8, { kind: "message", author: { type: "bot" }, channel: "site", text: "**Цены** — [здесь](https://shop.test/prices)" });
    await add(9, { kind: "message", author: { type: "operator_crm", name: "Айгерим Тестова", id: "7" }, channel: "site", text: "Я на связи", delivery: "sent" });

    const p = await poll(s.auth);
    expect(p.body.messages.map((m: Record<string, unknown>) => [m.from, m.text, m.author])).toEqual([
      ["visitor", "Вопрос", null],
      ["company", "Цены — здесь (https://shop.test/prices)", "Помощник"],
      ["company", "Я на связи", null],
    ]);
    // Внутреннего в ответе нет: ни видов авторов, ни полных имён сотрудников
    expect(JSON.stringify(p.body)).not.toMatch(/operator_crm|Тестова/);

    // Второй посетитель видит только своё
    const other = await start();
    await send(other.auth, { clientMsgId: "m-00000009", text: "Я другой посетитель" });
    expect((await poll(other.auth)).body.messages.map((m: Record<string, unknown>) => m.text)).toEqual(["Я другой посетитель"]);
  });

  it("имя сотрудника — по желанию (первое слово); after — только новое; опрос без клиента (findContact) — пусто и без нового клиента", async () => {
    const { start, send, poll, store } = setup({ showAgentNames: true, online: () => false });
    const s = await start();
    await send(s.auth, { clientMsgId: "m-00000001", text: "Есть кто?" });
    const first = await poll(s.auth);
    expect(first.body).toMatchObject({ ok: true, online: false });
    await store.saveMessage("1", { kind: "message", author: { type: "operator_crm", name: "Айгерим Тестова" }, channel: "site", text: "Да, здесь", at: later(1), delivery: "sent" });
    const next = await poll(s.auth, first.body.messages[0].id);
    expect(next.body.messages).toEqual([
      { id: expect.any(String), at: expect.any(String), from: "company", text: "Да, здесь", author: "Айгерим", clientMsgId: null, attachment: null },
    ]);

    const t = setup({ findContact: async () => null });
    const v = await t.start();
    expect((await t.poll(v.auth)).body).toEqual({ ok: true, messages: [] });
    expect(t.store.contacts.size).toBe(0);
  });

  it("файл менеджера без fileUrl — только имя текстом", async () => {
    const { start, send, poll, store } = setup({ fileUrl: undefined });
    const s = await start();
    await send(s.auth, { clientMsgId: "m-00000001", text: "Пришлите прайс" });
    const { fileId } = await store.saveFile("1", { data: bytes.pdf(), mime: "application/pdf", ext: "pdf", name: "Прайс.pdf", sha1: "a", sha256: "b", fromClient: false });
    await store.saveMessage("1", { kind: "message", author: { type: "operator_crm" }, channel: "site", text: "Прайс.pdf", at: later(1), fileId });
    expect((await poll(s.auth)).body.messages[1]).toMatchObject({ from: "company", text: "Прайс.pdf", attachment: null });
  });
});

describe("CORS и частота", () => {
  it("предварительная проверка: разрешённый сайт — 204 с заголовками; чужой — 403 без них; сам сайт CRM и запросы без Origin — можно", async () => {
    const { call, store } = setup();
    const pre = await call("OPTIONS", "message", { headers: { "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe(SITE);
    expect(pre.headers.get("access-control-allow-methods")).toContain("POST");
    expect(pre.headers.get("access-control-allow-headers")).toContain("authorization");
    expect(pre.headers.get("vary")).toContain("Origin");

    const evil = await call("OPTIONS", "message", { origin: "https://evil.test" });
    expect(evil.status).toBe(403);
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    // Простой запрос с чужого сайта (без предварительной проверки) до CRM не доходит
    expect((await call("POST", "start", { origin: "https://evil.test", body: { profile: { name: "Спам" } } })).status).toBe(403);
    expect((await call("POST", "start", { origin: "null", body: {} })).status).toBe(403);
    expect(store.contacts.size).toBe(0);

    const ok = await call("POST", "start", { body: {} });
    expect(ok.headers.get("access-control-allow-origin")).toBe(SITE);
    expect((await call("POST", "start", { origin: "https://crm.test", body: {} })).status).toBe(200);
    const health = await call("GET", "", { origin: null });
    expect(health).toMatchObject({ status: 200, body: { ok: true } });
    expect(health.headers.get("access-control-allow-origin")).toBeNull();
    expect((await call("DELETE", "message")).status).toBe(405);
    expect((await call("POST", "nothing", { body: {} })).status).toBe(404);
  });

  it("«*» пускает любой сайт (только для проверок)", async () => {
    const { call } = setup({ origins: ["*"] });
    const r = await call("POST", "start", { origin: "https://any.test", body: {} });
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe("https://any.test");
  });

  it("сообщений от посетителя больше предела — 429 с Retry-After; через минуту — снова можно", async () => {
    let now = Date.parse("2026-09-27T08:00:00Z");
    const { start, send } = setup({ limits: { visitorMessages: 3 }, now: () => now });
    const s = await start();
    for (let i = 1; i <= 3; i++) expect((await send(s.auth, { clientMsgId: `m-0000000${i}`, text: `№${i}` })).status).toBe(200);
    const r = await send(s.auth, { clientMsgId: "m-00000004", text: "ещё" });
    expect(r).toMatchObject({ status: 429, body: { ok: false, retryable: true } });
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    now += 61_000;
    expect((await send(s.auth, { clientMsgId: "m-00000004", text: "ещё" })).status).toBe(200);
  });

  it("новых посетителей с одного адреса больше предела — 429; с другого адреса — можно; все запросы с адреса — тоже предел", async () => {
    const { start, call } = setup({ limits: { ipSessions: 2 } });
    expect((await start()).status).toBe(200);
    expect((await start()).status).toBe(200);
    expect((await start()).status).toBe(429);
    expect((await start({}, { ip: "203.0.113.9" })).status).toBe(200);

    const t = setup({ limits: { ipRequests: 2 } });
    await t.call("GET", "");
    await t.call("GET", "");
    expect((await t.call("GET", "")).status).toBe(429);
    expect((await call("GET", "", { ip: "203.0.113.10" })).status).toBe(200);
  });

  it("счётчики: окно, предел 0 — без ограничения, старые ключи выбрасываются", () => {
    const lim = createRateLimiter(3);
    const t0 = 1_000_000;
    expect([lim.hit("a", 2, 1000, t0), lim.hit("a", 2, 1000, t0), lim.hit("a", 2, 1000, t0 + 500)]).toEqual([0, 0, 1]);
    expect(lim.hit("a", 2, 1000, t0 + 1000)).toBe(0);
    expect(lim.hit("b", 0, 1000, t0)).toBe(0);
    for (const k of ["c", "d", "e", "f"]) lim.hit(k, 1, 60_000, t0 + 1000);
    expect(lim.hit("f", 1, 60_000, t0 + 1000)).toBeGreaterThan(0);
  });
});

describe("подключение", () => {
  it("send только подтверждает (ответ уже в базе проекта, виджет заберёт его сам); умеет текст и файлы, без статусов и «написать первым»", async () => {
    const a = createSiteAdapter({ secret: SECRET });
    expect(a.kind).toBe("site");
    expect(a.caps).toEqual(SITE_CAPS);
    expect(a.caps).toMatchObject({ text: true, files: true, statuses: false, start: false, pause: false, mute: false });
    const { visitorId } = a.issue();
    expect(await a.send({ externalId: visitorId }, { text: "Здравствуйте!" })).toEqual({ ok: true, externalId: null });
    expect(await a.send({ externalId: "12345" }, { text: "x" })).toMatchObject({ ok: false });
  });
});
