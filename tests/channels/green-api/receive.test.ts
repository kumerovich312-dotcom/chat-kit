import { describe, expect, it, vi } from "vitest";
import { createGreenApiAdapter, type GreenApiAlert, type GreenApiOptions } from "../../../src/channels/green-api/index.js";
import { createMemoryStore, ingest } from "../../../src/server/index.js";
import { bytes } from "../../helpers/fake-net.js";
import { API, CHAT, fakeGreenApi, HOOK, ID, instanceData, iso, MEDIA, msg, T0, text, TOKEN, WID, webp } from "./fake-green-api.js";

// Приём уведомлений GREEN-API на переходнике «в памяти» и поддельной сети. Имена, номера и ключи — вымышленные.

const NOW = (T0 + 3600) * 1000;

function setup(o: Partial<GreenApiOptions> = {}) {
  const net = fakeGreenApi();
  const store = createMemoryStore({ countryCode: "+996" });
  const alerts: GreenApiAlert[] = [];
  const adapter = createGreenApiAdapter({
    idInstance: ID, apiTokenInstance: TOKEN, apiUrl: API, mediaUrl: MEDIA, webhookToken: HOOK, fetch: net.fetch,
    onAlert: (a) => { alerts.push(a); }, ...o,
  });
  const post = (body: unknown, headers: Record<string, string> = { authorization: `Bearer ${HOOK}` }) =>
    ingest(adapter, store, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }, { now: () => NOW });
  return { net, store, adapter, post, alerts };
}

describe("проверка уведомления", () => {
  it("без ключа, с чужим ключом и без ключа в настройках — 401; чужой инстанс — 403; не JSON — 400; в базе ничего", async () => {
    const { post, store } = setup();
    expect((await post(msg(text("Привет")), {})).status).toBe(401);
    expect((await post(msg(text("Привет")), { authorization: "Bearer test-secret-not-real-other" })).status).toBe(401);
    expect((await post({ ...msg(text("Привет")), instanceData: { ...instanceData, idInstance: 1100000002 } })).status).toBe(403);
    expect((await post("{не json")).status).toBe(400);
    expect((await post({ instanceData })).status).toBe(400);
    const open = setup({ webhookToken: "" });
    expect((await open.post(msg(text("Привет")), { authorization: "Bearer " })).status).toBe(401);
    expect(store.contacts.size + open.store.contacts.size).toBe(0);
  });

  it("верный ключ — принято (ключ приходит заголовком Authorization: Bearer)", async () => {
    const { post } = setup();
    const r = await post(msg(text("Привет")));
    expect(r.status).toBe(200);
    expect(r.summary).toMatchObject({ ok: true, status: "ok", meta: { event: "incomingMessageReceived", type: "textMessage", idMessage: "A1" } });
  });
});

