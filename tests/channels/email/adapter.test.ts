import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  cleanMessageId, createEmailAdapter, emailWebhookAuthorized, messageIds, parseAddress, parseMailDate, toDataUrl, type EmailOptions, type OutgoingMail,
} from "../../../src/channels/email/index.js";
import { createMemoryStore, ingest } from "../../../src/server/index.js";
import { bytes, fakeNet } from "../../helpers/fake-net.js";

// Подключение «почта» на переходнике «в памяти»: вебхук Postmark Inbound и универсальный JSON. Адреса, имена,
// ключи — вымышленные.

const TOKEN = "test-secret-not-real-email";
const NOW = Date.parse("2026-09-27T08:00:00Z");
const b64 = (u: Uint8Array | string) => Buffer.from(typeof u === "string" ? new TextEncoder().encode(u) : u).toString("base64");

/** Письмо клиента так, как его присылает Postmark Inbound */
function postmark(over: Record<string, unknown> = {}) {
  return {
    FromName: "Клиент Тест",
    MessageStream: "inbound",
    From: "client@example.com",
    FromFull: { Email: "Client@Example.com", Name: "Клиент Тест", MailboxHash: "" },
    To: '"Компания" <inbox@company.example>',
    ToFull: [{ Email: "inbox@company.example", Name: "Компания", MailboxHash: "" }],
    Cc: "",
    CcFull: [],
    OriginalRecipient: "inbox@company.example",
    Subject: "Вопрос по заказу",
    MessageID: "7c1d6c2e-1111-4000-8000-000000000001",
    ReplyTo: "",
    MailboxHash: "",
    Date: "Sat, 27 Sep 2026 13:59:30 +0600",
    TextBody: "Здравствуйте! Когда будет готов заказ?\n\nОтправлено с iPhone",
    HtmlBody: "<div>Здравствуйте! Когда будет готов заказ?</div>",
    StrippedTextReply: "",
    Tag: "",
    Headers: [
      { Name: "Return-Path", Value: "<client@example.com>" },
      { Name: "X-Spam-Status", Value: "No" },
      { Name: "Message-ID", Value: "<CAF-client-0001@mail.example.com>" },
    ],
    Attachments: [],
    ...over,
  };
}

function setup(o: Partial<EmailOptions> = {}) {
  const store = createMemoryStore();
  const sent: OutgoingMail[] = [];
  const net = fakeNet();
  const adapter = createEmailAdapter({
    inboundToken: TOKEN,
    from: "Компания <hello@company.example>",
    send: async (m) => { sent.push(m); return { messageId: m.messageId }; },
    fetch: net.fetch,
    now: () => NOW,
    ...o,
  });
  const post = (body: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }, url?: string) =>
    ingest(adapter, store, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body), ...(url ? { url } : {}) }, { now: () => NOW });
  return { store, adapter, sent, post, net };
}

