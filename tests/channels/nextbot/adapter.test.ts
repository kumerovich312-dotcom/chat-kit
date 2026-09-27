import { describe, expect, it } from "vitest";
import { createNextbotAdapter, DEFAULT_MANAGER_NOTE, handleNextbotRequest, type NextbotSettings } from "../../../src/channels/nextbot/index.js";
import { createMemoryStore, ingest, sha1Hex, type IngestHooks } from "../../../src/server/index.js";
import { bytes, fakeNet } from "../../helpers/fake-net.js";

// Подключение Nextbot на переходнике «в памяти» и поддельной сети — сценарии с настоящего Nextbot.
// Имена, номера, диалоги и адреса — вымышленные.

const T0 = Date.parse("2026-09-27T08:00:00Z");
const MIN = 60_000;
const DO = "https://media-test.fra1.digitaloceanspaces.com/000000000000/";

function setup(o: { settings?: Partial<NextbotSettings>; hooks?: IngestHooks; canStoreFiles?: boolean; webhookStatus?: () => number; functions?: string[] } = {}) {
  const net = fakeNet(o.webhookStatus ? { webhookStatus: o.webhookStatus } : {});
  const store = createMemoryStore({ countryCode: "+996" });
  let now = T0;
  const adapter = createNextbotAdapter({
    settings: { enabled: true, webhookUrl: net.webhook, managerNote: DEFAULT_MANAGER_NOTE, phoneCode: "+996", ...o.settings },
    store, fetch: net.fetch, now: () => now,
    ...(o.canStoreFiles === false ? { canStoreFiles: async () => false } : {}),
    ...(o.functions ? { functions: o.functions } : {}),
  });
  const post = async (body: unknown, at = now) => {
    now = at;
    return ingest(adapter, store, { method: "POST", headers: {}, body: typeof body === "string" ? body : JSON.stringify(body) }, { now: () => now, hooks: o.hooks });
  };
  const texts = (contactId: string) => store.thread(contactId).map((m) => m.text);
  return { net, store, adapter, post, texts };
}

describe("приём событий Nextbot", () => {
  it("сообщение клиента: клиент заведён по номеру из WhatsApp, время — из поля time, клиент ждёт ответа", async () => {
    const { store, post } = setup();
    const r = await post({ event: "client_message", dialog_id: 10001, client_message: "Есть свободное время в субботу?", messenger: "WhatsApp", name: "Азат", phone: "0555 00-00-01", time: "2026-09-27 13:59:40" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, status: "ok", event: "client_message", client_id: "1", created_client: true });
    const [m] = store.thread("1");
    expect(m).toMatchObject({ text: "Есть свободное время в субботу?", author: { type: "client" }, channel: "whatsapp", at: "2026-09-27T07:59:40.000Z" });
    expect(store.waitingSince("1")).toBe("2026-09-27T07:59:40.000Z");
    expect(store.contacts.get("1")).toMatchObject({ phone: "+996555000001", channel: "whatsapp" });
  });

  it("повтор того же сообщения (по message_id) — duplicate, без второго сообщения", async () => {
    const { post, texts } = setup();
    const ev = { event: "client_message", dialog_id: 10002, message_id: "m1", client_message: "Здравствуйте", messenger: "WhatsApp" };
    await post(ev);
    const again = await post(ev, T0 + 5_000);
    expect(again.body).toMatchObject({ status: "duplicate" });
    expect(texts("1")).toEqual(["Здравствуйте"]);
  });

  it("ответ ИИ-агента — автор «бот», тот же клиент, клиент больше не ждёт", async () => {
    const { store, post } = setup();
    await post({ event: "client_message", dialog_id: 10003, client_message: "Сколько стоит?", messenger: "Instagram", name: "Бакыт" });
    const bot = await post({ event: "bot_message", dialog_id: 10003, text: "Да, есть свободное время", messenger: "Instagram" }, T0 + 3_000);
    expect(bot.body).toMatchObject({ ok: true, client_id: "1", created_client: false });
    expect(store.thread("1").map((m) => m.author.type)).toEqual(["client", "bot"]);
    expect(store.waitingSince("1")).toBeNull();
  });

  it("без текста — пропущено с подсказкой; пробный запуск из редактора — понятная подсказка; без диалога — 422; не JSON — 400", async () => {
    const { post, store } = setup();
    const notext = await post({ event: "client_message", dialog_id: 10004 });
    expect(notext.status).toBe(200);
    expect(notext.body).toMatchObject({ status: "ignored" });
    expect(String((notext.body as { error: string }).error)).toMatch(/текст/i);
    const testRun = await post({ event: "client_message", text: "test value", dialog_id: "test value" });
    expect(testRun.status).toBe(422);
    expect(String((testRun.body as { error: string }).error)).toMatch(/редактора Nextbot/);
    const nodialog = await post({ event: "client_message", text: "Привет" });
    expect(nodialog.status).toBe(422);
    expect((await post("{не json")).status).toBe(400);
    expect(store.contacts.size).toBe(0);
  });

  it("тестовый чат Nextbot — мимо CRM, клиента не заводим", async () => {
    const { post, store } = setup();
    const tc = await post({ event: "client_message", dialog_id: 10005, text: "проверка", messenger: "Тестовый чат", name: "WindowChat" });
    expect(tc.status).toBe(200);
    expect(tc.body).toMatchObject({ status: "ignored" });
    expect(store.contacts.size).toBe(0);
  });
});

