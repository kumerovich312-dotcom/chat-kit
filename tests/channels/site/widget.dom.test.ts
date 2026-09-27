// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRateLimiter, createSiteAdapter, handleSiteRequest, type SiteRequestOptions } from "../../../src/channels/site/index.js";
import type { ChatMessage } from "../../../src/core/model.js";
import { createMemoryStore } from "../../../src/server/index.js";
import {
  inkFor, mountChatWidget, WIDGET_THEME, widgetOptionsFromScript, type ChatWidget, type ChatWidgetOptions,
} from "../../../src/widget/chat-widget.js";
import { bytes } from "../../helpers/fake-net.js";

// Виджет чата на сайте в jsdom. Сервер — настоящий handleSiteRequest на переходнике «в памяти»: fetch виджета
// передаёт ему запрос как есть (с потерей ответа или обрывом связи — по желанию проверки). Всё вымышленное.

const SECRET = "test-secret-not-real-site-widget";
const ENDPOINT = "http://localhost:3000/api/site-chat";
const KEY = `ck-chat:${ENDPOINT}`;

type Call = { method: string; path: string; query: string; auth: string | null; body: Record<string, any> | null };

const later = (sec: number) => new Date(Date.now() + sec * 1000).toISOString();

function backend(extra: Partial<SiteRequestOptions> = {}) {
  const store = createMemoryStore();
  const calls: Call[] = [];
  const net = { down: false, loseMessageReplies: 0 };
  const opts: SiteRequestOptions = {
    secret: SECRET, store, limiter: createRateLimiter(),
    history: async (contactId: string, afterId: string | null): Promise<ChatMessage[]> => {
      const all = store.thread(contactId);
      const i = afterId ? all.findIndex((m) => m.id === afterId) : -1;
      return i >= 0 ? all.slice(i + 1) : all;
    },
    fileUrl: (att) => `https://crm.test/files/${att.id}?sig=test`,
    ...extra,
  };
  const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ method, path: url.pathname.split("/").pop() ?? "", query: url.search, auth: headers.get("authorization"), body: body ? JSON.parse(body) : null });
    if (net.down) throw new TypeError("Failed to fetch");
    const res = await handleSiteRequest(new Request(url.href, { method, headers, ...(body !== undefined ? { body } : {}) }), opts);
    // Сервер записал, а ответ до браузера не дошёл
    if (url.pathname.endsWith("/message") && net.loseMessageReplies > 0) {
      net.loseMessageReplies--;
      throw new TypeError("Failed to fetch");
    }
    return res;
  }) as typeof fetch;
  return { store, calls, net, fetch: fetchFn };
}

const mounted: ChatWidget[] = [];

function mount(o: Partial<ChatWidgetOptions> & { fetch: typeof fetch }) {
  const w = mountChatWidget({ endpoint: ENDPOINT, pollOpenMs: 60_000, pollClosedMs: 60_000, ...o });
  mounted.push(w);
  const $ = <T extends Element = HTMLElement>(sel: string) => w.root.querySelector<T>(sel);
  const ta = () => $<HTMLTextAreaElement>("textarea")!;
  const type = (text: string) => {
    ta().value = text;
    ta().dispatchEvent(new Event("input", { bubbles: true }));
  };
  const enter = (extra: KeyboardEventInit = {}) => ta().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...extra }));
  const say = (text: string) => {
    type(text);
    enter();
  };
  const serverMessages = () => [...w.root.querySelectorAll<HTMLElement>(".ckw-msg[data-id]")];
  return { w, root: w.root, $, ta, type, enter, say, serverMessages };
}

function choose(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new Event("change"));
}

afterEach(() => {
  for (const w of mounted.splice(0)) w.destroy();
  localStorage.clear();
  sessionStorage.clear();
  vi.useRealTimers();
  delete (document as { visibilityState?: unknown }).visibilityState;
});

