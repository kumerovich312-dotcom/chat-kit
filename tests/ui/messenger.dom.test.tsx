// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readComposerForm } from "../../src/core/composer.js";
import type { DialogSummary } from "../../src/core/conversation.js";
import type { ChatMessage } from "../../src/core/model.js";
import { defineProfile, NOUNS } from "../../src/core/profile.js";
import { BotToggle } from "../../src/ui/Bot.js";
import { ChatThread } from "../../src/ui/ChatThread.js";
import { ChatWindow } from "../../src/ui/ChatWindow.js";
import { Composer } from "../../src/ui/Composer.js";
import { DialogList } from "../../src/ui/DialogList.js";
import { PendingProvider } from "../../src/ui/Pending.js";
import { StageMenu } from "../../src/ui/Stage.js";
import { HandoffBanner } from "../../src/ui/Wait.js";

// Вид «Мессенджер» (макет пользователя 19.10.2026): отдельная тема рядом с обычным видом; полоса статуса, «Кратко»,
// фильтр и файлы — в панели диалога; заметка и письмо — значками в поле ввода.

// Время — своё, не часы компьютера: «ждёт 53 мин» считается от него
beforeEach(() => { vi.useFakeTimers({ now: Date.parse("2026-10-19T08:00:00Z"), toFake: ["Date"] }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const TZ = "Asia/Bishkek";
const NOW = Date.parse("2026-10-19T08:00:00Z");
const base = { channel: "whatsapp", kind: "message" as const };
const STAGES = [{ code: "new", label: "Новая заявка", tone: "blue" as const }, { code: "booked", label: "Записан", tone: "green" as const }];
const profile = defineProfile({ timeZone: TZ, look: "messenger", stages: STAGES, words: { client: NOUNS.patient } });

const thread: ChatMessage[] = [
  { ...base, id: "1", at: "2026-10-19T07:20:00.000Z", author: { type: "client" }, text: "Хочу записаться" },
  { ...base, id: "2", at: "2026-10-19T07:30:00.000Z", author: { type: "client" }, text: "Голосовое сообщение", attachments: [{ id: "v1", name: "Голосовое сообщение", mime: "audio/ogg", url: "/files/v1", transcript: "Можно в субботу?" }] },
  { ...base, id: "3", at: "2026-10-19T07:35:00.000Z", author: { type: "bot" }, text: "Передаю менеджеру", handoff: true },
];

describe("паспорт: вид окна и этапы", () => {
  it("по умолчанию — обычный вид, этапов нет; «Мессенджер» — только явно", () => {
    expect(defineProfile().look).toBe("classic");
    expect(defineProfile().stages).toEqual([]);
    expect(profile.look).toBe("messenger");
    expect(profile.stages).toHaveLength(2);
    // Чужое значение из базы — обычный вид
    expect(defineProfile({ look: "neon" as never }).look).toBe("classic");
  });

  it("надписи нового вида — со словами отрасли и подписью бота", () => {
    const p = defineProfile({ words: { botLabel: "ИИ-администратор" } });
    expect(p.texts.botOn).toBe("ИИ-администратор отвечает");
    expect(p.texts.botOff).toBe("ИИ-администратор на паузе");
    expect(p.texts.bannerHandoff).toBe("ИИ-администратор передал чат вам");
    expect(profile.texts.bannerWait).toBe("Пациент ждёт ответа");
  });
});

describe("лента в виде «Мессенджер»", () => {
  it("передача человеку — строкой после ответа бота, значок бота сбоку, расшифровка — в пузыре", () => {
    const { container } = render(<ChatThread look="messenger" messages={thread} timeZone={TZ} now={NOW} t={profile.texts} />);
    const pill = container.querySelector(".ck-sys--handoff")!;
    expect(pill.textContent).toContain("ИИ-агент передал чат менеджеру в 13:35");
    expect(container.querySelector('[data-message="3"] .ck-badge--warn')).toBeNull();
    expect(container.querySelector('[data-message="3"] .ck-msg__ava')).not.toBeNull();
    const tr = container.querySelector('[data-message="2"] .ck-transcript--inline')!;
    expect(tr.textContent).toBe("Расшифровка: Можно в субботу?");
  });

  it("в обычном виде — как было: пометка в пузыре, без строки и значка", () => {
    const { container } = render(<ChatThread messages={thread} timeZone={TZ} now={NOW} />);
    expect(container.querySelector(".ck-sys--handoff")).toBeNull();
    expect(container.querySelector('[data-message="3"] .ck-badge--warn')).not.toBeNull();
    expect(container.querySelector(".ck-msg__ava")).toBeNull();
  });
});

describe("список в виде «Мессенджер»", () => {
  const dialogs: DialogSummary[] = [
    { id: "a", name: "Эрлан Демо", channel: "whatsapp", chip: "суббота", waitSince: "2026-10-19T07:07:00.000Z", unread: 2,
      last: { text: "Голосовое: можно в субботу?", at: "2026-10-19T07:30:00.000Z", author: { type: "client" }, file: { mime: "audio/ogg" } } },
    { id: "b", name: "Азат Тестов", channel: "telegram",
      last: { text: "Записала вас", at: "2026-10-19T06:00:00.000Z", author: { type: "operator_crm", id: "me", name: "Айгерим" }, delivery: "read" } },
  ];
  const props = { dialogs, hrefFor: (d: DialogSummary) => `/?dialog=${d.id}`, link: () => "/", now: NOW, timeZone: TZ, meId: "me", look: "messenger" as const };

  it("«Все чаты», ярлык проекта, «53 мин» с часиками без слова «ждёт», значок голосового, «Вы:» и галочки", () => {
    const { container } = render(<DialogList {...props} compose={{ href: "/new" }} />);
    expect(container.querySelector(".ck-list__title strong")!.textContent).toBe("Все чаты");
    expect(container.querySelector(".ck-list__compose")!.getAttribute("href")).toBe("/new");
    const row = container.querySelectorAll(".ck-row--m")[0]!;
    expect(row.querySelector(".ck-row__chip")!.textContent).toBe("суббота");
    expect(row.querySelector(".ck-row__wait")!.textContent).toBe("53 мин");
    expect(row.querySelector(".ck-row__wait")!.classList.contains("ck-late")).toBe(true);
    expect(row.querySelector(".ck-row__ico")).not.toBeNull();
    const mine = container.querySelectorAll(".ck-row--m")[1]!;
    expect(mine.querySelector(".ck-row__who")!.textContent).toBe("Вы: ");
    expect(mine.querySelector(".ck-tick--read")).not.toBeNull();
  });

  it("фильтры — под кнопкой с ползунками; выбран фильтр — открыты сразу, в заголовке — его название", () => {
    const closed = render(<DialogList {...props} />);
    expect((closed.container.querySelector(".ck-list__toggle input") as HTMLInputElement).checked).toBe(false);
    cleanup();
    const { container } = render(<DialogList {...props} filter="wait" />);
    expect((container.querySelector(".ck-list__toggle input") as HTMLInputElement).checked).toBe(true);
    expect(container.querySelector(".ck-list__title strong")!.textContent).toBe("Ждут ответа");
  });
});

describe("поле ввода в виде «Мессенджер»", () => {
  const renderComposer = (action = vi.fn(async (_fd: FormData) => ({ ok: true }))) => {
    render(
      <PendingProvider>
        <Composer look="messenger" action={action} channel="whatsapp" live emailTo="client@example.kg" t={profile.texts}
          templates={[{ label: "Цены", text: "Консультация — 1 000 сом" }, { label: "Адрес", text: "Мы на ул. Примерной, 1" }, { label: "Фото", text: "Пришлите фото" }, { label: "Спасибо", text: "Спасибо!" }]}
          copilot={{ text: "Записать вас на субботу?" }} />
      </PendingProvider>,
    );
    return action;
  };

  it("вкладок нет: заметка — значком в поле, отправка уходит заметкой", async () => {
    const action = renderComposer();
    expect(document.querySelector(".ck-seg")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: profile.texts.noteToggle }));
    expect(document.querySelector(".ck-field--note")).not.toBeNull();
    const area = screen.getByRole("textbox", { name: "Текст заметки" });
    fireEvent.change(area, { target: { value: "Перезвонить вечером" } });
    await act(async () => { fireEvent.click(document.querySelector(".ck-sendbig")!); });
    expect(readComposerForm(action.mock.calls[0]![0]).mode).toBe("note");
  });

  it("быстрые ответы — первые три шаблона кнопками и «Ещё»; Tab в пустом поле вставляет черновик бота", () => {
    renderComposer();
    const chips = [...document.querySelectorAll(".ck-replies__chip")].map((x) => x.textContent);
    expect(chips.slice(0, 3)).toEqual(["Цены", "Адрес", "Фото"]);
    expect(chips[3]).toContain("Ещё");
    const area = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.keyDown(area, { key: "Tab" });
    expect(area.value).toBe("Записать вас на субботу?");
    fireEvent.click(screen.getByText("Цены"));
    expect(area.value).toBe("Консультация — 1 000 сом");
  });

  it("смайлик встаёт туда, где курсор", () => {
    renderComposer();
    const area = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(area, { target: { value: "Спасибо" } });
    area.setSelectionRange(7, 7);
    fireEvent.click(screen.getByRole("button", { name: profile.texts.emoji }));
    fireEvent.click(screen.getByRole("button", { name: "🙏" }));
    expect(area.value).toBe("Спасибо🙏");
  });
});

describe("шапка, плашка, панель", () => {
  it("переключатель бота: включён — пауза на 12 часов, выключен — вернуть боту", async () => {
    const action = vi.fn(async (_fd: FormData) => {});
    render(<BotToggle state={{ mode: "bot" }} action={action} t={profile.texts} />);
    const sw = screen.getByRole("switch");
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(sw.textContent).toContain("ИИ-агент отвечает");
    await act(async () => { fireEvent.click(sw); });
    expect(action.mock.calls[0]![0].get("command")).toBe("pause");
    expect(action.mock.calls[0]![0].get("hours")).toBe("12");
    expect(sw.getAttribute("aria-checked")).toBe("false");
    cleanup();
    const back = vi.fn(async (_fd: FormData) => {});
    render(<BotToggle state={{ mode: "manager" }} action={back} t={profile.texts} />);
    expect(screen.getByRole("switch").textContent).toContain("ИИ-агент на паузе");
    await act(async () => { fireEvent.click(screen.getByRole("switch")); });
    expect(back.mock.calls[0]![0].get("command")).toBe("resume");
  });

  it("этап рядом с именем: меню из паспорта, выбор уходит формой stage", async () => {
    const action = vi.fn(async (_fd: FormData) => {});
    render(<StageMenu stage="new" stages={STAGES} action={action} t={profile.texts} />);
    fireEvent.click(screen.getByRole("button", { name: /Новая заявка/ }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Записан/ })); });
    expect(action.mock.calls[0]![0].get("stage")).toBe("booked");
    expect(screen.getByRole("button", { name: /Записан/ })).toBeTruthy();
  });

  it("плашка: «бот передал чат вам», коротко о чём и «ждёт»", () => {
    render(<HandoffBanner since="2026-10-19T07:35:00.000Z" now={NOW} handoff brief="Хочет в субботу" t={profile.texts} />);
    const b = document.querySelector(".ck-banner")!;
    expect(b.textContent).toContain("ИИ-агент передал чат вам");
    expect(b.textContent).toContain("Хочет в субботу");
    expect(b.textContent).toContain("ждёт 25 мин");
  });

  it("окно: класс вида, переключатель в шапке, плашка вместо полосы ожидания; статус, «Кратко», фильтр — в панели", () => {
    const { container } = render(
      <ChatWindow profile={profile} now={NOW} meId="me"
        list={{ dialogs: [], hrefFor: () => "/", link: () => "/" }}
        dialog={{
          id: "a", name: "Эрлан Демо", channel: "whatsapp", messages: thread,
          bot: { state: { mode: "manager", handoff: "requested" }, action: async () => {} },
          waitSince: "2026-10-19T07:35:00.000Z", handoff: true, brief: "Хочет в субботу",
          status: "open", statusAction: async () => {}, stage: "new", stageAction: async () => {},
          summaryAction: async () => ({ text: "Кратко" }),
          composer: { action: async () => ({ ok: true }), channel: "whatsapp", live: true },
        }} />,
    );
    expect(container.querySelector(".ck-window")!.classList.contains("ck-look--messenger")).toBe(true);
    const head = container.querySelector(".ck-head")!;
    expect(head.querySelector('[role="switch"]')).not.toBeNull();
    expect(head.querySelector(".ck-stage")!.textContent).toContain("Новая заявка");
    expect(head.querySelector(".ck-summary-btn")).toBeNull();
    expect(container.querySelector(".ck-banner")!.textContent).toContain("Хочет в субботу");
    expect(container.querySelector(".ck-waitbar")).toBeNull();
    const side = container.querySelector("aside.ck-side")!;
    expect(side.hasAttribute("hidden")).toBe(true);
    expect(side.querySelector(".ck-strip")).not.toBeNull();
    expect(side.querySelector(".ck-summary-btn")).not.toBeNull();
    expect(side.textContent).toContain("Фильтр сообщений");
    // Под шапкой полосы нет — она в панели
    expect(container.querySelector(".ck-window__chat > .ck-strip")).toBeNull();
    // Кнопка в шапке открывает панель
    fireEvent.click(head.querySelector(".ck-side-toggle")!);
    expect(side.hasAttribute("hidden")).toBe(false);
  });
});
