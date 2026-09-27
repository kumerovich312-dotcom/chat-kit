import { describe, expect, it } from "vitest";
import { createInstagramAdapter } from "../../../src/channels/instagram/index.js";
import { createMemoryStore, ingest, sha1Hex, sha256Hex } from "../../../src/server/index.js";
import { bytes } from "../../helpers/fake-net.js";
import { CDN, echoTo, fakeMeta, fromClient, hook, SECRET, T, TOKEN, webhook } from "./fake-meta.js";

// «Эхо» — сообщения, которые компания отправила сама. Из приложения Instagram — пишем как «менеджер с телефона»;
// отправленные через набор — второй раз не пишем: ни в том же процессе сервера, ни в другом, ни если проект ещё не
// успел записать номер сообщения. Номера клиентов и ссылки — вымышленные.

async function setup(client: string) {
  const net = fakeMeta();
  const store = createMemoryStore();
  const adapter = createInstagramAdapter({ accessToken: TOKEN, appSecret: SECRET, fetch: net.fetch, echoDelayMs: 0 });
  const post = (payload: unknown, at = T + 5_000) => ingest(adapter, store, hook(payload), { now: () => at });
  // Клиент написал первым — в CRM он «1»
  await post(webhook(fromClient(client, { mid: `mid-${client}-in`, text: "Здравствуйте, есть свободное время?" }, T - 60_000)), T - 59_000);
  return { net, store, adapter, post };
}