describe("виджет: окно", () => {
  it("кнопка чата открывает панель: заголовок, «онлайн», приветствие, фокус в поле; Escape — свернуть, фокус на кнопку; сеть не трогаем", () => {
    const b = backend();
    const { w, $ } = mount({ fetch: b.fetch, title: "Магазин «Пример»", greeting: "Здравствуйте! Чем помочь?" });
    expect(document.querySelector("ck-chat-widget")).toBe(w.host);
    const launcher = $<HTMLButtonElement>(".ckw-launcher")!;
    const panel = $(".ckw-panel")!;
    expect(launcher.getAttribute("aria-expanded")).toBe("false");
    expect(panel.hidden).toBe(true);

    launcher.click();
    expect(panel.hidden).toBe(false);
    expect(launcher.getAttribute("aria-expanded")).toBe("true");
    expect(panel.getAttribute("role")).toBe("dialog");
    expect($(".ckw-title")!.textContent).toBe("Магазин «Пример»");
    expect($(".ckw-status")!.textContent).toBe("онлайн");
    expect($(".ckw-greeting")!.textContent).toBe("Здравствуйте! Чем помочь?");
    expect(w.root.activeElement).toBe($("textarea"));

    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel.hidden).toBe(true);
    expect(w.root.activeElement).toBe(launcher);
    expect(b.calls).toEqual([]);
  });

  it("внешний вид — переменными: цвет, светлому цвету — тёмный текст, своя тема, сторона; все значения темы есть в стилях", () => {
    expect(inkFor("#a3e635")).toBe("#111827");
    expect(inkFor("#2563eb")).toBe("#ffffff");
    expect(inkFor("#fff")).toBe("#111827");
    expect(inkFor("red")).toBe("#ffffff");
    const { w, $ } = mount({ fetch: backend().fetch, color: "#a3e635", theme: { radius: "8px" }, position: "left" });
    expect(w.host.style.getPropertyValue("--ckw-accent")).toBe("#a3e635");
    expect(w.host.style.getPropertyValue("--ckw-accent-ink")).toBe("#111827");
    expect(w.host.style.getPropertyValue("--ckw-radius")).toBe("8px");
    expect($(".ckw")!.getAttribute("data-position")).toBe("left");
    const css = $("style")!.textContent ?? "";
    for (const k of Object.keys(WIDGET_THEME)) expect(css).toContain(`--ckw-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:`);
    expect(css).toContain("@media (max-width: 480px)");
  });

  it("тег <script type=module data-endpoint> на сайте — виджет ставится сам по атрибутам, один раз", async () => {
    const s = document.createElement("script");
    s.type = "module";
    s.src = "https://crm.test/chat-widget.js";
    Object.assign(s.dataset, { endpoint: "/api/site-chat", title: "Напишите нам", position: "left", color: "#16a34a" });
    document.head.append(s);
    vi.resetModules();
    await import("../../../src/widget/chat-widget.js");
    await import("../../../src/widget/chat-widget.js");
    const hosts = document.querySelectorAll("ck-chat-widget");
    expect(hosts).toHaveLength(1);
    const host = hosts[0] as HTMLElement;
    expect(s.dataset.ckMounted).toBe("1");
    expect(host.shadowRoot?.querySelector(".ckw-title")?.textContent).toBe("Напишите нам");
    expect(host.shadowRoot?.querySelector(".ckw")?.getAttribute("data-position")).toBe("left");
    expect(host.style.getPropertyValue("--ckw-accent")).toBe("#16a34a");
    host.remove();
    s.remove();
  });

  it("настройки из тега <script>: адрес — от адреса скрипта, цвет, приветствие, сторона, форма", () => {
    const s = document.createElement("script");
    s.src = "https://crm.test/static/chat-widget.js";
    Object.assign(s.dataset, { endpoint: "/api/site-chat", title: "Напишите нам", color: "#16a34a", position: "left", greeting: "", prechat: "name,email", prechatRequired: "true" });
    expect(widgetOptionsFromScript(s)).toEqual({
      endpoint: "https://crm.test/api/site-chat", title: "Напишите нам", greeting: "", color: "#16a34a", position: "left",
      preChat: { fields: ["name", "email"], required: true },
    });
    const t = document.createElement("script");
    Object.assign(t.dataset, { endpoint: "https://crm.test/api/site-chat", prechat: "true", open: "true" });
    expect(widgetOptionsFromScript(t)).toEqual({ endpoint: "https://crm.test/api/site-chat", position: "right", preChat: { required: false }, open: true });
  });
});

