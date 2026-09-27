import { createHash, createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createZadarmaAdapter, verifyZadarmaSignature, zadarmaEcho, zadarmaEchoResponse, zadarmaQuery, zadarmaRecordingLink, zadarmaSign,
  type ZadarmaOptions,
} from "../../../src/channels/calls/index.js";
import { createMemoryStore, ingest, jsonResponse, readWebhook, type KeyValue, type WebhookInput } from "../../../src/server/index.js";
import { audio, fakeNet } from "./net.js";

// Уведомления Zadarma на переходнике «в памяти» и поддельной сети. Ключи, номера и номера звонков — вымышленные.

const KEY = "test-secret-not-real-zadarma-key";
const SECRET = "test-secret-not-real-zadarma-secret";
const NOW = Date.parse("2026-09-27T08:30:00Z");
const PBX = "in_000000000000000000000000000000000001";
const REC_ID = "1790000000.0000001";

/* Подпись считаем здесь сами, не кодом набора: base64 от шестнадцатеричного HMAC-SHA1 подписанных полей */
const SIGNED: Record<string, string[]> = {
  NOTIFY_START: ["caller_id", "called_did", "call_start"],
  NOTIFY_END: ["caller_id", "called_did", "call_start"],
  NOTIFY_ANSWER: ["caller_id", "destination", "call_start"],
  NOTIFY_OUT_START: ["internal", "destination", "call_start"],
  NOTIFY_OUT_END: ["internal", "destination", "call_start"],
  NOTIFY_RECORD: ["pbx_call_id", "call_id_with_rec"],
};
const hmacB64 = (data: string, secret: string) => Buffer.from(createHmac("sha1", secret).update(data).digest("hex"), "utf8").toString("base64");
function sign(fields: Record<string, string>, secret = SECRET): string {
  return hmacB64((SIGNED[fields.event ?? ""] ?? []).map((k) => fields[k] ?? "").join(""), secret);
}
/** Уведомление, как его шлёт Zadarma: поля формы и заголовок Signature */
function zd(fields: Record<string, string>, o: { secret?: string; signature?: string | null } = {}): WebhookInput {
  const signature = o.signature === undefined ? sign(fields, o.secret) : o.signature;
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(signature ? { signature } : {}) },
    body: new URLSearchParams(fields).toString(),
  };
}

const END = {
  event: "NOTIFY_END", call_start: "2026-09-27 14:00:00", pbx_call_id: PBX, caller_id: "996555000001", called_did: "996555000009",
  internal: "101", duration: "125", disposition: "answered", status_code: "16", is_recorded: "0", call_id_with_rec: "",
};
const OUT_END = {
  event: "NOTIFY_OUT_END", call_start: "2026-09-27 14:10:00", pbx_call_id: "out_000000000000000000000000000000000002", caller_id: "996555000009",
  destination: "0555000002", internal: "102", duration: "45", disposition: "answered", status_code: "16", is_recorded: "0", call_id_with_rec: "",
};
const RECORD = { event: "NOTIFY_RECORD", pbx_call_id: PBX, call_id_with_rec: REC_ID };
const RECORDED_END = { ...END, is_recorded: "1", call_id_with_rec: REC_ID };
const REC_URL = `https://records.zadarma.test/rec/${REC_ID}.mp3`;

function setup(o: Partial<ZadarmaOptions> = {}) {
  const net = fakeNet();
  const store = createMemoryStore({ countryCode: "+996" });
  const kv = new Map<string, string>();
  const state: KeyValue = { get: async (k) => kv.get(k) ?? null, set: async (k, v) => { kv.set(k, v); } };
  const adapter = createZadarmaAdapter({
    key: KEY, secret: SECRET, countryCode: "+996", managers: { "101": "Айгерим", "102": "Бакыт" }, timeZone: "Asia/Bishkek",
    state, fetch: net.fetch, now: () => NOW, ...o,
  });
  const jobs: (() => Promise<void>)[] = [];
  const post = (input: WebhookInput) => ingest(adapter, store, input, { now: () => NOW, later: (job) => { jobs.push(job); } });
  /** Выполнить то, что набор отложил на после ответа Zadarma (в Next.js — after) */
  const afterResponse = async () => { for (const job of jobs.splice(0)) await job(); };
  return { net, store, kv, adapter, post, afterResponse };
}

