// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readActionForm, readComposerForm } from "../../src/core/composer.js";
import type { DialogSummary } from "../../src/core/conversation.js";
import type { ChatMessage } from "../../src/core/model.js";
import { defineProfile, NOUNS } from "../../src/core/profile.js";
import { ChatThread } from "../../src/ui/ChatThread.js";
import { Composer } from "../../src/ui/Composer.js";
import { DialogList } from "../../src/ui/DialogList.js";
import { applyFilter } from "../../src/ui/Filter.js";
import { PendingProvider } from "../../src/ui/Pending.js";
import { DialogStrip, presenceLine } from "../../src/ui/Strip.js";

// Новые части окна (решения пользователя 27.09.2026): фильтр, цитата и «Ответить», свои карточки, «Расшифровать»,
// полоса статуса и меток, меню «+», «Улучшить текст», «срочно» в списке, слова отрасли.

afterEach(cleanup);

const TZ = "Asia/Bishkek";
const NOW = Date.parse("2026-09-27T10:00:00Z");
const base = { channel: "whatsapp", kind: "message" as const };
const profile = defineProfile({
  timeZone: TZ, currency: "сом", words: { client: NOUNS.patient },
  cards: {
    appointment: {
      title: "Запись", icon: "calendar", fields: [{ key: "at", label: "Когда", format: "datetime" }, { key: "service", label: "Услуга" }],
      statusKey: "status", statuses: { planned: { label: "Запланирована", tone: "blue" } },
    },
  },
});
const list: ChatMessage[] = [
  { ...base, id: "1", at: "2026-09-27T08:05:09.000Z", author: { type: "client" }, text: "Можно записаться на пятницу?" },
  { ...base, id: "2", at: "2026-09-27T08:05:40.000Z", author: { type: "bot" }, text: "Да, в 10:00 свободно" },
  { ...base, id: "3", at: "2026-09-27T08:06:00.000Z", author: { type: "operator_crm", name: "Айгерим", id: "u1" }, text: "Записала вас:", card: { type: "appointment", data: { at: "2026-10-02T04:00:00Z", service: "Консультация", status: "planned" } } },
  { ...base, id: "4", at: "2026-09-27T08:07:00.000Z", kind: "note", author: { type: "operator_crm", name: "Айгерим", id: "u1" }, text: "Перезвонить вечером" },
  { ...base, id: "5", at: "2026-09-27T08:08:00.000Z", author: { type: "client" }, text: "Голосовое сообщение", attachments: [{ id: "v1", name: "Голосовое сообщение", mime: "audio/ogg", url: "/files/v1" }] },
  { ...base, id: "6", at: "2026-09-27T08:09:00.000Z", author: { type: "client" }, text: "А во сколько точно?", replyTo: { id: "2" } },
  { ...base, id: "7", at: "2026-09-27T08:10:00.000Z", kind: "call", channel: "call", author: { type: "client" }, text: "Пропущенный звонок", call: { direction: "in", missed: true } },
];

