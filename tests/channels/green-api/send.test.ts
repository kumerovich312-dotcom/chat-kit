import { describe, expect, it } from "vitest";
import {
  createGreenApiAdapter, GREEN_API_CAPS, greenApiChatId, greenApiError, greenApiInstanceId, greenApiQuotedId, greenApiSetSettings,
  greenApiState, parseGreenApiWebhook, phoneFromChatId, type GreenApiOptions,
} from "../../../src/channels/green-api/index.js";
import { bytes } from "../../helpers/fake-net.js";
import { API, CHAT, fakeGreenApi, HOOK, ID, instanceData, MEDIA, TOKEN } from "./fake-green-api.js";

// Отправка через GREEN-API, ошибки словами и помощники — на поддельной сети. Номера, ключи и адреса — вымышленные.

function setup(o: Partial<GreenApiOptions> = {}) {
  const net = fakeGreenApi();
  const adapter = createGreenApiAdapter({ idInstance: ID, apiTokenInstance: TOKEN, apiUrl: `${API}/`, mediaUrl: MEDIA, webhookToken: HOOK, fetch: net.fetch, ...o });
  return { net, adapter };
}

const manager = { type: "operator_crm" as const, name: "Азат", id: "7" };

describe("отправка текста", () => {
  it("sendMessage на адрес инстанса; ключ повтора — «ga:<idMessage>»; умеет то, что умеет канал", async () => {
    const { adapter, net } = setup();
    expect(adapter.kind).toBe("green-api");
    expect(adapter.caps).toEqual(GREEN_API_CAPS);
    expect(GREEN_API_CAPS).toEqual({ text: true, files: true, pause: false, mute: false, start: true, statuses: true });
    const r = await adapter.send({ externalId: CHAT }, { text: "Добрый день! **Ждём вас**", author: manager });
    expect(r).toEqual({ ok: true, externalId: "ga:3EB0000000000001" });
    expect(net.calls).toEqual([{ url: `${API}/waInstance${ID}/sendMessage/${TOKEN}`, method: "POST", name: "sendMessage", json: { chatId: CHAT, message: "Добрый день! **Ждём вас**" }, form: null }]);
  });

  it("ответ бота — из Markdown в разметку WhatsApp; текст человека — как набран", async () => {
    const { adapter, net } = setup();
    await adapter.send({ externalId: CHAT }, { text: "**Запись** подтверждена:\n* завтра в 10:00\n[Карта](https://example.test/map)", author: { type: "bot" } });
    expect(net.calls[0]?.json?.message).toBe("*Запись* подтверждена:\n- завтра в 10:00\nКарта (https://example.test/map)");
  });

  it("написать первым по телефону: «+996 555 00-00-01» → 996555000001@c.us; местная запись без кода — ошибка без запроса", async () => {
    const { adapter, net } = setup();
    expect((await adapter.send({ externalId: "+996 555 00-00-01" }, { text: "Здравствуйте!", author: manager })).ok).toBe(true);
    expect(net.calls[0]?.json).toMatchObject({ chatId: "996555000001@c.us" });
    const local = await adapter.send({ externalId: "0555 00-00-01" }, { text: "Здравствуйте!" });
    expect(local).toMatchObject({ ok: false, retryable: false });
    expect(net.calls).toHaveLength(1);
  });

  it("цитата: номер сообщения GREEN-API из ключа набора (и у файла «:file:0»); ключ другого канала — без цитаты", async () => {
    const { adapter, net } = setup();
    await adapter.send({ externalId: CHAT }, { text: "Да", replyTo: { externalId: "ga:Q1" } });
    await adapter.send({ externalId: CHAT }, { text: "Получили", replyTo: { externalId: "ga:F1:file:0" } });
    await adapter.send({ externalId: CHAT }, { text: "Ок", replyTo: { externalId: "tg:100:5" } });
    expect(net.calls.map((c) => c.json?.quotedMessageId ?? null)).toEqual(["Q1", "F1", null]);
  });

  it("пустой текст и текст длиннее 20 000 знаков — ошибка без запроса", async () => {
    const { adapter, net } = setup();
    expect(await adapter.send({ externalId: CHAT }, { text: "   " })).toMatchObject({ ok: false, error: "Пустое сообщение — отправлять нечего" });
    expect((await adapter.send({ externalId: CHAT }, { text: "а".repeat(20_001) })).ok).toBe(false);
    expect(net.calls).toHaveLength(0);
  });
});