describe("виджет: переписка", () => {
  it("Enter — сообщение сразу с «отправляется…», сервер получил start и message с ключом; своё с сервера заменяет его; ответ менеджера — с именем и ссылкой", async () => {
    const b = backend({ showAgentNames: true });
    const { w, root, ta, say, serverMessages } = mount({ fetch: b.fetch });
    w.open();
    say("Здравствуйте! Есть доставка?");
    expect(ta().value).toBe("");
    expect(root.querySelector(".ckw-msg--sending .ckw-text")?.textContent).toBe("Здравствуйте! Есть доставка?");
    expect(root.querySelector(".ckw-msg--sending .ckw-meta")?.textContent).toBe("Сообщение отправляется…");

    await vi.waitFor(() => expect(serverMessages()).toHaveLength(1));
    expect(root.querySelectorAll("[data-local]")).toHaveLength(0);
    expect(serverMessages()[0]?.classList.contains("ckw-msg--visitor")).toBe(true);
    expect(b.calls.map((c) => c.path)).toEqual(["start", "message", "messages"]);
    expect(b.calls[0]?.auth).toBeNull();
    expect(b.calls[1]?.auth).toMatch(/^Bearer v_[\w-]+\.[\w-]+$/);
    expect(b.calls[1]?.body).toMatchObject({ text: "Здравствуйте! Есть доставка?", clientMsgId: expect.stringMatching(/^m[0-9a-z]{24}$/), page: { url: "http://localhost:3000/" } });
    expect(b.store.thread("1").map((m) => [m.kind, m.text])).toEqual([
      ["system", "Чат на сайте: страница http://localhost:3000/"],
      ["message", "Здравствуйте! Есть доставка?"],
    ]);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "{}")).toMatchObject({ engaged: true, visitorId: expect.stringMatching(/^v_/) });

    await b.store.saveMessage("1", { kind: "message", author: { type: "operator_crm", name: "Айгерим Тестова" }, channel: "site", text: "Да! Подробнее: https://shop.test/delivery.", at: later(2), delivery: "sent" });
    await w.refresh();
    expect(b.calls.at(-1)).toMatchObject({ path: "messages", query: `?after=${serverMessages()[0]?.dataset.id}` });
    const reply = root.querySelector<HTMLElement>(".ckw-msg--company[data-id]")!;
    expect(reply.querySelector(".ckw-text")?.textContent).toBe("Да! Подробнее: https://shop.test/delivery.");
    const a = reply.querySelector("a")!;
    expect([a.getAttribute("href"), a.textContent, a.target, a.rel]).toEqual(["https://shop.test/delivery", "https://shop.test/delivery", "_blank", "noopener noreferrer"]);
    expect(reply.querySelector(".ckw-meta")?.textContent).toMatch(/^Айгерим · \d\d:\d\d$/);
  });

  it("Shift+Enter — новая строка, не отправка; пустое не отправляется", async () => {
    const b = backend();
    const { w, root, type, enter, $ } = mount({ fetch: b.fetch });
    w.open();
    expect($<HTMLButtonElement>(".ckw-send")!.disabled).toBe(true);
    type("первая строка");
    expect($<HTMLButtonElement>(".ckw-send")!.disabled).toBe(false);
    enter({ shiftKey: true });
    type("   ");
    enter();
    expect(b.calls).toEqual([]);
    expect(root.querySelectorAll("[data-local]")).toHaveLength(0);
  });

  it("XSS: <img onerror> и <script> в ответе и в своём сообщении остаются текстом; javascript:-ссылок нет", async () => {
    const b = backend();
    const { w, root, say, serverMessages } = mount({ fetch: b.fetch });
    w.open();
    say('<img src=x onerror="alert(1)">');
    await vi.waitFor(() => expect(serverMessages()).toHaveLength(1));
    await b.store.saveMessage("1", {
      kind: "message", author: { type: "operator_crm" }, channel: "site", at: later(1),
      text: '<img src=x onerror="alert(2)"><script>alert(3)</script> [жми](javascript:alert(4)) javascript:alert(5) https://shop.test/ok',
    });
    await w.refresh();
    expect(serverMessages()).toHaveLength(2);
    expect(root.querySelector("img, script, iframe")).toBeNull();
    expect(serverMessages()[0]?.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(serverMessages()[1]?.textContent).toContain('<img src=x onerror="alert(2)"><script>alert(3)</script>');
    const links = [...root.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toEqual(["https://shop.test/ok"]);
  });

  it("обрыв связи: «Не отправилось. Повторить»; повтор — тем же номером сообщения, без дубля в CRM", async () => {
    const b = backend();
    const { w, root, say, serverMessages } = mount({ fetch: b.fetch });
    w.open();
    b.net.loseMessageReplies = 1;
    say("Можно оплатить картой?");
    await vi.waitFor(() => expect(root.querySelector(".ckw-msg--failed")).not.toBeNull());
    expect(root.querySelector(".ckw-msg--failed .ckw-meta")?.textContent).toBe("Не отправилось. Повторить");
    root.querySelector<HTMLButtonElement>(".ckw-retry")!.click();
    await vi.waitFor(() => expect(serverMessages()).toHaveLength(1));
    expect(root.querySelector(".ckw-msg--failed, .ckw-msg--sending")).toBeNull();
    const posts = b.calls.filter((c) => c.path === "message");
    expect(posts).toHaveLength(2);
    expect(posts[0]?.body?.clientMsgId).toBe(posts[1]?.body?.clientMsgId);
    expect(b.store.thread("1").filter((m) => m.kind === "message").map((m) => m.text)).toEqual(["Можно оплатить картой?"]);
  });

  it("нет связи совсем — «Не отправилось», после связи повтор проходит", async () => {
    const b = backend();
    const { w, root, say, serverMessages } = mount({ fetch: b.fetch });
    w.open();
    b.net.down = true;
    say("Алло?");
    await vi.waitFor(() => expect(root.querySelector(".ckw-msg--failed")).not.toBeNull());
    b.net.down = false;
    root.querySelector<HTMLButtonElement>(".ckw-retry")!.click();
    await vi.waitFor(() => expect(serverMessages()).toHaveLength(1));
    expect(b.store.thread("1").filter((m) => m.kind === "message")).toHaveLength(1);
  });

  it("localStorage закрыт браузером — виджет работает, посетителя помнит в памяти страницы", async () => {
    const b = backend();
    const blocked = {
      getItem(): string | null { throw new Error("SecurityError"); },
      setItem(): void { throw new Error("SecurityError"); },
      removeItem(): void { throw new Error("SecurityError"); },
    };
    const { w, say, serverMessages } = mount({ fetch: b.fetch, storage: blocked });
    w.open();
    say("Первое");
    await vi.waitFor(() => expect(serverMessages()).toHaveLength(1));
    say("Второе");
    await vi.waitFor(() => expect(serverMessages()).toHaveLength(2));
    expect(b.calls.filter((c) => c.path === "start")).toHaveLength(1);
    expect(b.store.contacts.size).toBe(1);
  });
});

