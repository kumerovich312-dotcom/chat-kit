import { describe, expect, it } from "vitest";
import { authorFromTish, authorToTish, createWaGatewayAdapter, phoneFromJid, waJid, type WaOutboxRow } from "../../src/wa-gateway/index.js";
import { createMemoryStore, ingest } from "../../src/server/index.js";
import type { ControlMode } from "../../src/core/index.js";

// Подключение к шлюзу WhatsApp TishCRM: событие «пациент написал», очередь исходящих, управление по HTTP. Токен — тестовый.

const TOKEN = "test-secret-not-real-gateway";

function setup(fetchImpl?: typeof fetch) {
  const queue: WaOutboxRow[] = [];
  const modes: ControlMode[] = [];
  const calls: { url: string; body: unknown; auth: string | null }[] = [];
  const fakeFetch = fetchImpl ?? (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")), auth: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  const adapter = createWaGatewayAdapter({
    url: "http://127.0.0.1:3010/", token: TOKEN, orgId: 7, fetch: fakeFetch,
    enqueue: async (row) => { queue.push(row); },
    setMode: async (_t, mode) => { modes.push(mode); },
  });
  return { adapter, queue, modes, calls };
}

describe("шлюз WhatsApp TishCRM", () => {
  it("«пациент написал» с верным токеном — обновить экраны диалога", async () => {
    const { adapter } = setup();
    const store = createMemoryStore();
    const r = await ingest(adapter, store, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ event: "message_in", org_id: 7, dialog_id: 15 }) });
    expect(r.status).toBe(200);
    expect(store.events).toEqual([{ contactId: "15", kind: "message" }]);
  });

  it("чужой токен — 401, чужая клиника — 403, незнакомое событие — пропущено", () => {
    const { adapter } = setup();
    expect(adapter.receive({ method: "POST", headers: { authorization: "Bearer test-secret-not-real-wrong" }, body: "{}" })).toMatchObject({ ok: false, status: 401 });
    expect(adapter.receive({ method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ event: "message_in", org_id: 8, dialog_id: 1 }) })).toMatchObject({ ok: false, status: 403 });
    expect(adapter.receive({ method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ event: "other", org_id: 7 }) })).toMatchObject({ ok: false, ignored: true });
  });

  it("исходящее — в очередь шлюза; ответ ИИ — разметкой WhatsApp; файл — путём в uploads", async () => {
    const { adapter, queue } = setup();
    expect(await adapter.send({ externalId: "996555000001@s.whatsapp.net" }, { text: "Записали на **пятницу**", author: { type: "bot" }, messageId: "41" })).toEqual({ ok: true, externalId: null });
    expect(queue[0]).toEqual({ jid: "996555000001@s.whatsapp.net", text: "Записали на *пятницу*", media: null, messageId: "41" });
    await adapter.send({ externalId: "996555000001@s.whatsapp.net" }, { text: "Снимок", author: { type: "operator_crm", name: "Врач" }, file: { name: "снимок.jpg", mime: "image/jpeg", path: "org_7/wa/out_1_снимок.jpg" } });
    expect(queue[1]?.media).toEqual({ path: "org_7/wa/out_1_снимок.jpg", type: "image", mime: "image/jpeg", name: "снимок.jpg" });
    expect((await adapter.send({ externalId: "x@s.whatsapp.net" }, { text: "без пути", file: { name: "a.pdf", mime: "application/pdf", url: "https://x" } })).ok).toBe(false);
  });

  it("пауза ИИ — статус диалога через проект; «не отвечать» шлюз не умеет", async () => {
    const { adapter, modes } = setup();
    expect(await adapter.control!({ externalId: "1@s.whatsapp.net" }, { type: "pause" })).toEqual({ ok: true });
    expect(await adapter.control!({ externalId: "1@s.whatsapp.net" }, { type: "resume" })).toEqual({ ok: true });
    expect(modes).toEqual(["manager", "bot"]);
    expect((await adapter.control!({ externalId: "1@s.whatsapp.net" }, { type: "mute" })).ok).toBe(false);
  });

  it("управление шлюзом по HTTP: токен в заголовке, номер клиники в теле; шлюз не запущен — понятная ошибка", async () => {
    const { adapter, calls } = setup();
    expect(await adapter.connect()).toEqual({ ok: true });
    await adapter.testNextbot("10177", "проверка");
    expect(calls.map((c) => c.url)).toEqual(["http://127.0.0.1:3010/connect", "http://127.0.0.1:3010/nextbot-test"]);
    expect(calls[0]?.auth).toBe(`Bearer ${TOKEN}`);
    expect(calls[1]?.body).toEqual({ orgId: 7, dialogId: "10177", text: "проверка" });
    const down = setup((async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch);
    expect(await down.adapter.disconnect()).toMatchObject({ ok: false, error: "Шлюз WhatsApp не запущен или недоступен" });
    const bad = setup((async () => new Response("{}", { status: 401 })) as typeof fetch);
    expect((await bad.adapter.connect()).ok).toBe(false);
  });

  it("адреса WhatsApp и авторы TishCRM", () => {
    expect(waJid("+996 555 00-00-01")).toBe("996555000001@s.whatsapp.net");
    expect(phoneFromJid("996555000001@s.whatsapp.net")).toBe("+996555000001");
    expect(phoneFromJid("123456789012345@lid")).toBeNull();
    expect(authorFromTish("patient")).toEqual({ type: "client" });
    expect(authorFromTish("ai")).toMatchObject({ type: "bot" });
    expect(authorFromTish("operator:Врач")).toEqual({ type: "operator_crm", name: "Врач" });
    expect(authorFromTish("auto:Напоминание")).toMatchObject({ type: "operator_crm", name: "Напоминание · автоматически" });
    expect(authorToTish({ type: "operator_crm", name: "Врач" })).toBe("operator:Врач");
    expect(authorToTish({ type: "operator_phone" })).toBe("phone");
  });
});