describe("приём писем: Postmark", () => {
  it("письмо клиента в ленте: клиент по адресу (маленькими буквами), тема, время из Date, без «Отправлено с iPhone»; клиент ждёт ответа", async () => {
    const { store, post } = setup();
    const r = await post(postmark());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, status: "ok", contact_id: "1" });
    expect(store.contacts.get("1")).toMatchObject({ name: "Клиент Тест", channel: "email", identities: ["email:client@example.com"] });
    const [m] = store.thread("1");
    expect(m).toMatchObject({
      text: "Здравствуйте! Когда будет готов заказ?", subject: "Вопрос по заказу", channel: "email", author: { type: "client" },
      at: "2026-09-27T07:59:30.000Z", externalId: "mail:CAF-client-0001@mail.example.com",
    });
    expect(store.waitingSince("1")).toBe("2026-09-27T07:59:30.000Z");
  });

  it("повтор того же письма (Postmark повторил вебхук или письмо пришло дважды) — duplicate", async () => {
    const { store, post } = setup();
    await post(postmark());
    const again = await post(postmark());
    expect(again.body).toMatchObject({ status: "duplicate" });
    // Тот же Message-ID, другой номер Postmark — то же письмо
    const third = await post(postmark({ MessageID: "7c1d6c2e-1111-4000-8000-000000000002" }));
    expect(third.body).toMatchObject({ status: "duplicate" });
    expect(store.thread("1")).toHaveLength(1);
  });

  it("английский ответ: берём StrippedTextReply Postmark; письмо только в HTML — читаемым текстом без цитаты", async () => {
    const { store, post } = setup();
    await post(postmark({
      TextBody: "Thanks!\n\nOn Fri, Sep 26, 2026 at 10:00 AM Company <hello@company.example> wrote:\n> Your order is ready.",
      StrippedTextReply: "Thanks!\n",
    }));
    expect(store.thread("1")[0]?.text).toBe("Thanks!");
    await post(postmark({
      MessageID: "7c1d6c2e-1111-4000-8000-000000000003",
      Headers: [{ Name: "Message-ID", Value: "<CAF-client-0002@mail.example.com>" }],
      TextBody: "",
      HtmlBody: '<div dir="ltr">Спасибо! Заберу <b>завтра</b>.</div><div class="gmail_quote"><div class="gmail_attr">пт, 26 сент. 2026 г. в 10:00, Компания &lt;hello@company.example&gt;:</div><blockquote class="gmail_quote">Заказ готов.</blockquote></div>',
    }));
    expect(store.thread("1")[1]?.text).toBe("Спасибо! Заберу завтра.");
  });

  it("проверка вебхука из кабинета Postmark — ответ 200 без клиента", async () => {
    const { store, post } = setup();
    const r = await post(postmark({ From: "support@postmarkapp.com", FromFull: { Email: "support@postmarkapp.com", Name: "Postmarkapp Support" } }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true });
    expect(store.contacts.size).toBe(0);
  });
});

describe("ключ приёма", () => {
  it("Bearer, пароль Basic-входа (Postmark: https://имя:ключ@адрес), ?token= в адресе — принимаются; чужой или без ключа — 401", async () => {
    const { post, store } = setup();
    const basic = (pass: string) => ({ authorization: `Basic ${b64(`postmark:${pass}`)}` });
    expect((await post(postmark(), {})).status).toBe(401);
    expect((await post(postmark(), { authorization: "Bearer test-secret-not-real-other" })).status).toBe(401);
    expect((await post(postmark(), basic("test-secret-not-real-other"))).status).toBe(401);
    expect((await post(postmark(), {}, "https://crm.example/api/email?token=wrong")).status).toBe(401);
    expect(store.contacts.size).toBe(0);
    expect((await post(postmark(), basic(TOKEN))).status).toBe(200);
    expect((await post(postmark({ MessageID: "m2", Headers: [{ Name: "Message-ID", Value: "<m2@mail.example.com>" }] }), {}, `https://crm.example/api/email?token=${TOKEN}`)).status).toBe(200);
    expect((await post(postmark({ MessageID: "m3", Headers: [{ Name: "Message-ID", Value: "<m3@mail.example.com>" }] }), { Authorization: `Bearer ${TOKEN}` })).status).toBe(200);
    expect(store.thread("1")).toHaveLength(3);
  });

  it("ключ не настроен — не пускаем никого", () => {
    const input = { method: "POST", headers: { authorization: "Bearer " }, body: "{}" };
    expect(emailWebhookAuthorized(input, "")).toBe(false);
    expect(emailWebhookAuthorized({ ...input, url: "https://crm.example/api/email?token=" }, "")).toBe(false);
  });
});

