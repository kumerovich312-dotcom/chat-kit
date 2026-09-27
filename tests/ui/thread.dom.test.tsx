// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatMessage } from "../../src/core/model.js";
import { ChatThread } from "../../src/ui/ChatThread.js";

// Лента: кто написал, время до секунды по поясу компании, доставка, вложения, заметки и служебные строки.

afterEach(cleanup);

const TZ = "Asia/Bishkek";
const NOW = Date.parse("2026-09-27T10:00:00Z");
const base = { channel: "whatsapp", kind: "message" as const };
const list: ChatMessage[] = [
  { ...base, id: "1", at: "2026-09-27T08:05:09.000Z", author: { type: "client" }, text: "Есть работа?" },
  { ...base, id: "2", at: "2026-09-27T08:05:40.000Z", author: { type: "bot" }, text: "Да, **есть**", handoff: true },
  { ...base, id: "3", at: "2026-09-27T08:06:00.000Z", author: { type: "operator_phone" }, text: "Перезвоню" },
  { ...base, id: "4", at: "2026-09-27T08:07:00.000Z", author: { type: "operator_crm", name: "Нургуль", id: "7" }, text: "Отправила", delivery: "failed", deliveryError: "номер недоступен" },
  { ...base, id: "5", at: "2026-09-27T08:08:00.000Z", kind: "note", author: { type: "operator_crm", name: "Нургуль", id: "7" }, text: "Звонить после 18:00" },
  { ...base, id: "6", at: "2026-09-27T08:09:00.000Z", kind: "system", author: { type: "system" }, text: "ИИ-агент в этом диалоге на паузе" },
  { ...base, id: "7", at: "2026-09-27T08:10:00.000Z", author: { type: "client" }, text: "паспорт.jpg", attachments: [{ id: "f1", name: "паспорт.jpg", mime: "image/jpeg", url: "/files/f1", version: "ab12" }] },
  { ...base, id: "8", at: "2026-09-27T08:11:00.000Z", author: { type: "operator_crm", name: "Нургуль", id: "7" }, text: "Договор", delivery: "read", channel: "telegram", attachments: [{ id: "f2", name: "Договор.pdf", mime: "application/pdf", url: "/files/f2", size: 120_000 }] },
];

describe("ChatThread", () => {
  it("авторы: клиент слева, бот фиолетовый с меткой «ИИ-агент» и «передал менеджеру», менеджер с телефона и из CRM — справа", () => {
    const { container } = render(<ChatThread messages={list} timeZone={TZ} now={NOW} meId="7" />);
    const bubble = (id: string) => container.querySelector(`[data-message="${id}"]`)!;
    expect(bubble("1").className).toContain("ck-msg--in");
    expect(bubble("2").className).toContain("ck-msg--bot");
    expect(bubble("2").textContent).toContain("ИИ-агент");
    expect(bubble("2").textContent).toContain("передал менеджеру — нужен ответ человека");
    expect(bubble("2").querySelector("strong")?.textContent).toBe("есть");
    expect(bubble("3").className).toContain("ck-msg--out");
    expect(bubble("3").textContent).toContain("менеджер с телефона");
    expect(bubble("4").textContent).toContain("вы");
  });

  it("время до секунды по поясу компании и подпись дня", () => {
    render(<ChatThread messages={list} timeZone={TZ} now={NOW} />);
    expect(screen.getByText("сегодня")).toBeTruthy();
    expect(screen.getByText(/^14:05:09/)).toBeTruthy();
  });

  it("не доставлено — причина и «повторить» формой с номером сообщения", () => {
    const { container } = render(<ChatThread messages={list} timeZone={TZ} now={NOW} resendAction={() => {}} />);
    expect(screen.getByText(/не доставлено: номер недоступен/)).toBeTruthy();
    const input = container.querySelector('[data-message="4"] input[name="message_id"]') as HTMLInputElement;
    expect(input.value).toBe("4");
  });

  it("заметка — жёлтой карточкой, служебное — строкой посередине", () => {
    const { container } = render(<ChatThread messages={list} timeZone={TZ} now={NOW} />);
    expect(container.querySelector(".ck-note")?.textContent).toContain("Заметка · Нургуль");
    expect(container.querySelector(".ck-sys")?.textContent).toBe("ИИ-агент в этом диалоге на паузе");
  });

  it("фото — картинкой с меткой содержимого и окном просмотра; имя файла вместо подписи не повторяется; PDF — плашкой", () => {
    const { container } = render(<ChatThread messages={list} timeZone={TZ} now={NOW} />);
    const img = container.querySelector('[data-message="7"] img') as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/files/f1?v=ab12");
    expect(container.querySelector('[data-message="7"] a[data-view-file="f1"]')).toBeTruthy();
    expect(container.querySelector('[data-message="7"] .ck-msg__text')).toBeNull();
    expect(container.querySelector('[data-message="8"] .ck-doc__badge')?.textContent).toBe("PDF");
  });

  it("клиент пишет в двух мессенджерах — под сообщением подписан канал; прочитано — две галочки", () => {
    const { container } = render(<ChatThread messages={list} timeZone={TZ} now={NOW} />);
    expect(container.querySelector('[data-message="8"] .ck-msg__meta')?.textContent).toContain("Telegram");
    expect(container.querySelector('[data-message="8"] .ck-tick--read')).toBeTruthy();
  });

  it("места для проекта: действия под сообщением и у вложения", () => {
    render(<ChatThread messages={list} timeZone={TZ} now={NOW}
      renderActions={(m) => (m.author.type === "bot" ? <button type="button">Как надо было</button> : null)}
      renderAttachmentExtra={(_m, a) => <span>+ В документы {a.id}</span>} />);
    expect(screen.getAllByText("Как надо было")).toHaveLength(1);
    expect(screen.getByText("+ В документы f1")).toBeTruthy();
  });
});
