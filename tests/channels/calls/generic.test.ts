import { describe, expect, it, vi } from "vitest";
import { CALLS_CAPS, createCallsAdapter, managerName, parseStartedAt, zonedIso, type CallsOptions } from "../../../src/channels/calls/index.js";
import { createMemoryStore, ingest, type ChatStore, type MemoryStore } from "../../../src/server/index.js";
import { audio, fakeNet } from "./net.js";

// Общий вебхук телефонии на переходнике «в памяти» и поддельной сети. Номера — из нулей, имена и ключи — вымышленные.

const TOKEN = "test-secret-not-real-calls-token";
const NOW = Date.parse("2026-09-27T08:30:00Z");
const REC = "https://pbx.example/records/r1.mp3";

function setup(o: Partial<CallsOptions> = {}, store: ChatStore = createMemoryStore({ countryCode: "+996" })) {
  const net = fakeNet();
  const adapter = createCallsAdapter({ token: TOKEN, countryCode: "+996", managers: { "101": "Айгерим" }, fetch: net.fetch, ...o });
  const jobs: (() => Promise<void>)[] = [];
  const post = (body: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) =>
    ingest(adapter, store, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }, {
      now: () => NOW, later: (job) => { jobs.push(job); },
    });
  /** Выполнить то, что набор отложил на после ответа АТС (в Next.js — after) */
  const afterResponse = async () => { for (const job of jobs.splice(0)) await job(); };
  return { net, adapter, post, afterResponse, jobs };
}

function memory(): MemoryStore {
  return createMemoryStore({ countryCode: "+996" });
}

describe("общий вебхук: строка звонка в ленте", () => {
  it("входящий разговор: клиент по номеру from, время начала, длительность, сотрудник по внутреннему номеру; клиент не ждёт", async () => {
    const store = memory();
    const { post } = setup({}, store);
    const r = await post({
      id: "a1", direction: "in", from: "0555 00-00-01", to: "+996 555 00-00-09", startedAt: "2026-09-27T14:00:00+06:00",
      answered: true, durationSec: 185, manager: { extension: "101" },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, status: "ok", contact_id: "1" });
    expect(store.contacts.get("1")).toMatchObject({ phone: "+996555000001", channel: "call", identities: ["calls:+996555000001"] });
    const thread = store.thread("1");
    expect(thread).toHaveLength(1);
    expect(thread[0]).toMatchObject({
      kind: "call", channel: "call", author: { type: "client" }, text: "Входящий звонок, 3 мин 05 с", at: "2026-09-27T08:00:00.000Z", externalId: "call:a1",
      call: { direction: "in", missed: false, durationSec: 185, manager: "Айгерим" },
    });
    expect(store.waitingSince("1")).toBeNull();
  });

  it("исходящий разговор: клиент по номеру to, автор — сотрудник с телефона; время — Unix-секунды", async () => {
    const store = memory();
    const { post } = setup({}, store);
    const started = Date.parse("2026-09-27T08:20:00Z") / 1000;
    await post({ id: "a2", direction: "out", from: "102", to: "996555000002", startedAt: started, answered: true, durationSec: 45, manager: { name: "Бакыт", extension: "102" } });
    const [m] = store.thread("1");
    expect(m).toMatchObject({
      author: { type: "operator_phone", name: "Бакыт" }, text: "Исходящий звонок, 45 с", at: "2026-09-27T08:20:00.000Z",
      call: { direction: "out", missed: false, durationSec: 45, manager: "Бакыт" },
    });
    expect(store.contacts.get("1")?.phone).toBe("+996555000002");
  });

  it("пропущенный входящий — клиент ждёт ответа; не дозвонились в ответ — всё ещё ждёт; перезвонили и поговорили — не ждёт", async () => {
    const store = memory();
    const { post } = setup({}, store);
    await post({ id: "m1", direction: "in", from: "+996555000003", startedAt: "2026-09-27T08:05:00Z", answered: false, durationSec: 20, manager: { extension: "101" } });
    const [missed] = store.thread("1");
    // У пропущенного никто не говорил, а 20 секунд — время звонков в трубке, не разговор
    expect(missed).toMatchObject({ text: "Пропущенный звонок", author: { type: "client" }, call: { direction: "in", missed: true, durationSec: null, manager: null } });
    expect(store.waitingSince("1")).toBe("2026-09-27T08:05:00.000Z");

    await post({ id: "m2", direction: "out", to: "+996555000003", startedAt: "2026-09-27T08:07:00Z", answered: false, manager: { extension: "101" } });
    expect(store.thread("1")[1]).toMatchObject({ text: "Не дозвонились", author: { type: "operator_phone", name: "Айгерим" }, call: { missed: true, manager: "Айгерим" } });
    expect(store.waitingSince("1")).toBe("2026-09-27T08:05:00.000Z");

    await post({ id: "m3", direction: "out", to: "+996555000003", startedAt: "2026-09-27T08:10:00Z", answered: true, durationSec: 60, manager: { extension: "101" } });
    expect(store.waitingSince("1")).toBeNull();
    expect(store.thread("1").map((m) => m.text)).toEqual(["Пропущенный звонок", "Не дозвонились", "Исходящий звонок, 1 мин 00 с"]);
  });

  it("повтор того же звонка (тот же id) — одна строка, ответ «duplicate»", async () => {
    const store = memory();
    const { post } = setup({}, store);
    const body = { id: 7001, direction: "in", from: "+996555000001", answered: true, durationSec: 5 };
    expect((await post(body)).body).toMatchObject({ status: "ok" });
    expect((await post(body)).body).toMatchObject({ status: "duplicate" });
    expect(store.thread("1")).toHaveLength(1);
    expect(store.thread("1")[0]?.externalId).toBe("call:7001");
  });

  it("status вместо answered; clientPhone главнее from; время без пояса — по поясу АТС, без timeZone — время приёма", async () => {
    const store = memory();
    const { post } = setup({ timeZone: "Asia/Bishkek" }, store);
    await post({ id: "s1", direction: "in", from: "+996555000009", clientPhone: "0555 00-00-04", status: "NO ANSWER", startedAt: "2026-09-27 14:15:00" });
    expect(store.contacts.get("1")?.phone).toBe("+996555000004");
    expect(store.thread("1")[0]).toMatchObject({ text: "Пропущенный звонок", at: "2026-09-27T08:15:00.000Z" });
    await post({ id: "s2", direction: "in", from: "+996555000004", status: "ANSWERED", durationSec: 10, startedAt: "2026-09-27 14:20:00" });
    expect(store.thread("1")[1]).toMatchObject({ text: "Входящий звонок, 10 с", at: "2026-09-27T08:20:00.000Z" });

    const plain = memory();
    const noZone = setup({}, plain);
    await noZone.post({ id: "s3", direction: "in", from: "+996555000004", answered: true, startedAt: "2026-09-27 14:15:00" });
    expect(plain.thread("1")[0]?.at).toBe(new Date(NOW).toISOString());
  });

  it("клиент с тем же номером уже писал в WhatsApp — звонок встаёт в его карточку", async () => {
    const store = memory();
    const c = await store.findOrCreateContact({ source: "test-wa", externalId: "996555000005@c.us", channel: "whatsapp", phone: "+996555000005", phoneTrusted: true, name: "Клиент Тест" });
    const { post } = setup({}, store);
    await post({ id: "w1", direction: "in", from: "0555000005", answered: false });
    expect(store.contacts.size).toBe(1);
    expect(store.thread(c.contactId).map((m) => m.kind)).toEqual(["call"]);
    expect(store.waitingSince(c.contactId)).not.toBeNull();
  });
});

