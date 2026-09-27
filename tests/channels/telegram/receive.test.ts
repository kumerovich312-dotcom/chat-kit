import { describe, expect, it } from "vitest";
import { createTelegramAdapter, TELEGRAM_TEXTS, type TelegramOptions } from "../../../src/channels/telegram/index.js";
import { createMemoryStore, ingest } from "../../../src/server/index.js";
import { bytes } from "../../helpers/fake-net.js";
import { fakeTelegram, SECRET, TOKEN } from "./fake-telegram.js";

// Приём уведомлений Telegram на переходнике «в памяти» и поддельном Bot API. Имена, номера чатов и ключи — вымышленные.

const NOW = Date.parse("2026-09-27T08:00:00Z");
/** Время сообщения у Telegram — секунды Unix, за минуту до приёма */
const DATE = Math.floor(NOW / 1000) - 60;
const AT = new Date(DATE * 1000).toISOString();
const CHAT = 100000001;
const USER = { id: CHAT, is_bot: false, first_name: "Айгерим", last_name: "Тест", username: "aigerim_test", language_code: "ru" };
const PRIVATE = { id: CHAT, type: "private", first_name: "Айгерим", last_name: "Тест", username: "aigerim_test" };
const BOT_USER = { id: 999000999, is_bot: true, first_name: "Бот компании", username: "company_test_bot" };

// Видео mp4 и музыка mp3 — первые байты, по которым набор узнаёт тип (n — чтобы файлы различались содержимым)
const mp4 = (n = 0) => new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, ...new Array(32).fill(n)]);
const mp3 = () => new Uint8Array([0x49, 0x44, 0x33, 3, 0, ...new Array(32).fill(5)]);

const hook = (update: unknown, headers: Record<string, string> = { "x-telegram-bot-api-secret-token": SECRET }) => ({
  method: "POST", headers, body: typeof update === "string" ? update : JSON.stringify(update),
});

function setup(o: Partial<TelegramOptions> = {}) {
  const tg = fakeTelegram();
  const store = createMemoryStore({ countryCode: "+996" });
  const adapter = createTelegramAdapter({ token: TOKEN, secretToken: SECRET, fetch: tg.fetch, ...o });
  let seq = 1;
  const post = (update: unknown, headers?: Record<string, string>) => ingest(adapter, store, hook(update, headers), { now: () => NOW });
  /** Уведомление с сообщением клиента в личном чате */
  const message = (fields: Record<string, unknown>, id = 10) => ({ update_id: seq++, message: { message_id: id, date: DATE, chat: PRIVATE, from: USER, ...fields } });
  const texts = (contactId = "1") => store.thread(contactId).map((m) => m.text);
  return { tg, store, adapter, post, message, texts };
}