describe("«Полный диалог»", () => {
  it("реплики разложены по сообщениям, время — по Гринвичу; повторный дамп добавляет только новое", async () => {
    const { post, store, texts } = setup();
    const dump1 = "27.09.26 07-50 [Азат]: Салам алейкум\n27.09.26 07-50 [ИИ-квалификатор]: Здравствуйте! Чем помочь?\n27.09.26 07-51 [Азат]: Нужна консультация";
    await post({ event: "client_message", dialog_id: 20001, text: dump1, name: "Азат", messenger: "Instagram" });
    expect(texts("1")).toEqual(["Салам алейкум", "Здравствуйте! Чем помочь?", "Нужна консультация"]);
    expect(store.thread("1").map((m) => m.at)).toEqual(["2026-09-27T07:50:00.000Z", "2026-09-27T07:50:00.001Z", "2026-09-27T07:51:59.999Z"]);
    const dump2 = `${dump1}\n27.09.26 07-52 [ИИ-квалификатор]: Какой день удобен?\n27.09.26 07-53 [Азат]: Есть кто?`;
    await post({ event: "client_message", dialog_id: 20001, text: dump2, name: "Азат", messenger: "Instagram" }, T0 + MIN);
    expect(texts("1")).toEqual(["Салам алейкум", "Здравствуйте! Чем помочь?", "Нужна консультация", "Какой день удобен?", "Есть кто?"]);
  });

  it("ответ бота и следующее сообщение клиента в ту же минуту — клиент ниже бота, как в WhatsApp, и ждёт ответа", async () => {
    const { post, store, texts } = setup();
    await post({ event: "client_message", dialog_id: 20002, name: "Бакыт", text: "27.09.26 07-58 [ИИ-агент]: Здравствуйте!\n27.09.26 07-59 [Бакыт]: Сколько стоит?" }, T0 - 40_000);
    await post({ event: "bot_message", dialog_id: 20002, text: "От 1000 сом", time: "2026-09-27 13:59:40" }, T0 - 20_000);
    await post({
      event: "client_message", dialog_id: 20002, name: "Бакыт",
      text: "27.09.26 07-58 [ИИ-агент]: Здравствуйте!\n27.09.26 07-59 [Бакыт]: Сколько стоит?\n27.09.26 07-59 [ИИ-агент]: От 1000 сом\n27.09.26 07-59 [Бакыт]: А в субботу?",
    }, T0 + 30_000);
    expect(texts("1")).toEqual(["Здравствуйте!", "Сколько стоит?", "От 1000 сом", "А в субботу?"]);
    expect(store.waitingSince("1")).toBe("2026-09-27T07:59:59.999Z");
  });

  it("поле time: вопрос клиента выше ответа бота, хотя пришёл в CRM позже; клиент не ждёт", async () => {
    const { post, store, texts } = setup();
    await post({ event: "bot_message", dialog_id: 20003, text: "Да, есть", time: "2026-09-27 14:00:05" }, T0 + 6_000);
    await post({ event: "client_message", dialog_id: 20003, client_message: "Сколько стоит?", time: "2026-09-27 14:00:00" }, T0 + 8_000);
    expect(texts("1")).toEqual(["Сколько стоит?", "Да, есть"]);
    expect(store.waitingSince("1")).toBeNull();
  });

  it("время без секунд не берём — ставим время прихода", async () => {
    const { post, store } = setup();
    await post({ event: "client_message", dialog_id: 20004, client_message: "Нужна консультация", time: "27.09.2026, 13:59" }, T0 + 20_000);
    expect(store.thread("1")[0]?.at).toBe(new Date(T0 + 20_000).toISOString());
  });

  it("ответ из дампа, которого не было событием, — «менеджер с телефона»; событие бота позже с тем же текстом исправляет на бота", async () => {
    const { post, store } = setup();
    await post({ event: "bot_message", dialog_id: 20005, text: "Здравствуйте!" }, T0);
    await post({
      event: "client_message", dialog_id: 20005, name: "Жылдыз",
      text: "27.09.26 08-00 [ИИ-агент]: Здравствуйте!\n27.09.26 08-01 [Жылдыз]: Салам\n27.09.26 08-02 [ИИ-агент]: Азыр загранга жазабыз\n27.09.26 08-03 [Жылдыз]: Рахмат",
    }, T0 + 4 * MIN);
    const phone = store.thread("1").find((m) => m.text === "Азыр загранга жазабыз");
    expect(phone?.author.type).toBe("operator_phone");
    await post({ event: "bot_message", dialog_id: 20005, text: "Азыр загранга жазабыз" }, T0 + 5 * MIN);
    const fixed = store.thread("1").filter((m) => m.text === "Азыр загранга жазабыз");
    expect(fixed).toHaveLength(1);
    expect(fixed[0]?.author.type).toBe("bot");
  });

  it("поле agent с ответом, который уже есть в дампе, — без дубля; новый ответ — после последней реплики", async () => {
    const { post, texts } = setup();
    const dump = "27.09.26 07-50 [Эрлан]: Салам\n27.09.26 07-50 [ИИ-агент]: Чем помочь?\n27.09.26 07-51 [Эрлан]: А зарплата какая?";
    await post({ event: "client_message", dialog_id: 20006, name: "Эрлан", text: dump, agent: "Чем помочь?" });
    expect(texts("1").filter((t) => t === "Чем помочь?")).toHaveLength(1);
    await post({ event: "client_message", dialog_id: 20006, name: "Эрлан", text: dump, agent: "Зарплата от 2500 евро" }, T0 + MIN);
    const list = texts("1");
    expect(list.indexOf("Зарплата от 2500 евро")).toBeGreaterThan(list.indexOf("А зарплата какая?"));
  });
});