describe("Zadarma: подпись уведомлений", () => {
  it("base64 от hex HMAC-SHA1 подписанных полей; изменённое поле, чужой секрет, пустой секрет, незнакомое событие — неверна", () => {
    expect(zadarmaSign("abc", SECRET)).toBe(hmacB64("abc", SECRET));
    const f = new URLSearchParams(END);
    expect(verifyZadarmaSignature(f, sign(END), SECRET)).toBe(true);
    expect(verifyZadarmaSignature(new URLSearchParams({ ...END, caller_id: "996555000002" }), sign(END), SECRET)).toBe(false);
    expect(verifyZadarmaSignature(f, sign(END, "test-secret-not-real-other"), SECRET)).toBe(false);
    expect(verifyZadarmaSignature(f, sign(END), "")).toBe(false);
    expect(verifyZadarmaSignature(f, undefined, SECRET)).toBe(false);
    expect(verifyZadarmaSignature(new URLSearchParams({ ...END, event: "NOTIFY_SOMETHING" }), sign(END), SECRET)).toBe(false);
    // Длительность и итог подписью не закрыты — так устроено у Zadarma (оговорка в описании)
    expect(verifyZadarmaSignature(new URLSearchParams({ ...END, duration: "999" }), sign(END), SECRET)).toBe(true);
    // Каждому событию — свои поля
    expect(verifyZadarmaSignature(new URLSearchParams(OUT_END), sign(OUT_END), SECRET)).toBe(true);
    expect(verifyZadarmaSignature(new URLSearchParams(RECORD), sign(RECORD), SECRET)).toBe(true);
    const answer = { event: "NOTIFY_ANSWER", caller_id: "996555000001", destination: "101", call_start: "2026-09-27 14:00:00", pbx_call_id: PBX };
    expect(verifyZadarmaSignature(new URLSearchParams(answer), sign(answer), SECRET)).toBe(true);
  });

  it("без подписи и с неверной — 401, ничего не записано", async () => {
    const { post, store } = setup();
    expect((await post(zd(END, { signature: null }))).status).toBe(401);
    expect((await post(zd(END, { secret: "test-secret-not-real-other" }))).status).toBe(401);
    expect((await post(zd({ ...END, disposition: "busy" }, { signature: sign({ ...END, caller_id: "996555000002" }) }))).status).toBe(401);
    expect(store.contacts.size).toBe(0);
  });

  it("начало звонка и ответ сотрудника — подпись проверена, пропущено (200); незнакомое уведомление — пропущено", async () => {
    const { post, store } = setup();
    const start = { event: "NOTIFY_START", call_start: "2026-09-27 14:00:00", pbx_call_id: PBX, caller_id: "996555000001", called_did: "996555000009" };
    const r = await post(zd(start));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: false, status: "ignored" });
    expect((await post(zd(start, { signature: null }))).status).toBe(401);
    const outStart = { event: "NOTIFY_OUT_START", call_start: "2026-09-27 14:00:00", pbx_call_id: PBX, destination: "996555000001", internal: "101", caller_id: "996555000009" };
    expect((await post(zd(outStart))).body).toMatchObject({ status: "ignored" });
    expect((await post(zd({ event: "NOTIFY_IVR", caller_id: "996555000001" }, { signature: "x" }))).body).toMatchObject({ status: "ignored" });
    expect(store.contacts.size).toBe(0);
  });
});

