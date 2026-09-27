import { mountChatWidget, type ChatWidget, type ChatWidgetOptions } from "../../src/widget/chat-widget.js";

// Проверка виджета чата на сайте: «сайт компании», виджет в углу и пульт (цвет, сторона, форма перед чатом, ответ
// менеджера). Сервер ненастоящий — в браузере (и в localStorage, чтобы переживал перезагрузку), отвечает как
// handleSiteRequest набора: start / message / messages. Имена и данные — вымышленные.

type Attachment = { name: string; mime: string; url: string; size?: number };
type Row = {
  id: string;
  at: string;
  kind: "message" | "system";
  from: "visitor" | "company";
  text: string;
  author: string | null;
  clientMsgId: string | null;
  attachment: Attachment | null;
};
type Visitor = { token: string; rows: Row[]; greeted: boolean; intro: boolean };
type Db = { seq: number; current: string | null; visitors: Record<string, Visitor> };

const ENDPOINT = "/api/site-chat";
const DB_KEY = "ck-widget-demo:db";
const MANAGER = "Айгерим";
const COLORS: [string, string][] = [
  ["#2563eb", "синий"], ["#16a34a", "зелёный"], ["#a3e635", "лаймовый"], ["#1f2937", "графит"], ["#7c3aed", "фиолетовый"],
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/* ── Ненастоящий сервер ─────────────────────────────────────────────────────────────────────────────────────── */

function loadDb(): Db {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(DB_KEY) ?? "null");
    if (v && typeof v === "object" && "visitors" in v) return v as Db;
  } catch { /* начнём заново */ }
  return { seq: 0, current: null, visitors: {} };
}

let db = loadDb();
const server = { online: true };

function saveDb() {
  try {
    localStorage.setItem(DB_KEY, JSON.stringify(db));
  } catch { /* не страшно */ }
  renderFeed();
}