describe("отправка файла", () => {
  it("по ссылке проекта — sendFileByUrl: имя с расширением, текст — подписью", async () => {
    const { adapter, net } = setup();
    const url = "https://crm.example.test/files/15?exp=1&sig=abc";
    const r = await adapter.send({ externalId: CHAT }, { text: "Счёт за октябрь", file: { name: "Счёт", mime: "application/pdf", url }, author: manager, replyTo: { externalId: "ga:Q1" } });
    expect(r).toEqual({ ok: true, externalId: "ga:3EB0000000000001" });
    expect(net.calls[0]).toMatchObject({ url: `${API}/waInstance${ID}/sendFileByUrl/${TOKEN}`, json: { chatId: CHAT, urlFile: url, fileName: "Счёт.pdf", caption: "Счёт за октябрь", quotedMessageId: "Q1" } });
  });

  it("текст совпадает с именем файла — без подписи", async () => {
    const { adapter, net } = setup();
    await adapter.send({ externalId: CHAT }, { text: "Договор.pdf", file: { name: "Договор.pdf", mime: "application/pdf", url: "https://crm.example.test/files/16" } });
    expect(net.calls[0]?.json).toEqual({ chatId: CHAT, urlFile: "https://crm.example.test/files/16", fileName: "Договор.pdf" });
  });

  it("содержимым — sendFileByUpload формой на адрес загрузки (mediaUrl)", async () => {
    const { adapter, net } = setup();
    const data = bytes.jpeg();
    const r = await adapter.send({ externalId: CHAT }, { text: "Вот снимок", file: { name: "снимок.jpg", mime: "image/jpeg", data } });
    expect(r.ok).toBe(true);
    const c = net.calls[0];
    expect(c?.url).toBe(`${MEDIA}/waInstance${ID}/sendFileByUpload/${TOKEN}`);
    expect(c?.form?.get("chatId")).toBe(CHAT);
    expect(c?.form?.get("fileName")).toBe("снимок.jpg");
    expect(c?.form?.get("caption")).toBe("Вот снимок");
    const file = c?.form?.get("file");
    expect(file instanceof Blob ? [file.size, file.type] : null).toEqual([data.byteLength, "image/jpeg"]);
  });

  it("без адреса загрузки — на apiUrl", async () => {
    const { adapter, net } = setup({ mediaUrl: undefined });
    await adapter.send({ externalId: CHAT }, { text: "", file: { name: "голос.ogg", mime: "audio/ogg", data: bytes.ogg() } });
    expect(net.calls[0]?.url).toBe(`${API}/waInstance${ID}/sendFileByUpload/${TOKEN}`);
    expect(net.calls[0]?.form?.get("caption")).toBeNull();
  });

  it("подпись длиннее 1024, ссылка на внутренний адрес, файл без ссылки и данных — ошибка без запроса", async () => {
    const { adapter, net } = setup();
    const long = await adapter.send({ externalId: CHAT }, { text: "б".repeat(1025), file: { name: "a.pdf", mime: "application/pdf", url: "https://crm.example.test/files/1" } });
    expect(long).toMatchObject({ ok: false, error: "Подпись к файлу длиннее 1024 знаков — WhatsApp её не примет: отправьте текст отдельным сообщением" });
    const local = await adapter.send({ externalId: CHAT }, { text: "", file: { name: "a.pdf", mime: "application/pdf", url: "http://localhost:3000/files/1" } });
    expect(local.ok ? "" : local.error).toMatch(/внутренний адрес/);
    expect((await adapter.send({ externalId: CHAT }, { text: "", file: { name: "a.pdf", mime: "application/pdf" } })).ok).toBe(false);
    expect(net.calls).toHaveLength(0);
  });
});