describe("приём писем: универсальный JSON", () => {
  it("мост (Cloudflare Email Worker, свой IMAP): адрес строкой, время ISO, вложение base64 и ссылкой", async () => {
    const { store, post, net } = setup();
    net.files.set("https://files.example/photo.jpg", bytes.jpeg());
    const r = await post({
      from: '"Айгерим" <Aigerim@Example.org>',
      to: ["inbox@company.example"],
      subject: "=?UTF-8?B?0JTQvtC60YPQvNC10L3RgtGL?=",
      text: "Добрый день! Документы во вложении.\n\n-- \nАйгерим",
      messageId: "<abc-0001@mail.example.org>",
      date: "2026-09-27T07:58:00Z",
      attachments: [
        { name: "Договор.pdf", mime: "application/pdf", contentBase64: b64(bytes.pdf()) },
        { name: "Фото.jpg", mime: "image/jpeg", url: "https://files.example/photo.jpg" },
      ],
    });
    expect(r.status).toBe(200);
    expect(store.contacts.get("1")).toMatchObject({ name: "Айгерим", identities: ["email:aigerim@example.org"] });
    const thread = store.thread("1");
    expect(thread.map((m) => m.text)).toEqual(["Добрый день! Документы во вложении.", "Договор.pdf", "Фото.jpg"]);
    expect(thread[0]).toMatchObject({ subject: "Документы", at: "2026-09-27T07:58:00.000Z", externalId: "mail:abc-0001@mail.example.org" });
    expect(thread[1]?.attachments?.[0]).toMatchObject({ name: "Договор.pdf", mime: "application/pdf" });
    expect(thread[2]?.attachments?.[0]).toMatchObject({ name: "Фото.jpg", mime: "image/jpeg" });
    expect([...store.files.values()].map((f) => f.mime)).toEqual(["application/pdf", "image/jpeg"]);
  });

  it("не JSON — 400; не письмо — 422; без адреса отправителя — 422", async () => {
    const { post, store } = setup();
    expect((await post("{не json")).status).toBe(400);
    expect((await post({ hello: 1 })).status).toBe(422);
    const noFrom = await post({ from: "не адрес", text: "Привет" });
    expect(noFrom.status).toBe(422);
    expect(String((noFrom.body as { error: string }).error)).toMatch(/адрес/);
    expect(store.contacts.size).toBe(0);
  });
});

describe("цепочка писем", () => {
  it("ответ клиента на наше письмо: в ленте — цитата нашего письма (In-Reply-To → наш номер письма)", async () => {
    const { store, adapter, post } = setup();
    await post(postmark());
    // Менеджер ответил: проект сохранил externalId отправленного письма у сообщения
    const sent = await adapter.send({ externalId: "client@example.com" }, {
      text: "Заказ будет готов завтра.", subject: "Re: Вопрос по заказу", replyTo: { externalId: "mail:CAF-client-0001@mail.example.com" },
      author: { type: "operator_crm", name: "Айгерим", id: "7" },
    });
    expect(sent.ok).toBe(true);
    const ours = sent.ok ? sent.externalId ?? "" : "";
    await store.saveMessage("1", { kind: "message", author: { type: "operator_crm", name: "Айгерим" }, channel: "email", text: "Заказ будет готов завтра.", at: "2026-09-27T07:59:50.000Z", externalId: ours });
    const ourId = ours.slice("mail:".length);
    await post(postmark({
      MessageID: "7c1d6c2e-1111-4000-8000-000000000009",
      Date: "Sat, 27 Sep 2026 08:00:00 GMT",
      Subject: "Re: Вопрос по заказу",
      TextBody: "Спасибо!\n\nOn Sat, Sep 27, 2026 at 1:59 PM Компания <hello@company.example> wrote:\n> Заказ будет готов завтра.",
      Headers: [
        { Name: "Message-ID", Value: "<CAF-client-0003@mail.example.com>" },
        { Name: "In-Reply-To", Value: `<${ourId}>` },
        { Name: "References", Value: `<CAF-client-0001@mail.example.com> <${ourId}>` },
      ],
    }));
    const last = store.thread("1").at(-1);
    expect(last).toMatchObject({ text: "Спасибо!", subject: "Re: Вопрос по заказу" });
    expect(last?.replyTo).toMatchObject({ id: "2", externalId: ours, text: "Заказ будет готов завтра." });
  });

  it("ответ на письмо, которого в CRM нет, — цитата из самого письма", async () => {
    const { store, post } = setup();
    await post(postmark({
      TextBody: "Да, актуально.\n\nпт, 26 сент. 2026 г. в 10:00, Компания <hello@company.example>:\n> Ваша заявка ещё актуальна?",
      Headers: [{ Name: "Message-ID", Value: "<CAF-client-0004@mail.example.com>" }, { Name: "In-Reply-To", Value: "<old-0001@company.example>" }],
    }));
    expect(store.thread("1")[0]).toMatchObject({ text: "Да, актуально.", replyTo: { externalId: "mail:old-0001@company.example", text: "Ваша заявка ещё актуальна?" } });
  });
});