describe("лента: цитата, «Ответить», карточка, слова для фильтра", () => {
  it("цитата показывает исходное сообщение и ведёт к нему; «Ответить» знает, кто и что написал", () => {
    const { container } = render(<ChatThread messages={list} timeZone={TZ} now={NOW} t={profile.texts} canReply clientName="Азат Тестов" />);
    const quote = container.querySelector('[data-message="6"] .ck-quote') as HTMLAnchorElement;
    expect(quote.getAttribute("href")).toBe("#ck-m-2");
    expect(quote.textContent).toContain("ИИ-агент");
    expect(quote.textContent).toContain("Да, в 10:00 свободно");
    const reply = container.querySelector('[data-message="1"] [data-ck-reply]')!;
    expect(reply.getAttribute("data-ck-reply-who")).toBe("Азат Тестов");
    expect(reply.getAttribute("data-ck-reply-text")).toBe("Можно записаться на пятницу?");
    // У заметки и звонка «Ответить» нет
    expect(container.querySelector('[data-message="4"] [data-ck-reply]')).toBeNull();
  });

  it("своя карточка проекта — по описанию из паспорта: заголовок, статус, поля по поясу компании", () => {
    const { container } = render(<ChatThread messages={list} timeZone={TZ} now={NOW} cards={profile.cards} currency="сом" />);
    const card = container.querySelector('[data-message="3"] .ck-card')!;
    expect(card.textContent).toContain("Запись");
    expect(card.textContent).toContain("Запланирована");
    expect(card.textContent).toContain("2 октября в 10:00");
    expect(card.textContent).toContain("Консультация");
  });

  it("фильтр прячет лишнее и пустые дни; «Все» возвращает всё", () => {
    const { container } = render(<div data-chat-thread=""><ChatThread messages={list} timeZone={TZ} now={NOW} /></div>);
    const visible = () => [...container.querySelectorAll<HTMLElement>("[data-f]")].filter((x) => !x.hidden).map((x) => x.getAttribute("data-message"));
    expect(applyFilter(container, "voice")).toBe(1);
    expect(visible()).toEqual(["5"]);
    expect(applyFilter(container, "notes")).toBe(1);
    expect(applyFilter(container, "calls")).toBe(1);
    expect(applyFilter(container, "bot")).toBe(1);
    expect(applyFilter(container, "client")).toBe(4);
    expect(applyFilter(container, "all")).toBe(list.length);
  });

  it("«Расшифровать» у голосового: текст приходит от действия проекта и остаётся под плеером", async () => {
    const action = vi.fn(async (fd: FormData) => ({ text: `текст ${fd.get("attachment_id")}` }));
    render(<ChatThread messages={list} timeZone={TZ} now={NOW} transcribeAction={action} t={profile.texts} />);
    await act(async () => { fireEvent.click(screen.getByText("Расшифровать")); });
    expect(action).toHaveBeenCalledTimes(1);
    expect(action.mock.calls[0]![0].get("message_id")).toBe("5");
    expect(screen.getByText("текст v1")).toBeTruthy();
  });
});

describe("полоса под шапкой", () => {
  it("метка ставится и снимается формой; «отложить до» уходит статусом с временем", async () => {
    const tags = vi.fn(async (_fd: FormData) => {});
    const status = vi.fn(async (_fd: FormData) => {});
    render(<DialogStrip t={profile.texts} timeZone={TZ} now={NOW} status="open" tags={["vip"]}
      tagDefs={[{ code: "vip", label: "VIP", tone: "violet" }, { code: "new", label: "Новый" }]}
      snoozeChoices={[{ label: "На 1 час", until: "2026-09-27T11:00:00.000Z" }]}
      actions={{ tags, status }} />);
    await act(async () => { fireEvent.click(screen.getByLabelText("Снять метку «VIP»")); });
    expect(tags.mock.calls[0]![0].get("tag")).toBe("vip");
    expect(tags.mock.calls[0]![0].get("on")).toBe("0");
    fireEvent.click(screen.getByText("Открыт"));
    await act(async () => { fireEvent.click(screen.getByText("На 1 час")); });
    expect(status.mock.calls[0]![0].get("status")).toBe("snoozed");
    expect(status.mock.calls[0]![0].get("until")).toBe("2026-09-27T11:00:00.000Z");
  });

  it("«коллега уже отвечает»: пишет — важнее, чем смотрит; себя и старое не показываем", () => {
    const at = new Date(NOW - 5_000).toISOString();
    expect(presenceLine([{ userId: "u2", name: "Бакыт", state: "typing", at }, { userId: "u3", name: "Нурлан", state: "viewing", at }], "u1", NOW)?.text).toBe("Бакыт пишет ответ…");
    expect(presenceLine([{ userId: "u3", name: "Нурлан", state: "viewing", at }], "u1", NOW)?.text).toBe("Нурлан смотрит этот диалог");
    expect(presenceLine([{ userId: "u1", name: "Я", state: "typing", at }], "u1", NOW)).toBeNull();
    expect(presenceLine([{ userId: "u2", name: "Бакыт", state: "typing", at: new Date(NOW - 120_000).toISOString() }], "u1", NOW)).toBeNull();
  });
});