describe("ошибки GREEN-API словами", () => {
  it("ключ, инстанс, лимит тарифа, частота, сбой сервера, WhatsApp не подключён, нет связи", async () => {
    const { adapter, net } = setup();
    const send = () => adapter.send({ externalId: CHAT }, { text: "Здравствуйте" });
    const cases: [number, string, RegExp, boolean][] = [
      [401, "Unauthorized", /apiTokenInstance/, false],
      [403, "Forbidden", /idInstance/, false],
      [466, JSON.stringify({ invokeStatus: { method: "sendmessage", status: "QUOTE_ALLOWED" }, correspondentsStatus: { method: "correspondents", used: 3, total: 3, status: "CORRESPONDENTS_QUOTE_EXCEEDED" } }), /^Закончился лимит тарифа GREEN-API: .*3 чатами/, false],
      [429, "Too Many Requests", /реже/, true],
      [502, "Bad Gateway", /временно не отвечает \(ошибка 502\)/, true],
      [400, JSON.stringify({ message: "instance is starting or not authorized" }), /^WhatsApp не подключён — отсканируйте QR в кабинете GREEN-API$/, false],
    ];
    for (const [status, body, error, retryable] of cases) {
      net.state.next = { status, body };
      const r = await send();
      expect(r.ok, `${status}`).toBe(false);
      if (!r.ok) {
        expect(r.error, `${status}`).toMatch(error);
        expect(r.retryable, `${status}`).toBe(retryable);
      }
    }
    net.state.down = true;
    expect(await send()).toEqual({ ok: false, error: "Нет связи с GREEN-API", retryable: true });
  });

  it("разбор ошибок: 400 с подробностями, запуск инстанса, срок тарифа, слишком большой файл", () => {
    expect(greenApiError(400, JSON.stringify({ message: "Validation failed. Details: 'chatId' is required" }))).toEqual({ error: "GREEN-API не принял запрос: Validation failed. Details: 'chatId' is required", retryable: false });
    expect(greenApiError(400, "instance in starting process try later")).toMatchObject({ retryable: true });
    expect(greenApiError(400, "Instance account is expired. Renew your instance from personal area").error).toMatch(/продлите тариф/);
    expect(greenApiError(500, "File from url exceeded max upload size. Size: 120mb Limit: 100mb")).toEqual({ error: "Файл слишком большой для WhatsApp (больше 100 МБ)", retryable: false });
    expect(greenApiError(466, "").error).toBe("Закончился лимит тарифа GREEN-API — смените тариф в кабинете GREEN-API");
  });

  it("настройки не заданы — ошибка без запроса", async () => {
    const { adapter, net } = setup({ apiUrl: "" });
    expect(await adapter.send({ externalId: CHAT }, { text: "Привет" })).toMatchObject({ ok: false, error: expect.stringMatching(/не настроено/), retryable: false });
    const http = setup({ apiUrl: "http://1100.api.greenapi.test" });
    expect((await http.adapter.send({ externalId: CHAT }, { text: "Привет" })).ok).toBe(false);
    expect(net.calls.length + http.net.calls.length).toBe(0);
  });
});

describe("скачивание файлов", () => {
  it("ссылка GREEN-API — с проверками набора; «ga-file:» — свежая ссылка через downloadFile; кривой адрес — bad", async () => {
    const { adapter, net } = setup();
    const url = "https://media.greenapi.test/1100000001/photo.jpg";
    net.files.set(url, bytes.jpeg());
    expect(await adapter.download!(url)).toMatchObject({ ok: true, mime: "image/jpeg", ext: "jpg" });
    net.state.fresh = "https://media.greenapi.test/fresh/doc.pdf";
    net.files.set(net.state.fresh, bytes.pdf());
    expect(await adapter.download!(`ga-file:${CHAT}:ABC123`)).toMatchObject({ ok: true, mime: "application/pdf" });
    expect(net.calls[0]?.json).toEqual({ chatId: CHAT, idMessage: "ABC123" });
    expect(await adapter.download!("ga-file:чепуха")).toEqual({ ok: false, reason: "bad" });
    net.state.fresh = "";
    expect(await adapter.download!(`ga-file:${CHAT}:GONE1`)).toEqual({ ok: false, reason: "missing" });
    net.state.next = { status: 500, body: "File unavailable" };
    expect(await adapter.download!(`ga-file:${CHAT}:LATER1`)).toEqual({ ok: false, reason: "retry" });
  });

  it("чужой тип (архив) и файл больше предела — не сохраняем", async () => {
    const { adapter, net } = setup({ maxFileBytes: 16 });
    net.files.set("https://media.greenapi.test/a.zip", bytes.zip());
    net.files.set("https://media.greenapi.test/big.jpg", bytes.jpeg());
    expect(await adapter.download!("https://media.greenapi.test/a.zip")).toEqual({ ok: false, reason: "bad" });
    expect(await adapter.download!("https://media.greenapi.test/big.jpg")).toEqual({ ok: false, reason: "bad" });
  });
});