describe("вложения", () => {
  it("base64 → ссылка data: → файл после ответа вебхуку; логотип подписи, архив и слишком большой — не сохраняются (строка в ленте)", async () => {
    const { store, post } = setup({ maxFileBytes: 1024 * 1024 });
    const logo = bytes.png();
    const r = await post(postmark({
      TextBody: "Документы во вложении",
      HtmlBody: '<p>Документы во вложении</p><img src="cid:logo001@mail.example.com">',
      Attachments: [
        { Name: "Договор.pdf", Content: b64(bytes.pdf()), ContentType: "application/pdf", ContentLength: bytes.pdf().byteLength },
        { Name: "logo.png", Content: b64(logo), ContentType: "image/png", ContentLength: logo.byteLength, ContentID: "logo001@mail.example.com" },
        { Name: "заметка.txt", Content: b64("Размеры: 2×3 м"), ContentType: "text/plain", ContentLength: 20 },
        { Name: "архив.zip", Content: b64(bytes.zip()), ContentType: "application/zip", ContentLength: bytes.zip().byteLength },
        { Name: "страница.txt", Content: b64("<html><script>alert(1)</script></html>"), ContentType: "text/plain", ContentLength: 40 },
        { Name: "видео.mov", Content: "AAAA", ContentType: "video/quicktime", ContentLength: 50 * 1024 * 1024 },
        { Name: "smime.p7s", Content: b64("подпись"), ContentType: "application/pkcs7-signature", ContentLength: 14 },
      ],
    }));
    expect(r.status).toBe(200);
    const thread = store.thread("1");
    expect(thread.filter((m) => m.kind === "message").map((m) => m.text)).toEqual(["Документы во вложении", "Договор.pdf", "заметка.txt"]);
    expect([...store.files.values()].map((f) => [f.name, f.mime, f.ext])).toEqual([
      ["Договор.pdf", "application/pdf", "pdf"],
      ["заметка.txt", "text/plain", "txt"],
    ]);
    const notice = thread.find((m) => m.kind === "system");
    expect(notice?.text).toMatch(/«архив\.zip» — такие файлы не сохраняем/);
    expect(notice?.text).toMatch(/«страница\.txt» — такие файлы не сохраняем/);
    expect(notice?.text).toMatch(/«видео\.mov» — больше 1 МБ/);
    expect(notice?.text).not.toMatch(/logo|smime/);
  });

  it("download: ссылка data: — тип по содержимому, CSV по словам письма, страница HTML и большой файл — нет", async () => {
    const { adapter } = setup({ maxFileBytes: 100 });
    expect(await adapter.download(toDataUrl("application/octet-stream", b64(bytes.png()), "x.bin"))).toMatchObject({ ok: true, mime: "image/png", ext: "png" });
    expect(await adapter.download(toDataUrl("text/csv", b64("a;b\n1;2"), "таблица.csv"))).toMatchObject({ ok: true, mime: "text/csv", ext: "csv" });
    expect(await adapter.download(toDataUrl("application/octet-stream", b64("a;b\n1;2"), "таблица.csv"))).toMatchObject({ ok: true, mime: "text/csv" });
    expect(await adapter.download(toDataUrl("text/html", b64("<!doctype html><p>x</p>"), "a.html"))).toEqual({ ok: false, reason: "bad" });
    expect(await adapter.download(toDataUrl("image/svg+xml", b64("<svg onload=alert(1)></svg>"), "a.svg"))).toEqual({ ok: false, reason: "bad" });
    expect(await adapter.download(toDataUrl("application/pdf", b64(new Uint8Array(200).fill(0x25)), "big.pdf"))).toEqual({ ok: false, reason: "bad" });
    expect(await adapter.download("data:application/pdf;base64,***")).toEqual({ ok: false, reason: "bad" });
    // Ссылка из письма — с защитой набора: внутренние адреса не качаем
    expect(await adapter.download("http://127.0.0.1/secret.pdf")).toEqual({ ok: false, reason: "bad" });
  });

  it("письмо без текста: с темой — строка «(без текста)» и файл; без темы — только файл", async () => {
    const { store, post } = setup();
    await post(postmark({ TextBody: "", HtmlBody: "", Subject: "Резюме", Attachments: [{ Name: "resume.pdf", Content: b64(bytes.pdf()), ContentType: "application/pdf" }] }));
    expect(store.thread("1").map((m) => [m.text, m.subject ?? null])).toEqual([["(без текста)", "Резюме"], ["resume.pdf", null]]);
    await post(postmark({
      MessageID: "x2", Headers: [{ Name: "Message-ID", Value: "<CAF-client-0005@mail.example.com>" }], TextBody: "", HtmlBody: "", Subject: "",
      Attachments: [{ Name: "photo.jpg", Content: b64(bytes.jpeg()), ContentType: "image/jpeg" }],
    }));
    expect(store.thread("1").map((m) => m.text)).toEqual(["(без текста)", "resume.pdf", "photo.jpg"]);
  });
});

