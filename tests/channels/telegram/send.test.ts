import { describe, expect, it } from "vitest";
import {
  createTelegramAdapter, telegramEscape, telegramFileMethod, telegramFileMime, splitTelegramText, telegramError, telegramKeepsFile, TELEGRAM_TEXT_LIMIT, tgMessageId,
} from "../../../src/channels/telegram/index.js";
import { bytes } from "../../helpers/fake-net.js";
import { fakeTelegram, SECRET, tgError, TOKEN } from "./fake-telegram.js";

// Ответы из CRM в Telegram на поддельном Bot API. Номера чатов, адреса файлов и ключи — вымышленные.

const CHAT = "100000001";
const manager = { type: "operator_crm" as const, name: "Менеджер", id: "7" };
const bot = { type: "bot" as const };
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function setup() {
  const tg = fakeTelegram();
  const adapter = createTelegramAdapter({ token: TOKEN, secretToken: SECRET, fetch: tg.fetch });
  return { tg, adapter, to: { externalId: CHAT } };
}

describe("отправка текста", () => {
  it("текст менеджера — как набран: < > & экранированы, разметка HTML; ключ — tg:<чат>:<номер>", async () => {
    const { tg, adapter, to } = setup();
    const r = await adapter.send(to, { text: "Цена <100> & **без скидки**", author: manager });
    expect(r).toEqual({ ok: true, externalId: `tg:${CHAT}:500` });
    expect(tg.calls[0]).toMatchObject({ method: "sendMessage", body: { chat_id: CHAT, text: "Цена &lt;100&gt; &amp; **без скидки**", parse_mode: "HTML" } });
    expect(tg.calls[0]?.body).not.toHaveProperty("reply_parameters");
  });

  it("ответ бота (Markdown) → HTML Telegram", async () => {
    const { tg, adapter, to } = setup();
    await adapter.send(to, { text: "**Запись** на *завтра* — [подробнее](https://example.com/a?b=1&c=2) <тег>", author: bot });
    expect(tg.calls[0]?.body.text).toBe('<b>Запись</b> на <i>завтра</i> — <a href="https://example.com/a?b=1&amp;c=2">подробнее</a> &lt;тег&gt;');
  });

  it("ответ с цитатой: reply_parameters с номером сообщения клиента; цитата вложения (…:file:0) — то же сообщение; чужой ключ — без цитаты", async () => {
    const { tg, adapter, to } = setup();
    await adapter.send(to, { text: "Да", author: manager, replyTo: { externalId: `tg:${CHAT}:42` } });
    await adapter.send(to, { text: "Получили фото", author: manager, replyTo: { externalId: `tg:${CHAT}:43:file:0` } });
    await adapter.send(to, { text: "Другой канал", author: manager, replyTo: { externalId: "wa:ABC" } });
    expect(tg.calls.map((c) => c.body.reply_parameters)).toEqual([
      { message_id: 42, allow_sending_without_reply: true },
      { message_id: 43, allow_sending_without_reply: true },
      undefined,
    ]);
  });

  it("длинный текст — несколько сообщений по абзацам, каждое не длиннее 4096; цитата — у первого; ключ — первого", async () => {
    const { tg, adapter, to } = setup();
    const para = (n: number) => `Абзац ${n}. ${"текст ".repeat(300).trim()}`;
    const text = [1, 2, 3, 4, 5].map(para).join("\n\n");
    const r = await adapter.send(to, { text, author: manager, replyTo: { externalId: `tg:${CHAT}:9` } });
    expect(r).toEqual({ ok: true, externalId: `tg:${CHAT}:500` });
    const sent = tg.calls.map((c) => String(c.body.text));
    expect(sent).toHaveLength(3);
    expect(sent.every((t) => t.length <= TELEGRAM_TEXT_LIMIT)).toBe(true);
    expect(sent.join("\n\n")).toBe(text);
    expect(sent[1]?.startsWith("Абзац 3.")).toBe(true);
    expect(tg.calls.map((c) => c.body.reply_parameters !== undefined)).toEqual([true, false, false]);
  });

  it("вторая часть не ушла — «ушла только часть», без повтора (иначе первая часть задвоится)", async () => {
    const { tg, adapter, to } = setup();
    tg.answer("sendMessage", () => ({ ok: true, result: { message_id: 700, chat: { id: Number(CHAT) } } }));
    tg.answer("sendMessage", () => tgError(429, "Too Many Requests: retry after 3", { retry_after: 3 }));
    const r = await adapter.send(to, { text: `${"а".repeat(3000)}\n\n${"б".repeat(3000)}`, author: manager });
    expect(r).toEqual({ ok: false, error: "Ушла только часть сообщения (1 из 2): Telegram просит подождать 3 с: слишком много сообщений подряд", retryable: false });
  });

  it("ошибки Telegram — коротко по-русски; 429 (с retry_after), 5xx и сбой связи — можно повторить", async () => {
    const cases: [() => Response, Record<string, unknown>][] = [
      [() => tgError(403, "Forbidden: bot was blocked by the user"), { ok: false, error: "Клиент заблокировал бота — сообщение не дошло", retryable: false }],
      [() => tgError(400, "Bad Request: chat not found"), { ok: false, error: "Чат не найден: клиент не писал этому боту или номер чата неверный", retryable: false }],
      [() => tgError(400, "Bad Request: message is too long"), { ok: false, error: "Сообщение слишком длинное для Telegram", retryable: false }],
      [() => tgError(429, "Too Many Requests: retry after 7", { retry_after: 7 }), { ok: false, error: "Telegram просит подождать 7 с: слишком много сообщений подряд", retryable: true, retryAfterSec: 7 }],
      [() => tgError(502, "Bad Gateway"), { ok: false, error: "Telegram временно не отвечает (ошибка 502) — попробуйте позже", retryable: true }],
      [() => tgError(401, "Unauthorized"), { ok: false, error: "Ключ бота Telegram не подходит — проверьте токен от @BotFather", retryable: false }],
      [() => { throw new TypeError("fetch failed"); }, { ok: false, error: "Нет связи с Telegram", retryable: true }],
    ];
    for (const [answer, want] of cases) {
      const { tg, adapter, to } = setup();
      tg.answer("sendMessage", answer);
      expect(await adapter.send(to, { text: "Здравствуйте", author: manager })).toEqual(want);
    }
  });

  it("Telegram не понял разметку ответа бота — тот же ответ уходит без разметки", async () => {
    const { tg, adapter, to } = setup();
    tg.answer("sendMessage", () => tgError(400, "Bad Request: can't parse entities: Unsupported start tag"));
    const r = await adapter.send(to, { text: "**Важно**: приходите к 10", author: bot });
    expect(r.ok).toBe(true);
    expect(tg.calls.map((c) => [c.body.text, c.body.parse_mode ?? null])).toEqual([["<b>Важно</b>: приходите к 10", "HTML"], ["Важно: приходите к 10", null]]);
  });

  it("нет номера чата — «клиент ещё не писал боту»; пустой текст — ошибка; в обоих случаях без запроса", async () => {
    const { tg, adapter } = setup();
    expect(await adapter.send({ externalId: "" }, { text: "Привет" })).toMatchObject({ ok: false, error: expect.stringMatching(/не писал боту/) });
    expect(await adapter.send({ externalId: CHAT }, { text: "  " })).toMatchObject({ ok: false });
    expect(tg.calls).toHaveLength(0);
  });
});