/** Случайная строка base64url — как номера и ключи настоящего сервера */
function rand(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function addRow(v: Visitor, r: Omit<Row, "id" | "at">) {
  v.rows.push({ ...r, id: String(++db.seq), at: new Date().toISOString() });
}

type Page = { url?: string; referrer?: string; landing?: string } | null | undefined;
type Profile = { name?: string; phone?: string; email?: string } | null | undefined;

/** Строка «откуда пришёл и как представился» — один раз, как у настоящего сервера */
function intro(v: Visitor, page: Page, p: Profile) {
  if (v.intro) return;
  v.intro = true;
  const parts: string[] = [];
  if (page?.url) parts.push(`страница ${page.url.split("?")[0]}`);
  if (page?.referrer) {
    try {
      parts.push(`пришёл с ${new URL(page.referrer).host.replace(/^www\./, "")}`);
    } catch { /* нет */ }
  }
  try {
    const utm = [...new URL(page?.landing || page?.url || location.href).searchParams].filter(([k]) => k.startsWith("utm_"));
    if (utm.length) parts.push(`метки: ${utm.map(([k, x]) => `${k}=${x}`).join(", ")}`);
  } catch { /* нет */ }
  const who = [p?.name, p?.phone, p?.email].filter((x): x is string => !!x);
  if (who.length) parts.push(`представился: ${who.join(", ")}`);
  addRow(v, { kind: "system", from: "company", text: `Чат на сайте: ${parts.join(" · ") || "начат"}`, author: null, clientMsgId: null, attachment: null });
}

/** «Менеджер» отвечает сам через 2,5 секунды после первого сообщения посетителя */
function autoReply(id: string) {
  const v = db.visitors[id];
  if (!v || v.greeted) return;
  v.greeted = true;
  setTimeout(() => {
    const x = db.visitors[id];
    if (!x) return;
    addRow(x, { kind: "message", from: "company", text: `Здравствуйте! Я ${MANAGER}, менеджер. Сейчас посмотрю и отвечу здесь же.`, author: MANAGER, clientMsgId: null, attachment: null });
    saveDb();
  }, 2500);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

const fakeFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  const action = url.pathname.split("/").pop() ?? "";
  const method = init?.method ?? "GET";
  const m = /^Bearer (v_[\w-]+)\.([\w-]+)$/.exec(new Headers(init?.headers).get("authorization") ?? "");
  const vid = m?.[1] && m[2] && db.visitors[m[1]]?.token === m[2] ? m[1] : null;
  let body: Record<string, unknown> = {};
  try {
    body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  } catch {
    return json(400, { ok: false, error: "Тело запроса должно быть JSON" });
  }
  await sleep(method === "POST" ? 400 : 150);
  const online = { online: server.online };

  if (method === "POST" && action === "start") {
    let id = vid;
    if (!id) {
      id = `v_${rand(16)}`;
      db.visitors[id] = { token: rand(32), rows: [], greeted: false, intro: false };
    }
    const v = db.visitors[id]!;
    db.current = id;
    const p = body.profile as Profile;
    if (p && (p.name || p.phone || p.email)) intro(v, body.page as Page, p);
    saveDb();
    return json(200, { ok: true, visitorId: id, token: v.token, resumed: !!vid, ...online });
  }
  if (!vid) return json(401, { ok: false, error: "Нет доступа — начните чат заново" });
  const v = db.visitors[vid]!;
  if (db.current !== vid) {
    db.current = vid;
    renderFeed();
  }

  if (method === "POST" && action === "message") {
    const cmid = typeof body.clientMsgId === "string" ? body.clientMsgId : "";
    if (v.rows.some((r) => r.clientMsgId === cmid)) return json(200, { ok: true, duplicate: true });
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (text.length > 4000) return json(422, { ok: false, error: "Сообщение длиннее 4000 знаков — разделите его на несколько", field: "text" });
    if (body.page) intro(v, body.page as Page, null);
    if (text) addRow(v, { kind: "message", from: "visitor", text, author: null, clientMsgId: cmid, attachment: null });
    const file = body.file as { name?: string } | undefined;
    // Настоящий сервер сохранит файл и отдаст ссылку на него; здесь хранить его негде — посетитель увидит имя файла
    if (file) addRow(v, { kind: "message", from: "visitor", text: file.name || "Файл", author: null, clientMsgId: cmid, attachment: null });
    saveDb();
    autoReply(vid);
    return json(200, { ok: true, duplicate: false });
  }

  if (method === "GET" && action === "messages") {
    const after = url.searchParams.get("after");
    const visible = v.rows.filter((r) => r.kind === "message");
    const i = after ? visible.findIndex((r) => r.id === after) : -1;
    const messages = (i >= 0 ? visible.slice(i + 1) : visible).map((r) => ({
      id: r.id, at: r.at, from: r.from, text: r.text, author: r.author, clientMsgId: r.clientMsgId, attachment: r.attachment,
    }));
    return json(200, { ok: true, messages, ...online });
  }
  return json(404, { ok: false, error: "Нет такого действия" });
};

/* ── Виджет и пульт ─────────────────────────────────────────────────────────────────────────────────────────── */

const settings = { color: COLORS[0]![0], position: "right" as "right" | "left", preChat: "off" as "off" | "optional" | "required" };
let widget: ChatWidget | null = null;

function mount(open: boolean) {
  widget?.destroy();
  const preChat: ChatWidgetOptions["preChat"] = settings.preChat === "off" ? false
    : settings.preChat === "optional" ? { fields: ["name", "phone"] }
    : { fields: ["name", "phone", "email"], required: true };
  widget = mountChatWidget({
    endpoint: ENDPOINT, fetch: fakeFetch, title: "Компания «Пример»", greeting: "Здравствуйте! Напишите ваш вопрос — ответим здесь же.",
    color: settings.color, position: settings.position, preChat, open,
  });
}

function renderFeed() {
  const feed = $<HTMLOListElement>("feed");
  const v = db.current ? db.visitors[db.current] : undefined;
  const items = (v?.rows ?? []).map((r) => {
    const li = document.createElement("li");
    li.className = r.kind === "system" ? "system" : r.from;
    if (r.kind !== "system") {
      const who = document.createElement("span");
      who.className = "who";
      who.textContent = r.from === "visitor" ? "Посетитель:" : `${r.author ?? "Компания"}:`;
      li.append(who);
    }
    li.append(r.text || (r.attachment ? `[${r.attachment.name}]` : ""));
    if (r.text && r.attachment) li.append(` [${r.attachment.name}]`);
    return li;
  });
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Пока пусто: напишите в чат в углу экрана.";
    items.push(li);
  }
  feed.replaceChildren(...items);
  feed.scrollTop = feed.scrollHeight;
}

