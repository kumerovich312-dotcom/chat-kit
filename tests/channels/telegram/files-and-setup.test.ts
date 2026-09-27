import { describe, expect, it } from "vitest";
import {
  createTelegramAdapter, telegramDeleteWebhook, telegramGetMe, telegramSetWebhook, telegramWebhookInfo,
} from "../../../src/channels/telegram/index.js";
import { bytes } from "../../helpers/fake-net.js";
import { fakeTelegram, SECRET, tgError, TOKEN } from "./fake-telegram.js";

// Файлы клиента (getFile) и настройка бота (вебхук, getMe) на поддельном Bot API. Ключи и адреса — вымышленные.

const mp4 = () => new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, ...new Array(32).fill(0)]);

function setup(maxFileBytes?: number) {
  const tg = fakeTelegram();
  const adapter = createTelegramAdapter({ token: TOKEN, secretToken: SECRET, fetch: tg.fetch, ...(maxFileBytes ? { maxFileBytes } : {}) });
  return { tg, adapter };
}

describe("файлы клиента (download)", () => {
  it("getFile → путь → файл по адресу с ключом бота; тип — по содержимому", async () => {
    const { tg, adapter } = setup();
    tg.files.set("f1", { path: "photos/file_1.jpg", data: bytes.jpeg() });
    const r = await adapter.download("tg-file:f1");
    expect(r).toMatchObject({ ok: true, mime: "image/jpeg", ext: "jpg" });
    expect(r.ok && r.data).toEqual(bytes.jpeg());
    expect(tg.calls).toMatchObject([{ method: "getFile", body: { file_id: "f1" } }]);
    expect(tg.downloads).toEqual(["photos/file_1.jpg"]);
  });

  it("больше лимита по словам Telegram — bad без скачивания; больше по факту — тоже bad", async () => {
    const { tg, adapter } = setup();
    tg.files.set("big", { path: "videos/file_2.mp4", data: mp4(), size: 30 * 1024 * 1024 });
    expect(await adapter.download("tg-file:big")).toEqual({ ok: false, reason: "bad" });
    expect(tg.downloads).toEqual([]);
    const small = setup(16);
    small.tg.files.set("lie", { path: "documents/file_3.pdf", data: bytes.pdf(), size: 10 });
    expect(await small.adapter.download("tg-file:lie")).toEqual({ ok: false, reason: "bad" });
  });

  it("простой текст (txt, csv) — по расширению, если внутри нет двоичного; архив и двоичное под видом txt — bad", async () => {
    const { tg, adapter } = setup();
    tg.files.set("t", { path: "documents/file_4.txt", data: new TextEncoder().encode("Список: паспорт, фото\r\n\tкопия") });
    tg.files.set("c", { path: "documents/file_5.csv", data: new TextEncoder().encode("имя;дата\nАйгерим;2026-09-27\n") });
    tg.files.set("bin", { path: "documents/file_6.txt", data: new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0]) });
    tg.files.set("zip", { path: "documents/file_7.zip", data: bytes.zip() });
    expect(await adapter.download("tg-file:t")).toMatchObject({ ok: true, mime: "text/plain", ext: "txt" });
    expect(await adapter.download("tg-file:c")).toMatchObject({ ok: true, mime: "text/csv", ext: "csv" });
    // Необычные знаки в пути — в кодировке адреса
    tg.files.set("sp", { path: "documents/file 8#1.pdf", data: bytes.pdf() });
    expect(await adapter.download("tg-file:sp")).toMatchObject({ ok: true, mime: "application/pdf" });
    expect(tg.downloads.at(-1)).toBe("documents/file%208%231.pdf");
    expect(await adapter.download("tg-file:bin")).toEqual({ ok: false, reason: "bad" });
    expect(await adapter.download("tg-file:zip")).toEqual({ ok: false, reason: "bad" });
  });

  it("нет файла — missing; «слишком большой» у Telegram — bad; сбой связи и 5xx — retry; чужие ссылки и пути — не берём", async () => {
    const { tg, adapter } = setup();
    expect(await adapter.download("tg-file:nope")).toEqual({ ok: false, reason: "missing" });
    tg.answer("getFile", () => tgError(400, "Bad Request: file is too big"));
    expect(await adapter.download("tg-file:huge")).toEqual({ ok: false, reason: "bad" });
    tg.answer("getFile", () => { throw new TypeError("fetch failed"); });
    expect(await adapter.download("tg-file:f1")).toEqual({ ok: false, reason: "retry" });
    tg.answer("getFile", () => tgError(500, "Internal Server Error"));
    expect(await adapter.download("tg-file:f1")).toEqual({ ok: false, reason: "retry" });
    tg.answer("getFile", () => ({ ok: true, result: { file_id: "x", file_path: "../../secret" } }));
    expect(await adapter.download("tg-file:x")).toEqual({ ok: false, reason: "missing" });
    tg.answer("getFile", () => ({ ok: true, result: { file_id: "y", file_path: "/var/lib/telegram-bot-api/file.jpg" } }));
    expect(await adapter.download("tg-file:y")).toEqual({ ok: false, reason: "missing" });
    expect(await adapter.download("https://example.com/a.jpg")).toEqual({ ok: false, reason: "bad" });
    expect(await adapter.download("tg-file:a/../b")).toEqual({ ok: false, reason: "bad" });
    expect(tg.downloads).toEqual([]);
  });

  it("5xx при скачивании самого файла — retry", async () => {
    const tg = fakeTelegram();
    const inner = tg.fetch;
    const flaky = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      String(input).includes("/file/bot") ? new Response("busy", { status: 503 }) : inner(input, init)) as typeof fetch;
    const adapter = createTelegramAdapter({ token: TOKEN, secretToken: SECRET, fetch: flaky });
    tg.files.set("f1", { path: "photos/file_1.jpg", data: bytes.jpeg() });
    expect(await adapter.download("tg-file:f1")).toEqual({ ok: false, reason: "retry" });
  });
});