describe("служебные строки и передача человеку", () => {
  it("ошибка доставки — строкой в переписке один раз; «диалог на паузе» — своей строкой, ответ из agent — менеджер с телефона", async () => {
    const { post, store, texts } = setup();
    await post({ event: "client_message", dialog_id: 30001, client_message: "Алло", errors: "номер недоступен" });
    await post({ event: "client_message", dialog_id: 30001, message_id: "x2", client_message: "Алло?", errors: "номер недоступен" }, T0 + MIN);
    expect(texts("1").filter((t) => t === "Nextbot не доставил сообщение клиенту: номер недоступен")).toHaveLength(1);
    await post({ event: "client_message", dialog_id: 30002, client_message: "Здравствуйте", errors: "VALIDATE_ACCESS_DIALOG_PAUSED", agent: "Сейчас уточню и напишу" }, T0 + 2 * MIN);
    const t2 = store.thread("2");
    expect(t2.some((m) => m.kind === "system" && m.text.startsWith("ИИ-агент в этом диалоге на паузе"))).toBe(true);
    expect(t2.some((m) => m.kind === "system" && m.text.startsWith("Nextbot не доставил"))).toBe(false);
    expect(t2.find((m) => m.text === "Сейчас уточню и напишу")?.author.type).toBe("operator_phone");
  });

  it("бот «передаю менеджеру» — пометка, клиент снова ждёт человека", async () => {
    const { post, store } = setup();
    await post({ event: "client_message", dialog_id: 30003, client_message: "Хочу подписать договор" }, T0);
    await post({ event: "bot_message", dialog_id: 30003, text: "Сейчас передам вас нашему менеджеру" }, T0 + 5_000);
    const bot = store.thread("1").find((m) => m.author.type === "bot");
    expect(bot?.handoff).toBe(true);
    expect(store.waitingSince("1")).toBe(new Date(T0).toISOString());
  });
});