describe("эхо сообщений компании", () => {
  it("из приложения Instagram — «менеджер с телефона» у того же клиента, клиент больше не ждёт", async () => {
    const { store, post } = await setup("6300000000000001");
    const r = await post(webhook(echoTo("6300000000000001", { mid: "mid-app-1", text: "Да, завтра в 15:00" }, T)));
    expect(r.status).toBe(200);
    expect(store.contacts.size).toBe(1);
    expect(store.thread("1").map((m) => [m.author.type, m.text, m.externalId])).toEqual([
      ["client", "Здравствуйте, есть свободное время?", "ig:mid-6300000000000001-in"],
      ["operator_phone", "Да, завтра в 15:00", "ig:mid-app-1"],
    ]);
    expect(store.waitingSince("1")).toBeNull();
    // Meta прислала то же уведомление ещё раз — не задваиваем
    expect((await post(webhook(echoTo("6300000000000001", { mid: "mid-app-1", text: "Да, завтра в 15:00" }, T)))).summary.status).toBe("duplicate");
    expect(store.thread("1")).toHaveLength(2);
  });

  it("наше сообщение, отправленное этим же сервером, — эхо мимо, даже если проект ещё не записал номер", async () => {
    const { store, adapter, post } = await setup("6300000000000002");
    const sent = await adapter.send({ externalId: "6300000000000002" }, { text: "Добрый день! Записали вас.", author: { type: "operator_crm", name: "Айгерим" } });
    expect(sent).toMatchObject({ ok: true, externalId: "ig:mid-sent-1" });
    // Эхо пришло раньше, чем проект записал сообщение с номером
    const r = await post(webhook(echoTo("6300000000000002", { mid: "mid-sent-1", text: "Добрый день! Записали вас." }, T)));
    expect(r.status).toBe(200);
    expect(store.thread("1")).toHaveLength(1);
  });

  it("отправлено другим процессом, номер уже записан — эхо узнаём по номеру в базе", async () => {
    const { store, post } = await setup("6300000000000003");
    await store.saveMessage("1", { kind: "message", author: { type: "operator_crm", name: "Айгерим" }, channel: "instagram", text: "Ждём вас", at: new Date(T - 1_000).toISOString(), externalId: "ig:mid-other-proc-1", delivery: "sent" });
    const r = await post(webhook(echoTo("6300000000000003", { mid: "mid-other-proc-1", text: "Ждём вас" }, T)));
    expect(r.summary.status).toBe("duplicate");
    expect(store.thread("1").map((m) => m.author.type)).toEqual(["client", "operator_crm"]);
  });

  it("отправлено другим процессом, номер ещё не записан — узнаём по тексту недавнего сообщения из CRM", async () => {
    const { store, post } = await setup("6300000000000004");
    // Проект записал сообщение до отправки (delivery pending), номер допишет после ответа Instagram
    await store.saveMessage("1", { kind: "message", author: { type: "operator_crm", name: "Айгерим" }, channel: "instagram", text: "Стоимость — 1500 сом, оплата на месте.", at: new Date(T - 1_000).toISOString(), delivery: "pending" });
    await post(webhook(echoTo("6300000000000004", { mid: "mid-other-proc-2", text: "Стоимость — 1500 сом, оплата на месте." }, T)));
    expect(store.thread("1").map((m) => m.author.type)).toEqual(["client", "operator_crm"]);
  });

  it("часть длинного сообщения из CRM — тоже наша; ответ бота узнаём и после снятия разметки", async () => {
    const { store, post } = await setup("6300000000000005");
    const long = "Первая половина длинного ответа про подготовку к приёму. Вторая половина длинного ответа про оплату.";
    await store.saveMessage("1", { kind: "message", author: { type: "operator_crm" }, channel: "instagram", text: long, at: new Date(T - 2_000).toISOString(), externalId: "ig:mid-last-part" });
    await store.saveMessage("1", { kind: "message", author: { type: "bot" }, channel: "instagram", text: "**Адрес:** ул. Примерная, 1", at: new Date(T - 1_000).toISOString() });
    await post(webhook(echoTo("6300000000000005", { mid: "mid-first-part", text: "Первая половина длинного ответа про подготовку к приёму." }, T)));
    await post(webhook(echoTo("6300000000000005", { mid: "mid-bot-plain", text: "Адрес: ул. Примерная, 1" }, T)));
    expect(store.thread("1")).toHaveLength(3);
  });

  it("файл из приложения Instagram — одно сообщение с файлом (слова «Фото» до скачивания)", async () => {
    const { store, post, net } = await setup("6300000000000006");
    net.files.set(`${CDN}app-photo-1`, bytes.png());
    await post(webhook(echoTo("6300000000000006", { mid: "mid-app-photo", attachments: [{ type: "image", payload: { url: `${CDN}app-photo-1` } }] }, T)));
    const echo = store.thread("1")[1];
    expect(echo).toMatchObject({ author: { type: "operator_phone" }, text: "Фото", externalId: "ig:mid-app-photo" });
    expect(echo?.attachments?.[0]?.mime).toBe("image/png");
    expect(store.thread("1")).toHaveLength(2);
    expect([...store.files.values()][0]?.fromClient).toBe(false);
  });

  it("файл, отправленный из CRM другим процессом, — эхо не скачиваем и не пишем", async () => {
    const { store, post, net } = await setup("6300000000000007");
    const data = bytes.jpeg();
    const { fileId } = await store.saveFile("1", { data, mime: "image/jpeg", ext: "jpg", name: "Схема проезда", sha1: sha1Hex(data), sha256: sha256Hex(data), fromClient: false });
    await store.saveMessage("1", { kind: "message", author: { type: "operator_crm" }, channel: "instagram", text: "Схема проезда", at: new Date(T - 1_000).toISOString(), fileId });
    net.files.set(`${CDN}crm-photo-1`, bytes.png());
    await post(webhook(echoTo("6300000000000007", { mid: "mid-crm-photo", attachments: [{ type: "image", payload: { url: `${CDN}crm-photo-1` } }] }, T)));
    expect(store.thread("1")).toHaveLength(2);
    expect(net.gets.get(`${CDN}crm-photo-1`)).toBeUndefined();
  });

  it("эхо с ответом на сообщение клиента — цитата; удалённое в приложении — служебная строка", async () => {
    const { store, post } = await setup("6300000000000008");
    await post(webhook(echoTo("6300000000000008", { mid: "mid-app-reply", text: "Есть, на 16:00", reply_to: { mid: "mid-6300000000000008-in" } }, T)));
    await post(webhook(echoTo("6300000000000008", { mid: "mid-app-reply", is_deleted: true }, T + 1_000)), T + 6_000);
    const [, reply, gone] = store.thread("1");
    expect(reply?.replyTo).toMatchObject({ externalId: "ig:mid-6300000000000008-in", author: { type: "client" } });
    expect(gone).toMatchObject({ kind: "system", text: "Сообщение удалено в приложении Instagram" });
  });
});