describe("общий вебхук: ключ и проверки", () => {
  const body = { id: "k1", direction: "in", from: "+996555000001", answered: true };

  it("без ключа, с чужим, не Bearer — 401 и ничего не записано; X-Api-Key тоже понимаем", async () => {
    const store = memory();
    const { post } = setup({}, store);
    expect((await post(body, {})).status).toBe(401);
    expect((await post(body, { authorization: "Bearer test-secret-not-real-other-token" })).status).toBe(401);
    expect((await post(body, { authorization: `Basic ${TOKEN}` })).status).toBe(401);
    expect(store.contacts.size).toBe(0);
    expect((await post(body, { "x-api-key": TOKEN })).status).toBe(200);
  });

  it("ключ приёма в проекте не задан или короткий — 401 для всех, с подсказкой", async () => {
    const empty = setup({ token: "" }, memory());
    expect((await empty.post(body, { authorization: "Bearer " })).status).toBe(401);
    const short = setup({ token: "short" }, memory());
    const r = await short.post(body, { authorization: "Bearer short" });
    expect(r.status).toBe(401);
    expect(String((r.body as { error: string }).error)).toMatch(/16 знаков/);
  });

  it("не JSON и не объект — 400; нет id, направления, номера или answered — 422 с названием поля; скрытый номер — 200, пропущено", async () => {
    const store = memory();
    const { post } = setup({}, store);
    const err = async (b: unknown) => {
      const r = await post(b);
      return { status: r.status, error: String((r.body as { error?: string }).error ?? "") };
    };
    expect((await err("{не json")).status).toBe(400);
    expect((await err([body])).status).toBe(400);
    expect(await err({ ...body, id: "" })).toMatchObject({ status: 422, error: expect.stringMatching(/id/) });
    expect(await err({ ...body, direction: "sideways" })).toMatchObject({ status: 422, error: expect.stringMatching(/direction/) });
    expect(await err({ id: "k2", direction: "in", to: "+996555000001", answered: true })).toMatchObject({ status: 422, error: expect.stringMatching(/from/) });
    expect(await err({ id: "k3", direction: "out", from: "+996555000001", answered: true })).toMatchObject({ status: 422, error: expect.stringMatching(/to/) });
    expect(await err({ id: "k4", direction: "in", from: "+996555000001" })).toMatchObject({ status: 422, error: expect.stringMatching(/answered/) });
    const hidden = await post({ id: "k5", direction: "in", from: "anonymous", answered: false });
    expect(hidden.status).toBe(200);
    expect(hidden.body).toMatchObject({ ok: false, status: "ignored" });
    expect((await post({ id: "k6", direction: "in", from: "101", answered: true })).body).toMatchObject({ status: "ignored" });
    expect(store.contacts.size).toBe(0);
  });

  it("GET — 405", async () => {
    const { adapter } = setup();
    expect(await adapter.receive({ method: "GET", headers: { authorization: `Bearer ${TOKEN}` }, body: "" })).toMatchObject({ ok: false, status: 405 });
  });
});

