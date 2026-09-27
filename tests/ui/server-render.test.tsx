import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChatMessage, DialogSummary } from "../../src/core/index.js";
import { ChatWindow, DialogList } from "../../src/ui/index.js";

// Окно собирается и на сервере (Атлас рисует переписку серверной страницей): без window и document, без ошибок.

const NOW = Date.parse("2026-09-27T10:00:00Z");
const messages: ChatMessage[] = [
  { id: "1", at: "2026-09-27T08:05:09.000Z", kind: "message", author: { type: "client" }, channel: "whatsapp", text: "Есть работа?" },
  { id: "2", at: "2026-09-27T08:05:40.000Z", kind: "message", author: { type: "bot" }, channel: "whatsapp", text: "Да" },
  { id: "3", at: "2026-09-27T08:06:00.000Z", kind: "message", author: { type: "client" }, channel: "whatsapp", text: "Голосовое", attachments: [{ id: "v", name: "Голосовое", mime: "audio/ogg", url: "/files/v" }] },
];
const dialogs: DialogSummary[] = [
  { id: "1", name: "Азат Тестов", channel: "whatsapp", waitSince: "2026-09-27T08:06:00.000Z", unread: 2, last: { text: "Есть работа?", at: messages[0]!.at, author: { type: "client" } } },
  { id: "2", name: "Бакыт", channel: "instagram", last: { text: "Чем помочь?", at: messages[1]!.at, author: { type: "bot" } } },
  { id: "3", name: "Нургуль", channel: "telegram", last: { text: "Отправила", at: messages[1]!.at, author: { type: "operator_crm", id: "7", name: "Нургуль" } } },
];

describe("серверная сборка окна", () => {
  it("список диалогов: «ждёт …», «ИИ-агент:», «Вы:», счётчики и фильтры", () => {
    const html = renderToString(
      <DialogList dialogs={dialogs} activeId="1" hrefFor={(d) => `/inbox?client=${d.id}`} link={(o) => `/inbox?show=${o.filter ?? "all"}`}
        filter="wait" counts={{ wait: 1, unread: 2 }} meId="7" timeZone="Asia/Bishkek" now={NOW} hasMore />
    );
    expect(html).toContain("ждёт 1 ч");
    expect(html).toContain("ИИ-агент: ");
    expect(html).toContain("Вы: ");
    expect(html).toContain("2 непрочитанных");
    expect(html).toContain('href="/inbox?client=2"');
    expect(html).toContain("Показать ещё");
  });

  it("окно целиком с перепиской, полем ввода и полосой «ждёт ответа»", () => {
    const html = renderToString(
      <ChatWindow timeZone="Asia/Bishkek" now={NOW}
        list={{ dialogs, activeId: "1", hrefFor: (d) => `/inbox?client=${d.id}`, link: () => "/inbox" }}
        dialog={{ id: "1", name: "Азат Тестов", channel: "whatsapp", contact: "+996 555 00-00-01", messages, waitSince: messages[2]!.at,
          dismissAction: async () => {}, composer: { action: async () => {}, channel: "whatsapp", live: true } }} />
    );
    expect(html).toContain("data-chat-thread");
    expect(html).toContain("ИИ-агент");
    expect(html).toContain("клиент написал последним");
    expect(html).toContain("Ответ не нужен");
    expect(html).toContain("Enter — отправить");
    expect(html).toContain('data-voice="v"');
  });
});
