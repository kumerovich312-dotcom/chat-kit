// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readComposerForm } from "../../src/core/composer.js";
import { Composer } from "../../src/ui/Composer.js";
import { PendingBubbles, PendingProvider } from "../../src/ui/Pending.js";

// Поле ввода: Enter — отправить, Shift+Enter — строка, сообщение сразу с часиками, ошибка — текст возвращается.

afterEach(cleanup);

function setup(action: (fd: FormData) => Promise<{ error?: string } | void>, extra: Partial<Parameters<typeof Composer>[0]> = {}) {
  return render(
    <PendingProvider>
      <div data-chat-thread=""><PendingBubbles /></div>
      <Composer action={action} channel="whatsapp" live {...extra} />
    </PendingProvider>
  );
}

describe("Composer", () => {
  it("Enter отправляет форму «Клиенту»; поле очищается; сообщение сразу видно с часиками", async () => {
    let release!: () => void;
    const sent: FormData[] = [];
    const action = vi.fn((fd: FormData) => { sent.push(fd); return new Promise<void>((r) => { release = r; }); });
    const { container } = setup(action);
    const area = screen.getByLabelText("Текст сообщения") as HTMLTextAreaElement;
    fireEvent.change(area, { target: { value: "Здравствуйте!" } });
    await act(async () => { fireEvent.keyDown(area, { key: "Enter" }); });
    expect(action).toHaveBeenCalledTimes(1);
    expect(readComposerForm(sent[0]!)).toMatchObject({ mode: "send", text: "Здравствуйте!", channel: "whatsapp", direction: "out" });
    expect(area.value).toBe("");
    expect(container.querySelector(".ck-pending")?.textContent).toContain("отправляется");
    await act(async () => { release(); });
  });

  it("Shift+Enter — новая строка, не отправка", async () => {
    const action = vi.fn(async () => {});
    setup(action);
    const area = screen.getByLabelText("Текст сообщения");
    fireEvent.change(area, { target: { value: "строка" } });
    await act(async () => { fireEvent.keyDown(area, { key: "Enter", shiftKey: true }); });
    expect(action).not.toHaveBeenCalled();
  });

  it("ошибка — причина под полем, текст вернулся", async () => {
    setup(async () => ({ error: "Клиент ещё не писал нам в мессенджер" }));
    const area = screen.getByLabelText("Текст сообщения") as HTMLTextAreaElement;
    fireEvent.change(area, { target: { value: "Не дойдёт" } });
    await act(async () => { fireEvent.keyDown(area, { key: "Enter" }); });
    expect(screen.getByRole("alert").textContent).toBe("Клиент ещё не писал нам в мессенджер");
    expect(area.value).toBe("Не дойдёт");
  });

  it("клиент не на связи — «В историю» с выбором «клиент написал»; заметка — отдельной вкладкой", async () => {
    const sent: FormData[] = [];
    setup(async (fd) => { sent.push(fd); }, { live: false });
    fireEvent.click(screen.getByText("клиент написал"));
    const area = screen.getByLabelText("Текст сообщения");
    fireEvent.change(area, { target: { value: "Спасибо" } });
    await act(async () => { fireEvent.keyDown(area, { key: "Enter" }); });
    expect(readComposerForm(sent[0]!)).toMatchObject({ mode: "copy", direction: "in", text: "Спасибо" });
    fireEvent.click(screen.getByText("Заметка"));
    const note = screen.getByLabelText("Текст заметки");
    fireEvent.change(note, { target: { value: "Звонить после 18:00" } });
    await act(async () => { fireEvent.keyDown(note, { key: "Enter" }); });
    expect(readComposerForm(sent[1]!)).toMatchObject({ mode: "note", text: "Звонить после 18:00" });
  });

  it("ответ на письмо — сразу вкладка «Письмо» с темой «Re: …»; Enter — новая строка, Ctrl+Enter — отправить", async () => {
    const sent: FormData[] = [];
    setup(async (fd) => { sent.push(fd); }, { emailTo: "client@example.kg", replySubject: "Вопрос по визе" });
    expect((screen.getByLabelText("Тема письма") as HTMLInputElement).value).toBe("Re: Вопрос по визе");
    const area = screen.getByLabelText("Текст письма");
    fireEvent.change(area, { target: { value: "Добрый день!" } });
    await act(async () => { fireEvent.keyDown(area, { key: "Enter" }); });
    expect(sent).toHaveLength(0);
    await act(async () => { fireEvent.keyDown(area, { key: "Enter", ctrlKey: true }); });
    expect(readComposerForm(sent[0]!)).toMatchObject({ mode: "email", channel: "email", subject: "Re: Вопрос по визе", text: "Добрый день!" });
  });

  it("шаблон подставляется в поле; разделы шаблонов подписаны", () => {
    setup(async () => {}, { templates: [{ label: "Приветствие", text: "Здравствуйте!", group: "own" }, { label: "Документы", text: "Не хватает справки", group: "deal" }], templateGroups: { deal: "По сделке клиента" } });
    fireEvent.click(screen.getByLabelText("Шаблоны"));
    expect(screen.getByText("По сделке клиента")).toBeTruthy();
    fireEvent.click(screen.getByText("Документы"));
    expect((screen.getByLabelText("Текст сообщения") as HTMLTextAreaElement).value).toBe("Не хватает справки");
  });
});