describe("общий вебхук: запись разговора", () => {
  it("скачивается после ответа АТС и прикрепляется к строке звонка; повтор уведомления второй раз не качает", async () => {
    const store = memory();
    const { post, net, afterResponse } = setup({}, store);
    net.files.set(REC, audio.mp3());
    const body = { id: "r1", direction: "in", from: "+996555000005", answered: true, durationSec: 30, recordUrl: REC };
    const r = await post(body);
    expect(r.body).toMatchObject({ ok: true, status: "ok" });
    // АТС уже получила ответ, а запись ещё не качали
    expect(net.seen).toHaveLength(0);
    expect(store.thread("1")[0]?.attachments).toBeUndefined();

    await afterResponse();
    const thread = store.thread("1");
    expect(thread).toHaveLength(1);
    expect(thread[0]?.attachments?.[0]).toMatchObject({ name: "Запись разговора", mime: "audio/mpeg" });
    expect(store.files.get(thread[0]!.attachments![0]!.id)).toMatchObject({ sourceUrl: REC, fromClient: true, ext: "mp3" });
    expect(store.events.at(-1)).toEqual({ contactId: "1", kind: "file" });

    const again = await post(body);
    await afterResponse();
    expect(again.body).toMatchObject({ status: "duplicate" });
    expect(net.seen).toHaveLength(1);
    expect(store.files.size).toBe(1);
  });

  it("запись готова позже: тот же звонок ещё раз со ссылкой — строка одна, запись прикрепилась", async () => {
    const store = memory();
    const { post, net, afterResponse } = setup({}, store);
    const url = "https://pbx.example/records/r2.wav";
    net.files.set(url, audio.wav());
    const body = { id: "r2", direction: "out", to: "+996555000006", answered: true, durationSec: 12, manager: { extension: "101" } };
    await post(body);
    await afterResponse();
    expect(store.thread("1")[0]?.attachments).toBeUndefined();

    const later = await post({ ...body, recordUrl: url });
    expect(later.body).toMatchObject({ ok: true, status: "ok" });
    await afterResponse();
    const thread = store.thread("1");
    expect(thread).toHaveLength(1);
    expect(thread[0]).toMatchObject({ text: "Исходящий звонок, 12 с", author: { type: "operator_phone", name: "Айгерим" } });
    expect(thread[0]?.attachments?.[0]?.mime).toBe("audio/wav");
    expect(store.files.get(thread[0]!.attachments![0]!.id)?.fromClient).toBe(false);
  });

  it("у переходника нет updateMessage — запись отдельной строкой сразу за звонком", async () => {
    const mem = memory();
    const { updateMessage: _without, ...store } = mem;
    const { post, net, afterResponse } = setup({}, store);
    net.files.set(REC, audio.mp3());
    await post({ id: "r3", direction: "in", from: "+996555000007", startedAt: "2026-09-27T08:00:00Z", answered: true, durationSec: 30, recordUrl: REC });
    await afterResponse();
    const thread = mem.thread("1");
    expect(thread.map((m) => [m.kind, m.text, m.externalId])).toEqual([
      ["call", "Входящий звонок, 30 с", "call:r3"],
      ["call", "Запись разговора", "call:r3:record"],
    ]);
    expect(thread[1]?.attachments?.[0]?.mime).toBe("audio/mpeg");
    expect(Date.parse(thread[1]!.at)).toBe(Date.parse(thread[0]!.at) + 1);
    // Повтор — запись уже есть
    const again = await post({ id: "r3", direction: "in", from: "+996555000007", answered: true, recordUrl: REC });
    await afterResponse();
    expect(again.body).toMatchObject({ status: "duplicate" });
    expect(mem.thread("1")).toHaveLength(2);
  });

  it("не звук, слишком большая, с внутреннего адреса, не с адреса АТС — не сохраняем", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = memory();
    const { post, net, afterResponse } = setup({ maxRecordBytes: 1000, allowRecordHost: (h) => h === "pbx.example" }, store);
    net.files.set("https://pbx.example/r/doc.mp3", audio.pdf());
    net.files.set("https://pbx.example/r/big.mp3", audio.mp3(5000));
    net.files.set("https://other.example/r/b4.mp3", audio.mp3());
    const call = (id: string, recordUrl: string) => post({ id, direction: "in", from: "+996555000008", answered: true, recordUrl });
    await call("b1", "https://pbx.example/r/doc.mp3");
    await call("b2", "https://pbx.example/r/big.mp3");
    await call("b3", "http://192.168.1.10/r/b3.mp3");
    await call("b4", "https://other.example/r/b4.mp3");
    await afterResponse();
    expect(store.files.size).toBe(0);
    expect(store.thread("1").every((m) => !m.attachments)).toBe(true);
    // На внутренний адрес и чужой сервер запросов не было
    expect(net.seen.map((s) => s.url)).toEqual(["https://pbx.example/r/doc.mp3", "https://pbx.example/r/big.mp3"]);
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.some((c) => String(c[0]).includes("pbx.example"))).toBe(false);
    warn.mockRestore();
  });
});

