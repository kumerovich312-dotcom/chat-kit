import { describe, expect, it } from "vitest";
import { parseJsonObject, readAssessment, readImproved, readSummary, stripFences } from "../../src/ai/index.js";
import { salvageString } from "../../src/ai/json.js";

// Ответ модели разбирается с запасом: обёртка ```json, слова до и после, лишняя запятая, обрыв на полуслове,
// другое написание значений.

describe("JSON из ответа модели", () => {
  it("обёртка ```json и слова вокруг не мешают; скобки внутри строк — не конец объекта", () => {
    expect(parseJsonObject('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(parseJsonObject('Вот ответ: {"text": "Здравствуйте, {имя}! }"} Надеюсь, помог.')).toEqual({ text: "Здравствуйте, {имя}! }" });
    expect(parseJsonObject('{"text": "кавычка \\" и скобка {"}')).toEqual({ text: 'кавычка " и скобка {' });
  });

  it("лишняя запятая прощается; не объект и не JSON — null; первый настоящий объект — из нескольких", () => {
    expect(parseJsonObject('{"mood": "negative", "urgency": "high",}')).toEqual({ mood: "negative", urgency: "high" });
    expect(parseJsonObject("[1, 2]")).toBeNull();
    expect(parseJsonObject("просто текст")).toBeNull();
    expect(parseJsonObject('{оборвано {"a": 2} {"b": 3}')).toEqual({ a: 2 });
  });

  it("обёртка снимается только вокруг всего ответа; оборванное поле достаётся", () => {
    expect(stripFences("```\nтекст\n```")).toBe("текст");
    expect(stripFences("текст ```код```")).toBe("текст ```код```");
    expect(salvageString('{"summary": "Клиент хочет записат', "summary")).toBe("Клиент хочет записат");
    expect(salvageString('{"summary": "строка\\nвторая \\u04', "summary")).toBe("строка\nвторая ");
    expect(salvageString('{"other": 1}', "summary")).toBeNull();
  });
});

describe("краткое содержание", () => {
  it("summary и points; не строки среди пунктов отброшены", () => {
    expect(readSummary('{"summary": "Клиент хочет записаться.", "points": ["Завтра в 15:00", 5, " ", "Перезвонить"]}')).toEqual({
      summary: "Клиент хочет записаться.", points: ["Завтра в 15:00", "Перезвонить"],
    });
  });

  it("без JSON — весь ответ как текст; оборванный JSON — начало summary; пусто — null", () => {
    expect(readSummary("Клиент хочет записаться на завтра.")).toEqual({ summary: "Клиент хочет записаться на завтра.", points: [] });
    expect(readSummary('```json\n{"summary": "Клиент хочет запи')).toEqual({ summary: "Клиент хочет запи", points: [] });
    expect(readSummary('{"summary": "", "points": []}')).toBeNull();
    expect(readSummary("   ")).toBeNull();
  });
});

describe("настроение и срочность", () => {
  it("точные значения и другое написание: High, высокая, medium, недовольный", () => {
    expect(readAssessment('{"mood": "negative", "urgency": "high", "reason": "Третий раз спрашивает, где заказ"}')).toEqual({
      mood: "negative", urgency: "high", reason: "Третий раз спрашивает, где заказ",
    });
    expect(readAssessment('{"mood": "Positive", "urgency": "medium", "reason": " "}')).toEqual({ mood: "positive", urgency: "normal", reason: null });
    expect(readAssessment('{"mood": "недовольный", "urgency": "высокая"}')).toMatchObject({ mood: "negative", urgency: "high" });
  });

  it("незнакомые значения — neutral и normal; оборванный ответ — что успело прийти; ни одного поля — null", () => {
    expect(readAssessment('{"mood": "восторг", "urgency": 5, "reason": "?"}')).toEqual({ mood: "neutral", urgency: "normal", reason: "?" });
    expect(readAssessment('Оценка: {"mood": "negative", "urgency": "high", "reason": "Жалуется на дост')).toEqual({
      mood: "negative", urgency: "high", reason: "Жалуется на дост",
    });
    expect(readAssessment('{"настроение": "плохое"}')).toBeNull();
    expect(readAssessment("не знаю")).toBeNull();
  });
});

describe("улучшенный текст", () => {
  it("из JSON; без JSON — весь ответ без обёртки и кавычек; пусто — null", () => {
    expect(readImproved('{"text": "Здравствуйте! Запись на завтра в 15:00 свободна."}')).toBe("Здравствуйте! Запись на завтра в 15:00 свободна.");
    expect(readImproved("«Добрый день! Ждём вас.»")).toBe("Добрый день! Ждём вас.");
    expect(readImproved("```\nДобрый день!\n```")).toBe("Добрый день!");
    // Шаблон с {имя} в начале — это текст, а не сломанный JSON
    expect(readImproved("{имя}, здравствуйте!")).toBe("{имя}, здравствуйте!");
    expect(readImproved('{"text": "Добрый де')).toBe("Добрый де");
    expect(readImproved('```json\n{"text": "Добр')).toBe("Добр");
    expect(readImproved('```json\n{"other": 1')).toBeNull();
    expect(readImproved('{"text": ""}')).toBeNull();
  });
});
