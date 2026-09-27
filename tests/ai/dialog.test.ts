import { describe, expect, it } from "vitest";
import { personalDataMask, renderConversation, timeStamp } from "../../src/ai/index.js";
import { at, dialog, msg, TZ } from "./messages.js";

// Переписка текстом для ИИ: строка на сообщение, время по поясу компании, служебное и черновики бота — мимо.

describe("переписка текстом для ИИ", () => {
  it("строки «[день.месяц часы:минуты] Кто: текст», заметка помечена, служебное и черновик бота пропущены", () => {
    const r = renderConversation(dialog(), { timeZone: TZ });
    expect(r.text.split("\n")).toEqual([
      "[12.10 14:03] Клиент: Здравствуйте, можно записаться на завтра? Мой номер +996 555 00-00-01",
      "[12.10 14:05] Менеджер Айгерим: Да, есть время в 15:00.",
      "[12.10 14:06] Менеджер Айгерим (заметка команды, клиент не видел): перезвонить после обеда",
      "[12.10 14:10] Клиент: (голосовое, расшифровка: «Хорошо, тогда в три. Почта client.test@example.com»)",
    ]);
    expect(r).toMatchObject({ count: 4, fromClient: 2, truncated: false });
  });

  it("порядок — по времени, даже если сообщения пришли вперемешку; слово проекта вместо «Клиент»", () => {
    const list = dialog().reverse();
    const r = renderConversation(list, { timeZone: TZ, client: "пациент" });
    expect(r.text.split("\n")[0]).toBe("[12.10 14:03] Пациент: Здравствуйте, можно записаться на завтра? Мой номер +996 555 00-00-01");
  });

  it("звонок с расшифровкой, бот, письмо с темой, фото, документ, недоставленное, ответ с цитатой", () => {
    const r = renderConversation([
      msg({ at: at("09:00"), kind: "call", text: "Входящий звонок, 3 мин 05 с", call: { direction: "in", durationSec: 185 },
        attachments: [{ id: "r1", name: "Запись разговора", mime: "audio/mpeg", url: "/files/r1", transcript: "Добрый день, я по поводу заказа" }] }),
      msg({ at: at("09:01"), author: { type: "bot" }, text: "Чем ещё помочь?", delivery: "failed" }),
      msg({ at: at("09:02"), channel: "email", subject: "Документы", text: "Отправляю договор\n\nи фото", attachments: [
        { id: "d1", name: "Договор.pdf", mime: "application/pdf", url: "/files/d1" },
        { id: "p1", name: "фото.jpg", mime: "image/jpeg", url: "/files/p1" },
      ] }),
      msg({ at: at("09:03"), author: { type: "operator_phone" }, text: "Получили", replyTo: { text: "Отправляю договор" } }),
    ], { timeZone: TZ });
    expect(r.text).toBe([
      "[12.10 15:00] Звонок: Входящий звонок, 3 мин 05 с. Расшифровка разговора: «Добрый день, я по поводу заказа»",
      "[12.10 15:01] Бот: Чем ещё помочь? (не доставлено)",
      // Многострочное сообщение — со сдвигом, пустые строки убраны
      "[12.10 15:02] Клиент: Тема: Документы. Отправляю договор\n  и фото (документ «Договор.pdf») (фото)",
      "[12.10 15:03] Менеджер: (в ответ на «Отправляю договор») Получили",
    ].join("\n"));
  });

  it("берёт последние сообщения: не больше lastMessages и не больше maxChars — и говорит, что начало не показано", () => {
    const many = Array.from({ length: 10 }, (_, i) => msg({ at: at(`10:0${i}`), text: `Сообщение ${i + 1}` }));
    const last3 = renderConversation(many, { timeZone: TZ, lastMessages: 3 });
    expect(last3.text).toBe("(начало переписки не показано)\n[12.10 16:07] Клиент: Сообщение 8\n[12.10 16:08] Клиент: Сообщение 9\n[12.10 16:09] Клиент: Сообщение 10");
    expect(last3).toMatchObject({ count: 3, truncated: true });
    const short = renderConversation(many, { timeZone: TZ, maxChars: 80 });
    expect(short.count).toBe(2);
    expect(short.text.endsWith("Сообщение 10")).toBe(true);
    // Одно сообщение берём всегда, даже если оно длиннее предела
    expect(renderConversation(many, { timeZone: TZ, maxChars: 5 }).count).toBe(1);
  });

  it("маска скрывает телефоны и почту во всех строках одной меткой на номер", () => {
    const mask = personalDataMask();
    const r = renderConversation(dialog(), { timeZone: TZ, mask });
    expect(r.text).not.toContain("555 00-00-01");
    expect(r.text).not.toContain("example.com");
    expect(r.text).toContain("Мой номер {{PHONE_1}}");
    expect(r.text).toContain("Почта {{EMAIL_1}}");
    // Время не спутано с номером
    expect(r.text).toContain("[12.10 14:03]");
  });

  it("время: по поясу компании; незнакомый пояс — время сервера, а не ошибка; нет времени — без метки", () => {
    expect(timeStamp(at("08:03"), TZ)).toBe("12.10 14:03");
    expect(timeStamp(at("08:03"), "Нет/Такого")).toMatch(/^\d\d\.\d\d \d\d:\d\d$/);
    expect(timeStamp("не время")).toBeNull();
    expect(renderConversation([msg({ at: "вчера", text: "Привет" })]).text).toBe("Клиент: Привет");
  });
});
