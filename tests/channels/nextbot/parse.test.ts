import { describe, expect, it } from "vitest";
import { isHandoff, lastDialogLine, nextbotTime, parseDialogDump, parseDialogId, parseEvent, parseStamp } from "../../../src/channels/nextbot/parse.js";
import { mediaCandidates, mediaFolders, mediaHostAllowed, mediaRef, mediaText, mediaTitle } from "../../../src/channels/nextbot/media.js";
import { webhookUrlFix, webhookUrlProblem } from "../../../src/channels/nextbot/webhook.js";

// Разбор событий Nextbot — случаи с настоящего Nextbot, данные вымышленные.

describe("parseEvent", () => {
  it("событие клиента: поля верхнего уровня важнее args, телефон по-местному → +996", () => {
    const ev = parseEvent({
      event: "client_message", dialog_id: 10001, text: "Есть свободное время в субботу?",
      args: { text: "не это", messenger: "WhatsApp", name: "Азат", phone: "0555 00-00-01" },
    }, "+996");
    expect(ev.kind).toBe("client_message");
    expect(ev.dialogId).toBe("10001");
    expect(ev.text).toBe("Есть свободное время в субботу?");
    expect(ev.channel).toBe("whatsapp");
    expect(ev.name).toBe("Азат");
    expect(ev.phone).toBe("+996555000001");
  });

  it("без event — сообщение клиента; синонимы типов", () => {
    expect(parseEvent({ dialog_id: 1, text: "x" }).kind).toBe("client_message");
    expect(parseEvent({ event: "agent", dialog_id: 1, text: "x" }).kind).toBe("bot_message");
    expect(parseEvent({ event: "заявка", dialog_id: 1 }).kind).toBe("lead");
    expect(parseEvent({ event: "function", function: "free_slots" })).toMatchObject({ kind: "function", functionName: "free_slots" });
    expect(parseEvent({ event: "free_slots" }, "", ["free_slots"])).toMatchObject({ kind: "function", functionName: "free_slots" });
    expect(parseEvent({ event: "free_slots" }).kind).toBe("client_message");
  });

  it("номер диалога из ссылки на диалог", () => {
    expect(parseDialogId("https://app.nextbot.ru/dialogs/10177062")).toBe("10177062");
    expect(parseDialogId("55501")).toBe("55501");
    expect(parseDialogId("нет")).toBeNull();
    expect(parseEvent({ args: { "ссылка на диалог": "https://app.nextbot.ru/dialogs/424242" }, text: "x" }).dialogId).toBe("424242");
  });

  it("ответ агента: assistantMessage — текст только у события бота; поле agent у клиента — отдельно", () => {
    expect(parseEvent({ event: "bot_message", dialog_id: 1, args: { assistantMessage: "Чем помочь?" } }).text).toBe("Чем помочь?");
    expect(parseEvent({ event: "client_message", dialog_id: 1, args: { assistantMessage: "Чем помочь?" } }).text).toBe("");
    const ev = parseEvent({ event: "client_message", dialog_id: 1, text: "Привет", agent: "Здравствуйте!" });
    expect(ev.agentText).toBe("Здравствуйте!");
    expect(parseEvent({ event: "client_message", dialog_id: 1, text: "Привет", agent: "test value" }).agentText).toBeNull();
  });

  it("«Полный диалог» в поле text — это дамп, а не сообщение", () => {
    const dump = "27.09.26 07-58 [ИИ-агент]: Здравствуйте!\n27.09.26 07-59 [Азат]: Сколько стоит?";
    const ev = parseEvent({ event: "client_message", dialog_id: 1, text: dump });
    expect(ev.dump).toBe(dump);
    expect(ev.text).toBe("");
    const withField = parseEvent({ event: "client_message", dialog_id: 1, client_message: "Сколько стоит?", full_dialog: dump });
    expect(withField.text).toBe("Сколько стоит?");
    expect(withField.dump).toBe(dump);
  });

  it("длинный дамп — берётся конец (самое свежее внизу)", () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `27.09.26 07-${String(i % 60).padStart(2, "0")} [Азат]: сообщение номер ${i}`);
    const ev = parseEvent({ event: "client_message", dialog_id: 1, text: lines.join("\n") });
    expect(ev.dump!.length).toBeLessThanOrEqual(60_000);
    expect(ev.dump!.endsWith("сообщение номер 2999")).toBe(true);
  });

  it("тестовый чат Nextbot узнаётся", () => {
    expect(parseEvent({ dialog_id: 1, text: "x", messenger: "Тестовый чат" }).testChat).toBe(true);
    expect(parseEvent({ dialog_id: 1, text: "x", name: "WindowChat" }).testChat).toBe(true);
    expect(parseEvent({ dialog_id: 1, text: "x", messenger: "WhatsApp" }).testChat).toBe(false);
  });

  it("вложения: поля Nextbot и списки через запятую", () => {
    const ev = parseEvent({ dialog_id: 1, args: { lastUserImageLink: "https://storage.nextbot.ru/a.jpg", userDocumentLinks: "https://storage.nextbot.ru/b.pdf, https://storage.nextbot.ru/c.pdf" } });
    expect(ev.attachments).toEqual(["https://storage.nextbot.ru/a.jpg", "https://storage.nextbot.ru/b.pdf", "https://storage.nextbot.ru/c.pdf"]);
  });

  it("ошибка отправки и заявка", () => {
    const ev = parseEvent({ event: "lead", dialog_id: 1, args: { errors: "VALIDATE_ACCESS_DIALOG_PAUSED", city: "Бишкек", service: "Консультация", budget: "1 500" } });
    expect(ev.sendError).toBe("VALIDATE_ACCESS_DIALOG_PAUSED");
    expect(ev.lead).toMatchObject({ city: "Бишкек", amount: 1500 });
    expect(ev.fields).toMatchObject({ service: "Консультация" });
  });
});