describe("приём уведомлений Telegram", () => {
  it("сообщение клиента: клиент заведён с именем и ником, время — из date, ключ tg:<чат>:<номер>, клиент ждёт ответа", async () => {
    const { store, post, message } = setup();
    const r = await post(message({ text: "Здравствуйте! Можно записаться на завтра?" }));
    expect(r.status).toBe(200);
    expect(r.summary).toMatchObject({ ok: true, status: "ok", contactId: "1", createdContact: true });
    const [m] = store.thread("1");
    expect(m).toMatchObject({ text: "Здравствуйте! Можно записаться на завтра?", author: { type: "client" }, channel: "telegram", externalId: `tg:${CHAT}:10`, at: AT });
    expect(store.contacts.get("1")).toMatchObject({ name: "Айгерим Тест", channel: "telegram", phone: null, identities: [`telegram:${CHAT}`] });
    expect(store.waitingSince("1")).toBe(AT);
  });

  it("ContactHint: источник и канал telegram, номер чата, имя и ник; телефона нет", async () => {
    const { adapter, message } = setup();
    const r = await adapter.receive(hook(message({ text: "Привет" })));
    expect(r).toMatchObject({
      ok: true, meta: { kind: "message" },
      events: [{ type: "message", contact: { source: "telegram", externalId: String(CHAT), channel: "telegram", name: "Айгерим Тест", username: "aigerim_test" } }],
    });
    expect(r.ok && r.events[0]?.type === "message" ? r.events[0].contact.phone : "нет").toBeUndefined();
  });

  it("без секрета, с чужим секретом и когда секрет не задан — 401, ничего не записано; заголовок в другом регистре узнаётся", async () => {
    const { post, message, store } = setup();
    expect((await post(message({ text: "a" }), {})).status).toBe(401);
    expect((await post(message({ text: "a" }), { "x-telegram-bot-api-secret-token": "test-secret-not-real-other" })).status).toBe(401);
    const empty = setup({ secretToken: "" });
    expect((await empty.post(empty.message({ text: "a" }), { "x-telegram-bot-api-secret-token": "" })).status).toBe(401);
    expect(store.contacts.size + empty.store.contacts.size).toBe(0);
    expect((await post(message({ text: "a" }), { "X-Telegram-Bot-Api-Secret-Token": SECRET })).status).toBe(200);
  });

  it("повтор того же уведомления — duplicate, второе сообщение не записано", async () => {
    const { post, message, texts } = setup();
    const u = message({ text: "Добрый день" });
    await post(u);
    const again = await post(u);
    expect(again.status).toBe(200);
    expect(again.summary.status).toBe("duplicate");
    expect(texts()).toEqual(["Добрый день"]);
  });

  it("фото — самый большой размер (getFile), подпись — текстом сообщения, файл — следом; повтор не качает второй раз", async () => {
    const { tg, store, post, message } = setup();
    tg.files.set("ph-big", { path: "photos/file_1.jpg", data: bytes.jpeg() });
    tg.files.set("ph-small", { path: "photos/file_0.jpg", data: bytes.jpeg() });
    const u = message({
      caption: "Вот фото документа",
      photo: [{ file_id: "ph-small", file_unique_id: "s", width: 90, height: 67, file_size: 1200 }, { file_id: "ph-big", file_unique_id: "b", width: 1280, height: 960, file_size: 90_000 }],
    });
    await post(u);
    await post(u);
    expect(tg.calls.filter((c) => c.method === "getFile").map((c) => c.body.file_id)).toEqual(["ph-big"]);
    const thread = store.thread("1");
    expect(thread.map((m) => m.text)).toEqual(["Вот фото документа", "Фото"]);
    expect(thread[1]).toMatchObject({ externalId: `tg:${CHAT}:10:file:0`, author: { type: "client" }, attachments: [{ mime: "image/jpeg", name: "Фото" }] });
    expect(store.files.get("f1")).toMatchObject({ sourceUrl: "tg-file:ph-big", fromClient: true, ext: "jpg" });
  });

  it("файл больше лимита — не качаем, в тексте строка «…: в CRM сохраняются файлы до …»", async () => {
    const { tg, post, message, texts } = setup({ maxFileBytes: 1024 * 1024 });
    await post(message({ video: { file_id: "vid-1", file_unique_id: "v", mime_type: "video/mp4", file_size: 5 * 1024 * 1024, duration: 30, width: 640, height: 360 } }));
    expect(tg.calls.some((c) => c.method === "getFile")).toBe(false);
    expect(texts()).toEqual(["Видео (5,0 МБ): в CRM сохраняются файлы до 1,0 МБ"]);
  });

  it("документы: PDF — с именем файла; архив — строкой, без скачивания; подпись — текстом", async () => {
    const { tg, store, post, message } = setup();
    tg.files.set("doc-pdf", { path: "documents/file_2.pdf", data: bytes.pdf() });
    await post(message({ document: { file_id: "doc-pdf", file_unique_id: "p", file_name: "Договор.pdf", mime_type: "application/pdf", file_size: 40 } }, 11));
    await post(message({ date: DATE + 5, document: { file_id: "doc-zip", file_unique_id: "z", file_name: "Сканы.zip", mime_type: "application/zip", file_size: 40 }, caption: "Все сканы" }, 12));
    const thread = store.thread("1");
    expect(thread.map((m) => m.text)).toEqual(["Договор.pdf", "Все сканы\nФайл «Сканы.zip»: такой вид файлов в CRM не сохраняется"]);
    expect(thread[0]?.attachments?.[0]).toMatchObject({ name: "Договор.pdf", mime: "application/pdf" });
    expect(tg.calls.filter((c) => c.method === "getFile").map((c) => c.body.file_id)).toEqual(["doc-pdf"]);
  });

  it("голосовое, аудио, «кружок», GIF — файлами с понятными подписями; у GIF документ второй раз не берётся", async () => {
    const { tg, store, post, message } = setup();
    tg.files.set("v1", { path: "voice/file_3.oga", data: bytes.ogg() });
    tg.files.set("a1", { path: "music/file_4.mp3", data: mp3() });
    tg.files.set("n1", { path: "video_notes/file_5.mp4", data: mp4(1) });
    tg.files.set("g1", { path: "animations/file_6.mp4", data: mp4(2) });
    await post(message({ voice: { file_id: "v1", file_unique_id: "1", duration: 3, mime_type: "audio/ogg", file_size: 68 } }, 20));
    await post(message({ audio: { file_id: "a1", file_unique_id: "2", duration: 60, performer: "Исполнитель", title: "Мелодия", mime_type: "audio/mpeg", file_size: 37 } }, 21));
    await post(message({ video_note: { file_id: "n1", file_unique_id: "3", length: 240, duration: 5, file_size: 44 } }, 22));
    await post(message({
      animation: { file_id: "g1", file_unique_id: "4", file_name: "smile.mp4", mime_type: "video/mp4", width: 200, height: 200, duration: 2, file_size: 44 },
      document: { file_id: "g1", file_unique_id: "4", file_name: "smile.mp4", mime_type: "video/mp4", file_size: 44 },
    }, 23));
    expect(store.thread("1").map((m) => [m.text, m.attachments?.[0]?.mime])).toEqual([
      ["Голосовое сообщение", "audio/ogg"],
      ["Исполнитель — Мелодия", "audio/mpeg"],
      ["Видеосообщение", "video/mp4"],
      ["GIF-анимация", "video/mp4"],
    ]);
    expect(tg.calls.filter((c) => c.method === "getFile").map((c) => c.body.file_id)).toEqual(["v1", "a1", "n1", "g1"]);
  });

  it("стикер, геопозиция, место, кубик, опрос, история — понятным текстом, без скачивания", async () => {
    const { tg, post, message, texts } = setup();
    await post(message({ sticker: { file_id: "st1", file_unique_id: "s", type: "regular", emoji: "😀", width: 512, height: 512, is_animated: false, is_video: false } }, 30));
    await post(message({ location: { latitude: 42.874621, longitude: 74.569762 } }, 31));
    await post(message({ location: { latitude: 42.87, longitude: 74.59 }, venue: { location: { latitude: 42.87, longitude: 74.59 }, title: "Офис", address: "ул. Примерная, 1" } }, 32));
    await post(message({ dice: { emoji: "🎲", value: 4 } }, 33));
    await post(message({ poll: { id: "p1", question: "Когда удобно?", options: [{ text: "Утром", voter_count: 0 }, { text: "Вечером", voter_count: 0 }], total_voter_count: 0 } }, 34));
    await post(message({ story: { chat: PRIVATE, id: 5 } }, 35));
    expect(texts()).toEqual([
      "Стикер 😀",
      "Геопозиция: 42.874621, 74.569762 — https://maps.google.com/?q=42.874621,74.569762",
      "Место: Офис, ул. Примерная, 1 — https://maps.google.com/?q=42.87,74.59",
      "Бросок 🎲: 4",
      "Опрос: Когда удобно? (варианты: Утром / Вечером)",
      "История Telegram — в CRM не показывается",
    ]);
    expect(tg.calls).toHaveLength(0);
  });

  it("свой номер (контакт самого клиента) — подлинный: переписка встаёт к клиенту, уже известному по этому телефону", async () => {
    const { store, post, message } = setup();
    // Клиент уже есть в CRM — оставлял заявку на сайте с этим номером
    await store.findOrCreateContact({ source: "site", externalId: "form-1", channel: "site", phone: "+996555000001", phoneTrusted: true, name: "Айгерим" });
    await post(message({ contact: { phone_number: "996555000001", first_name: "Айгерим", user_id: CHAT } }, 40));
    expect(store.contacts.size).toBe(1);
    expect(store.contacts.get("1")?.identities).toEqual(["site:form-1", `telegram:${CHAT}`]);
    expect(store.thread("1").map((m) => m.text)).toEqual(["Клиент поделился своим номером: +996 555 00-00-01"]);
  });

  it("чужой контакт и пересланный свой — только текстом, телефон клиенту не ставится", async () => {
    const { adapter, message } = setup();
    const other = await adapter.receive(hook(message({ contact: { phone_number: "+996555000002", first_name: "Коллега", user_id: 200000002 } })));
    const fwd = await adapter.receive(hook(message({
      contact: { phone_number: "996555000001", first_name: "Айгерим", user_id: CHAT },
      forward_origin: { type: "user", date: DATE, sender_user: { id: 300000003, is_bot: false, first_name: "Друг" } },
    })));
    expect(other).toMatchObject({ ok: true, events: [{ message: { text: "Контакт: Коллега, +996 555 00-00-02" } }] });
    expect(fwd).toMatchObject({ ok: true, events: [{ message: { text: "Переслано от Друг:\nКонтакт: Айгерим, +996 555 00-00-01" } }] });
    for (const r of [other, fwd]) {
      const ev = r.ok ? r.events[0] : undefined;
      expect(ev?.type === "message" ? [ev.contact.phone, ev.contact.phoneTrusted] : "нет события").toEqual([undefined, undefined]);
    }
  });

  it("ответ клиента с цитатой находит и его сообщение, и наше отправленное (ключ send — того же вида)", async () => {
    const { store, post, message, adapter } = setup();
    await post(message({ text: "Сколько стоит?" }, 50));
    // Менеджер ответил из CRM — проект записал сообщение с ключом, который вернул send
    const sent = await adapter.send({ externalId: String(CHAT) }, { text: "1000 сом", author: { type: "operator_crm", name: "Менеджер" } });
    expect(sent).toEqual({ ok: true, externalId: `tg:${CHAT}:500` });
    await store.saveMessage("1", {
      kind: "message", author: { type: "operator_crm" }, channel: "telegram", text: "1000 сом", at: new Date(NOW - 30_000).toISOString(), externalId: sent.ok ? sent.externalId : null,
    });
    await post(message({ date: DATE + 45, text: "А со скидкой?", reply_to_message: { message_id: 500, date: DATE + 30, chat: PRIVATE, from: BOT_USER, text: "1000 сом" } }, 51));
    const quoted = message({ date: DATE + 50, text: "Уточняю", reply_to_message: { message_id: 50, date: DATE, chat: PRIVATE, from: USER, text: "Сколько стоит?" }, quote: { text: "стоит", position: 8 } }, 52);
    expect(await adapter.receive(hook(quoted))).toMatchObject({ ok: true, events: [{ message: { replyTo: { externalId: `tg:${CHAT}:50`, text: "стоит" } } }] });
    await post(quoted);
    const [ask, answer, again, clarify] = store.thread("1");
    expect(again?.replyTo).toMatchObject({ id: answer?.id, externalId: `tg:${CHAT}:500`, text: "1000 сом" });
    expect(clarify?.replyTo).toMatchObject({ id: ask?.id, externalId: `tg:${CHAT}:50` });
  });

  it("правка сообщения — служебная строка с новым текстом, одна на правку; трансляция геопозиции — пропускается", async () => {
    const { post, store, message } = setup();
    await post(message({ text: "Завтра в 10" }, 60));
    const edit = { update_id: 900, edited_message: { message_id: 60, date: DATE, edit_date: DATE + 20, chat: PRIVATE, from: USER, text: "Завтра в 11" } };
    await post(edit);
    await post(edit);
    const live = await post({ update_id: 901, edited_message: { message_id: 61, date: DATE, edit_date: DATE + 30, chat: PRIVATE, from: USER, location: { latitude: 42.87, longitude: 74.59, live_period: 900 } } });
    expect(live.status).toBe(200);
    expect(live.summary.status).toBe("ignored");
    const thread = store.thread("1");
    expect(thread.map((m) => [m.kind, m.text])).toEqual([["message", "Завтра в 10"], ["system", "Клиент изменил сообщение: «Завтра в 11»"]]);
    expect(thread[1]?.externalId).toBe(`tg:${CHAT}:60:edit:${DATE + 20}`);
  });

  it("клиент заблокировал и разблокировал бота — по строке на каждую смену, повтор уведомления не задваивает", async () => {
    const { post, store, message } = setup();
    await post(message({ text: "Спасибо" }, 70));
    const member = (was: string, now: string, date: number, id: number) => ({
      update_id: id,
      my_chat_member: { chat: PRIVATE, from: USER, date, old_chat_member: { status: was, user: BOT_USER }, new_chat_member: { status: now, user: BOT_USER } },
    });
    await post(member("member", "kicked", DATE + 100, 910));
    await post(member("member", "kicked", DATE + 100, 910));
    await post(member("kicked", "member", DATE + 200, 911));
    expect(store.thread("1").filter((m) => m.kind === "system").map((m) => m.text)).toEqual([TELEGRAM_TEXTS.blocked, TELEGRAM_TEXTS.unblocked]);
  });

  it("свои слова служебных строк: «Пациент заблокировал бота»", async () => {
    const { post, store } = setup({ texts: { blocked: "Пациент заблокировал бота" } });
    await post({ update_id: 5, my_chat_member: { chat: PRIVATE, from: USER, date: DATE, old_chat_member: { status: "member" }, new_chat_member: { status: "kicked" } } });
    expect(store.thread("1").map((m) => m.text)).toEqual(["Пациент заблокировал бота"]);
  });

  it("группы: по умолчанию пропускаются (200); privateOnly: false — клиент — группа, автор — участник", async () => {
    const group = { id: -100000000001, type: "supergroup", title: "Группа клиентов" };
    const u = { update_id: 1, message: { message_id: 5, date: DATE, chat: group, from: USER, text: "Вопрос" } };
    const a = setup();
    const r = await a.post(u);
    expect(r.status).toBe(200);
    expect(r.summary.status).toBe("ignored");
    expect(a.store.contacts.size).toBe(0);
    const b = setup({ privateOnly: false });
    await b.post(u);
    expect(b.store.contacts.get("1")).toMatchObject({ name: "Группа клиентов", identities: ["telegram:-100000000001"] });
    expect(b.store.thread("1")[0]).toMatchObject({ text: "Вопрос", author: { type: "client", name: "Айгерим Тест" } });
  });

  it("кнопки, каналы, служебные сообщения — 200 и «пропущено»; не JSON и не уведомление — 400", async () => {
    const { post, store } = setup();
    const cb = await post({ update_id: 5, callback_query: { id: "q1", from: USER, chat_instance: "1", data: "x" } });
    expect(cb.status).toBe(200);
    expect(cb.summary).toMatchObject({ status: "ignored" });
    const ch = await post({ update_id: 6, channel_post: { message_id: 1, date: DATE, chat: { id: -1001, type: "channel", title: "Канал" }, text: "Новость" } });
    expect(ch.summary.status).toBe("ignored");
    const pin = await post({ update_id: 7, message: { message_id: 3, date: DATE, chat: PRIVATE, from: USER, pinned_message: { message_id: 2, date: DATE, chat: PRIVATE } } });
    expect(pin.summary.status).toBe("ignored");
    expect((await post("{не json")).status).toBe(400);
    expect((await post({ message: { text: "без номера уведомления" } })).status).toBe(400);
    expect(store.contacts.size).toBe(0);
  });

  it("«Старт» с меткой ссылки, скрытые ссылки в тексте, пересланное из канала", async () => {
    const { post, message, texts } = setup();
    await post(message({ text: "/start", entities: [{ type: "bot_command", offset: 0, length: 6 }] }, 80));
    await post(message({ text: "/start promo_autumn" }, 81));
    await post(message({
      text: "Смотрите здесь и тут",
      entities: [{ type: "text_link", offset: 9, length: 5, url: "https://example.com/a" }, { type: "text_link", offset: 17, length: 3, url: "https://example.com/b" }],
    }, 82));
    await post(message({ text: "Цены на сайте", forward_origin: { type: "channel", date: DATE, chat: { id: -1002, type: "channel", title: "Новости компании" }, message_id: 7 } }, 83));
    expect(texts()).toEqual([
      "Нажата кнопка «Старт»",
      "Нажата кнопка «Старт» (метка ссылки: promo_autumn)",
      "Смотрите здесь (https://example.com/a) и тут (https://example.com/b)",
      "Переслано от Новости компании:\nЦены на сайте",
    ]);
  });
});