describe("отправка файлов", () => {
  it("фото ссылкой: sendPhoto с адресом и подписью", async () => {
    const { tg, adapter, to } = setup();
    const url = "https://crm.example/files/15?exp=1790000000&sig=test";
    const r = await adapter.send(to, { text: "Схема проезда", author: manager, file: { name: "Схема.jpg", mime: "image/jpeg", url } });
    expect(r).toEqual({ ok: true, externalId: `tg:${CHAT}:500` });
    expect(tg.calls).toHaveLength(1);
    expect(tg.calls[0]).toMatchObject({ method: "sendPhoto", form: null, body: { chat_id: CHAT, photo: url, caption: "Схема проезда", parse_mode: "HTML" } });
    expect(tg.webGets).toEqual([]);
  });

  it("документ загрузкой: sendDocument с файлом (multipart), имя и содержимое те же; текст = имя файла подписью не повторяется", async () => {
    const { tg, adapter, to } = setup();
    const data = bytes.pdf();
    const r = await adapter.send(to, { text: "Договор.pdf", author: manager, file: { name: "Договор.pdf", mime: "application/pdf", data }, replyTo: { externalId: `tg:${CHAT}:9` } });
    expect(r).toEqual({ ok: true, externalId: `tg:${CHAT}:500` });
    const c = tg.calls[0];
    expect(c?.method).toBe("sendDocument");
    expect(c?.body).toEqual({ chat_id: CHAT, reply_parameters: JSON.stringify({ message_id: 9, allow_sending_without_reply: true }) });
    const f = c?.form?.get("document");
    expect(f).toBeInstanceOf(File);
    expect((f as File).name).toBe("Договор.pdf");
    expect((f as File).type).toBe("application/pdf");
    expect(new Uint8Array(await (f as File).arrayBuffer())).toEqual(data);
  });

  it("Word по ссылке: Telegram по ссылке берёт только PDF, GIF и ZIP — подключение скачивает файл проекта и загружает", async () => {
    const { tg, adapter, to } = setup();
    const url = "https://crm.example/files/16?exp=1790000000&sig=test";
    tg.web.set(url, bytes.docx());
    const r = await adapter.send(to, { text: "Анкета", author: manager, file: { name: "Анкета.docx", mime: DOCX, url } });
    expect(r.ok).toBe(true);
    expect(tg.webGets).toEqual([url]);
    expect(tg.calls.map((c) => c.method)).toEqual(["sendDocument"]);
    expect((tg.calls[0]?.form?.get("document") as File).name).toBe("Анкета.docx");
    expect(tg.calls[0]?.body).toMatchObject({ caption: "Анкета", parse_mode: "HTML" });
  });

  it("Telegram не смог забрать фото по ссылке — подключение загружает его само; файл по внутреннему адресу не берём", async () => {
    const { tg, adapter, to } = setup();
    const url = "https://crm.example/files/17?exp=1790000000&sig=test";
    tg.web.set(url, bytes.jpeg());
    tg.answer("sendPhoto", () => tgError(400, "Bad Request: failed to get HTTP URL content"));
    expect(await adapter.send(to, { text: "", author: manager, file: { name: "Фото.jpg", mime: "image/jpeg", url } })).toMatchObject({ ok: true });
    expect(tg.calls.map((c) => [c.method, c.form ? "загрузка" : "ссылка"])).toEqual([["sendPhoto", "ссылка"], ["sendPhoto", "загрузка"]]);
    const inside = await adapter.send(to, { text: "", author: manager, file: { name: "Отчёт.docx", mime: DOCX, url: "http://127.0.0.1/files/1" } });
    expect(inside).toEqual({ ok: false, error: "Не удалось взять файл по ссылке для отправки в Telegram" });
  });

  it("фото, которое Telegram не принял как фото (слишком вытянутое), уходит документом", async () => {
    const { tg, adapter, to } = setup();
    tg.answer("sendPhoto", () => tgError(400, "Bad Request: PHOTO_INVALID_DIMENSIONS"));
    const r = await adapter.send(to, { text: "Скриншот", author: manager, file: { name: "long.png", mime: "image/png", data: bytes.png() } });
    expect(r.ok).toBe(true);
    expect(tg.calls.map((c) => c.method)).toEqual(["sendPhoto", "sendDocument"]);
  });

  it("голосовое ogg — sendVoice загрузкой; подпись бота — HTML", async () => {
    const { tg, adapter, to } = setup();
    await adapter.send(to, { text: "Послушайте **ответ**", author: bot, file: { name: "voice.ogg", mime: "audio/ogg; codecs=opus", data: bytes.ogg() } });
    expect(tg.calls[0]).toMatchObject({ method: "sendVoice", body: { caption: "Послушайте <b>ответ</b>", parse_mode: "HTML" } });
    expect(tg.calls[0]?.form?.get("voice")).toBeInstanceOf(File);
  });

  it("клиент запретил голосовые (настройка Telegram Premium) — голосовое уходит документом", async () => {
    const { tg, adapter, to } = setup();
    tg.answer("sendVoice", () => tgError(400, "Bad Request: VOICE_MESSAGES_FORBIDDEN"));
    const r = await adapter.send(to, { text: "", author: manager, file: { name: "Голосовое 14-05.ogg", mime: "audio/ogg", data: bytes.ogg() } });
    expect(r).toEqual({ ok: true, externalId: `tg:${CHAT}:500` });
    expect(tg.calls.map((c) => c.method)).toEqual(["sendVoice", "sendDocument"]);
  });

  it("подпись длиннее 1024 знаков — файл без подписи, текст следом; ключ — у файла", async () => {
    const { tg, adapter, to } = setup();
    const text = "Подробности. ".repeat(100).trim();
    const r = await adapter.send(to, { text, author: manager, file: { name: "Прайс.pdf", mime: "application/pdf", data: bytes.pdf() } });
    expect(r).toEqual({ ok: true, externalId: `tg:${CHAT}:500` });
    expect(tg.calls.map((c) => c.method)).toEqual(["sendDocument", "sendMessage"]);
    expect(tg.calls[0]?.body).not.toHaveProperty("caption");
    expect(tg.calls[1]?.body.text).toBe(text);
  });

  it("файл больше 50 МБ и файл без данных и ссылки — понятная ошибка без запроса", async () => {
    const { tg, adapter, to } = setup();
    expect(await adapter.send(to, { text: "", file: { name: "big.mp4", mime: "video/mp4", data: new Uint8Array(50 * 1024 * 1024 + 1) } })).toEqual({ ok: false, error: "Файл больше 50 МБ — Telegram не примет его от бота" });
    expect(await adapter.send(to, { text: "", file: { name: "empty.pdf", mime: "application/pdf" } })).toEqual({ ok: false, error: "Нет файла для отправки: ни данных, ни ссылки" });
    expect(tg.calls).toHaveLength(0);
  });
});

