import { describe, expect, it } from "vitest";
import { formatForChannel, parseRich, stripRich } from "../../src/core/markup.js";

describe("parseRich — разметка для окна переписки", () => {
  it("**жирный** и *курсив* от ИИ", () => {
    expect(parseRich("Услуги: **консультация** и *доставка*")).toEqual([
      { t: "text", v: "Услуги: " },
      { t: "b", c: [{ t: "text", v: "консультация" }] },
      { t: "text", v: " и " },
      { t: "i", c: [{ t: "text", v: "доставка" }] },
    ]);
  });

  it("в сообщении из WhatsApp *так* — жирный, ~так~ — зачёркнутый", () => {
    expect(parseRich("*важно* и ~старое~", "whatsapp")).toEqual([
      { t: "b", c: [{ t: "text", v: "важно" }] },
      { t: "text", v: " и " },
      { t: "s", c: [{ t: "text", v: "старое" }] },
    ]);
  });

  it("не разметка: подчёркивание внутри слова, 2*3*4, одиночная звёздочка", () => {
    expect(stripRich("file_name_1 и 2*3*4 и * пункт")).toBe("file_name_1 и 2*3*4 и * пункт");
    expect(parseRich("snake_case_name")).toEqual([{ t: "text", v: "snake_case_name" }]);
  });

  it("ссылка — без точки в конце; ссылка с подписью", () => {
    expect(parseRich("смотрите https://example.kg/jobs.")).toEqual([
      { t: "text", v: "смотрите " },
      { t: "link", href: "https://example.kg/jobs", c: [{ t: "text", v: "https://example.kg/jobs" }] },
      { t: "text", v: "." },
    ]);
    expect(parseRich("[каталог](https://example.kg/c)")).toEqual([
      { t: "link", href: "https://example.kg/c", c: [{ t: "text", v: "каталог" }] },
    ]);
  });

  it("ссылки только http и https", () => {
    expect(parseRich("[x](javascript:alert(1))").some((n) => n.t === "link")).toBe(false);
  });

  it("жирный внутри с курсивом", () => {
    expect(parseRich("**срок _до пятницы_**")).toEqual([
      { t: "b", c: [{ t: "text", v: "срок " }, { t: "i", c: [{ t: "text", v: "до пятницы" }] }] },
    ]);
  });
});

describe("formatForChannel — ответ бота под канал", () => {
  const answer = "## Документы\n* паспорт\n* **справка** о несудимости\nПодробнее: [каталог](https://example.kg/c)";

  it("WhatsApp: *жирный*, пункты через «-», ссылка «подпись (адрес)»", () => {
    expect(formatForChannel(answer, "whatsapp")).toBe("*Документы*\n- паспорт\n- *справка* о несудимости\nПодробнее: каталог (https://example.kg/c)");
    expect(formatForChannel("*курсив* и `код`", "whatsapp")).toBe("_курсив_ и `код`");
  });

  it("Telegram: HTML с экранированием", () => {
    expect(formatForChannel("**A < B** & [сайт](https://example.kg/?a=1&b=2)", "telegram")).toBe(
      '<b>A &lt; B</b> &amp; <a href="https://example.kg/?a=1&amp;b=2">сайт</a>'
    );
    expect(formatForChannel("<script>", "telegram")).toBe("&lt;script&gt;");
  });

  it("остальные каналы — чистый текст", () => {
    expect(formatForChannel(answer, "plain")).toBe("Документы\n- паспорт\n- справка о несудимости\nПодробнее: каталог (https://example.kg/c)");
  });
});
