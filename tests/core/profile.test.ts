import { describe, expect, it } from "vitest";
import { authorLabel } from "../../src/core/model.js";
import { botStateText } from "../../src/core/conversation.js";
import { defineProfile, fill, formatCardValue, makeTexts, NOUNS, profileCss } from "../../src/core/profile.js";

// Паспорт проекта: слова отрасли в нужных падежах, что включено, цвета без лишнего в CSS, значения карточек.

describe("слова отрасли", () => {
  it("клиент по умолчанию, пациент и кандидат — во всех надписях с нужными падежами", () => {
    const t = makeTexts();
    expect(t.tabSend).toBe("Клиенту");
    expect(t.listAllAnswered).toBe("Все клиенты получили ответ");
    expect(t.memoryTitle).toBe("Что бот знает о клиенте");
    const p = makeTexts({ ...defineProfile().words, client: NOUNS.patient, manager: NOUNS.administrator });
    expect(p.tabSend).toBe("Пациенту");
    expect(p.sendToClient).toBe("Отправить пациенту");
    expect(p.memoryTitle).toBe("Что бот знает о пациенте");
    expect(p.waitWhyHandoff).toBe("— ИИ-агент передал пациента администратору");
    expect(p.listPrefixPhone).toBe("Администратор с телефона: ");
    const s = makeTexts({ ...defineProfile().words, client: NOUNS.student });
    expect(s.memoryTitle).toBe("Что бот знает об ученике");
  });

  it("подписи авторов и пометка бота берут слова из паспорта", () => {
    const t = defineProfile({ words: { client: NOUNS.guest, manager: NOUNS.consultant, bot: NOUNS.assistant, botLabel: "ИИ-консультант" } }).texts;
    expect(authorLabel({ type: "client" }, { t })).toBe("гость");
    expect(authorLabel({ type: "bot" }, { t })).toBe("ИИ-консультант");
    expect(authorLabel({ type: "operator_phone" }, { t })).toBe("консультант с телефона");
    expect(authorLabel({ type: "operator_phone", name: "Айгерим" }, { t })).toBe("Айгерим · с телефона");
    expect(botStateText({ mode: "muted" }, (x) => x, t)).toBe("ассистент не отвечает этому гостю");
    expect(botStateText({ mode: "manager", pausedUntil: "2026-09-27T12:00:00Z" }, () => "18:00", t)).toBe("ассистент на паузе до 18:00");
  });

  it("любую надпись можно заменить в паспорте; fill подставляет значения", () => {
    const p = defineProfile({ texts: { tabNote: "Для своих" } });
    expect(p.texts.tabNote).toBe("Для своих");
    expect(p.texts.tabSend).toBe("Клиенту");
    expect(fill("ответ уйдёт {who} в {channel}", { channel: "WhatsApp" })).toBe("ответ уйдёт {who} в WhatsApp");
  });
});

describe("паспорт целиком", () => {
  it("не заданное — по умолчанию; включённое можно выключить", () => {
    const p = defineProfile({ features: { voice: false }, timeZone: "Asia/Bishkek" });
    expect(p.features.voice).toBe(false);
    expect(p.features.filter).toBe(true);
    expect(p.timeZone).toBe("Asia/Bishkek");
    expect(p.tags).toEqual([]);
    // Паспорт — простые данные: переживает JSON (его можно хранить в базе и отдавать браузерным частям)
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
  });

  it("цвета — только переменные --ck-* и значения без знаков, которыми можно вырваться из правила", () => {
    const css = profileCss({
      theme: {
        "--ck-accent": "#0f766e",
        "--ck-radius": "8px",
        "color": "red",
        "--ck-bad": "red; } body { display: none",
        "--ck-evil": "</style><script>",
      },
    });
    expect(css).toBe(":root { --ck-accent: #0f766e; --ck-radius: 8px; }");
    expect(profileCss({ theme: {} })).toBe("");
  });

  it("значения карточек: дата и время по поясу компании, деньги с валютой, пустое — прочерк", () => {
    expect(formatCardValue("2026-10-02T04:00:00Z", "datetime", { timeZone: "Asia/Bishkek" })).toBe("2 октября в 10:00");
    expect(formatCardValue("2026-10-02T04:00:00Z", "date", { timeZone: "Asia/Bishkek" })).toBe("2 октября 2026 г.");
    // Разряды — неразрывным пробелом (число не переносится на две строки)
    expect(formatCardValue(4500, "money", { currency: "сом" })).toMatch(/^4\s500 сом$/);
    expect(formatCardValue(null, "text")).toBe("—");
    expect(formatCardValue(true, "text")).toBe("да");
  });
});
