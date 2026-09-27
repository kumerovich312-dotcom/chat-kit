import { describe, expect, it } from "vitest";
import { canView, fileBadge, fileHref, fileKind, fileWords, fmtSize, textIsFileName } from "../../src/core/files.js";
import { dayLabel, fmtClock, fmtDuration, fullTime, listTime } from "../../src/core/time.js";
import { foldYo, initials, plural, searchWords, textMatches } from "../../src/core/text.js";
import { messengerGreeting, messengerState, tgLink, waLink } from "../../src/core/links.js";
import { channelMarkup, normalizeChannel } from "../../src/core/channels.js";
import { authorLabel } from "../../src/core/model.js";
import { botStateText } from "../../src/core/conversation.js";

describe("файлы в сообщениях", () => {
  it("вид файла по типу и по имени", () => {
    expect(fileKind("image/jpeg")).toBe("image");
    expect(fileKind("audio/ogg; codecs=opus")).toBe("audio");
    expect(fileKind("application/pdf")).toBe("pdf");
    expect(fileKind("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("doc");
    expect(fileKind("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe("xls");
    expect(fileKind("application/octet-stream", "Договор.DOCX")).toBe("doc");
    expect(fileKind("", "таблица.xlsx")).toBe("xls");
    expect(fileKind("application/zip")).toBe("other");
    expect([fileBadge("pdf"), fileBadge("doc"), fileBadge("xls"), fileBadge("other")]).toEqual(["PDF", "DOC", "XLS", "файл"]);
  });
  it("размер словами", () => {
    expect(fmtSize(29_000)).toBe("28 КБ");
    expect(fmtSize(1_468_006)).toBe("1,4 МБ");
    expect(fmtSize(0)).toBe("");
  });
  it("окно просмотра — для фото и PDF", () => {
    expect(canView({ mime: "image/png", name: "a.png" })).toBe(true);
    expect(canView({ mime: "application/pdf", name: "a.pdf" })).toBe(true);
    expect(canView({ mime: "application/msword", name: "a.doc" })).toBe(false);
  });
  it("метка содержимого в адресе", () => {
    expect(fileHref({ url: "/files/15", version: "ab12cd34" })).toBe("/files/15?v=ab12cd34");
    expect(fileHref({ url: "/files/15?x=1", version: null }, { download: "1" })).toBe("/files/15?x=1&download=1");
  });
  it("подпись-имя файла под вложением не повторяем", () => {
    expect(textIsFileName("паспорт.jpg", [{ name: "паспорт.jpg" }])).toBe(true);
    expect(textIsFileName("Файл: паспорт.jpg", [{ name: "паспорт.jpg" }])).toBe(true);
    expect(textIsFileName("вот мой паспорт", [{ name: "паспорт.jpg" }])).toBe(false);
  });
  it("слова вместо файла", () => {
    expect(fileWords({ mime: "audio/ogg", name: "" })).toBe("Голосовое сообщение");
    expect(fileWords({ mime: "application/pdf", name: "договор.pdf" })).toBe("Документ: договор.pdf");
  });
});

describe("время по поясу компании", () => {
  const tz = "Asia/Bishkek"; // UTC+6
  const now = Date.parse("2026-09-27T10:00:00Z");
  it("время сообщения до секунды", () => {
    expect(fmtClock("2026-09-27T08:05:09.123Z", tz)).toBe("14:05:09");
    expect(fmtClock("2026-09-27T08:05:09.123Z", tz, false)).toBe("14:05");
  });
  it("подпись дня: сегодня, вчера, дата, прошлый год", () => {
    expect(dayLabel("2026-09-27T01:00:00Z", tz, now)).toBe("сегодня");
    expect(dayLabel("2026-09-26T17:59:00Z", tz, now)).toBe("вчера");
    expect(dayLabel("2026-09-26T18:01:00Z", tz, now)).toBe("сегодня");
    expect(dayLabel("2026-09-20T08:00:00Z", tz, now)).toBe("20 сентября");
    expect(dayLabel("2025-12-31T08:00:00Z", tz, now)).toBe("31 декабря 2025");
  });
  it("время в списке диалогов", () => {
    expect(listTime("2026-09-27T08:05:09Z", tz, now)).toBe("14:05");
    expect(listTime("2026-09-26T08:05:09Z", tz, now)).toBe("вчера");
    expect(listTime("2026-09-14T08:05:09Z", tz, now)).toBe("14 сен");
  });
  it("полное время и длительность", () => {
    expect(fullTime("2026-09-27T08:05:09Z", tz)).toBe("27 сентября, 14:05:09");
    expect(fmtDuration(65.7)).toBe("1:05");
  });
});

describe("поиск и слова", () => {
  it("ё = е, слова в любом порядке, регистр не важен", () => {
    expect(foldYo("Алёна")).toBe("Алена");
    expect(searchWords("  №2411-К   Алёна ")).toEqual(["2411-К", "Алена"]);
    expect(textMatches("Паспорт получила Алёна", "алена паспорт")).toBe(true);
    expect(textMatches("Паспорт готов", "виза")).toBe(false);
  });
  it("числа и инициалы", () => {
    expect([plural(1, "а", "б", "в"), plural(3, "а", "б", "в"), plural(11, "а", "б", "в"), plural(22, "а", "б", "в")]).toEqual(["а", "б", "в", "б"]);
    expect(initials("Азат Тестов")).toBe("АТ");
    expect(initials("@nick")).toBe("N");
    expect(initials("")).toBe("?");
  });
});

describe("ссылки на мессенджеры", () => {
  it("wa.me с текстом, t.me/+номер, короткий номер — нет ссылки", () => {
    expect(waLink("+996 555 00-00-01", "Здравствуйте!")).toBe("https://wa.me/996555000001?text=%D0%97%D0%B4%D1%80%D0%B0%D0%B2%D1%81%D1%82%D0%B2%D1%83%D0%B9%D1%82%D0%B5!");
    expect(tgLink("+996555000001")).toBe("https://t.me/+996555000001");
    expect(waLink("12345")).toBeNull();
    expect(tgLink(null)).toBeNull();
  });
  it("приветствие: в первом сообщении — кто и почему; заглушка вместо имени — без имени", () => {
    expect(messengerGreeting({ client: "Азат Тестов", manager: "Нургуль Менеджерова", company: "Пример Трэвел", source: "Сайт", first: true }))
      .toBe("Здравствуйте, Азат! Это Нургуль, «Пример Трэвел». Вы оставили заявку на нашем сайте. Когда вам удобно поговорить?");
    expect(messengerGreeting({ client: "Заявка с сайта", manager: "Нургуль", company: "ОсОО «Пример»", source: null, first: true }))
      .toBe("Здравствуйте! Это Нургуль, ОсОО «Пример». Когда вам удобно поговорить?");
    expect(messengerGreeting({ client: "Азат", manager: "Нургуль", company: "Пример", source: "Сайт", first: false })).toBe("Здравствуйте, Азат! ");
  });
  it("писал нам сам — «есть» даже после отметки «нет»", () => {
    expect([messengerState("no", true), messengerState("yes", false), messengerState("no", false), messengerState(null, false)]).toEqual(["yes", "yes", "no", null]);
  });
});

describe("каналы, авторы, состояние бота", () => {
  it("канал по названию от провайдера", () => {
    expect(normalizeChannel("WhatsApp")).toBe("whatsapp");
    expect(normalizeChannel("Instagram Direct")).toBe("instagram");
    expect(normalizeChannel("telegram_bot")).toBe("telegram");
    expect(normalizeChannel("Тестовый чат")).toBe("nextbot");
    expect(normalizeChannel("")).toBe("nextbot");
    expect([channelMarkup("whatsapp"), channelMarkup("telegram"), channelMarkup("instagram")]).toEqual(["whatsapp", "telegram", "plain"]);
  });
  it("подпись автора", () => {
    expect(authorLabel({ type: "bot" })).toBe("ИИ-агент");
    expect(authorLabel({ type: "operator_phone" })).toBe("менеджер с телефона");
    expect(authorLabel({ type: "operator_crm", name: "Нургуль", id: "7" }, { meId: "7" })).toBe("вы");
    expect(authorLabel({ type: "operator_crm", name: "Нургуль", id: "7" })).toBe("Нургуль");
  });
  it("пометка состояния бота", () => {
    expect(botStateText({ mode: "muted" })).toBe("бот не отвечает этому клиенту");
    expect(botStateText({ mode: "manager", pausedUntil: "18:30" })).toBe("бот на паузе до 18:30");
    expect(botStateText({ mode: "bot" })).toBeNull();
  });
});