function flash(text: string) {
  $("flash").textContent = text;
  setTimeout(() => { if ($("flash").textContent === text) $("flash").textContent = ""; }, 4000);
}

/** Ответ «из CRM»: в базу — и виджет заберёт его опросом (здесь — сразу) */
function reply(r: { text: string; attachment?: Attachment | null }) {
  const v = db.current ? db.visitors[db.current] : undefined;
  if (!v) return flash("Сначала напишите в чат как посетитель — тогда появится диалог.");
  addRow(v, { kind: "message", from: "company", author: MANAGER, clientMsgId: null, text: r.text, attachment: r.attachment ?? null });
  saveDb();
  void widget?.refresh();
}

const QUICK: Record<string, { text: string; attachment: Attachment | null }> = {
  photo: { text: "", attachment: { name: "Прайс", mime: "image/svg+xml", url: "/photos/screenshot.svg" } },
  file: { text: "Прайс-лист — во вложении", attachment: { name: "Прайс-лист.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", url: "/files/price.xlsx" } },
  voice: { text: "", attachment: { name: "Голосовое сообщение", mime: "audio/wav", url: "/files/voice-1.wav" } },
  link: { text: "Условия доставки и оплаты: https://example.com/delivery", attachment: null },
};

for (const [color, name] of COLORS) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "swatch";
  b.style.background = color;
  b.title = name;
  b.setAttribute("aria-label", `Цвет: ${name}`);
  b.setAttribute("aria-pressed", String(color === settings.color));
  b.addEventListener("click", () => {
    settings.color = color;
    for (const x of $("colors").querySelectorAll("button")) x.setAttribute("aria-pressed", String(x === b));
    mount(true);
  });
  $("colors").append(b);
}
$<HTMLSelectElement>("position").addEventListener("change", (e) => {
  settings.position = (e.target as HTMLSelectElement).value === "left" ? "left" : "right";
  mount(true);
});
$<HTMLSelectElement>("prechat").addEventListener("change", (e) => {
  const v = (e.target as HTMLSelectElement).value;
  settings.preChat = v === "optional" || v === "required" ? v : "off";
  mount(true);
});
$<HTMLInputElement>("online").addEventListener("change", (e) => {
  server.online = (e.target as HTMLInputElement).checked;
  void widget?.refresh();
});
$("reset").addEventListener("click", () => {
  // Виджет помнит посетителя в localStorage по адресу чата — забываем его и первую страницу посещения
  localStorage.removeItem(`ck-chat:${new URL(ENDPOINT, location.href).href}`);
  sessionStorage.removeItem("ck-chat:landing");
  db = { seq: db.seq, current: null, visitors: {} };
  saveDb();
  mount(true);
});
$("send-reply").addEventListener("click", () => {
  const box = $<HTMLTextAreaElement>("reply");
  const text = box.value.trim();
  if (!text) return;
  box.value = "";
  reply({ text });
});
for (const b of document.querySelectorAll<HTMLButtonElement>("[data-quick]")) {
  b.addEventListener("click", () => {
    const q = QUICK[b.dataset.quick ?? ""];
    if (q) reply(q);
  });
}

renderFeed();
mount(false);