describe("Zadarma: строка звонка", () => {
  it("NOTIFY_END answered — входящий разговор: клиент по caller_id, время по поясу кабинета, сотрудник по internal; повтор — duplicate", async () => {
    const { post, store } = setup();
    const r = await post(zd(END));
    expect(r.body).toMatchObject({ ok: true, status: "ok", contact_id: "1" });
    expect(store.contacts.get("1")).toMatchObject({ phone: "+996555000001", channel: "call", identities: ["calls:+996555000001"] });
    expect(store.thread("1")[0]).toMatchObject({
      kind: "call", author: { type: "client" }, text: "Входящий звонок, 2 мин 05 с", at: "2026-09-27T08:00:00.000Z", externalId: `call:zadarma:${PBX}`,
      call: { direction: "in", missed: false, durationSec: 125, manager: "Айгерим" },
    });
    expect(store.waitingSince("1")).toBeNull();
    expect((await post(zd(END))).body).toMatchObject({ status: "duplicate" });
    expect(store.thread("1")).toHaveLength(1);
  });

  it("NOTIFY_END no answer и busy — пропущенный: клиент ждёт ответа с начала звонка", async () => {
    const { post, store } = setup();
    await post(zd({ ...END, disposition: "no answer", duration: "0", internal: "" }));
    expect(store.thread("1")[0]).toMatchObject({ text: "Пропущенный звонок", call: { missed: true, durationSec: null, manager: null } });
    expect(store.waitingSince("1")).toBe("2026-09-27T08:00:00.000Z");
    await post(zd({ ...END, pbx_call_id: "in_000000000000000000000000000000000003", call_start: "2026-09-27 14:05:00", disposition: "busy", duration: "0" }));
    expect(store.thread("1").map((m) => m.text)).toEqual(["Пропущенный звонок", "Пропущенный звонок"]);
    expect(store.waitingSince("1")).toBe("2026-09-27T08:00:00.000Z");
  });

  it("NOTIFY_OUT_END — исходящий: клиент по destination, звонил сотрудник internal; cancel — «Не дозвонились», ожидание не меняет", async () => {
    const { post, store } = setup();
    await post(zd(OUT_END));
    expect(store.contacts.get("1")?.phone).toBe("+996555000002");
    expect(store.thread("1")[0]).toMatchObject({
      author: { type: "operator_phone", name: "Бакыт" }, text: "Исходящий звонок, 45 с", at: "2026-09-27T08:10:00.000Z",
      call: { direction: "out", missed: false, durationSec: 45, manager: "Бакыт" },
    });
    await post(zd({ ...OUT_END, pbx_call_id: "out_000000000000000000000000000000000004", call_start: "2026-09-27 14:12:00", disposition: "cancel", duration: "0" }));
    expect(store.thread("1")[1]).toMatchObject({ text: "Не дозвонились", author: { type: "operator_phone", name: "Бакыт" }, call: { missed: true } });
    expect(store.waitingSince("1")).toBeNull();
  });

  it("без пояса кабинета — начало звонка = приход уведомления минус длительность; скрытый номер — пропущено", async () => {
    const { post, store } = setup({ timeZone: undefined });
    await post(zd(END));
    expect(store.thread("1")[0]?.at).toBe(new Date(NOW - 125_000).toISOString());
    const hidden = await post(zd({ ...END, pbx_call_id: "in_000000000000000000000000000000000005", caller_id: "anonymous" }));
    expect(hidden.status).toBe(200);
    expect(hidden.body).toMatchObject({ status: "ignored" });
    expect(store.contacts.size).toBe(1);
  });

  it("маршрут: заголовок Signature любыми буквами → readWebhook → ingest → jsonResponse", async () => {
    const { adapter, store } = setup();
    const req = new Request("https://crm.example/api/calls/zadarma", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Signature: sign(END) }, body: new URLSearchParams(END).toString(),
    });
    const input = await readWebhook(req);
    const res = jsonResponse(await ingest(adapter, store, input!, { now: () => NOW }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "ok" });
    expect(store.thread("1")).toHaveLength(1);
  });
});