describe("время Nextbot", () => {
  it("только время с секундами", () => {
    expect(parseStamp("2026-09-27 13:59:40")).toBe(Date.UTC(2026, 8, 27, 13, 59, 40));
    expect(parseStamp("27.09.2026, 13:59")).toBeNull();
    expect(parseStamp("1790487580")).toBe(1790487580000);
  });

  it("пояс Nextbot — по разнице с часами (Бишкек +6): событие встаёт на своё настоящее время", () => {
    const now = Date.parse("2026-09-27T08:00:30Z");
    const sent = parseStamp("2026-09-27 13:59:40")!; // по Бишкеку
    expect(new Date(nextbotTime(sent, now)!).toISOString()).toBe("2026-09-27T07:59:40.000Z");
  });

  it("из будущего и больше чем на 14 часов в сторону (пояса так не отличаются) — не берём", () => {
    const now = Date.parse("2026-09-27T08:00:00Z");
    expect(nextbotTime(Date.parse("2026-09-27T08:05:00Z"), now)).toBeNull();
    expect(nextbotTime(now + 3_000, now)).toBe(now);
    expect(nextbotTime(Date.parse("2026-09-26T12:00:00Z"), now)).toBeNull();
    expect(nextbotTime(null, now)).toBeNull();
    // Время на 7 часов раньше — это другой пояс аккаунта Nextbot, а не старое событие: встаёт «сейчас»
    expect(nextbotTime(Date.parse("2026-09-27T01:00:00Z"), now)).toBe(now);
  });
});

describe("«Полный диалог»", () => {
  it("реплики по строкам, время по Гринвичу, многострочная реплика склеивается", () => {
    const lines = parseDialogDump("22.09.26 20-21 [Азат]: Салам\n22.09.26 20-21 [ИИ-квалификатор]: Здравствуйте!\nЧем помочь?\n22.09.26 20-22 [Азат]: Работа", ["Азат"]);
    expect(lines).toEqual([
      { at: "2026-09-22 20:21", out: false, author: "Азат", text: "Салам" },
      { at: "2026-09-22 20:21", out: true, author: "ИИ-квалификатор", text: "Здравствуйте!\nЧем помочь?" },
      { at: "2026-09-22 20:22", out: false, author: "Азат", text: "Работа" },
    ]);
  });
  it("«Пользователь» — всегда клиент; последняя реплика нужной стороны", () => {
    expect(parseDialogDump("22.09.26 20-21 [Пользователь]: Привет\n22.09.26 20-21 [Бот]: Здравствуйте", [])[0]?.out).toBe(false);
    expect(lastDialogLine("25.12.24 14-30 [Пользователь]: Привет\n25.12.24 14-31 [Бот]: Здравствуйте", "client_message")).toBe("Привет");
  });
});