describe("помощники", () => {
  it("адрес чата и телефон", () => {
    expect(greenApiChatId("+996 555 00-00-01")).toBe("996555000001@c.us");
    expect(greenApiChatId("996555000001")).toBe("996555000001@c.us");
    expect(greenApiChatId(CHAT)).toBe(CHAT);
    expect(greenApiChatId("120363000000000001@g.us")).toBe("120363000000000001@g.us");
    expect(greenApiChatId("155500000000001@lid")).toBe("155500000000001@lid");
    expect(greenApiChatId("0555 00-00-01")).toBeNull();
    expect(greenApiChatId("мама")).toBeNull();
    expect(greenApiChatId(null)).toBeNull();
    expect(phoneFromChatId(CHAT)).toBe("+996555000001");
    expect(phoneFromChatId("120363000000000001@g.us")).toBeNull();
    expect(phoneFromChatId("155500000000001@lid")).toBeNull();
  });

  it("номер цитаты и номер инстанса из уведомления", () => {
    expect(greenApiQuotedId("ga:3EB0000000000001")).toBe("3EB0000000000001");
    expect(greenApiQuotedId("ga:3EB0000000000001:file:2")).toBe("3EB0000000000001");
    expect(greenApiQuotedId("ga:call:C1")).toBeNull();
    expect(greenApiQuotedId("nb:12")).toBeNull();
    expect(greenApiInstanceId(JSON.stringify({ typeWebhook: "incomingMessageReceived", instanceData }))).toBe(ID);
    expect(greenApiInstanceId({ instanceData: { idInstance: "1100000001" } })).toBe(ID);
    expect(greenApiInstanceId("{не json")).toBeNull();
    expect(greenApiInstanceId({})).toBeNull();
  });

  it("состояние WhatsApp: getStateInstance → слова для администратора", async () => {
    const net = fakeGreenApi();
    const access = { idInstance: ID, apiTokenInstance: TOKEN, apiUrl: API, fetch: net.fetch };
    net.state.stateInstance = "notAuthorized";
    expect(await greenApiState(access)).toEqual({ ok: true, state: "notAuthorized", authorized: false, text: "WhatsApp не подключён — отсканируйте QR в кабинете GREEN-API" });
    expect(net.calls[0]).toMatchObject({ method: "GET", url: `${API}/waInstance${ID}/getStateInstance/${TOKEN}` });
    net.state.stateInstance = "authorized";
    expect(await greenApiState(access)).toMatchObject({ ok: true, authorized: true, text: "WhatsApp подключён" });
    net.state.next = { status: 401, body: "" };
    expect(await greenApiState(access)).toMatchObject({ ok: false, error: expect.stringMatching(/apiTokenInstance/) });
  });

  it("настройка уведомлений: адрес, ключ и нужные виды уведомлений; плохой адрес и короткий ключ — без запроса", async () => {
    const net = fakeGreenApi();
    const access = { idInstance: ID, apiTokenInstance: TOKEN, apiUrl: API, fetch: net.fetch };
    const hook = "https://crm.example.test/api/whatsapp/green-api";
    expect(await greenApiSetSettings({ ...access, webhookUrl: hook, webhookUrlToken: HOOK, extra: { delaySendMessagesMilliseconds: 1000 } })).toEqual({ ok: true });
    expect(net.calls[0]).toMatchObject({ method: "POST", url: `${API}/waInstance${ID}/setSettings/${TOKEN}` });
    expect(net.calls[0]?.json).toMatchObject({
      webhookUrl: hook, webhookUrlToken: HOOK, incomingWebhook: "yes", outgoingWebhook: "yes", outgoingMessageWebhook: "yes",
      outgoingAPIMessageWebhook: "yes", stateWebhook: "yes", incomingCallWebhook: "yes", editedMessageWebhook: "yes",
      deletedMessageWebhook: "yes", markIncomingMessagesReaded: "no", delaySendMessagesMilliseconds: 1000,
    });
    expect((await greenApiSetSettings({ ...access, webhookUrl: "http://crm.example.test/hook", webhookUrlToken: HOOK })).ok).toBe(false);
    expect((await greenApiSetSettings({ ...access, webhookUrl: "https://localhost/hook", webhookUrlToken: HOOK })).ok).toBe(false);
    expect((await greenApiSetSettings({ ...access, webhookUrl: hook, webhookUrlToken: "short" })).ok).toBe(false);
    expect(net.calls).toHaveLength(1);
  });

  it("разбор без сети: вид чата и пропуск лишнего", () => {
    expect(parseGreenApiWebhook({ typeWebhook: "deviceInfo" })).toMatchObject({ kind: "skip" });
    expect(parseGreenApiWebhook({ typeWebhook: "incomingCall", from: CHAT, status: "offer", idMessage: "C1" })).toMatchObject({ kind: "skip" });
    expect(parseGreenApiWebhook({ typeWebhook: "incomingCall", from: CHAT, status: "missed", idMessage: "C1", timestamp: 0 })).toMatchObject({
      kind: "events", events: [{ type: "call", call: { externalId: "ga:call:C1", direction: "in", missed: true, at: null } }],
    });
  });
});