describe("сообщения клиента", () => {
  it("текст: клиент заведён по номеру WhatsApp (подлинный телефон), время — GREEN-API, клиент ждёт ответа; повтор — duplicate", async () => {
    const { post, store } = setup();
    const ev = msg(text("Здравствуйте! Есть запись на завтра?"), { senderContactName: "Айгерим (из телефона)" });
    const r = await post(ev);
    expect(r.summary).toMatchObject({ status: "ok", contactId: "1", createdContact: true });
    expect(store.thread("1")).toMatchObject([
      { text: "Здравствуйте! Есть запись на завтра?", author: { type: "client" }, channel: "whatsapp", externalId: "ga:A1", at: iso(T0) },
    ]);
    expect(store.contacts.get("1")).toMatchObject({ name: "Айгерим", phone: "+996555000001", channel: "whatsapp", identities: ["green-api:996555000001@c.us"] });
    expect(store.waitingSince("1")).toBe(iso(T0));
    expect((await post(ev)).summary.status).toBe("duplicate");
    expect(store.thread("1")).toHaveLength(1);
  });

  it("клиент с этим телефоном уже есть в проекте — переписка попадает к нему, второго клиента нет", async () => {
    const { post, store } = setup();
    await store.findOrCreateContact({ source: "site", externalId: "visitor-1", channel: "site", phone: "+996555000001", name: "Клиент Тест" });
    await post(msg(text("Это я, с сайта")));
    expect(store.contacts.size).toBe(1);
    expect(store.thread("1").map((m) => m.text)).toEqual(["Это я, с сайта"]);
  });

  it("имя: как клиент подписан в WhatsApp, иначе — как записан в телефоне компании; номер вместо имени не берём", async () => {
    const { post, store } = setup();
    await post(msg(text("Добрый день"), { senderName: "", senderContactName: "Бакыт" }));
    await post(msg(text("Добрый день"), { chatId: "996555000002@c.us", senderName: "+996 555 00-00-02", chatName: "996555000002" }));
    expect(store.contacts.get("1")?.name).toBe("Бакыт");
    expect(store.contacts.get("2")?.name).toBe("Клиент");
  });

  it("скрытый номер (@lid) — личный чат без телефона", async () => {
    const { post, store } = setup();
    await post(msg(text("Здравствуйте"), { chatId: "155500000000001@lid" }));
    expect(store.contacts.get("1")).toMatchObject({ phone: null, identities: ["green-api:155500000000001@lid"] });
  });

  it("ссылка с предпросмотром и нечитаемое сообщение ({{SWE001}}) — текстом", async () => {
    const { post, store } = setup();
    await post(msg({ typeMessage: "extendedTextMessage", extendedTextMessageData: { text: "Вот адрес: https://example.test/price", title: "Цены", description: "" } }, { id: "X1" }));
    await post(msg(text("{{SWE001}}"), { id: "X2", ts: T0 + 1 }));
    expect(store.thread("1").map((m) => m.text)).toEqual([
      "Вот адрес: https://example.test/price",
      "WhatsApp не передал текст этого сообщения (код SWE001) — посмотрите его в телефоне",
    ]);
  });

  it("ответ с цитатой: цитата ведёт к исходному сообщению; исходного нет — текст цитаты от GREEN-API", async () => {
    const { post, store } = setup();
    await post(msg(text("Сколько стоит чистка?"), { id: "Q1" }));
    await post(msg({
      typeMessage: "quotedMessage",
      extendedTextMessageData: { text: "А со скидкой?", stanzaId: "Q1", participant: CHAT },
      quotedMessage: { stanzaId: "Q1", participant: CHAT, typeMessage: "textMessage", textMessage: "Сколько стоит чистка?" },
    }, { id: "Q2", ts: T0 + 5 }));
    await post(msg({
      typeMessage: "quotedMessage",
      extendedTextMessageData: { text: "Вот это", stanzaId: "OLD1", participant: WID },
      quotedMessage: { stanzaId: "OLD1", participant: WID, typeMessage: "imageMessage", caption: "" },
    }, { id: "Q3", ts: T0 + 6 }));
    const [orig, reply, old] = store.thread("1");
    expect(reply).toMatchObject({ text: "А со скидкой?", replyTo: { id: orig?.id, externalId: "ga:Q1", text: "Сколько стоит чистка?" } });
    expect(old).toMatchObject({ text: "Вот это", replyTo: { externalId: "ga:OLD1", text: "Фото" } });
  });

  it("фото с подписью: подпись — сообщением, фото — вложением следом; клиент ждёт ответа", async () => {
    const { post, store, net } = setup();
    const url = "https://media.greenapi.test/1100000001/photo-1.jpg";
    net.files.set(url, bytes.jpeg());
    await post(msg({ typeMessage: "imageMessage", fileMessageData: { downloadUrl: url, caption: "Вот снимок", fileName: "photo-1.jpg", mimeType: "image/jpeg" } }, { id: "F1" }));
    const thread = store.thread("1");
    expect(thread.map((m) => m.text)).toEqual(["Вот снимок", "Фото"]);
    expect(thread[1]).toMatchObject({ externalId: "ga:F1:file:0", author: { type: "client" }, attachments: [{ name: "Фото", mime: "image/jpeg" }] });
    expect(store.waitingSince("1")).toBe(iso(T0));
  });

  it("документ — под своим именем; голосовое — «Голосовое сообщение»; стикер — картинкой «Стикер»", async () => {
    const { post, store, net } = setup();
    const doc = "https://media.greenapi.test/1100000001/doc-1.pdf";
    const voice = "https://media.greenapi.test/1100000001/voice-1.oga";
    const sticker = "https://media.greenapi.test/1100000001/sticker-1.webp";
    net.files.set(doc, bytes.pdf());
    net.files.set(voice, bytes.ogg());
    net.files.set(sticker, webp());
    await post(msg({ typeMessage: "documentMessage", fileMessageData: { downloadUrl: doc, caption: "", fileName: "Договор.pdf", mimeType: "application/pdf" } }, { id: "D1" }));
    await post(msg({ typeMessage: "audioMessage", fileMessageData: { downloadUrl: voice, mimeType: "audio/ogg; codecs=opus" } }, { id: "V1", ts: T0 + 1 }));
    await post(msg({ typeMessage: "stickerMessage", fileMessageData: { downloadUrl: sticker, mimeType: "image/webp", isAnimated: false } }, { id: "S1", ts: T0 + 2 }));
    expect(store.thread("1").map((m) => [m.text, m.attachments?.[0]?.name, m.attachments?.[0]?.mime])).toEqual([
      ["Договор.pdf", "Договор.pdf", "application/pdf"],
      ["Голосовое сообщение", "Голосовое сообщение", "audio/ogg"],
      ["Стикер", "Стикер", "image/webp"],
    ]);
  });

  it("ссылка на файл устарела — свежая у GREEN-API (downloadFile); ссылку на внутренний адрес не открываем", async () => {
    const { post, store, net } = setup();
    net.state.fresh = "https://media.greenapi.test/fresh/voice-2.ogg";
    net.files.set(net.state.fresh, bytes.ogg());
    await post(msg({ typeMessage: "audioMessage", fileMessageData: { downloadUrl: "http://127.0.0.1:9/voice-2.ogg", mimeType: "audio/ogg" } }, { id: "V2" }));
    expect(net.gets).toEqual([net.state.fresh]);
    expect(net.calls).toMatchObject([{ method: "POST", url: `${API}/waInstance${ID}/downloadFile/${TOKEN}`, json: { chatId: CHAT, idMessage: "V2" } }]);
    expect(store.thread("1")[0]?.attachments?.[0]).toMatchObject({ mime: "audio/ogg", name: "Голосовое сообщение" });
  });

  it("геопозиция, контакт, несколько контактов, опрос, голос в опросе, кнопки, список, неизвестный вид — текстом", async () => {
    const { post, store } = setup();
    const vcard = (name: string, tel: string) => `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\n${tel}\nEND:VCARD`;
    const items: Record<string, unknown>[] = [
      { typeMessage: "locationMessage", locationMessageData: { nameLocation: "Кафе", address: "ул. Примерная, 1", latitude: 42.87, longitude: 74.59 } },
      { typeMessage: "locationMessage", locationMessageData: { latitude: 42.87, longitude: 74.59 } },
      { typeMessage: "contactMessage", contactMessageData: { displayName: "Бакыт", vcard: vcard("Бакыт", "TEL;type=CELL;waid=996555000002:+996 555 00-00-02") } },
      {
        typeMessage: "contactsArrayMessage",
        messageData: { contacts: [
          { displayName: "Бакыт", vcard: vcard("Бакыт", "item1.TEL;waid=996555000002:+996 555 00-00-02") },
          { displayName: "Азат", vcard: vcard("Азат", "TEL;type=CELL:+996 555 00-00-03") },
        ] },
      },
      { typeMessage: "pollMessage", pollMessageData: { name: "Когда удобно?", options: [{ optionName: "Утром" }, { optionName: "Вечером" }], multipleAnswers: false } },
      { typeMessage: "pollUpdateMessage", pollMessageData: { stanzaId: "P0", name: "Когда удобно?", votes: [{ optionName: "Утром", optionVoters: [WID] }, { optionName: "Вечером", optionVoters: [CHAT] }] } },
      { typeMessage: "pollUpdateMessage", pollMessageData: { stanzaId: "P0", name: "Когда удобно?", votes: [{ optionName: "Утром", optionVoters: [] }] } },
      { typeMessage: "buttonsResponseMessage", buttonsResponseMessage: { stanzaId: "B0", selectedButtonId: "1", selectedButtonText: "Да, записаться" } },
      { typeMessage: "listResponseMessage", listResponseMessage: { stanzaId: "L0", title: "Вариант 2", listType: 1, singleSelectReply: "option2" } },
      { typeMessage: "templateButtonReplyMessage", templateButtonReplyMessage: { stanzaId: "T0", selectedIndex: 0, selectedId: "id1", selectedDisplayText: "Подтверждаю" } },
      { typeMessage: "groupInviteMessage", groupInviteMessageData: { groupName: "Клуб клиентов", caption: "Присоединяйтесь", inviteCode: "x" } },
      { typeMessage: "someNewMessage", someNewMessageData: { text: "что-то новое" } },
    ];
    for (const [i, md] of items.entries()) await post(msg(md, { id: `M${i}`, ts: T0 + i }));
    const thread = store.thread("1");
    expect(thread.map((m) => m.text)).toEqual([
      "Геопозиция: Кафе, ул. Примерная, 1 — https://maps.google.com/?q=42.87,74.59",
      "Геопозиция: 42.87, 74.59 — https://maps.google.com/?q=42.87,74.59",
      "Контакт: Бакыт, +996555000002",
      "Контакт: Бакыт, +996555000002\nКонтакт: Азат, +996 555 00-00-03",
      "Опрос: Когда удобно?\n— Утром\n— Вечером",
      "Ответ в опросе «Когда удобно?»: Вечером",
      "Голос в опросе «Когда удобно?» отменён",
      "Да, записаться",
      "Вариант 2",
      "Подтверждаю",
      "Приглашение в группу WhatsApp\nКлуб клиентов\nПрисоединяйтесь",
      "Сообщение WhatsApp такого вида CRM пока не показывает (someNewMessage) — посмотрите его в телефоне\nчто-то новое",
    ]);
    expect(thread[7]?.replyTo).toMatchObject({ externalId: "ga:B0" });
    expect(thread.every((m) => m.author.type === "client")).toBe(true);
  });

  it("реакция клиента — служебной строкой (ответа не ждёт); снятая реакция — пропущена", async () => {
    const { post, store } = setup();
    await post(msg(text("Записала вас на 15:00"), { type: "outgoingMessageReceived", id: "O1", sender: WID, senderName: "Компания" }));
    const r = await post(msg({ typeMessage: "reactionMessage", extendedTextMessageData: { text: "👍" }, quotedMessage: { stanzaId: "O1", participant: WID } }, { id: "R1", ts: T0 + 10 }));
    expect(r.summary.status).toBe("ok");
    const off = await post(msg({ typeMessage: "reactionMessage", extendedTextMessageData: { text: "" }, quotedMessage: { stanzaId: "O1" } }, { id: "R2", ts: T0 + 20 }));
    expect(off.summary.status).toBe("ignored");
    expect(store.thread("1").map((m) => [m.kind, m.author.type, m.text])).toEqual([
      ["message", "operator_phone", "Записала вас на 15:00"],
      ["system", "system", "Клиент отреагировал на сообщение: 👍"],
    ]);
    expect(store.waitingSince("1")).toBeNull();
  });

  it("исправленное сообщение — новой записью с цитатой исходного; удалённое — служебной строкой, исходное остаётся", async () => {
    const { post, store } = setup();
    await post(msg(text("Приду в 15:00"), { id: "E0" }));
    await post(msg({ typeMessage: "editedMessage", editedMessageData: { textMessage: "Приду в 16:00", stanzaId: "E0" } }, { id: "E1", ts: T0 + 30 }));
    const del = msg({ typeMessage: "deletedMessage", deletedMessageData: { stanzaId: "E0" } }, { id: "D1", ts: T0 + 40 });
    await post(del);
    await post(del); // повтор уведомления — служебная строка одна
    const [orig, edit, gone] = store.thread("1");
    expect(orig).toMatchObject({ text: "Приду в 15:00", externalId: "ga:E0" });
    expect(edit).toMatchObject({ text: "Исправлено: Приду в 16:00", author: { type: "client" }, externalId: `ga:edit:E1:${T0 + 30}`, replyTo: { id: orig?.id, text: "Приду в 15:00" } });
    expect(gone).toMatchObject({ kind: "system", text: "Клиент удалил сообщение в WhatsApp — в CRM оно осталось", externalId: "ga:del:E0" });
    expect(store.thread("1")).toHaveLength(3);
  });

  it("пустое сообщение, без номера сообщения, статусы WhatsApp (status@broadcast), «написать себе» — пропущены с причиной", async () => {
    const { post, store } = setup();
    expect((await post(msg(text("  ")))).summary.status).toBe("ignored");
    expect((await post({ ...msg(text("Привет")), idMessage: "" })).summary.status).toBe("ignored");
    const story = await post(msg(text("Моя история"), { chatId: "status@broadcast" }));
    expect(story.status).toBe(200);
    expect(story.summary).toMatchObject({ status: "ignored", error: "Статусы, каналы и рассылки WhatsApp в CRM не попадают" });
    const self = await post(msg(text("Заметка себе"), { type: "outgoingMessageReceived", chatId: WID, sender: WID }));
    expect(self.summary.status).toBe("ignored");
    expect(store.contacts.size).toBe(0);
  });
});