describe("настройка бота", () => {
  it("вебхук: адрес, секрет и нужные уведомления; http и неверный секрет — понятная ошибка без запроса; отказ Telegram — словами", async () => {
    const tg = fakeTelegram();
    const o = { token: TOKEN, fetch: tg.fetch };
    expect(await telegramSetWebhook({ ...o, url: "https://crm.example/api/telegram/1", secretToken: SECRET, dropPendingUpdates: true })).toEqual({ ok: true });
    expect(tg.calls[0]).toMatchObject({
      method: "setWebhook",
      body: { url: "https://crm.example/api/telegram/1", secret_token: SECRET, allowed_updates: ["message", "edited_message", "my_chat_member"], drop_pending_updates: true },
    });
    expect(await telegramSetWebhook({ ...o, url: "http://crm.example/hook", secretToken: SECRET })).toMatchObject({ ok: false, error: expect.stringMatching(/https/) });
    expect(await telegramSetWebhook({ ...o, url: "https://crm.example/hook", secretToken: "с пробелом" })).toMatchObject({ ok: false, error: expect.stringMatching(/^Секрет вебхука/) });
    expect(tg.calls).toHaveLength(1);
    tg.answer("setWebhook", () => tgError(400, "Bad Request: bad webhook: Failed to resolve host: Name or service not known"));
    expect(await telegramSetWebhook({ ...o, url: "https://crm.example/hook", secretToken: SECRET })).toMatchObject({ ok: false, error: expect.stringMatching(/^Telegram не принял адрес вебхука/) });
  });

  it("getMe — имя и ник бота; неверный ключ — по-русски; ключ не того вида — без запроса", async () => {
    const tg = fakeTelegram();
    tg.answer("getMe", () => ({ ok: true, result: { id: 999000999, is_bot: true, first_name: "Бот компании", username: "company_test_bot" } }));
    expect(await telegramGetMe({ token: TOKEN, fetch: tg.fetch })).toEqual({ ok: true, bot: { id: 999000999, username: "company_test_bot", name: "Бот компании" } });
    expect(await telegramGetMe({ token: "000000000:test-secret-not-real-other", fetch: tg.fetch })).toEqual({ ok: false, error: "Ключ бота Telegram не подходит — проверьте токен от @BotFather" });
    const calls = tg.calls.length;
    expect(await telegramGetMe({ token: "not a token/../x", fetch: tg.fetch })).toMatchObject({ ok: false, error: expect.stringMatching(/записан неверно/) });
    expect(tg.calls).toHaveLength(calls);
  });

  it("отключить вебхук; состояние вебхука — адрес, очередь и последняя ошибка доставки", async () => {
    const tg = fakeTelegram();
    const o = { token: TOKEN, fetch: tg.fetch };
    expect(await telegramDeleteWebhook({ ...o, dropPendingUpdates: true })).toEqual({ ok: true });
    expect(tg.calls[0]).toMatchObject({ method: "deleteWebhook", body: { drop_pending_updates: true } });
    tg.answer("getWebhookInfo", () => ({
      ok: true,
      result: { url: "https://crm.example/api/telegram/1", has_custom_certificate: false, pending_update_count: 3, last_error_date: 1790000000, last_error_message: "Wrong response from the webhook: 401 Unauthorized" },
    }));
    expect(await telegramWebhookInfo(o)).toEqual({
      ok: true,
      info: { url: "https://crm.example/api/telegram/1", pending: 3, lastError: "Wrong response from the webhook: 401 Unauthorized", lastErrorAt: new Date(1790000000 * 1000).toISOString() },
    });
    // Вебхук не подключён: адрес пустой
    tg.answer("getWebhookInfo", () => ({ ok: true, result: { url: "", has_custom_certificate: false, pending_update_count: 0 } }));
    expect(await telegramWebhookInfo(o)).toEqual({ ok: true, info: { url: null, pending: 0, lastError: null, lastErrorAt: null } });
  });
});