describe("не письма клиентов", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["автоответ (Auto-Submitted)", { Headers: [{ Name: "Auto-Submitted", Value: "auto-replied" }, { Name: "Message-ID", Value: "<a1@x.example>" }] }],
    ["автоответ по теме", { Subject: "Автоматический ответ: Вопрос по заказу" }],
    ["отчёт о недоставке", { From: "MAILER-DAEMON@mail.example.com", FromFull: { Email: "MAILER-DAEMON@mail.example.com", Name: "Mail Delivery System" }, Subject: "Undelivered Mail Returned to Sender" }],
    ["рассылка", { Headers: [{ Name: "Precedence", Value: "bulk" }, { Name: "List-Unsubscribe", Value: "<https://news.example/u>" }] }],
    ["спам", { Headers: [{ Name: "X-Spam-Status", Value: "Yes, score=7.1" }] }],
    ["наш же адрес", { From: "hello@company.example", FromFull: { Email: "Hello@Company.example", Name: "Компания" } }],
  ];
  for (const [what, over] of cases) {
    it(`${what} — пропущено (200, ignored), клиента не заводим`, async () => {
      const { store, post } = setup();
      const r = await post(postmark(over));
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: false, status: "ignored" });
      expect(String((r.body as { error: string }).error)).toMatch(/не добавляем/);
      expect(store.contacts.size).toBe(0);
    });
  }

  it("свои домены и принятие спама — настройками", async () => {
    const own = setup({ ownAddresses: ["@company.example"] });
    expect((await own.post(postmark({ From: "aigerim@company.example", FromFull: { Email: "aigerim@company.example", Name: "Айгерим" } }))).body).toMatchObject({ status: "ignored" });
    const spam = setup({ acceptSpam: true });
    expect((await spam.post(postmark({ Headers: [{ Name: "X-Spam-Status", Value: "Yes" }] }))).body).toMatchObject({ status: "ok" });
  });
});

describe("адреса, номера писем, время", () => {
  it("адрес и имя в разных видах", () => {
    expect(parseAddress('"Клиент Тест" <Client@Example.com>')).toEqual({ email: "client@example.com", name: "Клиент Тест" });
    expect(parseAddress("client@example.com (Клиент Тест)")).toEqual({ email: "client@example.com", name: "Клиент Тест" });
    expect(parseAddress({ address: "client@example.com", name: "" })).toEqual({ email: "client@example.com", name: null });
    expect(parseAddress("=?UTF-8?B?0JrQu9C40LXQvdGC?= <client@example.com>")).toEqual({ email: "client@example.com", name: "Клиент" });
    expect(parseAddress("не адрес")).toBeNull();
  });

  it("номера писем без угловых скобок; время из заголовка Date в разных видах", () => {
    expect(cleanMessageId(" <abc@mail.example> ")).toBe("abc@mail.example");
    expect(messageIds("<a@x.example>\n <b@y.example>")).toEqual(["a@x.example", "b@y.example"]);
    expect(parseMailDate("Sat, 27 Sep 2026 14:00:00 +0600 (+06)")).toBe("2026-09-27T08:00:00.000Z");
    expect(parseMailDate("Sat, 27 Sep 2026 11:00:00 MSK")).toBe("2026-09-27T08:00:00.000Z");
    expect(parseMailDate("Fri, 1 Aug 2014 16:45:32 -04:00")).toBe("2014-08-01T20:45:32.000Z");
    expect(parseMailDate("2026-09-27T08:00:00Z")).toBe("2026-09-27T08:00:00.000Z");
    expect(parseMailDate("вчера")).toBeNull();
  });
});
