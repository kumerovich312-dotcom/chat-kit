import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createEmailAdapter, MailSendError, POSTMARK_API, POSTMARK_METADATA_KEY, postmarkSender, type EmailOptions, type MailSender, type OutgoingMail,
} from "../../../src/channels/email/index.js";
import { createMemoryStore, ingest } from "../../../src/server/index.js";
import { bytes } from "../../helpers/fake-net.js";

// Ответы клиенту письмом: сборка письма, отправитель проекта (поддельный), Postmark (поддельная сеть), статусы доставки.
// Ключи — только тестовые.

const TOKEN = "test-secret-not-real-email";
const PM_TOKEN = "test-secret-not-real-postmark";
const NOW = Date.parse("2026-09-27T08:00:00Z");
const CLIENT = { externalId: "client@example.com", contactId: "1" };

function withSender(send: MailSender, o: Partial<EmailOptions> = {}) {
  return createEmailAdapter({ inboundToken: TOKEN, from: { email: "hello@company.example", name: "Компания" }, send, now: () => NOW, ...o });
}

function recorder() {
  const sent: OutgoingMail[] = [];
  const send: MailSender = async (m) => { sent.push(m); };
  return { sent, send };
}

describe("письмо клиенту через отправитель проекта", () => {
  it("ответ менеджера: тема, текст как набран, HTML со ссылкой, цепочка (In-Reply-To, References), номер письма — ключ повтора", async () => {
    const { sent, send } = recorder();
    const a = withSender(send, { replyToAddress: "inbox@company.example" });
    const out = {
      text: "Здравствуйте!\nЗаказ готов: https://shop.example/o/1.", subject: "Re: Вопрос по заказу",
      replyTo: { externalId: "mail:CAF-client-0001@mail.example.com" }, author: { type: "operator_crm" as const, name: "Айгерим", id: "7" },
      idempotencyKey: "crm:15",
    };
    const r = await a.send(CLIENT, out);
    const mail = sent[0]!;
    expect(mail).toMatchObject({
      from: "Компания <hello@company.example>", to: "client@example.com", replyTo: "inbox@company.example", subject: "Re: Вопрос по заказу",
      text: "Здравствуйте!\nЗаказ готов: https://shop.example/o/1.",
      inReplyTo: "<CAF-client-0001@mail.example.com>", references: ["<CAF-client-0001@mail.example.com>"],
    });
    expect(mail.html).toContain('<a href="https://shop.example/o/1">https://shop.example/o/1</a>.');
    expect(mail.messageId).toMatch(/^<ck\.[0-9a-f]{32}@company\.example>$/);
    expect(r).toEqual({ ok: true, externalId: `mail:${mail.messageId.slice(1, -1)}` });
    // Повтор с тем же ключом — тот же номер письма: почта клиента узнает повтор
    await a.send(CLIENT, out);
    expect(sent[1]?.messageId).toBe(mail.messageId);
    // Без ключа — каждый раз новый номер
    await a.send(CLIENT, { text: "Ещё вопрос?" });
    await a.send(CLIENT, { text: "Ещё вопрос?" });
    expect(sent[2]?.messageId).toMatch(/^<ck\.[0-9a-z]+\.[0-9a-f]{16}@company\.example>$/);
    expect(sent[2]?.messageId).not.toBe(sent[3]?.messageId);
  });

  it("ответ бота: в тексте — без разметки, в HTML — с разметкой; без темы — тема по умолчанию", async () => {
    const { sent, send } = recorder();
    const a = withSender(send);
    await a.send(CLIENT, { text: "**Важно**: оплатите [по ссылке](https://pay.example/1).", author: { type: "bot" } });
    expect(sent[0]).toMatchObject({ subject: "Ответ на ваше письмо", text: "Важно: оплатите по ссылке (https://pay.example/1)." });
    expect(sent[0]?.html).toContain('<b>Важно</b>: оплатите <a href="https://pay.example/1">по ссылке</a>.');
    expect(sent[0]?.inReplyTo).toBeUndefined();
    const b = withSender(send, { defaultSubject: "Письмо от компании" });
    await b.send(CLIENT, { text: "Добрый день", subject: "  " });
    expect(sent[1]?.subject).toBe("Письмо от компании");
  });

  it("файл: данными, с диска сервера (path), ссылкой; без текста — «Во вложении: …»; большой — ошибка", async () => {
    const { sent, send } = recorder();
    const a = withSender(send, { maxFileBytes: 1024 });
    await a.send(CLIENT, { text: "Счёт во вложении", file: { name: "Счёт.pdf", mime: "application/pdf", data: bytes.pdf() } });
    expect(sent[0]?.attachments).toEqual([{ name: "Счёт.pdf", mime: "application/pdf", data: bytes.pdf() }]);
    const dir = mkdtempSync(join(tmpdir(), "ck-email-"));
    try {
      writeFileSync(join(dir, "act.pdf"), bytes.pdf());
      await a.send(CLIENT, { text: "", file: { name: "Акт.pdf", mime: "application/pdf", path: join(dir, "act.pdf") } });
      expect(sent[1]).toMatchObject({ text: "Во вложении: Акт.pdf" });
      expect(Buffer.from(sent[1]!.attachments![0]!.data!).toString("latin1")).toBe(Buffer.from(bytes.pdf()).toString("latin1"));
      expect(await a.send(CLIENT, { text: "x", file: { name: "нет.pdf", mime: "application/pdf", path: join(dir, "missing.pdf") } }))
        .toEqual({ ok: false, error: "Файл «нет.pdf» не найден на сервере" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    await a.send(CLIENT, { text: "Фото", file: { name: "photo.jpg", mime: "image/jpeg", url: "https://crm.example/files/5?exp=1&sig=x" } });
    expect(sent[2]?.attachments).toEqual([{ name: "photo.jpg", mime: "image/jpeg", url: "https://crm.example/files/5?exp=1&sig=x" }]);
    expect(await a.send(CLIENT, { text: "x", file: { name: "big.pdf", mime: "application/pdf", data: new Uint8Array(2048) } }))
      .toEqual({ ok: false, error: "Файл «big.pdf» больше 1 КБ — письмом не отправить" });
    expect(sent).toHaveLength(3);
  });

  it("некуда или нечего отправлять; отправка не настроена; адрес отправителя не задан", async () => {
    const { sent, send } = recorder();
    const a = withSender(send);
    expect(await a.send({ externalId: "не адрес" }, { text: "x" })).toMatchObject({ ok: false, error: expect.stringMatching(/нет адреса почты/) });
    expect(await a.send(CLIENT, { text: "   " })).toMatchObject({ ok: false, error: expect.stringMatching(/Пустое письмо/) });
    expect(sent).toHaveLength(0);
    const noSend = createEmailAdapter({ inboundToken: TOKEN, from: "hello@company.example" });
    expect(await noSend.send(CLIENT, { text: "x" })).toMatchObject({ ok: false, error: expect.stringMatching(/не настроена/) });
    const noFrom = withSender(send, { from: "не адрес" });
    expect(await noFrom.send(CLIENT, { text: "x" })).toMatchObject({ ok: false, error: expect.stringMatching(/адрес отправителя/) });
  });

  it("номер письма от отправителя (SMTP-библиотека вернула свой) — ключ повтора по нему", async () => {
    const a = withSender(async () => ({ messageId: "<smtp-0001@mail.company.example>" }));
    expect(await a.send(CLIENT, { text: "Добрый день" })).toEqual({ ok: true, externalId: "mail:smtp-0001@mail.company.example" });
  });

  it("ошибки отправителя — словами: MailSendError как есть, ошибки SMTP-библиотеки по коду", async () => {
    const fail = (e: unknown) => withSender(async () => { throw e; }).send(CLIENT, { text: "x" });
    expect(await fail(new MailSendError("Лимит писем на сегодня исчерпан", true))).toEqual({ ok: false, error: "Лимит писем на сегодня исчерпан", retryable: true });
    expect(await fail(Object.assign(new Error("Invalid login"), { code: "EAUTH", responseCode: 535 }))).toMatchObject({ ok: false, error: expect.stringMatching(/логин или пароль/) });
    expect(await fail(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }))).toMatchObject({ ok: false, retryable: true, error: expect.stringMatching(/Нет связи/) });
    expect(await fail(Object.assign(new Error("mailbox unavailable"), { code: "EENVELOPE", responseCode: 550 }))).toMatchObject({ ok: false, error: expect.stringMatching(/адрес клиента/) });
    expect(await fail(Object.assign(new Error("try later"), { responseCode: 451 }))).toMatchObject({ ok: false, retryable: true });
  });
});

/** Поддельный Postmark: записывает запросы, отвечает заданным кодом; файлы по ссылкам — из files */
function fakePostmark(reply: () => { status: number; body: unknown } = () => ({ status: 200, body: { ErrorCode: 0, Message: "OK", MessageID: "b7bc2f4a-0000-4000-8000-000000000001" } })) {
  const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const files = new Map<string, Uint8Array>();
  const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    if (url === POSTMARK_API) {
      calls.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      const r = reply();
      return new Response(JSON.stringify(r.body), { status: r.status });
    }
    const data = files.get(url);
    return data ? new Response(new Blob([new Uint8Array(data)]), { status: 200 }) : new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { calls, files, fetch: fetchFn };
}

describe("Postmark: отправка", () => {
  it("запрос к API: ключ сервера, адреса, тема, текст и HTML, заголовки цепочки, наш номер в Metadata, файлы base64", async () => {
    const pm = fakePostmark();
    pm.files.set("https://crm.example/files/5", bytes.jpeg());
    const a = withSender(postmarkSender({ serverToken: PM_TOKEN, messageStream: "replies", fetch: pm.fetch }), { replyToAddress: "inbox@company.example" });
    const r = await a.send(CLIENT, {
      text: "Счёт и фото во вложении", subject: "Re: Заказ", replyTo: { externalId: "mail:CAF-client-0001@mail.example.com" },
      file: { name: "Счёт.pdf", mime: "application/pdf", data: bytes.pdf() },
    });
    expect(r.ok).toBe(true);
    const call = pm.calls[0]!;
    expect(call.headers.get("x-postmark-server-token")).toBe(PM_TOKEN);
    expect(call.headers.get("accept")).toBe("application/json");
    expect(call.headers.get("content-type")).toBe("application/json");
    const id = r.ok ? String(r.externalId).slice("mail:".length) : "";
    expect(call.body).toMatchObject({
      From: "Компания <hello@company.example>", To: "client@example.com", ReplyTo: "inbox@company.example", Subject: "Re: Заказ",
      TextBody: "Счёт и фото во вложении", MessageStream: "replies",
      Headers: [
        { Name: "Message-ID", Value: `<${id}>` },
        { Name: "In-Reply-To", Value: "<CAF-client-0001@mail.example.com>" },
        { Name: "References", Value: "<CAF-client-0001@mail.example.com>" },
      ],
      Metadata: { [POSTMARK_METADATA_KEY]: id },
      Attachments: [{ Name: "Счёт.pdf", Content: Buffer.from(bytes.pdf()).toString("base64"), ContentType: "application/pdf" }],
    });
    expect(String(call.body.HtmlBody)).toContain("Счёт и фото во вложении");
    expect(call.body.TrackOpens).toBeUndefined();

    // Файл ссылкой — Postmark нужен сам файл: забираем и кладём base64
    await a.send(CLIENT, { text: "Фото", file: { name: "photo.jpg", mime: "image/jpeg", url: "https://crm.example/files/5" } });
    expect(pm.calls[1]?.body.Attachments).toEqual([{ Name: "photo.jpg", Content: Buffer.from(bytes.jpeg()).toString("base64"), ContentType: "image/jpeg" }]);
    expect(pm.calls[1]?.body.MessageStream).toBe("replies");
  });

  it("ошибки Postmark — словами; сбой связи, 429 и 5xx — можно повторить", async () => {
    let reply = { status: 401, body: { ErrorCode: 10, Message: "Bad or missing Server API token." } as unknown };
    const pm = fakePostmark(() => reply);
    const a = withSender(postmarkSender({ serverToken: PM_TOKEN, fetch: pm.fetch }));
    const send = () => a.send(CLIENT, { text: "x" });
    expect(await send()).toMatchObject({ ok: false, retryable: false, error: expect.stringMatching(/ключ сервера/) });
    reply = { status: 422, body: { ErrorCode: 406, Message: "You tried to send to recipient(s) that have been marked as inactive." } };
    expect(await send()).toMatchObject({ ok: false, error: expect.stringMatching(/не отправляет писем на этот адрес/) });
    reply = { status: 422, body: { ErrorCode: 300, Message: "Invalid 'To' address: 'x'." } };
    expect(await send()).toMatchObject({ ok: false, error: "Postmark не принял письмо: проверьте адрес клиента и текст (Invalid 'To' address: 'x'.)" });
    reply = { status: 422, body: { ErrorCode: 400, Message: "Sender signature not defined" } };
    expect(await send()).toMatchObject({ ok: false, error: expect.stringMatching(/отправителя не подтверждён/) });
    reply = { status: 429, body: {} };
    expect(await send()).toMatchObject({ ok: false, retryable: true });
    reply = { status: 503, body: {} };
    expect(await send()).toMatchObject({ ok: false, retryable: true, error: expect.stringMatching(/временно недоступен/) });
    const offline = withSender(postmarkSender({ serverToken: PM_TOKEN, fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch }));
    expect(await offline.send(CLIENT, { text: "x" })).toEqual({ ok: false, error: "Нет связи с Postmark — повторите позже", retryable: true });
    const noKey = withSender(postmarkSender({ serverToken: "", fetch: pm.fetch }));
    expect(await noKey.send(CLIENT, { text: "x" })).toMatchObject({ ok: false, error: expect.stringMatching(/ключ сервера Postmark/) });
  });

  it("файл по ссылке: нет файла, слишком большой, внутренний адрес — ошибка до отправки", async () => {
    const pm = fakePostmark();
    pm.files.set("https://crm.example/files/big", new Uint8Array(4096));
    const a = withSender(postmarkSender({ serverToken: PM_TOKEN, fetch: pm.fetch, maxFileBytes: 1024 }));
    const file = (url: string) => a.send(CLIENT, { text: "x", file: { name: "Файл.pdf", mime: "application/pdf", url } });
    expect(await file("https://crm.example/files/missing")).toEqual({ ok: false, error: "Файл «Файл.pdf» не нашёлся по ссылке", retryable: false });
    expect(await file("https://crm.example/files/big")).toMatchObject({ ok: false, error: "Файл «Файл.pdf» больше 1 КБ — Postmark такое не отправит" });
    expect(await file("http://10.0.0.5/files/1")).toMatchObject({ ok: false, error: expect.stringMatching(/не внутренний адрес/) });
    expect(pm.calls).toHaveLength(0);
  });
});

describe("статусы доставки", () => {
  async function sentThroughPostmark() {
    const pm = fakePostmark();
    const store = createMemoryStore();
    const a = withSender(postmarkSender({ serverToken: PM_TOKEN, fetch: pm.fetch }));
    const r = await a.send(CLIENT, { text: "Добрый день" });
    const externalId = r.ok ? String(r.externalId) : "";
    await store.saveMessage("1", { kind: "message", author: { type: "operator_crm" }, channel: "email", text: "Добрый день", at: "2026-09-27T07:59:00.000Z", externalId, delivery: "sent" });
    const hook = (body: unknown) => ingest(a, store, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) }, { now: () => NOW });
    const meta = { [POSTMARK_METADATA_KEY]: externalId.slice("mail:".length) };
    return { store, hook, meta, msg: () => store.messages[0]! };
  }

  it("Postmark Delivery → «доставлено», Open → «прочитано» (по нашему номеру из Metadata)", async () => {
    const { hook, meta, msg } = await sentThroughPostmark();
    const r = await hook({ RecordType: "Delivery", MessageStream: "outbound", ServerID: 1, MessageID: "b7bc2f4a-0000-4000-8000-000000000001", Recipient: "client@example.com", DeliveredAt: "2026-09-27T08:00:01Z", Details: "250 OK", Metadata: meta });
    expect(r.status).toBe(200);
    expect(msg().delivery).toBe("delivered");
    await hook({ RecordType: "Open", MessageID: "b7bc2f4a-0000-4000-8000-000000000001", Recipient: "client@example.com", FirstOpen: true, Metadata: meta });
    expect(msg().delivery).toBe("read");
  });

  it("Bounce → «не доставлено» с причиной; автоответ клиента и клик по ссылке — пропущены", async () => {
    const { hook, meta, msg } = await sentThroughPostmark();
    const auto = await hook({ RecordType: "Bounce", Type: "AutoResponder", TypeCode: 2, MessageID: "b7bc2f4a-0000-4000-8000-000000000001", Email: "client@example.com", Metadata: meta });
    expect(auto.body).toMatchObject({ status: "ignored" });
    expect(msg().delivery).toBe("sent");
    const click = await hook({ RecordType: "Click", MessageID: "b7bc2f4a-0000-4000-8000-000000000001", Metadata: meta });
    expect(click.body).toMatchObject({ status: "ignored" });
    await hook({ RecordType: "Bounce", Type: "HardBounce", TypeCode: 1, Name: "Hard bounce", MessageID: "b7bc2f4a-0000-4000-8000-000000000001", Email: "client@example.com", Metadata: meta });
    expect(msg()).toMatchObject({ delivery: "failed", deliveryError: "Письмо не доставлено: адрес не существует или ящик закрыт" });
  });

  it("жалоба на спам и статус от моста (универсальный JSON)", async () => {
    const { hook, meta, msg } = await sentThroughPostmark();
    await hook({ RecordType: "SpamComplaint", MessageID: "b7bc2f4a-0000-4000-8000-000000000001", Email: "client@example.com", Metadata: meta });
    expect(msg()).toMatchObject({ delivery: "failed", deliveryError: expect.stringMatching(/спам/) });
    await hook({ event: "status", messageId: `<${meta[POSTMARK_METADATA_KEY]}>`, status: "delivered" });
    expect(msg()).toMatchObject({ delivery: "delivered" });
    const bad = await hook({ event: "status", messageId: "<x@y.example>", status: "непонятно" });
    expect(bad.body).toMatchObject({ status: "ignored" });
  });
});