describe("поле ввода: ответ с цитатой, меню «+», «Улучшить текст»", () => {
  const setup = (extra: Partial<Parameters<typeof Composer>[0]> = {}) => {
    const sent: FormData[] = [];
    const utils = render(
      <PendingProvider>
        <button type="button" data-ck-reply="42" data-ck-reply-who="Азат" data-ck-reply-text="А во сколько?">Ответить</button>
        <Composer action={async (fd) => { sent.push(fd); }} channel="whatsapp" live t={profile.texts} {...extra} />
      </PendingProvider>
    );
    return { ...utils, sent };
  };

  it("«Ответить» у сообщения — полоса «Ответ на» над полем, отправка несёт reply_to", async () => {
    const { sent } = setup();
    fireEvent.click(screen.getByText("Ответить"));
    expect(screen.getByText("А во сколько?")).toBeTruthy();
    const area = screen.getByLabelText("Текст сообщения");
    fireEvent.change(area, { target: { value: "В 10:00" } });
    await act(async () => { fireEvent.keyDown(area, { key: "Enter" }); });
    expect(readComposerForm(sent[0]!)).toMatchObject({ text: "В 10:00", replyTo: "42" });
    expect(screen.queryByText("А во сколько?")).toBeNull();
  });

  it("меню «+»: вставить текст с именем; форма кнопки уходит действию проекта", async () => {
    const onAction = vi.fn(async (_fd: FormData) => ({ ok: true }));
    setup({
      onAction, actionVars: { client: "Азат" },
      actions: [
        { id: "address", label: "Адрес", kind: "insert", text: "{client}, наш адрес: ул. Примерная, 1" },
        { id: "appointment", label: "Записать", kind: "form", fields: [{ key: "service", label: "Услуга", required: true }] },
      ],
    });
    fireEvent.click(screen.getByLabelText("Действия"));
    fireEvent.click(screen.getByText("Адрес"));
    expect((screen.getByLabelText("Текст сообщения") as HTMLTextAreaElement).value).toBe("Азат, наш адрес: ул. Примерная, 1");
    fireEvent.click(screen.getByLabelText("Действия"));
    fireEvent.click(screen.getByText("Записать"));
    // Обязательное поле пустое — не уходит
    await act(async () => { fireEvent.click(screen.getByText("Готово")); });
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Услуга *"), { target: { value: "Консультация" } });
    await act(async () => { fireEvent.click(screen.getByText("Готово")); });
    expect(readActionForm(onAction.mock.calls[0]![0])).toEqual({ actionId: "appointment", values: { service: "Консультация" } });
  });

  it("«Улучшить текст» заменяет текст и даёт вернуть как было", async () => {
    const improveAction = vi.fn(async (fd: FormData) => ({ text: `Здравствуйте! ${String(fd.get("text"))}.` }));
    setup({ improveAction });
    const area = screen.getByLabelText("Текст сообщения") as HTMLTextAreaElement;
    fireEvent.change(area, { target: { value: "ждём вас в пятницу" } });
    fireEvent.click(screen.getByLabelText("Улучшить текст"));
    await act(async () => { fireEvent.click(screen.getByText("Улучшить")); });
    expect(area.value).toBe("Здравствуйте! ждём вас в пятницу.");
    fireEvent.click(screen.getByText("Вернуть как было"));
    expect(area.value).toBe("ждём вас в пятницу");
  });

  it("слова отрасли: вкладка и подсказка — «Пациенту»", () => {
    setup();
    expect(screen.getByText("Пациенту")).toBeTruthy();
  });

  it("коллега пишет ответ — предупреждение над полем", () => {
    setup({ meId: "u1", presence: [{ userId: "u2", name: "Бакыт", state: "typing", at: new Date().toISOString() }] });
    expect(screen.getByRole("status").textContent).toContain("Бакыт пишет ответ…");
  });
});

describe("список: «срочно» и «недоволен» под именем, метки, «Мои»", () => {
  it("оценка ИИ видна, только когда есть что сказать", () => {
    const dialogs: DialogSummary[] = [
      { id: "1", name: "Азат", assessment: { urgency: "high", mood: "negative" }, tags: ["vip"] },
      { id: "2", name: "Бакыт", assessment: { urgency: "normal", mood: "positive" } },
    ];
    const { container } = render(<DialogList dialogs={dialogs} hrefFor={(d) => `/?d=${d.id}`} link={() => "/"} mine meId="u1"
      tags={[{ code: "vip", label: "VIP", tone: "violet" }]} t={profile.texts} status="open" now={NOW} />);
    const rows = container.querySelectorAll(".ck-row");
    expect(rows[0]!.textContent).toContain("срочно");
    expect(rows[0]!.textContent).toContain("недоволен");
    expect(rows[0]!.textContent).toContain("VIP");
    expect(rows[1]!.querySelector(".ck-row__mood")).toBeNull();
    expect(screen.getByText("Мои")).toBeTruthy();
    expect(screen.getByText("Отложенные")).toBeTruthy();
  });
});