describe("файлы из Nextbot", () => {
  it("фото полем события — скачано после ответа и стоит сразу за сообщением; знакомую ссылку второй раз не качаем", async () => {
    const { post, store, net } = setup();
    const url = "https://storage.nextbot.ru/u/photo-a1.jpg";
    net.files.set(url, bytes.jpeg());
    await post({ event: "client_message", dialog_id: 40001, client_message: "Вот фото", picture: url });
    let thread = store.thread("1");
    expect(thread.map((m) => m.text)).toEqual(["Вот фото", "Фото от клиента"]);
    expect(thread[1]?.attachments?.[0]?.mime).toBe("image/jpeg");
    expect(Date.parse(thread[1]!.at)).toBe(Date.parse(thread[0]!.at) + 1);
    await post({ event: "client_message", dialog_id: 40001, message_id: "m2", client_message: "И ещё вопрос", picture: url }, T0 + MIN);
    thread = store.thread("1");
    expect(net.gets.get(url)).toBe(1);
    expect(thread.filter((m) => m.attachments?.length)).toHaveLength(1);
  });

  it("файлы в дампе: фото одним именем найдено в папке хранилища, договор — с настоящим названием, голосовое; всё на своих местах", async () => {
    const { post, store, net } = setup();
    const photo = "0da4d22f-c0aa-4b68-b32a-024db71cd27b.jpg";
    const doc = "d421810c-84dc-40c9-9e45-504c9c6497f0.docx";
    const voice = "f98f7172-cc94-40f8-ab48-59f0fe37a012.oga";
    net.files.set(DO + photo, bytes.jpeg());
    net.files.set(DO + doc, bytes.docx());
    net.files.set(DO + voice, bytes.ogg());
    await post({ event: "bot_message", dialog_id: 40002, text: "Здравствуйте!" }, T0 - 10 * MIN);
    const dump = [
      "27.09.26 07-50 [ИИ-агент]: Здравствуйте!",
      "27.09.26 07-51 [Айгуль]: Отправьте договор, пожалуйста",
      `27.09.26 07-52 [ИИ-агент]: ${photo}`,
      `27.09.26 07-53 [ИИ-агент]: ${DO}${doc}`,
      "ДОГОВОР(ПРИМЕР) - 2026 (1)",
      `27.09.26 07-54 [Айгуль]: ${DO}${voice}`,
      "27.09.26 07-55 [Айгуль]: Спасибо!",
    ].join("\n");
    await post({ event: "client_message", dialog_id: 40002, name: "Айгуль", text: dump }, T0);
    const thread = store.thread("1");
    expect(thread.map((m) => m.text)).toEqual(["Здравствуйте!", "Отправьте договор, пожалуйста", "Фото", "ДОГОВОР(ПРИМЕР) - 2026 (1).docx", "Голосовое сообщение", "Спасибо!"]);
    expect(thread.map((m) => m.author.type)).toEqual(["bot", "client", "operator_phone", "operator_phone", "client", "client"]);
    expect(thread.map((m) => m.attachments?.[0]?.mime ?? "")).toEqual(["", "", "image/jpeg", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "audio/ogg", ""]);
    expect(thread.some((m) => m.text.includes("digitaloceanspaces") || m.text.includes(photo))).toBe(false);
    // Повтор дампа: файлы не скачиваются снова и не дублируются
    const before = [...net.gets.values()].reduce((a, b) => a + b, 0);
    await post({ event: "client_message", dialog_id: 40002, name: "Айгуль", text: dump }, T0 + MIN);
    expect([...net.gets.values()].reduce((a, b) => a + b, 0)).toBe(before);
    expect(store.thread("1")).toHaveLength(6);
  });

  it("файла нет ни в одной папке — строка остаётся текстом; строка, записанная раньше текстом, становится файлом", async () => {
    const { post, store, net } = setup();
    const lost = "11111111-2222-4333-8444-555555555555.jpg";
    const legacy = "66666666-7777-4888-8999-aaaaaaaaaaaa.jpg";
    const voice = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff.oga";
    net.files.set(DO + voice, bytes.ogg());
    net.files.set(DO + legacy, bytes.png());
    const c = await store.findOrCreateContact({ source: "nextbot", externalId: "40003", channel: "whatsapp", name: "Нурлан" });
    const legacyLine = { at: "2026-09-27 07:56", author: "ИИ-агент", text: legacy };
    await store.saveMessage(c.contactId, {
      kind: "message", author: { type: "operator_phone" }, channel: "whatsapp", text: legacy, at: "2026-09-27T07:56:00.000Z",
      externalId: `nb:40003:${sha1Hex(`${legacyLine.at}|${legacyLine.author}|${legacyLine.text}`).slice(0, 32)}`,
    });
    const dump = [
      `27.09.26 07-55 [Нурлан]: ${DO}${voice}`,
      `27.09.26 07-56 [ИИ-агент]: ${legacy}`,
      `27.09.26 07-57 [ИИ-агент]: ${lost}`,
      "27.09.26 07-58 [Нурлан]: Получил",
    ].join("\n");
    await post({ event: "client_message", dialog_id: 40003, name: "Нурлан", text: dump }, T0);
    const thread = store.thread(c.contactId);
    const converted = thread.find((m) => m.at === "2026-09-27T07:56:00.000Z");
    expect(converted?.attachments?.[0]?.mime).toBe("image/png");
    expect(converted?.text).toBe("Фото");
    expect(thread.find((m) => m.text === lost)?.attachments).toBeUndefined();
  });

  it("клиенту некуда положить файл — строки-файлы остаются текстом, ничего не скачиваем", async () => {
    const { post, store, net } = setup({ canStoreFiles: false });
    const voice = "12345678-1234-4234-8234-123456789012.oga";
    net.files.set(DO + voice, bytes.ogg());
    await post({ event: "client_message", dialog_id: 40004, name: "Азиз", text: `27.09.26 07-50 [Азиз]: Салам\n27.09.26 07-51 [Азиз]: ${DO}${voice}` });
    expect(store.thread("1").map((m) => m.text)).toEqual(["Салам", `${DO}${voice}`]);
    expect(net.gets.size).toBe(0);
  });

  it("чужой тип файла не сохраняется", async () => {
    const { post, store, net } = setup();
    const url = "https://storage.nextbot.ru/u/archive.zip";
    net.files.set(url, bytes.zip());
    await post({ event: "client_message", dialog_id: 40005, client_message: "Архив", document: url });
    expect(store.files.size).toBe(0);
    expect(store.thread("1").map((m) => m.text)).toEqual(["Архив"]);
  });
});