describe("группы", () => {
  const group = msg(text("Всем привет"), { chatId: "120363000000000001@g.us", sender: CHAT, senderName: "Айгерим", chatName: "Клуб клиентов" });

  it("по умолчанию группы не принимаем", async () => {
    const { post, store } = setup();
    const r = await post(group);
    expect(r.status).toBe(200);
    expect(r.summary.status).toBe("ignored");
    expect(store.contacts.size).toBe(0);
  });

  it("groups: true — группа как диалог, автор — участник по имени", async () => {
    const { post, store } = setup({ groups: true });
    await post(group);
    expect(store.contacts.get("1")).toMatchObject({ name: "Клуб клиентов", phone: null, identities: ["green-api:120363000000000001@g.us"] });
    expect(store.thread("1")[0]?.author).toEqual({ type: "client", name: "Айгерим" });
  });
});

describe("наши сообщения: с телефона и через API", () => {
  it("с телефона компании — «менеджер с телефона», имя клиента — из названия чата; это ответ — клиент не ждёт", async () => {
    const { post, store } = setup();
    await post(msg(text("Здравствуйте"), { id: "A1" }));
    await post(msg(text("Добрый день! Чем помочь?"), { type: "outgoingMessageReceived", id: "P1", ts: T0 + 60, sender: WID, senderName: "Компания", chatName: "Айгерим" }));
    expect(store.thread("1").map((m) => [m.author.type, m.text])).toEqual([["client", "Здравствуйте"], ["operator_phone", "Добрый день! Чем помочь?"]]);
    expect(store.waitingSince("1")).toBeNull();
    const fresh = setup();
    await fresh.post(msg(text("Напоминаем о записи"), { type: "outgoingMessageReceived", id: "P2", chatId: "996555000002@c.us", sender: WID, senderName: "Компания", chatName: "Бакыт" }));
    expect(fresh.store.contacts.get("1")).toMatchObject({ name: "Бакыт", phone: "+996555000002" });
  });

  it("«эхо» своей отправки через API — тот же ключ, что вернул send: второй раз не пишется; статус находит сообщение", async () => {
    const { post, store, adapter } = setup();
    await post(msg(text("Здравствуйте"), { id: "A1" }));
    const manager = { type: "operator_crm" as const, name: "Азат", id: "7" };
    const sent = await adapter.send({ externalId: CHAT, contactId: "1" }, { text: "Добрый день!", author: manager });
    expect(sent).toEqual({ ok: true, externalId: "ga:3EB0000000000001" });
    // Проект записывает своё сообщение с ключом из ответа send
    await store.saveMessage("1", { kind: "message", author: manager, channel: "whatsapp", text: "Добрый день!", at: iso(T0 + 10), externalId: sent.ok ? sent.externalId : null, delivery: "sent" });
    const echo = await post(msg(text("Добрый день!"), { type: "outgoingAPIMessageReceived", id: "3EB0000000000001", ts: T0 + 11, sender: WID }));
    expect(echo.summary.status).toBe("duplicate");
    await post({ typeWebhook: "outgoingMessageStatus", instanceData, chatId: CHAT, timestamp: T0 + 20, idMessage: "3EB0000000000001", status: "read", sendByApi: true });
    expect(store.thread("1").map((m) => [m.author.type, m.text, m.delivery ?? null])).toEqual([["client", "Здравствуйте", null], ["operator_crm", "Добрый день!", "read"]]);
  });

  it("«эхо» своего файла без подписи — тоже повтор: файл второй раз не качаем", async () => {
    const { post, store, adapter, net } = setup();
    await post(msg(text("Пришлите счёт"), { id: "A1" }));
    const sent = await adapter.send({ externalId: CHAT }, { text: "", file: { name: "Счёт.pdf", mime: "application/pdf", url: "https://crm.example.test/files/5?exp=1&sig=x" } });
    expect(sent.ok).toBe(true);
    await store.saveMessage("1", { kind: "message", author: { type: "operator_crm" }, channel: "whatsapp", text: "Счёт.pdf", at: iso(T0 + 10), externalId: sent.ok ? sent.externalId : null });
    const url = "https://media.greenapi.test/out/invoice.pdf";
    net.files.set(url, bytes.pdf());
    const id = sent.ok ? String(sent.externalId).slice(3) : "";
    const echo = await post(msg({ typeMessage: "documentMessage", fileMessageData: { downloadUrl: url, fileName: "Счёт.pdf", caption: "", mimeType: "application/pdf" } }, { type: "outgoingAPIMessageReceived", id, ts: T0 + 11, sender: WID }));
    expect(echo.summary.status).toBe("duplicate");
    expect(net.gets).toEqual([]);
    expect(store.thread("1")).toHaveLength(2);
  });

  it("через API другой программой на том же номере — записываем от «бота»", async () => {
    const { post, store } = setup();
    await post(msg(text("Напоминание: запись завтра в 10:00"), { type: "outgoingAPIMessageReceived", id: "X9", sender: WID, chatName: "Айгерим" }));
    expect(store.thread("1")).toMatchObject([{ author: { type: "bot" }, text: "Напоминание: запись завтра в 10:00", externalId: "ga:X9" }]);
  });
});