describe("звонки — только приём", () => {
  it("send — ошибка словами; caps — всё выключено", async () => {
    const { adapter } = setup();
    expect(await adapter.send({ externalId: "+996555000001" }, { text: "Здравствуйте" })).toEqual({ ok: false, error: "Звонки — только приём: отвечайте в мессенджере или перезвоните" });
    expect(adapter.kind).toBe("calls");
    expect(adapter.caps).toEqual({ text: false, files: false, pause: false, mute: false, start: false, statuses: false });
    expect(adapter.caps).toBe(CALLS_CAPS);
  });
});

describe("помощники телефонии", () => {
  it("managerName: имя по внутреннему номеру, иначе имя от АТС, иначе «внутр. N»; служебные имена объекта не находятся", () => {
    expect(managerName({ "101": "Айгерим" }, "101", "SIP 101")).toBe("Айгерим");
    expect(managerName({ "101": "Айгерим" }, "105", "Бакыт")).toBe("Бакыт");
    expect(managerName({ "101": "Айгерим" }, "105")).toBe("внутр. 105");
    expect(managerName({}, "constructor")).toBe("внутр. constructor");
    expect(managerName(undefined, null)).toBeNull();
  });

  it("время начала: ISO с поясом, Unix-секунды и миллисекунды, без пояса — только по поясу АТС (и при переводе часов)", () => {
    const iso = "2026-09-27T08:00:00.000Z";
    expect(parseStartedAt("2026-09-27T14:00:00+06:00")).toBe(iso);
    expect(parseStartedAt("2026-09-27 14:00:00+0600")).toBe(iso);
    expect(parseStartedAt("2026-09-27T08:00:00Z")).toBe(iso);
    expect(parseStartedAt(Date.parse(iso) / 1000)).toBe(iso);
    expect(parseStartedAt(String(Date.parse(iso) / 1000))).toBe(iso);
    expect(parseStartedAt(Date.parse(iso))).toBe(iso);
    expect(parseStartedAt("2026-09-27 14:00:00")).toBeNull();
    expect(parseStartedAt("2026-09-27 14:00:00", "Asia/Bishkek")).toBe(iso);
    expect(parseStartedAt("вчера", "Asia/Bishkek")).toBeNull();
    expect(parseStartedAt(null)).toBeNull();
    expect(zonedIso("2026-01-15 12:00:00", "Europe/Berlin")).toBe("2026-01-15T11:00:00.000Z");
    expect(zonedIso("2026-07-15 12:00:00", "Europe/Berlin")).toBe("2026-07-15T10:00:00.000Z");
    expect(zonedIso("2026-03-29 03:30:00", "Europe/Berlin")).toBe("2026-03-29T01:30:00.000Z");
    expect(zonedIso("2026-09-27 14:00:00", "Нет/Такого")).toBeNull();
    expect(zonedIso("2026-13-01 14:00:00", "Asia/Bishkek")).toBeNull();
  });
});