describe("ответ менеджера в Nextbot", () => {
  it("первый ответ за 6 часов — сначала заметка боту «не перебивай», потом ответ клиенту; второй — без заметки", async () => {
    const { adapter, store, net } = setup();
    const c = await store.findOrCreateContact({ source: "nextbot", externalId: "50001", channel: "instagram" });
    const r = await adapter.send({ externalId: "50001", contactId: c.contactId }, { text: "Ответ менеджера", author: { type: "operator_crm", name: "Нургуль" }, messageId: "7", idempotencyKey: "crm:abc" });
    expect(r).toEqual({ ok: true, externalId: "crm:abc" });
    expect(net.sent.map((x) => x.body.message_type)).toEqual(["output", "forwarded_output"]);
    expect(String(net.sent[0]?.body.text)).toMatch(/Нургуль.*Не отвечай/);
    expect(net.sent[1]?.body).toMatchObject({ dialog_id: 50001, text: "Ответ менеджера", message_id: "crm:abc" });
    await store.saveMessage(c.contactId, { kind: "message", author: { type: "operator_crm", name: "Нургуль" }, channel: "instagram", text: "Ответ менеджера", at: new Date(T0).toISOString(), delivery: "sent" });
    await adapter.send({ externalId: "50001", contactId: c.contactId }, { text: "Второй ответ", author: { type: "operator_crm", name: "Нургуль" } });
    expect(net.sent.map((x) => x.body.message_type)).toEqual(["output", "forwarded_output", "forwarded_output"]);
  });

  it("файл клиенту — ссылкой на картинку, подпись — следом отдельным сообщением", async () => {
    const { adapter, net } = setup({ settings: { managerNote: "" } });
    const r = await adapter.send({ externalId: "50002" }, { text: "Вот скан", file: { name: "скан.jpg", mime: "image/jpeg", url: "https://crm.example/files/5?exp=1&sig=x" } });
    expect(r.ok).toBe(true);
    expect(net.sent[0]?.body).toMatchObject({ message_type: "forwarded_output", content_type: "image", image_url: "https://crm.example/files/5?exp=1&sig=x", text: "скан.jpg" });
    expect(net.sent[1]?.body).toMatchObject({ message_type: "forwarded_output", text: "Вот скан" });
  });

  it("ошибка Nextbot — «не доставлено» с причиной; чужая ссылка вебхука — никуда не ходим", async () => {
    const fail = setup({ webhookStatus: () => 500, settings: { managerNote: "" } });
    expect(await fail.adapter.send({ externalId: "50003" }, { text: "Не дойдёт" })).toMatchObject({ ok: false, error: "Nextbot ответил 500", retryable: true });
    const evil = setup({ settings: { webhookUrl: "https://evil.example/hook", managerNote: "" } });
    const r = await evil.adapter.send({ externalId: "50004" }, { text: "x" });
    expect(r.ok).toBe(false);
    expect(evil.net.sent).toHaveLength(0);
  });
});