describe("статусы доставки", () => {
  it("дошло, не доставлено (причина словами), нет WhatsApp, незнакомый статус — пропущен", async () => {
    const { post, store } = setup();
    await post(msg(text("Здравствуйте"), { id: "A1" }));
    const save = (id: string) => store.saveMessage("1", { kind: "message", author: { type: "operator_crm" }, channel: "whatsapp", text: `Ответ ${id}`, at: iso(T0 + 5), externalId: `ga:${id}`, delivery: "pending" });
    await save("S1");
    await save("S2");
    await save("S3");
    const status = (id: string, s: string, extra: Record<string, unknown> = {}) =>
      post({ typeWebhook: "outgoingMessageStatus", instanceData, chatId: CHAT, timestamp: T0 + 9, idMessage: id, status: s, sendByApi: true, ...extra });
    await status("S1", "delivered");
    await status("S2", "failed", { description: "Error: forbidden" });
    await status("S3", "noAccount");
    expect((await status("S1", "somethingNew")).summary.status).toBe("ignored");
    expect(store.thread("1").slice(1).map((m) => [m.delivery, m.deliveryError ?? null])).toEqual([
      ["delivered", null],
      ["failed", "WhatsApp не доставил сообщение (Error: forbidden)"],
      ["failed", "У этого номера нет WhatsApp"],
    ]);
  });
});