describe("виджет: значок, файлы, форма", () => {
  it("свёрнут — значок непрочитанных; открыли — значок пропал; после перезагрузки прочитанное не всплывает, переписка на месте", async () => {
    const b = backend();
    let m = mount({ fetch: b.fetch });
    m.w.open();
    m.say("Вопрос");
    await vi.waitFor(() => expect(m.serverMessages()).toHaveLength(1));
    m.w.close();
    for (const [i, text] of ["Здравствуйте!", "Сейчас посмотрю"].entries()) {
      await b.store.saveMessage("1", { kind: "message", author: { type: "operator_crm" }, channel: "site", text, at: later(i + 1), delivery: "sent" });
    }
    await m.w.refresh();
    const badge = m.$(".ckw-badge")!;
    expect([badge.hidden, badge.textContent]).toEqual([false, "2"]);
    expect(m.$(".ckw-launcher")!.getAttribute("aria-label")).toBe("Открыть чат. Новых сообщений: 2");
    m.w.open();
    expect(badge.hidden).toBe(true);

    // «Перезагрузка страницы»: тот же посетитель из localStorage, переписка — с сервера
    m.w.destroy();
    m = mount({ fetch: b.fetch });
    await m.w.refresh();
    expect(m.serverMessages().map((x) => x.querySelector(".ckw-text")?.textContent)).toEqual(["Вопрос", "Здравствуйте!", "Сейчас посмотрю"]);
    expect(m.$(".ckw-badge")!.hidden).toBe(true);
    expect(b.calls.filter((c) => c.path === "start")).toHaveLength(1);
  });

  it("файл: скрепка → чип с именем; отправка base64; с сервера — картинкой по подписанной ссылке", async () => {
    const b = backend();
    const { w, root, $, enter, serverMessages } = mount({ fetch: b.fetch });
    w.open();
    const png = bytes.png();
    choose($<HTMLInputElement>(".ckw-file-input")!, new File([png], "photo.png", { type: "image/png" }));
    await vi.waitFor(() => expect($(".ckw-chip")!.hidden).toBe(false));
    expect($(".ckw-chip-name")!.textContent).toBe("photo.png");
    enter();
    await vi.waitFor(() => expect(serverMessages()).toHaveLength(1));
    const post = b.calls.find((c) => c.path === "message");
    expect(post?.body?.file).toMatchObject({ name: "photo.png", mime: "image/png" });
    expect([...Buffer.from(String(post?.body?.file.data), "base64")]).toEqual([...png]);
    const img = root.querySelector<HTMLImageElement>(".ckw-msg--visitor .ckw-img")!;
    expect(img.getAttribute("src")).toBe("https://crm.test/files/f1?sig=test");
    expect(img.closest("a")?.getAttribute("rel")).toBe("noopener noreferrer");
    expect($(".ckw-chip")!.hidden).toBe(true);
  });

  it("файл больше 5 МБ и чужой тип — ошибка сразу, без отправки; сервер не принял файл — сообщение убрано, текст вернулся, причина под полем", async () => {
    const b = backend();
    const { w, $, ta, type, enter, root } = mount({ fetch: b.fetch });
    w.open();
    const input = $<HTMLInputElement>(".ckw-file-input")!;
    choose(input, new File([new Uint8Array(5 * 1024 * 1024 + 1)], "big.png", { type: "image/png" }));
    expect($(".ckw-error")!.textContent).toBe("Файл больше 5 МБ — выберите поменьше");
    choose(input, new File(["MZ"], "setup.exe", { type: "application/x-msdownload" }));
    expect($(".ckw-error")!.textContent).toBe("Такой файл не отправить: можно фото, PDF, Word, Excel или аудио");
    expect($(".ckw-chip")!.hidden).toBe(true);

    // По имени и типу — PDF, по содержимому — нет: сервер отвечает 415
    choose(input, new File(["это не PDF"], "счёт.pdf", { type: "application/pdf" }));
    await vi.waitFor(() => expect($(".ckw-chip")!.hidden).toBe(false));
    type("Вот счёт");
    enter();
    await vi.waitFor(() => expect($(".ckw-error")!.hidden).toBe(false));
    expect($(".ckw-error")!.textContent).toBe("Такой файл не принимаем: можно фото, PDF, Word, Excel или аудио");
    expect(root.querySelectorAll("[data-local]")).toHaveLength(0);
    expect(ta().value).toBe("Вот счёт");
    expect(b.store.thread("1").filter((m) => m.kind === "message")).toHaveLength(0);
  });

  it("форма перед чатом: обязательные имя и телефон или почта — ошибки у полей; верные данные — клиент в CRM сразу, дальше переписка", async () => {
    const b = backend();
    const { w, $, root } = mount({ fetch: b.fetch, preChat: { fields: ["name", "phone", "email"], required: true } });
    w.open();
    expect($(".ckw-form")!.hidden).toBe(false);
    expect($(".ckw-chat")!.hidden).toBe(true);
    expect(w.root.activeElement).toBe($("#ckw-f-name"));
    const submit = $<HTMLButtonElement>(".ckw-primary")!;
    const field = (name: string) => $<HTMLInputElement>(`#ckw-f-${name}`)!;
    const err = (name: string) => $(`#ckw-f-${name}-err`)!;

    submit.click();
    expect(err("name").textContent).toBe("Заполните это поле");
    expect(err("phone").textContent).toBe("Укажите телефон или почту");
    expect(field("name").getAttribute("aria-invalid")).toBe("true");
    expect(w.root.activeElement).toBe(field("name"));

    field("name").value = "Айгерим";
    field("phone").value = "12";
    submit.click();
    expect(err("name").hidden).toBe(true);
    expect(err("phone").textContent).toBe("Проверьте номер телефона");
    field("email").value = "не почта";
    submit.click();
    expect(err("email").textContent).toBe("Проверьте адрес почты");
    expect(b.calls).toEqual([]);

    field("phone").value = "+996 555 00-00-01";
    field("email").value = "";
    submit.click();
    await vi.waitFor(() => expect($(".ckw-chat")!.hidden).toBe(false));
    expect($(".ckw-form")!.hidden).toBe(true);
    expect(b.calls[0]).toMatchObject({ path: "start", body: { profile: { name: "Айгерим", phone: "+996 555 00-00-01" }, page: { url: "http://localhost:3000/" } } });
    expect(b.store.contacts.get("1")).toMatchObject({ name: "Айгерим", phone: "+996555000001", channel: "site" });
    expect(b.store.thread("1")[0]?.text).toBe("Чат на сайте: страница http://localhost:3000/ · представился: Айгерим, +996 555 00-00-01");
    expect(root.activeElement).toBe($("textarea"));
  });

  it("необязательную форму можно пропустить — без запросов к серверу, форма больше не спрашивается", () => {
    const b = backend();
    const { w, $ } = mount({ fetch: b.fetch, preChat: true });
    w.open();
    expect([...w.root.querySelectorAll(".ckw-field")].map((x) => x.id)).toEqual(["ckw-f-name", "ckw-f-phone"]);
    $<HTMLButtonElement>(".ckw-primary")!.click();
    expect($(".ckw-chat")!.hidden).toBe(false);
    expect(b.calls).toEqual([]);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "{}")).toMatchObject({ introDone: true });
  });
});

