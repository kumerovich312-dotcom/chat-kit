// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotState, ChatMessage } from "../../src/core/index.js";
import { ChatWindow, type ChatWindowDialog } from "../../src/ui/index.js";

// Места для студии (решения пользователя 27.09.2026): кнопки бота в шапке, обучение — только кому дали доступ,
// «второй пилот» — когда диалог ведёт человек, «пример для бота» — у ответа на вопрос клиента, память бота.

afterEach(cleanup);

const msgs: ChatMessage[] = [
  { id: "1", at: "2026-09-27T08:00:00.000Z", kind: "message", author: { type: "client" }, channel: "whatsapp", text: "Сколько стоит?" },
  { id: "2", at: "2026-09-27T08:00:30.000Z", kind: "message", author: { type: "bot" }, channel: "whatsapp", text: "От 45 000 сом" },
  { id: "3", at: "2026-09-27T08:01:00.000Z", kind: "message", author: { type: "client" }, channel: "whatsapp", text: "А рассрочка есть?" },
  { id: "4", at: "2026-09-27T08:02:00.000Z", kind: "message", author: { type: "operator_crm", name: "Нургуль" }, channel: "whatsapp", text: "Да, на 3 месяца" },
  { id: "5", at: "2026-09-27T08:03:00.000Z", kind: "message", author: { type: "operator_crm", name: "Нургуль" }, channel: "whatsapp", text: "И ещё: без процентов" },
  { id: "6", at: "2026-09-27T08:04:00.000Z", kind: "message", author: { type: "client" }, channel: "whatsapp", text: "Отлично, а когда начать?" },
];

function win(dialog: Partial<ChatWindowDialog>, bot: BotState = { mode: "manager" }) {
  const action = vi.fn(async () => {});
  render(
    <ChatWindow timeZone="Asia/Bishkek" now={Date.parse("2026-09-27T10:00:00Z")}
      list={{ dialogs: [], hrefFor: () => "#", link: () => "#" }}
      dialog={{ id: "1", name: "Азат", messages: msgs, bot: { state: bot, action }, composer: { action: async () => {}, channel: "whatsapp", live: true }, ...dialog }} />
  );
  return action;
}

describe("места для студии в окне", () => {
  it("кнопки бота и пометка — в шапке", async () => {
    const action = win({}, { mode: "bot" });
    expect(screen.getByText("бот ведёт диалог")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByText("Пауза бота")); });
    const fd = (action.mock.calls[0] as unknown as [FormData])[0];
    expect(fd.get("command")).toBe("pause");
    expect(fd.get("hours")).toBe("12");
  });

  it("обучение — только если проект дал доступ: оценка у ответов бота, «пример» — у ответа на вопрос клиента", () => {
    win({});
    expect(screen.queryByText("Как надо было")).toBeNull();
    cleanup();
    win({ teach: { rate: async () => {}, example: async () => {} } });
    expect(screen.getAllByText("Как надо было")).toHaveLength(1);
    const examples = document.querySelectorAll(".ck-teach__example");
    expect([...examples].map((b) => b.closest("[data-message]")?.getAttribute("data-message"))).toEqual(["4"]);
  });

  it("«второй пилот» — когда диалог ведёт человек; «Вставить в поле» подставляет текст", () => {
    win({ copilot: { text: "Начать можно с понедельника" } }, { mode: "bot" });
    expect(screen.queryByText("Бот предлагает ответ")).toBeNull();
    cleanup();
    win({ copilot: { text: "Начать можно с понедельника" } }, { mode: "manager" });
    fireEvent.click(screen.getByText("Вставить в поле"));
    expect((screen.getByLabelText("Текст сообщения") as HTMLTextAreaElement).value).toBe("Начать можно с понедельника");
  });

  it("что бот знает о клиенте — рядом с перепиской, правится формой", async () => {
    const save = vi.fn(async () => {});
    win({ memory: { facts: [{ key: "country", label: "Страна", value: "Польша", source: "bot" }], action: save } });
    expect(screen.getByText("Что бот знает о клиенте")).toBeTruthy();
    fireEvent.click(screen.getByText("изменить"));
    fireEvent.change(screen.getByLabelText("Страна"), { target: { value: "Чехия" } });
    await act(async () => { fireEvent.click(screen.getByText("Сохранить")); });
    const fd = (save.mock.calls[0] as unknown as [FormData])[0];
    expect([fd.get("key"), fd.get("value")]).toEqual(["country", "Чехия"]);
  });
});