describe("«передаю менеджеру»", () => {
  it("узнаётся по смыслу, обычный ответ — нет", () => {
    expect(isHandoff("Сейчас передам вас нашему менеджеру")).toBe(true);
    expect(isHandoff("С вами свяжется менеджер в ближайшее время")).toBe(true);
    expect(isHandoff("Менеджер скоро ответит")).toBe(true);
    expect(isHandoff("В субботу есть свободное время у специалиста")).toBe(false);
  });
});

describe("файлы в «Полном диалоге» (адреса вымышленные)", () => {
  const DO = "https://media-test.fra1.digitaloceanspaces.com/000000000000/";
  it("документ — ссылка и название строкой ниже; название с расширением", () => {
    const docRef = mediaRef(`${DO}d421810c-84dc-40c9-9e45-504c9c6497f0.docx\nДОГОВОР(ПРИМЕР) - 2026 (1)`);
    expect(docRef?.url).toBe(`${DO}d421810c-84dc-40c9-9e45-504c9c6497f0.docx`);
    expect(docRef?.caption).toBe("ДОГОВОР(ПРИМЕР) - 2026 (1)");
    expect(mediaTitle(docRef!, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx", true)).toBe("ДОГОВОР(ПРИМЕР) - 2026 (1).docx");
    expect(mediaTitle(mediaRef(`${DO}365eb26e-b301-4a36-940c-32f360ae5530.docx\nДОГОВОР_ПРИМЕР.docx`)!, "application/x", "docx", true)).toBe("ДОГОВОР_ПРИМЕР.docx");
  });
  it("фото одним именем — ищется в папке хранилища, найденной по ссылкам диалога", () => {
    const photoRef = mediaRef("0da4d22f-c0aa-4b68-b32a-024db71cd27b.jpg");
    expect(photoRef?.url).toBeNull();
    expect(mediaCandidates(photoRef!, mediaFolders([`${DO}f98f7172-cc94-40f8-ab48-59f0fe37a012.oga`, "привет"]))).toEqual([`${DO}0da4d22f-c0aa-4b68-b32a-024db71cd27b.jpg`]);
    expect(mediaTitle(photoRef!, "image/jpeg", "jpg", true)).toBe("Фото");
    expect(mediaTitle(photoRef!, "image/jpeg", "jpg", false)).toBe("Фото от клиента");
  });
  it("обычный текст и ссылка на чужой сайт — не файл для скачивания", () => {
    expect(mediaRef("Здравствуйте, вот договор")).toBeNull();
    expect(mediaRef("смотрите https://site.example/a.pdf")).toBeNull();
    expect(mediaCandidates(mediaRef("https://site.example/files/a.pdf")!, [])).toEqual([]);
    expect(mediaCandidates(mediaRef("http://127.0.0.1:3003/x.pdf")!, [])).toEqual([]);
    expect(mediaHostAllowed("http://127.0.0.1:9/x.pdf", ["127.0.0.1"])).toBe(true);
  });
  it("подпись к фото — текстом сообщения, у документа текст — его название", () => {
    expect(mediaText(mediaRef("0da4d22f-c0aa-4b68-b32a-024db71cd27b.jpg\nМоё фото")!, "image/jpeg", "Фото")).toBe("Моё фото");
    expect(mediaText(mediaRef(`${DO}d421810c-84dc-40c9-9e45-504c9c6497f0.docx\nДОГОВОР`)!, "application/pdf", "ДОГОВОР.pdf")).toBe("ДОГОВОР.pdf");
  });
});

describe("ссылка вебхука", () => {
  it("только https на nextbot.ru, без логина и порта; начало дописывается", () => {
    expect(webhookUrlFix("app.nextbot.ru/api/webhooks/v1/x")).toBe("https://app.nextbot.ru/api/webhooks/v1/x");
    expect(webhookUrlProblem("https://app.nextbot.ru/api/webhooks/v1/x")).toBeNull();
    expect(webhookUrlProblem("app.nextbot.ru/api/webhooks/v1/x")).toBeNull();
    expect(webhookUrlProblem("http://app.nextbot.ru/x")).toMatch(/https/);
    expect(webhookUrlProblem("https://evil.example/x")).toMatch(/nextbot\.ru/);
    expect(webhookUrlProblem("https://u:p@app.nextbot.ru/x")).toMatch(/логин/);
    expect(webhookUrlProblem("http://127.0.0.1:30099/hook", true)).toBeNull();
    expect(webhookUrlProblem(null)).toMatch(/Не указана/);
  });
});