describe("звонки", () => {
  const call = (status: string, id: string, ts: number, extra: Record<string, unknown> = {}) =>
    ({ typeWebhook: "incomingCall", instanceData, from: CHAT, status, timestamp: ts, idMessage: id, ...extra });

  it("пропущенный входящий — строка звонка, клиент ждёт ответа; offer — ждём итога; повтор итога — без второй строки", async () => {
    const { post, store } = setup();
    const offer = await post(call("offer", "C1", T0));
    expect(offer.summary.status).toBe("ignored");
    expect(store.contacts.size).toBe(0);
    await post(call("declined", "C1", T0 + 20));
    expect(store.thread("1")).toMatchObject([
      { kind: "call", author: { type: "client" }, channel: "call", text: "Пропущенный звонок", externalId: "ga:call:C1", call: { direction: "in", missed: true }, at: iso(T0 + 20) },
    ]);
    expect(store.contacts.get("1")).toMatchObject({ phone: "+996555000001" });
    expect(store.waitingSince("1")).toBe(iso(T0 + 20));
    expect((await post(call("declined", "C1", T0 + 20))).summary.status).toBe("duplicate");
    expect(store.thread("1")).toHaveLength(1);
  });

  it("отклонили у нас (hungUp) — тоже пропущенный; принятый звонок (pickUp) — ответ, клиент больше не ждёт", async () => {
    const { post, store } = setup();
    await post(call("hungUp", "C1", T0));
    await post(call("offer", "C2", T0 + 100));
    await post(call("pickUp", "C2", T0 + 110));
    expect(store.thread("1").map((m) => [m.text, m.call?.missed])).toEqual([["Пропущенный звонок", true], ["Входящий звонок", false]]);
    expect(store.waitingSince("1")).toBeNull();
  });

  it("исходящий с телефона компании: поговорили — длительность; не дозвонились — строка без ожидания", async () => {
    const { post, store } = setup();
    const out = (status: string, id: string, ts: number, duration: number) =>
      post({ typeWebhook: "outgoingCall", instanceData, timestamp: ts, idMessage: id, from: CHAT, isVideo: false, duration, status, participants: [{ id: CHAT, status }] });
    await out("pickUp", "OC1", T0, 65);
    await out("hungUp", "OC2", T0 + 200, 0);
    expect(store.thread("1")).toMatchObject([
      { kind: "call", author: { type: "operator_phone" }, text: "Исходящий звонок, 1 мин 05 с", call: { direction: "out", missed: false, durationSec: 65 } },
      { kind: "call", author: { type: "operator_phone" }, text: "Не дозвонились", call: { direction: "out", missed: true, durationSec: null } },
    ]);
    expect(store.waitingSince("1")).toBeNull();
  });
});