describe("заявка, функция бота и ключ", () => {
  it("заявка бота — обработчику проекта с полями; телефон записан клиенту", async () => {
    const leads: Record<string, unknown>[] = [];
    const { post, store } = setup({ hooks: { onLead: async (x) => { leads.push(x.fields); } } });
    const r = await post({ event: "lead", dialog_id: 60001, args: { city: "Бишкек", service: "Консультация", phone: "0555 00-00-02", name: "Эрлан", messenger: "WhatsApp" } });
    expect(r.body).toMatchObject({ ok: true, event: "lead" });
    expect(leads[0]).toMatchObject({ city: "Бишкек", service: "Консультация", phone: "+996555000002" });
    expect(store.contacts.get("1")?.phone).toBe("+996555000002");
  });

  it("функция бота — ответ проекта уходит боту текстом: event function с именем или имя из списка проекта", async () => {
    const calls: { name: string; args: Record<string, string | null> }[] = [];
    const { post } = setup({
      functions: ["free_slots"],
      hooks: { onFunction: async (name, args) => { calls.push({ name, args }); return { text: `${name}: ${args.date}`, count: 2 }; } },
    });
    const r = await post({ event: "free_slots", key: "test-secret-not-real-nextbot", args: { date: "2026-10-12", service: "Консультация" } });
    expect(r.body).toMatchObject({ ok: true, event: "free_slots", count: 2, text: "free_slots: 2026-10-12" });
    expect(calls[0]?.args).toMatchObject({ date: "2026-10-12", service: "Консультация" });
    expect(calls[0]?.args).not.toHaveProperty("key");
    const r2 = await post({ event: "function", function: "in_stock", args: { product: "Товар 1" } });
    expect(r2.body).toMatchObject({ ok: true, event: "in_stock", count: 2 });
    const r3 = await post({ event: "function", args: { product: "Товар 1" } });
    expect(r3.status).toBe(422);
  });

  it("маршрут: без ключа и с неверным — 401, выключено — 403, верный — принято", async () => {
    const { adapter, store } = setup();
    const req = (key?: string) => new Request("http://crm.test/api/nextbot/events", {
      method: "POST", body: JSON.stringify({ event: "ping" }), headers: key ? { authorization: `Bearer ${key}` } : {},
    });
    const key = "nb_test-secret-not-real-0000";
    const resolve = async (k: string) => (k === key ? { enabled: true, adapter, store } : k === "nb_test-secret-not-real-off" ? { enabled: false, adapter, store } : null);
    expect((await handleNextbotRequest(req(), resolve)).status).toBe(401);
    expect((await handleNextbotRequest(req("nb_test-secret-not-real-9999"), resolve)).status).toBe(401);
    expect((await handleNextbotRequest(req("nb_test-secret-not-real-off"), resolve)).status).toBe(403);
    const ok = await handleNextbotRequest(req(key), resolve);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, event: "ping" });
  });
});