describe("правила отправки", () => {
  it("метод по типу файла: фото — sendPhoto (больше 10 МБ — документом), ogg — sendVoice, mp3 и m4a — sendAudio, mp4 — sendVideo, остальное — документом", () => {
    expect(telegramFileMethod("image/jpeg").method).toBe("sendPhoto");
    expect(telegramFileMethod("image/jpeg", 11 * 1024 * 1024).method).toBe("sendDocument");
    expect(telegramFileMethod("audio/ogg").method).toBe("sendVoice");
    expect(telegramFileMethod("audio/mpeg").method).toBe("sendAudio");
    expect(telegramFileMethod("audio/mp4").method).toBe("sendAudio");
    expect(telegramFileMethod("video/mp4").method).toBe("sendVideo");
    expect(telegramFileMethod("video/quicktime").method).toBe("sendDocument");
    expect(telegramFileMethod("image/gif").method).toBe("sendDocument");
    expect(telegramFileMethod(DOCX)).toEqual({ method: "sendDocument", field: "document" });
    expect(telegramFileMime("audio/ogg; codecs=opus", "voice.ogg")).toBe("audio/ogg");
    expect(telegramFileMime("application/octet-stream", "Отчёт.xlsx")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  });

  it("длинный текст режется по абзацам, строкам, предложениям, словам; эмодзи пополам не режется", () => {
    expect(splitTelegramText("Коротко")).toEqual(["Коротко"]);
    expect(splitTelegramText("Первый абзац.\n\nВторой абзац.", 20)).toEqual(["Первый абзац.", "Второй абзац."]);
    expect(splitTelegramText("Раз строка\nДва строка\nТри", 15)).toEqual(["Раз строка", "Два строка\nТри"]);
    expect(splitTelegramText("Первое предложение. Второе предложение.", 25)).toEqual(["Первое предложение.", "Второе предложение."]);
    const words = "слово ".repeat(10).trim();
    const parts = splitTelegramText(words, 16);
    expect(parts.every((p) => p.length <= 16)).toBe(true);
    expect(parts.join(" ")).toBe(words);
    const emoji = "😀".repeat(5);
    const pieces = splitTelegramText(emoji, 3);
    expect(pieces.join("")).toBe(emoji);
    expect(pieces.every((p) => p.length <= 3 && !/[\ud800-\udbff]$/.test(p))).toBe(true);
  });

  it("номер сообщения из ключа: tg:<чат>:<номер>, вложение того же сообщения, чужой чат и чужой ключ", () => {
    expect(tgMessageId(`tg:${CHAT}:42`)).toBe(42);
    expect(tgMessageId(`tg:${CHAT}:42:file:0`, CHAT)).toBe(42);
    expect(tgMessageId(`tg:${CHAT}:42`, "100000002")).toBeNull();
    expect(tgMessageId("tg:-100000000001:7")).toBe(7);
    expect(tgMessageId("wa:1:2")).toBeNull();
  });

  it("какие файлы клиента сохраняем: фото, PDF, Word, голосовые, видео, текст — да; архивы и программы — нет (решает расширение)", () => {
    expect(telegramKeepsFile("application/pdf", "Договор.pdf")).toBe(true);
    expect(telegramKeepsFile("text/plain", "Список.txt")).toBe(true);
    expect(telegramKeepsFile("application/zip", "Сканы.zip")).toBe(false);
    expect(telegramKeepsFile("image/jpeg", "photo.exe")).toBe(false);
    expect(telegramKeepsFile("audio/mpeg", "")).toBe(true);
    expect(telegramKeepsFile("application/x-msdownload", undefined)).toBe(false);
  });

  it("текст человека для HTML; ошибки Telegram, которых нет в списке, — с описанием Telegram", () => {
    expect(telegramEscape("a < b && c > d")).toBe("a &lt; b &amp;&amp; c &gt; d");
    expect(telegramError(400, "Bad Request: something new")).toEqual({ error: "Telegram не принял запрос (400: Bad Request: something new)", retryable: false });
    expect(telegramError(403, "Forbidden: user is deactivated").error).toBe("Аккаунт клиента в Telegram удалён");
    expect(telegramError(403, "Forbidden: bot can't initiate conversation with a user").error).toBe("Клиент ещё не писал боту — первым бот написать не может");
  });
});