describe("виджет: опрос", () => {
  function stub() {
    const urls: string[] = [];
    const net = { down: false };
    const fetchFn = (async (input: Parameters<typeof fetch>[0]) => {
      urls.push(String(input));
      if (net.down) throw new TypeError("Failed to fetch");
      // Ответ без потоков — только обещания: часы поддельные, всё должно успевать между шагами
      return { ok: true, status: 200, json: async () => ({ ok: true, messages: [] }) } as unknown as Response;
    }) as typeof fetch;
    return { urls, net, fetch: fetchFn, polls: () => urls.filter((u) => u.includes("/messages")).length };
  }

  function engaged() {
    const { visitorId, token } = createSiteAdapter({ secret: SECRET }).issue();
    localStorage.setItem(KEY, JSON.stringify({ visitorId, token, engaged: true, introDone: true }));
  }

  it("свёрнут — раз в 20 с, открыт — раз в 3 с, вкладка скрыта — не спрашиваем, вернулись — сразу", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    engaged();
    const s = stub();
    const { w } = mount({ fetch: s.fetch, pollOpenMs: 3000, pollClosedMs: 20_000 });
    await vi.advanceTimersByTimeAsync(800);
    expect(s.polls()).toBe(1);
    await vi.advanceTimersByTimeAsync(19_000);
    expect(s.polls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.polls()).toBe(2);

    w.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.polls()).toBe(3);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(s.polls()).toBe(4);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(s.polls()).toBe(5);

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.polls()).toBe(5);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(s.polls()).toBe(6);
  });

  it("сбой связи — спрашиваем всё реже и показываем «Нет связи»; связь вернулась — снова раз в 3 с", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    engaged();
    const s = stub();
    const { w, $ } = mount({ fetch: s.fetch, pollOpenMs: 3000, pollClosedMs: 20_000, open: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.polls()).toBe(1);
    s.net.down = true;
    await vi.advanceTimersByTimeAsync(3_000); // сбой 1 → следующий через 6 с
    expect(s.polls()).toBe(2);
    expect($(".ckw-net")!.hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.polls()).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000); // сбой 2 → «Нет связи», следующий через 12 с
    expect(s.polls()).toBe(3);
    expect($(".ckw-net")!.hidden).toBe(false);
    s.net.down = false;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(s.polls()).toBe(4);
    expect($(".ckw-net")!.hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(s.polls()).toBe(5);
    expect(w.host.isConnected).toBe(true);
  });

  it("ключ больше не подходит (401, сменили секрет) — посетитель забыт, опрос остановлен; следующее сообщение — новым посетителем", async () => {
    const { visitorId } = createSiteAdapter({ secret: SECRET }).issue();
    localStorage.setItem(KEY, JSON.stringify({ visitorId, token: "A".repeat(43), engaged: true, introDone: true }));
    const b = backend();
    const { w, say, serverMessages } = mount({ fetch: b.fetch });
    await w.refresh();
    expect(b.calls).toMatchObject([{ path: "messages", auth: `Bearer ${visitorId}.${"A".repeat(43)}` }]);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "{}")).toEqual({ introDone: true });
    await w.refresh();
    expect(b.calls).toHaveLength(1);

    w.open();
    say("Я снова здесь");
    await vi.waitFor(() => expect(serverMessages()).toHaveLength(1));
    expect(b.calls.map((c) => c.path)).toEqual(["messages", "start", "message", "messages"]);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "{}").visitorId).not.toBe(visitorId);
  });

  it("чат начат в другой вкладке — эта подхватывает посетителя (событие storage) и спрашивает ответы его ключом", async () => {
    const b = backend();
    const { w } = mount({ fetch: b.fetch });
    await w.refresh();
    expect(b.calls).toEqual([]);
    const { visitorId, token } = createSiteAdapter({ secret: SECRET }).issue();
    localStorage.setItem(KEY, JSON.stringify({ visitorId, token, engaged: true, introDone: true }));
    window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
    await vi.waitFor(() => expect(b.calls).toHaveLength(1));
    expect(b.calls[0]).toMatchObject({ path: "messages", auth: `Bearer ${visitorId}.${token}` });
  });

  it("испорченные номер или ключ в памяти браузера — не отправляем их, начинаем заново", async () => {
    localStorage.setItem(KEY, JSON.stringify({ visitorId: "v_<script>", token: "не-тот-ключ", engaged: true }));
    const b = backend();
    const { w } = mount({ fetch: b.fetch });
    await w.refresh();
    expect(b.calls).toEqual([]);
  });
});