describe("Zadarma: запись разговора", () => {
  it("NOTIFY_RECORD после конца звонка: ссылка у API с подписью, скачана после ответа, прикреплена к строке звонка", async () => {
    const { post, store, net, kv, afterResponse } = setup();
    net.files.set(REC_URL, audio.mp3());
    await post(zd(RECORDED_END));
    await afterResponse();
    expect(net.seen).toHaveLength(0);
    expect(kv.size).toBe(1); // звонок запомнен до прихода записи
    expect(store.thread("1")[0]?.attachments).toBeUndefined();

    const r = await post(zd(RECORD));
    expect(r.body).toMatchObject({ ok: true, status: "ok", contact_id: "1" });
    expect(net.seen).toHaveLength(0); // Zadarma уже получила ответ, запись ещё не качали
    await afterResponse();

    // Запрос ссылки: подпись посчитана здесь независимо — путь + параметры + md5(параметры)
    const q = `call_id=${REC_ID}&format=json`;
    const md5 = createHash("md5").update(q).digest("hex");
    expect(net.seen[0]).toMatchObject({ url: `https://api.zadarma.com/v1/pbx/record/request/?${q}`, method: "GET" });
    expect(net.seen[0]?.headers.get("authorization")).toBe(`${KEY}:${hmacB64(`/v1/pbx/record/request/${q}${md5}`, SECRET)}`);
    expect(net.seen[1]?.url).toBe(REC_URL);

    const thread = store.thread("1");
    expect(thread).toHaveLength(1);
    expect(thread[0]?.attachments?.[0]).toMatchObject({ name: "Запись разговора", mime: "audio/mpeg" });
    expect(store.files.get(thread[0]!.attachments![0]!.id)).toMatchObject({ sourceUrl: `zadarma-record:call:${REC_ID}`, fromClient: true });

    // Повтор уведомления о записи — второй раз не качаем
    expect((await post(zd(RECORD))).body).toMatchObject({ status: "duplicate" });
    await afterResponse();
    expect(net.seen).toHaveLength(2);
  });

  it("NOTIFY_RECORD раньше конца звонка — запомнили; пришёл конец звонка — запись прикрепляется сразу после ответа", async () => {
    const { post, store, net, afterResponse } = setup();
    net.files.set(REC_URL, audio.mp3());
    const early = await post(zd(RECORD));
    expect(early.status).toBe(200);
    expect(early.body).toMatchObject({ ok: false, status: "ignored" });
    expect(store.contacts.size).toBe(0);

    await post(zd(RECORDED_END));
    expect(store.thread("1")[0]?.attachments).toBeUndefined();
    await afterResponse();
    expect(store.thread("1")[0]?.attachments?.[0]?.mime).toBe("audio/mpeg");
  });

  it("без state — память процесса: конец звонка и запись встречаются", async () => {
    const { post, store, net, afterResponse } = setup({ state: undefined, key: "test-secret-not-real-zadarma-key-2" });
    net.files.set(REC_URL, audio.mp3());
    await post(zd({ ...RECORDED_END, pbx_call_id: "in_000000000000000000000000000000000006" }));
    await post(zd({ ...RECORD, pbx_call_id: "in_000000000000000000000000000000000006" }));
    await afterResponse();
    expect(store.thread("1")[0]?.attachments?.[0]?.mime).toBe("audio/mpeg");
  });

  it("«ключ → значение» проекта не работает — строка звонка всё равно записана", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken: KeyValue = {
      get: async () => { throw new Error("нет связи с базой"); },
      set: async () => { throw new Error("нет связи с базой"); },
    };
    const { post, store } = setup({ state: broken });
    expect((await post(zd(RECORDED_END))).body).toMatchObject({ ok: true, status: "ok" });
    expect(store.thread("1")).toHaveLength(1);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("download: ссылка подключения — ссылка у API, затем файл; не звук — не берём; API не знает запись — «нет файла»", async () => {
    const { adapter, net } = setup();
    net.files.set("https://records.zadarma.test/rec/r9.mp3", audio.wav());
    expect(await adapter.download("zadarma-record:call:r9")).toMatchObject({ ok: true, mime: "audio/wav", ext: "wav" });
    net.files.set("https://records.zadarma.test/rec/r8.mp3", audio.pdf());
    expect(await adapter.download("zadarma-record:call:r8")).toEqual({ ok: false, reason: "bad" });
    expect(await adapter.download("zadarma-record:bogus")).toEqual({ ok: false, reason: "bad" });
    net.setZadarma(() => net.json({ status: "error", message: "record not found" }));
    expect(await adapter.download("zadarma-record:call:r7")).toEqual({ ok: false, reason: "missing" });
    net.setZadarma(() => new Response("busy", { status: 503 }));
    expect(await adapter.download("zadarma-record:pbx:r6")).toEqual({ ok: false, reason: "retry" });
  });
});

describe("Zadarma: ссылка на запись через API", () => {
  it("подпись запроса посчитана независимо; по pbx_call_id — все ссылки (только https); ошибки — словами, сбой — «попробовать потом»", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    let reply: () => Response = () => new Response(JSON.stringify({
      status: "success", links: ["https://records.zadarma.test/a.mp3", "https://records.zadarma.test/b.mp3", "http://insecure.example/c.mp3"],
    }));
    const fake = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
      return reply();
    }) as typeof fetch;

    const r = await zadarmaRecordingLink({ key: KEY, secret: SECRET, pbxCallId: PBX, lifetimeSec: 3600, fetch: fake });
    expect(r).toEqual({ ok: true, links: ["https://records.zadarma.test/a.mp3", "https://records.zadarma.test/b.mp3"] });
    const q = `format=json&lifetime=3600&pbx_call_id=${PBX}`;
    const md5 = createHash("md5").update(q).digest("hex");
    expect(seen[0]).toEqual({ url: `https://api.zadarma.com/v1/pbx/record/request/?${q}`, auth: `${KEY}:${hmacB64(`/v1/pbx/record/request/${q}${md5}`, SECRET)}` });

    reply = () => new Response(JSON.stringify({ status: "error", message: "Record not found" }));
    expect(await zadarmaRecordingLink({ key: KEY, secret: SECRET, callId: REC_ID, fetch: fake })).toEqual({
      ok: false, error: "Zadarma не дала ссылку на запись: Record not found", retryable: false,
    });
    reply = () => new Response("bad gateway", { status: 502 });
    expect(await zadarmaRecordingLink({ key: KEY, secret: SECRET, callId: REC_ID, fetch: fake })).toMatchObject({ ok: false, retryable: true });
    reply = () => new Response(JSON.stringify({ status: "error", message: "Not authorized" }), { status: 401 });
    expect(await zadarmaRecordingLink({ key: KEY, secret: SECRET, callId: REC_ID, fetch: fake })).toMatchObject({ ok: false, error: expect.stringMatching(/ключ API/), retryable: false });
    reply = () => { throw new TypeError("fetch failed"); };
    expect(await zadarmaRecordingLink({ key: KEY, secret: SECRET, callId: REC_ID, fetch: fake })).toEqual({ ok: false, error: "Нет связи с Zadarma", retryable: true });
    // Zadarma молчит — ждём не дольше timeoutMs
    const hang = ((_: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))); })) as typeof fetch;
    expect(await zadarmaRecordingLink({ key: KEY, secret: SECRET, callId: REC_ID, fetch: hang, timeoutMs: 50 })).toEqual({ ok: false, error: "Zadarma не ответила за 1 с", retryable: true });
    const before = seen.length;
    expect(await zadarmaRecordingLink({ key: KEY, secret: SECRET, fetch: fake })).toMatchObject({ ok: false, retryable: false });
    expect(seen.length).toBe(before);
  });

  it("параметры — как PHP http_build_query: ключи по алфавиту, пробел — «+», служебные знаки — %XX", () => {
    expect(zadarmaQuery({ b: "x y", a: "1*2~3", c: "a.b-c_d" })).toBe("a=1%2A2%7E3&b=x+y&c=a.b-c_d");
  });
});

describe("Zadarma: проверка адреса (zd_echo)", () => {
  it("слово проверки — обратно простым текстом; чужие знаки и обычный запрос — нет; GET в receive — 405", async () => {
    expect(zadarmaEcho("https://crm.example/api/calls/zadarma?zd_echo=a1B2c3")).toBe("a1B2c3");
    expect(zadarmaEcho("/api/calls/zadarma?zd_echo=a1B2c3")).toBe("a1B2c3");
    expect(zadarmaEcho("https://crm.example/api/calls/zadarma?zd_echo=%3Cscript%3E")).toBeNull();
    expect(zadarmaEcho("https://crm.example/api/calls/zadarma")).toBeNull();
    expect(zadarmaEcho(null)).toBeNull();
    const res = zadarmaEchoResponse(new Request("https://crm.example/api/calls/zadarma?zd_echo=a1B2c3"));
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await res?.text()).toBe("a1B2c3");
    expect(zadarmaEchoResponse(new Request("https://crm.example/api/calls/zadarma"))).toBeNull();
    const { post } = setup();
    expect((await post({ method: "GET", headers: {}, body: "" })).status).toBe(405);
  });
});
