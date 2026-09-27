import { describe, expect, it } from "vitest";
import { createStudioAdapter, studioSignature, verifyStudioSignature } from "../../src/studio/index.js";
import { createMemoryStore, ingest } from "../../src/server/index.js";

// Заготовка подключения студии — по разделу 10.8 плана студии (API ещё нет). Секреты — тестовые.

const SECRET = "test-secret-not-real-studio-webhook";
const NOW = Date.parse("2026-09-27T08:00:00Z");

function signed(ev: unknown) {
  const body = JSON.stringify(ev);
  return { method: "POST", headers: { "x-signature": studioSignature(SECRET, Math.floor(NOW / 1000), body) }, body };
}

describe("подпись вебхуков студии", () => {
  it("верная — принимается; изменённое тело и старая подпись — нет", () => {
    const body = '{"a":1}';
    const sig = studioSignature(SECRET, Math.floor(NOW / 1000), body);
    expect(verifyStudioSignature(SECRET, sig, body, NOW)).toBe(true);
    expect(verifyStudioSignature(SECRET, sig, '{"a":2}', NOW)).toBe(false);
    expect(verifyStudioSignature(SECRET, sig, body, NOW + 10 * 60_000)).toBe(false);
    expect(verifyStudioSignature(SECRET, undefined, body, NOW)).toBe(false);
  });
});

describe("события студии", () => {
  const adapter = createStudioAdapter({ baseUrl: "https://studio.test/v1", apiKey: "test-secret-not-real-key", webhookSecret: SECRET, now: () => NOW });

  it("message.created — сообщение с автором студии (в том числе «с телефона»), повтор по номеру сообщения", async () => {
    const store = createMemoryStore();
    const ev = {
      event_id: "e1", type: "message.created.v1", occurred_at: "2026-09-27T07:59:59.000Z", conversation_id: "c1", seq: 3,
      contact: { id: "k1", name: "Азат" }, channel: "whatsapp",
      data: { message_id: "m1", author_type: "operator_phone", author_name: "Айгерим", text: "Здравствуйте!", provider_ts: "2026-09-27T07:59:58.500Z" },
    };
    await ingest(adapter, store, signed(ev), { now: () => NOW });
    const again = await ingest(adapter, store, signed({ ...ev, event_id: "e1-retry" }), { now: () => NOW });
    expect(again.summary.status).toBe("duplicate");
    const thread = store.thread("1");
    expect(thread).toHaveLength(1);
    expect(thread[0]).toMatchObject({ text: "Здравствуйте!", author: { type: "operator_phone", name: "Айгерим" }, at: "2026-09-27T07:59:58.500Z", externalId: "studio:m1" });
  });

  it("camelCase тоже понимаем; статус доставки, пауза бота и передача человеку", async () => {
    const store = createMemoryStore();
    const states: string[] = [];
    const handoffs: (string | null)[] = [];
    const hooks = { onState: async (x: { mode: string }) => { states.push(x.mode); }, onHandoff: async (x: { reason: string | null }) => { handoffs.push(x.reason); } };
    await ingest(adapter, store, signed({ event_id: "e2", type: "message.created", occurred_at: "2026-09-27T07:50:00Z", conversation_id: "c2", contact: { id: "k2" }, channel: "telegram", data: { messageId: "m2", authorType: "bot", text: "Чем помочь?" } }), { now: () => NOW });
    await ingest(adapter, store, signed({ event_id: "e3", type: "message.status", occurred_at: "2026-09-27T07:50:02Z", conversation_id: "c2", data: { message_id: "m2", status: "read" } }), { now: () => NOW });
    expect(store.thread("1")[0]?.delivery).toBe("read");
    await ingest(adapter, store, signed({ event_id: "e4", type: "conversation.state_changed", occurred_at: "2026-09-27T07:51:00Z", conversation_id: "c2", contact: { id: "k2" }, data: { control_mode: "manager", paused_until: "2026-09-27T09:51:00Z" } }), { now: () => NOW, hooks });
    await ingest(adapter, store, signed({ event_id: "e5", type: "handoff.requested", occurred_at: "2026-09-27T07:52:00Z", conversation_id: "c2", contact: { id: "k2" }, data: { reason: "person_requested", summary: "Хочет поговорить с человеком" } }), { now: () => NOW, hooks });
    expect(states).toEqual(["manager"]);
    expect(handoffs).toEqual(["person_requested"]);
    expect(store.waits.at(-1)?.change.type).toBe("handoff");
  });

  it("без подписи — 401", async () => {
    const r = await ingest(adapter, createMemoryStore(), { method: "POST", headers: {}, body: "{}" });
    expect(r.status).toBe(401);
  });
});

describe("команды студии", () => {
  it("ответ менеджера — с ключом повтора и ключом проекта; пауза и «не отвечать» — своими адресами; ошибка — словами студии", async () => {
    const calls: { url: string; method: string; headers: Headers; body: Record<string, unknown> }[] = [];
    let status = 200;
    const fake = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      calls.push({ url: String(input), method: String(init?.method), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return status === 200
        ? new Response(JSON.stringify({ data: { message_id: "m9" } }), { status })
        : new Response(JSON.stringify({ error: { code: "IDEMPOTENCY_KEY_REUSED", messageRu: "Этот ключ уже использован с другим текстом" } }), { status });
    }) as typeof fetch;
    const a = createStudioAdapter({ baseUrl: "https://studio.test/v1/", apiKey: "test-secret-not-real-key", webhookSecret: SECRET, fetch: fake, now: () => NOW });
    expect(await a.send({ externalId: "c1" }, { text: "Добрый день", author: { type: "operator_crm", name: "Айгерим", id: "7" }, idempotencyKey: "crm:1" })).toEqual({ ok: true, externalId: "m9" });
    expect(calls[0]).toMatchObject({ url: "https://studio.test/v1/conversations/c1/messages", method: "POST", body: { text: "Добрый день", author: { type: "operator", name: "Айгерим", external_id: "7" } } });
    expect(calls[0]?.headers.get("idempotency-key")).toBe("crm:1");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer test-secret-not-real-key");
    await a.control!({ externalId: "c1" }, { type: "pause", hours: 2 });
    await a.control!({ externalId: "c1", contactId: "k1" }, { type: "mute" });
    expect(calls.slice(1).map((c) => c.url)).toEqual(["https://studio.test/v1/conversations/c1/pause", "https://studio.test/v1/contacts/k1/mute"]);
    status = 409;
    expect(await a.send({ externalId: "c1" }, { text: "x", idempotencyKey: "crm:1" })).toMatchObject({ ok: false, error: "Этот ключ уже использован с другим текстом", retryable: false });
  });
});