describe("уведомления про номер целиком", () => {
  it("WhatsApp отключён / снова подключён — onAlert и meta, в переписку не пишем", async () => {
    const { post, store, alerts } = setup();
    const off = await post({ typeWebhook: "stateInstanceChanged", instanceData, timestamp: T0, stateInstance: "notAuthorized" });
    expect(off.status).toBe(200);
    expect(off.summary.meta).toMatchObject({ event: "stateInstanceChanged", alert: "WhatsApp не подключён — отсканируйте QR в кабинете GREEN-API" });
    await post({ typeWebhook: "stateInstanceChanged", instanceData, timestamp: T0 + 60, stateInstance: "authorized" });
    expect(alerts).toEqual([
      { type: "state", state: "notAuthorized", ok: false, at: iso(T0), text: "WhatsApp не подключён — отсканируйте QR в кабинете GREEN-API" },
      { type: "state", state: "authorized", ok: true, at: iso(T0 + 60), text: "WhatsApp подключён к GREEN-API — сообщения снова приходят и уходят" },
    ]);
    expect(store.contacts.size).toBe(0);
  });

  it("закончился лимит тарифа — onAlert словами; сбой onAlert не ломает приём", async () => {
    const quota = { typeWebhook: "quotaExceeded", instanceData, quotaData: { method: "correspondents", used: 3, total: 3, status: "CORRESPONDENTS_QUOTA_EXCEEDED", description: "Monthly quota has been exceeded" } };
    const { post, alerts } = setup();
    await post(quota);
    expect(alerts[0]).toMatchObject({ type: "quota", ok: false });
    expect(alerts[0]?.text).toBe("Закончился лимит тарифа GREEN-API: переписка только с 3 чатами в месяц (использовано 3 из 3) — новые клиенты не дойдут до CRM, смените тариф в кабинете GREEN-API");
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = setup({ onAlert: () => { throw new Error("сбой проекта"); } });
    expect((await broken.post(quota)).status).toBe(200);
    expect(quiet).toHaveBeenCalled();
    quiet.mockRestore();
  });

  it("лишние уведомления (deviceInfo, statusInstanceChanged) — 200 и пропуск", async () => {
    const { post } = setup();
    for (const typeWebhook of ["deviceInfo", "statusInstanceChanged", "incomingBlock"]) {
      const r = await post({ typeWebhook, instanceData, timestamp: T0 });
      expect(r.status).toBe(200);
      expect(r.summary.status).toBe("ignored");
    }
  });
});
