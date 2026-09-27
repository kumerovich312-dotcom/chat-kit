import { describe, expect, it } from "vitest";
import { hidePersonalData, personalDataMask } from "../../src/ai/index.js";

// Телефоны, почта и номера карт не уходят поставщику ИИ: вместо них метки, в ответе — снова настоящие значения.
// Все номера вымышленные — из нулей.

describe("маска личных данных", () => {
  it("телефоны в любой записи — метки; один номер в разной записи — одна метка", () => {
    const mask = personalDataMask();
    const hidden = mask.hide("Мой номер +996 555 00-00-01, раньше писал с 0555 00-00-01, жена — 996555000003. Рабочий: 8 (700) 000-00-04");
    expect(hidden).toBe("Мой номер {{PHONE_1}}, раньше писал с {{PHONE_1}}, жена — {{PHONE_2}}. Рабочий: {{PHONE_3}}");
    expect(mask.size).toBe(3);
    expect(mask.restore("Перезвонить на {{PHONE_1}} или {{PHONE_3}}")).toBe("Перезвонить на +996 555 00-00-01 или 8 (700) 000-00-04");
  });

  it("короткий номер с дефисами, номер в ссылке и после «Тел:» — тоже скрыты", () => {
    const hidden = hidePersonalData("Домашний 555-00-01, пишите https://wa.me/996555000001, Тел:+7 700 000 00 05");
    expect(hidden).toBe("Домашний {{PHONE_1}}, пишите https://wa.me/{{PHONE_2}}, Тел:{{PHONE_3}}");
  });

  it("почта — метка без учёта регистра; номер карты и счёта — метка CARD", () => {
    const mask = personalDataMask();
    const hidden = mask.hide("Пишите на client.test@example.com или CLIENT.TEST@example.com. Карта 0000 0000 0000 0001, счёт 00000000000000000002");
    expect(hidden).toBe("Пишите на {{EMAIL_1}} или {{EMAIL_1}}. Карта {{CARD_1}}, счёт {{CARD_2}}");
    expect(mask.restore("Почта {{EMAIL_1}}, карта {{CARD_1}}")).toBe("Почта client.test@example.com, карта 0000 0000 0000 0001");
    // В краткое содержание номер карты не возвращаем
    expect(mask.restore("Карта {{CARD_1}}", { cards: false })).toBe("Карта (номер карты)");
  });

  it("даты, время, цены и короткие номера заказов не трогаем", () => {
    const text = "Запись 12.10.2026 в 14:03, или 2026-10-12, или 12-10-2026. Цена 150 000 сом, квартира 12 500 000, скидка 1000-2000, заказ № 12345, код ABC1234567890";
    expect(hidePersonalData(text)).toBe(text);
  });

  it("метку, которой не было, ИИ не протащит: вместо неё — слово; пробелы внутри метки прощаем", () => {
    const mask = personalDataMask();
    mask.hide("Номер 0555 00-00-02");
    expect(mask.restore("{{ PHONE_1 }} и {{PHONE_7}}, {{EMAIL_3}}, {{CARD_2}}")).toBe("0555 00-00-02 и (телефон), (почта), (номер карты)");
  });

  it("длинную сумму тоже скрываем — и возвращаем на место в ответе", () => {
    const mask = personalDataMask();
    const hidden = mask.hide("Бюджет 1 000 000 000 сом");
    expect(hidden).toBe("Бюджет {{PHONE_1}} сом");
    expect(mask.restore("Бюджет клиента — {{PHONE_1}} сом")).toBe("Бюджет клиента — 1 000 000 000 сом");
  });
});
