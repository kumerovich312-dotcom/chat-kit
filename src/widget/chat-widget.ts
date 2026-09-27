/* Чат на сайте — виджет для сайта компании. Один файл без зависимостей и без импортов: проект отдаёт собранный
   dist/widget/chat-widget.js как есть и ставит на сайт одной строкой:
     <script type="module" src="https://crm.example/chat-widget.js" data-endpoint="https://crm.example/api/site-chat"
       data-title="Напишите нам" data-color="#2563eb" data-greeting="Здравствуйте! Чем помочь?" data-position="right"></script>
   или зовёт mountChatWidget({ endpoint, … }) сам (свой сайт на React, проверка).

   Окно живёт в Shadow DOM: стили сайта его не ломают, его стили не трогают сайт. Внешний вид — переменные --ckw-*, все
   значения собраны в WIDGET_THEME: проект меняет их через options.theme (или data-color), сайт — своим CSS у элемента
   <ck-chat-widget>. Слова — WIDGET_TEXTS, меняются через options.texts.

   Сервер — handleSiteRequest набора (src/channels/site): start — номер посетителя и ключ (помним в localStorage),
   message — сообщение (текст, файл base64), messages?after= — новые сообщения. Опрос: раз в 3 с, пока чат открыт, раз
   в 20 с, пока свёрнут (для значка непрочитанных); вкладка скрыта — не спрашиваем; сбой связи — всё реже.
   Безопасность: текст посетителя и ответы компании вставляются только как текст (textContent), ссылки — отдельными
   элементами (только http и https, rel="noopener noreferrer"). */

/* ── Внешний вид: все значения — здесь ─────────────────────────────────────────────────────────────────────── */

export type ChatWidgetTheme = {
  /** Главный цвет: круглая кнопка, шапка, пузырь посетителя, «Отправить» */
  accent: string;
  /** Текст и значки на главном цвете. Задан только цвет (color) — подбирается сам: белый или почти чёрный */
  accentInk: string;
  /** Фон панели, формы и поля ввода */
  background: string;
  /** Фон ленты сообщений */
  surface: string;
  /** Основной текст */
  text: string;
  /** Время, подписи, подсказки */
  muted: string;
  /** Линии и рамки */
  border: string;
  /** Пузырь ответа компании и текст в нём */
  companyBubble: string;
  companyInk: string;
  /** Пузырь посетителя и текст в нём (по умолчанию — главный цвет) */
  visitorBubble: string;
  visitorInk: string;
  /** Ссылки в ответах компании — свой цвет: светлый главный цвет (лайм) плохо читается текстом */
  link: string;
  /** Ошибки, «не отправилось» */
  danger: string;
  /** Полоса «нет связи» */
  notice: string;
  noticeInk: string;
  /** Значок непрочитанных на кнопке */
  badge: string;
  badgeInk: string;
  /** Точка «онлайн» */
  online: string;
  /** Шрифт и размер текста */
  font: string;
  fontSize: string;
  /** Скругление панели и пузырей */
  radius: string;
  bubbleRadius: string;
  /** Круглая кнопка чата */
  launcherSize: string;
  /** Панель на компьютере; на экране уже 480 px — во весь экран */
  panelWidth: string;
  panelHeight: string;
  /** Отступ кнопки и панели от края окна */
  offset: string;
  shadow: string;
  /** Поверх всего на сайте */
  zIndex: string;
};

export const WIDGET_THEME: Readonly<ChatWidgetTheme> = Object.freeze({
  accent: "#2563eb",
  accentInk: "#ffffff",
  background: "#ffffff",
  surface: "#f5f6f8",
  text: "#161a22",
  muted: "#697386",
  border: "#e3e6eb",
  companyBubble: "#ffffff",
  companyInk: "#161a22",
  visitorBubble: "var(--ckw-accent)",
  visitorInk: "var(--ckw-accent-ink)",
  link: "#1d4ed8",
  danger: "#d92d20",
  notice: "#fff4e5",
  noticeInk: "#8a4b08",
  badge: "#ef4444",
  badgeInk: "#ffffff",
  online: "#22c55e",
  font: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  fontSize: "15px",
  radius: "18px",
  bubbleRadius: "16px",
  launcherSize: "60px",
  panelWidth: "380px",
  panelHeight: "600px",
  offset: "20px",
  shadow: "0 16px 48px rgba(16, 24, 40, 0.22)",
  zIndex: "2147483000",
});

/* ── Слова ─────────────────────────────────────────────────────────────────────────────────────────────────── */

export type ChatWidgetTexts = {
  title: string;
  online: string;
  offline: string;
  launcher: string;
  close: string;
  greeting: string;
  message: string;
  placeholder: string;
  send: string;
  attach: string;
  removeFile: string;
  sending: string;
  failed: string;
  retry: string;
  reconnecting: string;
  preChatIntro: string;
  name: string;
  phone: string;
  email: string;
  phonePlaceholder: string;
  emailPlaceholder: string;
  startChat: string;
  starting: string;
  required: string;
  contactRequired: string;
  badPhone: string;
  badEmail: string;
  fileTooBig: string;
  fileType: string;
  tooLong: string;
  unread: string;
  file: string;
  photo: string;
  error: string;
};

export const WIDGET_TEXTS: Readonly<ChatWidgetTexts> = Object.freeze({
  title: "Напишите нам",
  /** Под заголовком: на связи (или сервер об этом не говорит) и не на связи */
  online: "онлайн",
  offline: "ответим, как только сможем",
  launcher: "Открыть чат",
  close: "Свернуть чат",
  /** Первое сообщение от компании — только на экране, на сервер не уходит */
  greeting: "Здравствуйте! Напишите ваш вопрос — ответим здесь же.",
  message: "Сообщение",
  placeholder: "Напишите сообщение…",
  send: "Отправить",
  attach: "Прикрепить файл",
  removeFile: "Убрать файл",
  sending: "Сообщение отправляется…",
  failed: "Не отправилось.",
  retry: "Повторить",
  reconnecting: "Нет связи — пробуем снова…",
  preChatIntro: "Представьтесь, пожалуйста, — так мы сможем ответить, даже если вы уйдёте с сайта.",
  name: "Имя",
  phone: "Телефон",
  email: "Почта",
  phonePlaceholder: "",
  emailPlaceholder: "",
  startChat: "Начать чат",
  starting: "Подождите…",
  required: "Заполните это поле",
  contactRequired: "Укажите телефон или почту",
  badPhone: "Проверьте номер телефона",
  badEmail: "Проверьте адрес почты",
  fileTooBig: "Файл больше {mb} МБ — выберите поменьше",
  fileType: "Такой файл не отправить: можно фото, PDF, Word, Excel или аудио",
  tooLong: "Сообщение длиннее {max} знаков — разделите его",
  /** Для кнопки чата: «Открыть чат. Новых сообщений: 2» */
  unread: "Новых сообщений: {n}",
  file: "Файл",
  photo: "Фото",
  error: "Не получилось — попробуйте ещё раз",
});

/* ── Настройки ─────────────────────────────────────────────────────────────────────────────────────────────── */

export type ChatWidgetField = "name" | "phone" | "email";

export type ChatWidgetPreChat = {
  /** Какие поля спросить (по умолчанию имя и телефон) */
  fields?: readonly ChatWidgetField[] | undefined;
  /** Обязательно: имя и контакт (телефон или почта — хватит одного из показанных). Иначе форму можно пропустить */
  required?: boolean | undefined;
};

/** Где помнить посетителя (как localStorage) */
export type ChatWidgetStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type ChatWidgetOptions = {
  /** Адрес чата в проекте: «https://crm.example/api/site-chat» (относительный — от страницы) */
  endpoint: string;
  /** Заголовок панели */
  title?: string | undefined;
  /** Приветствие в начале переписки; "" или null — без приветствия */
  greeting?: string | null | undefined;
  /** Главный цвет — короче, чем theme.accent */
  color?: string | undefined;
  /** С какой стороны окна кнопка и панель */
  position?: "right" | "left" | undefined;
  /** Форма перед чатом; true — имя и телефон, по желанию */
  preChat?: ChatWidgetPreChat | boolean | null | undefined;
  texts?: Partial<ChatWidgetTexts> | undefined;
  theme?: Partial<ChatWidgetTheme> | undefined;
  /** Открыть панель сразу */
  open?: boolean | undefined;
  /** Куда поставить виджет (по умолчанию document.body) */
  container?: HTMLElement | undefined;
  /** Язык времени сообщений (по умолчанию ru-RU) */
  locale?: string | undefined;
  /** Самый большой файл (по умолчанию 5 МБ — как на сервере) */
  maxFileBytes?: number | undefined;
  /** Как часто спрашивать новые сообщения, мс: пока чат открыт (3000) и пока свёрнут (20000) */
  pollOpenMs?: number | undefined;
  pollClosedMs?: number | undefined;
  /** Свой fetch — для проверок */
  fetch?: typeof fetch | undefined;
  /** Где помнить посетителя (по умолчанию localStorage; null — только до перезагрузки страницы) */
  storage?: ChatWidgetStorage | null | undefined;
};

export type ChatWidget = {
  /** Элемент <ck-chat-widget> на странице */
  readonly host: HTMLElement;
  readonly root: ShadowRoot;
  open(): void;
  close(): void;
  toggle(): void;
  /** Спросить новые сообщения сейчас */
  refresh(): Promise<void>;
  /** Убрать виджет со страницы */
  destroy(): void;
};

/* ── Что отвечает сервер (тот же вид — SitePublicMessage в src/channels/site/public.ts, менять вместе) ─────── */

type PublicAttachment = { name: string; mime: string; url: string; size?: number | null | undefined };
type PublicMessage = {
  id: string;
  at: string;
  from: "visitor" | "company";
  text: string;
  author?: string | null | undefined;
  clientMsgId?: string | null | undefined;
  attachment?: PublicAttachment | null | undefined;
};

type Saved = {
  visitorId?: string | undefined;
  token?: string | undefined;
  /** Посетитель уже писал или представился — в CRM есть его диалог, можно спрашивать ответы */
  engaged?: boolean | undefined;
  /** Последний ответ компании, который посетитель видел, — значок непрочитанных после перезагрузки */
  seenId?: string | undefined;
  /** Форму перед чатом заполнили или пропустили */
  introDone?: boolean | undefined;
};

type PickedFile = { name: string; mime: string; size: number; data: string };
type LocalMessage = { key: string; text: string; file: PickedFile | null; state: "sending" | "sent" | "failed" };
type ApiResult = { ok: boolean; status: number; data: Record<string, unknown> };

/** Как на сервере: самое длинное сообщение и самый большой файл */
const MAX_TEXT = 4000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ACCEPT = [
  "image/*", "audio/*", "application/pdf", ".pdf", ".docx", ".xlsx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
].join(",");
const FILE_EXTS = ["jpg", "jpeg", "png", "gif", "webp", "heic", "pdf", "docx", "xlsx", "mp3", "m4a", "ogg", "oga", "opus", "wav", "amr"];
const PHONE_RE = /^\+?[\d\s().-]{5,30}$/;
const EMAIL_RE = /^[^\s@<>()[\]",;:]+@[^\s@<>()[\]",;:]+\.[^\s@<>()[\]",;:.]{2,}$/;
const URL_RE = /https?:\/\/[^\s<>"'«»]+/g;
/** Номер посетителя и ключ — как их выдаёт сервер (src/channels/site/token.ts) */
const VISITOR_RE = /^v_[A-Za-z0-9_-]{16,64}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;
const LANDING_KEY = "ck-chat:landing";

/* ── Мелочи ────────────────────────────────────────────────────────────────────────────────────────────────── */

type Attrs = Record<string, string | number | boolean | null | undefined>;
type Kid = Node | string | null | undefined | false;

/** Элемент с атрибутами и детьми; строки — всегда текстом (никакого HTML) */
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (k === "text") el.textContent = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const ICONS = {
  chat: ["M20 11.5a8 8 0 0 1-11.7 7.1L4 20l1.3-4.1A8 8 0 1 1 20 11.5z"],
  close: ["M18 6 6 18", "M6 6l12 12"],
  down: ["M6 9l6 6 6-6"],
  clip: ["M21 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9"],
  send: ["M4 12l16-8-6 16-2.5-6.5z", "M20 4 11.5 13.5"],
  file: ["M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z", "M14 3v5h5"],
} as const;

function icon(paths: readonly string[], size = 24, cls = ""): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  const set = (k: string, v: string) => svg.setAttribute(k, v);
  set("viewBox", "0 0 24 24");
  set("width", String(size));
  set("height", String(size));
  set("fill", "none");
  set("stroke", "currentColor");
  set("stroke-width", "2");
  set("stroke-linecap", "round");
  set("stroke-linejoin", "round");
  set("aria-hidden", "true");
  set("focusable", "false");
  if (cls) set("class", cls);
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

/** «{n} сообщений» → подставить значения */
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String(v[k]) : m));

const mbText = (bytes: number) => String(Math.round((bytes / 1024 / 1024) * 10) / 10).replace(".", ",");

/** «29 КБ», «1,4 МБ» */
function sizeText(bytes: number | null | undefined): string {
  if (!bytes || bytes < 0) return "";
  return bytes >= 1024 * 1024 ? `${mbText(bytes)} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

/** Адрес только http или https (относительный — от base); иначе null */
function safeUrl(raw: string, base?: string): string | null {
  try {
    const u = new URL(raw, base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/** Адрес без хвостовых знаков препинания: «смотрите https://site.kg/a.pdf.» — точка не часть адреса */
function trimUrl(raw: string): string {
  let s = raw;
  while (/[.,;:!?)\]}»]$/.test(s)) {
    if (s.endsWith(")") && (s.match(/\(/g)?.length ?? 0) >= (s.match(/\)/g)?.length ?? 0)) break;
    s = s.slice(0, -1);
  }
  return s;
}

/** Текст с нажимаемыми адресами — без HTML: куски текста и отдельные ссылки */
function linkify(el: HTMLElement, text: string): void {
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    const shown = trimUrl(m[0]);
    const href = safeUrl(shown);
    if (!href) continue;
    if (start > last) el.append(text.slice(last, start));
    el.append(h("a", { href, target: "_blank", rel: "noopener noreferrer", text: shown }));
    last = start + shown.length;
  }
  if (last < text.length) el.append(text.slice(last));
}

/** Адрес страницы для CRM: без параметров, кроме меток utm_* (в остальных бывают личные данные и ключи) */
function pageUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    const keep = new URLSearchParams();
    u.searchParams.forEach((v, k) => { if (/^utm_/i.test(k)) keep.append(k, v); });
    const q = keep.toString();
    return u.origin + u.pathname + (q ? `?${q}` : "");
  } catch {
    return "";
  }
}

/** Откуда пришли: только сайт и путь */
function refUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin + u.pathname : "";
  } catch {
    return "";
  }
}

/** Номер сообщения у виджета: по нему сервер не запишет повтор после обрыва связи */
function newKey(): string {
  const a = new Uint8Array(12);
  try {
    crypto.getRandomValues(a);
  } catch {
    for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
  }
  return `m${Array.from(a, (b) => b.toString(36).padStart(2, "0")).join("")}`;
}

/** Хранилище, которое не падает: закрыто браузером (приватный режим, запрет cookie) — помним в памяти страницы */
function safeStorage(s: ChatWidgetStorage | null): { get(k: string): string | null; set(k: string, v: string): void } {
  const mem = new Map<string, string>();
  return {
    get(k) {
      try {
        const v = s?.getItem(k);
        if (typeof v === "string") return v;
      } catch { /* закрыто */ }
      return mem.get(k) ?? null;
    },
    set(k, v) {
      mem.set(k, v);
      try { s?.setItem(k, v); } catch { /* закрыто или переполнено */ }
    },
  };
}

function browserStorage(kind: "localStorage" | "sessionStorage"): ChatWidgetStorage | null {
  try {
    return window[kind];
  } catch {
    return null;
  }
}

/** Цвет текста на цвете фона: белый или почти чёрный — что контрастнее (для цветов вида #2563eb) */
export function inkFor(color: string): string {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m?.[1]) return "#ffffff";
  const hex = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  const lin = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
  // Контраст с белым (1.05 / (L + 0.05)) и с #111827 (≈ (L + 0.05) / 0.059): берём больший
  return 1.05 / (lum + 0.05) >= (lum + 0.05) / 0.059 ? "#ffffff" : "#111827";
}

const cssVar = (k: string) => `--ckw-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

function phoneOk(v: string): boolean {
  const digits = v.replace(/\D/g, "").length;
  return PHONE_RE.test(v) && digits >= 6 && digits <= 15;
}

function fileAllowed(f: { name: string; type: string }): boolean {
  const t = (f.type || "").toLowerCase();
  if (t === "image/svg+xml") return false;
  if (t.startsWith("image/") || t.startsWith("audio/") || t === "application/pdf" || t.includes("wordprocessingml") || t.includes("spreadsheetml")) return true;
  const ext = /\.([a-z0-9]{1,5})$/i.exec(f.name)?.[1]?.toLowerCase() ?? "";
  return FILE_EXTS.includes(ext);
}

function readBase64(f: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = typeof r.result === "string" ? r.result : "";
      const i = s.indexOf(",");
      resolve(i >= 0 ? s.slice(i + 1) : "");
    };
    r.onerror = () => reject(r.error ?? new Error("файл не прочитан"));
    r.readAsDataURL(f);
  });
}

function isPublicMessage(v: unknown): v is PublicMessage {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  if (typeof m.id !== "string" || !m.id || typeof m.at !== "string" || typeof m.text !== "string") return false;
  if (m.from !== "visitor" && m.from !== "company") return false;
  const a = m.attachment;
  if (a === null || a === undefined) return true;
  if (typeof a !== "object") return false;
  const x = a as Record<string, unknown>;
  return typeof x.name === "string" && typeof x.mime === "string" && typeof x.url === "string";
}

function preChatOf(v: ChatWidgetOptions["preChat"]): { fields: ChatWidgetField[]; required: boolean } | null {
  if (!v) return null;
  const o: ChatWidgetPreChat = v === true ? {} : v;
  const fields = (o.fields ?? ["name", "phone"]).filter((f, i, all) => (f === "name" || f === "phone" || f === "email") && all.indexOf(f) === i);
  return fields.length ? { fields: [...fields], required: !!o.required } : null;
}

/* ── Стили (значения — переменные из WIDGET_THEME) ─────────────────────────────────────────────────────────── */

function stylesheet(): string {
  const vars = Object.entries(WIDGET_THEME).map(([k, v]) => `${cssVar(k)}: ${v};`).join("\n  ");
  return `
:host {
  all: initial;
  ${vars}
}
@media print { :host { display: none !important; } }
.ckw, .ckw * { box-sizing: border-box; }
.ckw {
  font-family: var(--ckw-font); font-size: var(--ckw-font-size); line-height: 1.45; color: var(--ckw-text);
  -webkit-font-smoothing: antialiased; -webkit-text-size-adjust: 100%;
}
[hidden] { display: none !important; }
button { font: inherit; color: inherit; cursor: pointer; margin: 0; }
button:disabled { cursor: default; }
:focus-visible { outline: 2px solid var(--ckw-accent); outline-offset: 2px; }
.ckw-head :focus-visible { outline-color: var(--ckw-accent-ink); }

.ckw-launcher {
  position: fixed; bottom: var(--ckw-offset); right: var(--ckw-offset); z-index: var(--ckw-z-index);
  width: var(--ckw-launcher-size); height: var(--ckw-launcher-size); padding: 0; border: 0; border-radius: 50%;
  display: grid; place-items: center; background: var(--ckw-accent); color: var(--ckw-accent-ink);
  box-shadow: var(--ckw-shadow); transition: transform .15s ease;
}
.ckw-launcher:hover { transform: scale(1.05); }
.ckw-launcher:focus-visible { outline: 3px solid var(--ckw-accent); outline-offset: 3px; }
.ckw-launcher .ckw-ico-close, .ckw[data-open="true"] .ckw-launcher .ckw-ico-chat { display: none; }
.ckw[data-open="true"] .ckw-launcher .ckw-ico-close { display: block; }
.ckw-badge {
  position: absolute; top: -3px; right: -3px; min-width: 22px; height: 22px; padding: 0 6px; border-radius: 11px;
  background: var(--ckw-badge); color: var(--ckw-badge-ink); font-size: 12px; font-weight: 700; line-height: 22px;
  text-align: center; box-shadow: 0 0 0 2px var(--ckw-background);
}
.ckw[data-position="left"] .ckw-launcher, .ckw[data-position="left"] .ckw-panel { right: auto; left: var(--ckw-offset); }
.ckw[data-position="left"] .ckw-badge { right: auto; left: -3px; }

.ckw-panel {
  position: fixed; right: var(--ckw-offset); bottom: calc(var(--ckw-offset) + var(--ckw-launcher-size) + 12px);
  z-index: var(--ckw-z-index); width: var(--ckw-panel-width); max-width: calc(100vw - 2 * var(--ckw-offset));
  height: var(--ckw-panel-height); max-height: calc(100vh - var(--ckw-launcher-size) - 2 * var(--ckw-offset) - 12px);
  display: flex; flex-direction: column; overflow: hidden; background: var(--ckw-background);
  border-radius: var(--ckw-radius); box-shadow: var(--ckw-shadow); animation: ckw-in .18s ease-out;
}
@keyframes ckw-in { from { opacity: 0; transform: translateY(12px) scale(.98); } to { opacity: 1; transform: none; } }

.ckw-head { display: flex; align-items: center; gap: 10px; padding: 14px 10px 14px 18px; background: var(--ckw-accent); color: var(--ckw-accent-ink); }
.ckw-head-text { flex: 1; min-width: 0; }
.ckw-title { font-size: 16px; font-weight: 650; line-height: 1.25; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ckw-status { display: flex; align-items: center; gap: 6px; margin-top: 2px; font-size: 13px; opacity: .9; }
.ckw-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ckw-online); flex: none; }
.ckw-icon-btn { width: 40px; height: 40px; flex: none; display: grid; place-items: center; padding: 0; border: 0; border-radius: 50%; background: transparent; }
.ckw-close:hover { background: rgba(127, 127, 127, .2); }

.ckw-chat { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.ckw-net { padding: 6px 14px; font-size: 13px; text-align: center; background: var(--ckw-notice); color: var(--ckw-notice-ink); }
.ckw-list {
  flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 16px 14px 10px;
  display: flex; flex-direction: column; gap: 8px; background: var(--ckw-surface);
}
.ckw-group { display: contents; }
.ckw-msg { display: flex; flex-direction: column; align-items: flex-start; align-self: flex-start; max-width: 84%; }
.ckw-msg--visitor { align-self: flex-end; align-items: flex-end; }
.ckw-bubble {
  padding: 9px 13px; border: 1px solid var(--ckw-border); border-radius: var(--ckw-bubble-radius); border-bottom-left-radius: 6px;
  background: var(--ckw-company-bubble); color: var(--ckw-company-ink); white-space: pre-wrap; overflow-wrap: anywhere; max-width: 100%;
}
.ckw-msg--visitor .ckw-bubble {
  border-color: transparent; border-bottom-left-radius: var(--ckw-bubble-radius); border-bottom-right-radius: 6px;
  background: var(--ckw-visitor-bubble); color: var(--ckw-visitor-ink);
}
.ckw-bubble--media { padding: 4px; }
.ckw-bubble--media .ckw-text { padding: 5px 9px 4px; }
.ckw-msg--sending .ckw-bubble { opacity: .7; }
.ckw-text a { color: var(--ckw-link); text-decoration: underline; text-underline-offset: 2px; }
.ckw-msg--visitor .ckw-text a { color: inherit; }
.ckw-meta { margin: 3px 6px 0; font-size: 12px; color: var(--ckw-muted); }
.ckw-meta--failed { color: var(--ckw-danger); }
.ckw-retry { padding: 0; border: 0; background: none; color: var(--ckw-danger); font-size: 12px; font-weight: 650; text-decoration: underline; }
.ckw-img-link { display: block; }
.ckw-img { display: block; max-width: 100%; max-height: 260px; border-radius: calc(var(--ckw-bubble-radius) - 5px); }
.ckw-audio { display: block; width: 260px; max-width: 100%; }
.ckw-file { display: flex; align-items: center; gap: 8px; padding: 6px 8px; color: inherit; text-decoration: none; }
.ckw-file svg { flex: none; }
.ckw-file-name { font-weight: 600; overflow-wrap: anywhere; }
.ckw-file-size { font-size: 12px; opacity: .75; white-space: nowrap; }

.ckw-chip {
  display: flex; align-items: center; gap: 8px; margin: 8px 12px 0; padding: 5px 5px 5px 10px; font-size: 13px;
  border: 1px solid var(--ckw-border); border-radius: 10px; background: var(--ckw-surface);
}
.ckw-chip-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ckw-chip-size { color: var(--ckw-muted); white-space: nowrap; }
.ckw-chip-x { width: 28px; height: 28px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 50%; background: transparent; color: var(--ckw-muted); }
.ckw-error { padding: 6px 14px 0; font-size: 13px; color: var(--ckw-danger); }
.ckw-composer { display: flex; align-items: flex-end; gap: 6px; padding: 10px 10px 12px; border-top: 1px solid var(--ckw-border); background: var(--ckw-background); }
.ckw-attach { color: var(--ckw-muted); }
.ckw-attach:hover { color: var(--ckw-text); background: var(--ckw-surface); }
.ckw-input {
  flex: 1; min-width: 0; min-height: 40px; max-height: 140px; padding: 9px 4px; resize: none; border: 0; outline: none;
  background: transparent; color: var(--ckw-text); font: inherit; line-height: 1.45;
}
.ckw-input::placeholder, .ckw-field::placeholder { color: var(--ckw-muted); opacity: 1; }
.ckw-send { width: 40px; height: 40px; flex: none; display: grid; place-items: center; padding: 0; border: 0; border-radius: 50%; background: var(--ckw-accent); color: var(--ckw-accent-ink); }
.ckw-send:disabled { opacity: .45; }
.ckw-file-input { display: none; }

.ckw-form { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; padding: 18px; background: var(--ckw-background); }
.ckw-form-intro { margin: 0; }
.ckw-row { display: flex; flex-direction: column; gap: 6px; }
.ckw-label { font-size: 13px; font-weight: 600; color: var(--ckw-muted); }
.ckw-field {
  width: 100%; padding: 10px 12px; font: inherit; color: var(--ckw-text); background: var(--ckw-background);
  border: 1px solid var(--ckw-border); border-radius: 10px; outline: none;
}
.ckw-field:focus { border-color: var(--ckw-accent); box-shadow: 0 0 0 3px rgba(127, 127, 127, .18); }
.ckw-field[aria-invalid="true"] { border-color: var(--ckw-danger); }
.ckw-field-err { font-size: 12px; color: var(--ckw-danger); }
.ckw-primary { margin-top: 4px; padding: 12px 16px; border: 0; border-radius: 10px; background: var(--ckw-accent); color: var(--ckw-accent-ink); font-weight: 650; }
.ckw-primary:disabled { opacity: .6; }

@media (max-width: 480px) {
  /* Во весь экран с любой стороны: селектор не слабее, чем у «слева» выше */
  .ckw[data-position] .ckw-panel { inset: 0; width: auto; max-width: none; height: auto; max-height: none; border-radius: 0; animation: none; }
  .ckw[data-open="true"] .ckw-launcher { display: none; }
  .ckw-input, .ckw-field { font-size: 16px; }
}
@media (prefers-reduced-motion: reduce) {
  .ckw-panel { animation: none; }
  .ckw-launcher { transition: none; }
}
`;
}

/* ── Виджет ────────────────────────────────────────────────────────────────────────────────────────────────── */

export function mountChatWidget(options: ChatWidgetOptions): ChatWidget {
  if (typeof document === "undefined" || typeof window === "undefined") throw new Error("Чат на сайте работает только в браузере");
  if (!options.endpoint) throw new Error("Не задан адрес чата (endpoint)");
  const doc = document;
  const texts: ChatWidgetTexts = { ...WIDGET_TEXTS, ...options.texts };
  if (options.title) texts.title = options.title;
  const api = new URL(options.endpoint, doc.baseURI).href.replace(/\/+$/, "");
  const fetchFn: typeof fetch = options.fetch ?? ((input, init) => window.fetch(input, init));
  const pollOpen = Math.max(500, options.pollOpenMs ?? 3000);
  const pollClosed = Math.max(500, options.pollClosedMs ?? 20_000);
  const maxBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
  const pre = preChatOf(options.preChat);
  const greeting = options.greeting === undefined ? texts.greeting : options.greeting ?? "";
  const store = safeStorage(options.storage === undefined ? browserStorage("localStorage") : options.storage);
  const tab = safeStorage(browserStorage("sessionStorage"));
  const KEY = `ck-chat:${api}`;
  let fmtTime: Intl.DateTimeFormat;
  let fmtDay: Intl.DateTimeFormat;
  try {
    fmtTime = new Intl.DateTimeFormat(options.locale ?? "ru-RU", { hour: "2-digit", minute: "2-digit" });
    fmtDay = new Intl.DateTimeFormat(options.locale ?? "ru-RU", { day: "numeric", month: "short" });
  } catch {
    fmtTime = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });
    fmtDay = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });
  }

  // Первая страница посещения и откуда на неё пришли — для строки «откуда пришёл» в CRM (метки utm_* обычно на ней)
  if (!tab.get(LANDING_KEY)) tab.set(LANDING_KEY, JSON.stringify({ url: pageUrl(location.href), referrer: refUrl(doc.referrer) }));

  let saved: Saved = readSaved();
  let destroyed = false;
  let isOpen = false;
  let unread = 0;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let polling: Promise<void> | null = null;
  let pollAgain = false;
  let starting: Promise<ApiResult> | null = null;
  let picked: PickedFile | null = null;
  let atBottom = true;
  const seen = new Set<string>();
  const order: PublicMessage[] = [];
  const local: LocalMessage[] = [];

  function readSaved(): Saved {
    try {
      const v: unknown = JSON.parse(store.get(KEY) ?? "null");
      if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        const s = (x: unknown) => (typeof x === "string" && x ? x : undefined);
        const introDone = o.introDone === true;
        // Номер и ключ не того вида (испорчены) — такой ключ не отправить даже заголовком: начинаем заново
        if (typeof o.visitorId !== "string" || !VISITOR_RE.test(o.visitorId) || typeof o.token !== "string" || !TOKEN_RE.test(o.token)) return { introDone };
        return { visitorId: o.visitorId, token: o.token, engaged: o.engaged === true, seenId: s(o.seenId), introDone };
      }
    } catch { /* испорчено — начинаем заново */ }
    return {};
  }
  const persist = () => store.set(KEY, JSON.stringify(saved));
  const hasSession = () => !!(saved.visitorId && saved.token);
  const isHidden = () => doc.visibilityState === "hidden";

  /* ── Разметка ── */

  const host = doc.createElement("ck-chat-widget");
  const root = host.attachShadow({ mode: "open" });
  const theme: Partial<ChatWidgetTheme> = { ...options.theme };
  if (options.color) theme.accent = options.color;
  for (const [k, v] of Object.entries(theme)) if (typeof v === "string" && v) host.style.setProperty(cssVar(k), v);
  if (theme.accent && !theme.accentInk) host.style.setProperty(cssVar("accentInk"), inkFor(theme.accent));

  const badge = h("span", { class: "ckw-badge", hidden: true, "aria-hidden": "true" });
  const launcher = h("button", { type: "button", class: "ckw-launcher", "aria-expanded": "false", "aria-controls": "ckw-panel", "aria-label": texts.launcher, title: texts.launcher },
    icon(ICONS.chat, 28, "ckw-ico-chat"), icon(ICONS.close, 26, "ckw-ico-close"), badge);
  const statusText = h("span", { text: texts.online });
  const dot = h("span", { class: "ckw-dot", "aria-hidden": "true" });
  const closeBtn = h("button", { type: "button", class: "ckw-icon-btn ckw-close", "aria-label": texts.close, title: texts.close }, icon(ICONS.down));
  const head = h("header", { class: "ckw-head" },
    h("div", { class: "ckw-head-text" }, h("div", { class: "ckw-title", id: "ckw-title", text: texts.title }), h("div", { class: "ckw-status" }, dot, statusText)),
    closeBtn);

  const net = h("div", { class: "ckw-net", role: "status", hidden: true, text: texts.reconnecting });
  const greetingBox = h("div", { class: "ckw-group" });
  const serverBox = h("div", { class: "ckw-group" });
  const localBox = h("div", { class: "ckw-group" });
  // Лента прокручивается и с клавиатуры (tabindex), новые сообщения читает экранный диктор (role="log")
  const list = h("div", { class: "ckw-list", role: "log", "aria-live": "polite", "aria-label": texts.title, tabindex: 0 }, greetingBox, serverBox, localBox);
  if (greeting) greetingBox.append(h("div", { class: "ckw-msg ckw-msg--company ckw-greeting" }, h("div", { class: "ckw-bubble" }, bubbleText(greeting, false))));

  const chip = h("div", { class: "ckw-chip", hidden: true });
  const error = h("div", { class: "ckw-error", role: "alert", hidden: true });
  const fileInput = h("input", { type: "file", class: "ckw-file-input", tabindex: "-1", "aria-hidden": "true", accept: ACCEPT });
  const attachBtn = h("button", { type: "button", class: "ckw-icon-btn ckw-attach", "aria-label": texts.attach, title: texts.attach }, icon(ICONS.clip, 22));
  const textarea = h("textarea", {
    class: "ckw-input", rows: 1, maxlength: MAX_TEXT, placeholder: texts.placeholder, "aria-label": texts.message, enterkeyhint: "send",
  });
  const sendBtn = h("button", { type: "submit", class: "ckw-send", "aria-label": texts.send, title: texts.send, disabled: true }, icon(ICONS.send, 20));
  const composer = h("form", { class: "ckw-composer", novalidate: true }, attachBtn, textarea, sendBtn, fileInput);
  const chat = h("div", { class: "ckw-chat" }, net, list, chip, error, composer);
  const form = pre ? buildForm(pre) : null;
  const panel = h("section", { class: "ckw-panel", id: "ckw-panel", role: "dialog", "aria-labelledby": "ckw-title", hidden: true }, head, chat, form?.el);
  const wrap = h("div", { class: "ckw", "data-position": options.position === "left" ? "left" : "right", "data-open": "false" }, launcher, panel);
  const style = doc.createElement("style");
  style.textContent = stylesheet();
  root.append(style, wrap);

  /* ── Форма перед чатом ── */

  function buildForm(p: { fields: ChatWidgetField[]; required: boolean }) {
    const el = h("form", { class: "ckw-form", novalidate: true }, h("p", { class: "ckw-form-intro", text: texts.preChatIntro }));
    const inputs = new Map<ChatWidgetField, { input: HTMLInputElement; err: HTMLElement }>();
    for (const name of p.fields) {
      const id = `ckw-f-${name}`;
      const input = h("input", {
        id, name, class: "ckw-field",
        type: name === "email" ? "email" : name === "phone" ? "tel" : "text",
        autocomplete: name === "name" ? "name" : name === "phone" ? "tel" : "email",
        inputmode: name === "phone" ? "tel" : name === "email" ? "email" : null,
        maxlength: name === "email" ? 120 : name === "phone" ? 30 : 80,
        placeholder: name === "phone" ? texts.phonePlaceholder || null : name === "email" ? texts.emailPlaceholder || null : null,
        "aria-required": p.required && name === "name" ? "true" : null,
        "aria-describedby": `${id}-err`,
      });
      const err = h("div", { class: "ckw-field-err", id: `${id}-err`, hidden: true });
      el.append(h("div", { class: "ckw-row" }, h("label", { class: "ckw-label", for: id, text: texts[name] }), input, err));
      inputs.set(name, { input, err });
    }
    const general = h("div", { class: "ckw-error", role: "alert", hidden: true });
    const submit = h("button", { type: "submit", class: "ckw-primary", text: texts.startChat });
    el.append(general, submit);
    el.addEventListener("submit", (e) => {
      e.preventDefault();
      void submitForm();
    });

    function fieldError(name: string, message: string | null) {
      const f = inputs.get(name as ChatWidgetField);
      if (!f) return;
      f.err.textContent = message ?? "";
      f.err.hidden = !message;
      if (message) f.input.setAttribute("aria-invalid", "true");
      else f.input.removeAttribute("aria-invalid");
    }

    async function submitForm() {
      general.hidden = true;
      const values: Partial<Record<ChatWidgetField, string>> = {};
      for (const [name, f] of inputs) {
        fieldError(name, null);
        const v = f.input.value.replace(/\s+/g, " ").trim();
        if (v) values[name] = v;
      }
      const errors = new Map<ChatWidgetField, string>();
      if (values.phone && !phoneOk(values.phone)) errors.set("phone", texts.badPhone);
      if (values.email && !EMAIL_RE.test(values.email)) errors.set("email", texts.badEmail);
      if (p.required) {
        if (inputs.has("name") && !values.name) errors.set("name", texts.required);
        const contacts = p.fields.filter((f) => f === "phone" || f === "email");
        const first = contacts[0];
        if (first && !contacts.some((f) => values[f])) errors.set(first, contacts.length > 1 ? texts.contactRequired : texts.required);
      }
      if (errors.size) {
        for (const [name, message] of errors) fieldError(name, message);
        const firstBad = p.fields.find((f) => errors.has(f));
        if (firstBad) inputs.get(firstBad)?.input.focus();
        return;
      }
      if (!Object.keys(values).length) {
        // Форму можно пропустить: посетитель станет клиентом с первым сообщением
        saved.introDone = true;
        persist();
        showView();
        focusFirst();
        return;
      }
      submit.disabled = true;
      submit.textContent = texts.starting;
      const r = await startSession(values);
      if (destroyed) return;
      submit.disabled = false;
      submit.textContent = texts.startChat;
      if (!r.ok) {
        const field = typeof r.data.field === "string" ? r.data.field : "";
        const message = typeof r.data.error === "string" && r.data.error ? r.data.error : texts.error;
        if (inputs.has(field as ChatWidgetField)) {
          fieldError(field, message);
          inputs.get(field as ChatWidgetField)?.input.focus();
        } else {
          general.textContent = message;
          general.hidden = false;
        }
        return;
      }
      // Представился — в CRM уже есть его диалог: можно спрашивать ответы
      saved.introDone = true;
      saved.engaged = true;
      persist();
      showView();
      focusFirst();
      schedule(0);
    }

    return { el, inputs };
  }

  const needForm = () => !!form && !saved.introDone && !saved.engaged;

  function showView() {
    const f = needForm();
    if (form) form.el.hidden = !f;
    chat.hidden = f;
  }

  function focusFirst() {
    // На телефоне сами поле не открываем — выскочит клавиатура и закроет половину экрана
    const coarse = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
    if (coarse) return;
    if (needForm()) form?.inputs.values().next().value?.input.focus();
    else textarea.focus();
  }

  /* ── Сообщения ── */

  function timeOf(at: string): string {
    const d = new Date(at);
    if (!Number.isFinite(d.getTime())) return "";
    return d.toDateString() === new Date().toDateString() ? fmtTime.format(d) : `${fmtDay.format(d)}, ${fmtTime.format(d)}`;
  }

  function bubbleText(text: string, plain: boolean): HTMLElement {
    const el = h("div", { class: "ckw-text" });
    if (plain) el.textContent = text;
    else linkify(el, text);
    return el;
  }

  function attachmentEl(a: PublicAttachment): HTMLElement | null {
    const href = safeUrl(a.url, api);
    if (!href) return null;
    const mime = (a.mime.split(";")[0] ?? "").trim().toLowerCase();
    if (mime.startsWith("image/") && mime !== "image/heic" && mime !== "image/heif") {
      const img = h("img", { class: "ckw-img", src: href, alt: a.name || texts.photo, loading: "lazy", decoding: "async" });
      img.addEventListener("load", () => { if (atBottom) scrollDown(); });
      return h("a", { class: "ckw-img-link", href, target: "_blank", rel: "noopener noreferrer" }, img);
    }
    if (mime.startsWith("audio/")) return h("audio", { class: "ckw-audio", controls: true, preload: "none", src: href });
    return h("a", { class: "ckw-file", href, target: "_blank", rel: "noopener noreferrer" },
      icon(ICONS.file, 20), h("span", { class: "ckw-file-name", text: a.name || texts.file }), a.size ? h("span", { class: "ckw-file-size", text: sizeText(a.size) }) : null);
  }

  function messageEl(m: PublicMessage): HTMLElement {
    const mine = m.from === "visitor";
    const bubble = h("div", { class: "ckw-bubble" });
    const att = m.attachment ? attachmentEl(m.attachment) : null;
    if (att) {
      bubble.append(att);
      bubble.classList.add("ckw-bubble--media");
    }
    // Файл без ссылки (проект не дал ссылку без входа) — хотя бы имя
    const text = m.text || (!att && m.attachment ? m.attachment.name : "");
    if (text) bubble.append(bubbleText(text, mine));
    const meta = [!mine && m.author ? m.author : "", timeOf(m.at)].filter(Boolean).join(" · ");
    return h("div", { class: `ckw-msg ${mine ? "ckw-msg--visitor" : "ckw-msg--company"}`, "data-id": m.id }, bubble, meta ? h("div", { class: "ckw-meta", text: meta }) : null);
  }

  function localEl(m: LocalMessage): HTMLElement {
    const bubble = h("div", { class: "ckw-bubble" });
    if (m.file) bubble.append(h("div", { class: "ckw-file" }, icon(ICONS.file, 20), h("span", { class: "ckw-file-name", text: m.file.name })));
    if (m.text) bubble.append(bubbleText(m.text, true));
    const meta = h("div", { class: "ckw-meta" });
    if (m.state === "sending") meta.textContent = texts.sending;
    else if (m.state === "failed") {
      meta.classList.add("ckw-meta--failed");
      const retry = h("button", { type: "button", class: "ckw-retry", text: texts.retry });
      retry.addEventListener("click", () => {
        textarea.focus();
        void deliver(m);
      });
      meta.append(`${texts.failed} `, retry);
    } else meta.hidden = true;
    return h("div", { class: `ckw-msg ckw-msg--visitor ckw-msg--${m.state}`, "data-local": m.key }, bubble, meta);
  }

  const renderLocal = () => localBox.replaceChildren(...local.map(localEl));
  const nearBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  function scrollDown() {
    list.scrollTop = list.scrollHeight;
    atBottom = true;
  }
  list.addEventListener("scroll", () => { atBottom = nearBottom(); });

  /** Пришедшие с сервера сообщения — в ленту по порядку; своё отправленное заменяет «отправляется…» */
  function merge(msgs: PublicMessage[]) {
    const stick = atBottom || nearBottom();
    let added = 0;
    for (const m of msgs) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      order.push(m);
      serverBox.append(messageEl(m));
      added++;
      if (m.clientMsgId) {
        const i = local.findIndex((x) => x.key === m.clientMsgId);
        if (i >= 0) local.splice(i, 1);
      }
    }
    if (!added) return;
    renderLocal();
    updateUnread();
    if (stick) scrollDown();
  }

  /* ── Непрочитанные ── */

  function setBadge(n: number) {
    unread = n;
    badge.textContent = n > 9 ? "9+" : String(n);
    badge.hidden = n === 0;
    const label = isOpen ? texts.close : n ? `${texts.launcher}. ${fill(texts.unread, { n })}` : texts.launcher;
    launcher.setAttribute("aria-label", label);
    launcher.title = label;
  }

  function updateUnread() {
    if (isOpen && !isHidden()) {
      markSeen();
      return;
    }
    const from = saved.seenId ? order.findIndex((m) => m.id === saved.seenId) : -1;
    setBadge(order.slice(from + 1).filter((m) => m.from === "company").length);
  }

  function markSeen() {
    const last = [...order].reverse().find((m) => m.from === "company");
    if (last && saved.seenId !== last.id) {
      saved.seenId = last.id;
      persist();
    }
    setBadge(0);
  }

  /* ── Сервер ── */

  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<ApiResult> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (saved.visitorId && saved.token) headers.authorization = `Bearer ${saved.visitorId}.${saved.token}`;
    const init: RequestInit = { method, headers, cache: "no-store", credentials: "omit" };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    if (ctrl) init.signal = ctrl.signal;
    const timeout = ctrl ? setTimeout(() => ctrl.abort(), body === undefined ? 20_000 : 60_000) : undefined;
    try {
      const res = await fetchFn(`${api}/${path}`, init);
      let data: Record<string, unknown> = {};
      try {
        const j: unknown = await res.json();
        if (j && typeof j === "object" && !Array.isArray(j)) data = j as Record<string, unknown>;
      } catch { /* не JSON */ }
      return { ok: res.ok && data.ok === true, status: res.status, data };
    } catch {
      return { ok: false, status: 0, data: {} };
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  function pageInfo() {
    let land: { url?: unknown; referrer?: unknown } = {};
    try {
      land = JSON.parse(tab.get(LANDING_KEY) ?? "{}") as typeof land;
    } catch { /* нет — не страшно */ }
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    return { url: pageUrl(location.href), referrer: str(land.referrer) || refUrl(doc.referrer), landing: str(land.url) || pageUrl(location.href) };
  }

  function applyOnline(v: unknown) {
    if (typeof v !== "boolean") return;
    statusText.textContent = v ? texts.online : texts.offline;
    dot.hidden = !v;
  }

  /** Номер посетителя и ключ: новый или прежний (с формой перед чатом — клиент в CRM сразу) */
  function startSession(profile?: Partial<Record<ChatWidgetField, string>>): Promise<ApiResult> {
    if (starting && !profile) return starting;
    const run = (async () => {
      const r = await call("POST", "start", { page: pageInfo(), ...(profile ? { profile } : {}) });
      const id = r.data.visitorId;
      const token = r.data.token;
      if (r.ok && typeof id === "string" && VISITOR_RE.test(id) && typeof token === "string" && TOKEN_RE.test(token)) {
        if (saved.visitorId && saved.visitorId !== id) resetConversation();
        saved = { ...saved, visitorId: id, token };
        persist();
        applyOnline(r.data.online);
      }
      return r;
    })();
    if (!profile) {
      starting = run;
      void run.finally(() => { if (starting === run) starting = null; });
    }
    return run;
  }

  async function ensureSession(): Promise<boolean> {
    if (hasSession()) return true;
    return (await startSession()).ok;
  }

  /** Ключ больше не подходит (сменили секрет) — начинаем с чистого листа; неотправленное остаётся, форму второй раз
   *  не спрашиваем */
  function forget() {
    saved = { introDone: saved.introDone };
    persist();
    resetConversation();
    showView();
  }

  function resetConversation() {
    seen.clear();
    order.length = 0;
    serverBox.replaceChildren();
    setBadge(0);
  }

  function schedule(delay?: number) {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (destroyed || !saved.engaged || !hasSession() || isHidden()) return;
    const base = isOpen ? pollOpen : pollClosed;
    // Сбой связи — спрашиваем всё реже: 3 → 6 → 12 … до минуты (свёрнутый — до 80 с)
    const ms = delay ?? (failures ? Math.min(base * 2 ** Math.min(failures, 6), Math.max(60_000, base * 4)) : base);
    timer = setTimeout(() => { void poll(); }, ms);
  }

  function poll(): Promise<void> {
    if (destroyed || !hasSession()) return Promise.resolve();
    if (polling) {
      pollAgain = true;
      return polling;
    }
    const run = (async () => {
      try {
        const after = order[order.length - 1]?.id;
        const r = await call("GET", `messages${after ? `?after=${encodeURIComponent(after)}` : ""}`);
        if (destroyed) return;
        if (r.status === 401) {
          forget();
          return;
        }
        if (!r.ok) {
          failures++;
          net.hidden = failures < 2;
          return;
        }
        failures = 0;
        net.hidden = true;
        applyOnline(r.data.online);
        merge((Array.isArray(r.data.messages) ? r.data.messages : []).filter(isPublicMessage));
      } finally {
        polling = null;
        if (pollAgain && !destroyed) {
          pollAgain = false;
          void poll();
        } else schedule();
      }
    })();
    polling = run;
    return run;
  }

  /* ── Отправка ── */

  function showError(message: string | null) {
    error.textContent = message ?? "";
    error.hidden = !message;
  }

  const updateSend = () => { sendBtn.disabled = !textarea.value.trim() && !picked; };

  function autosize() {
    textarea.style.height = "auto";
    const hgt = textarea.scrollHeight;
    if (hgt > 0) textarea.style.height = `${Math.min(hgt, 140)}px`;
  }

  function setPicked(p: PickedFile | null) {
    picked = p;
    chip.replaceChildren();
    chip.hidden = !p;
    if (p) {
      const x = h("button", { type: "button", class: "ckw-chip-x", "aria-label": texts.removeFile, title: texts.removeFile }, icon(ICONS.close, 16));
      x.addEventListener("click", () => {
        setPicked(null);
        textarea.focus();
      });
      chip.append(icon(ICONS.file, 16), h("span", { class: "ckw-chip-name", text: p.name }), h("span", { class: "ckw-chip-size", text: sizeText(p.size) }), x);
    }
    updateSend();
  }

  async function pick(f: File) {
    showError(null);
    if (f.size > maxBytes) return showError(fill(texts.fileTooBig, { mb: mbText(maxBytes) }));
    if (!fileAllowed(f)) return showError(texts.fileType);
    let data: string;
    try {
      data = await readBase64(f);
    } catch {
      return showError(texts.error);
    }
    if (destroyed) return;
    setPicked({ name: f.name || texts.file, mime: f.type || "", size: f.size, data });
    textarea.focus();
  }

  async function submitComposer() {
    const text = textarea.value.replace(/\r\n?/g, "\n").trim();
    const file = picked;
    if (!text && !file) {
      textarea.focus();
      return;
    }
    if (text.length > MAX_TEXT) return showError(fill(texts.tooLong, { max: MAX_TEXT }));
    const m: LocalMessage = { key: newKey(), text, file, state: "sending" };
    local.push(m);
    textarea.value = "";
    autosize();
    setPicked(null);
    showError(null);
    renderLocal();
    scrollDown();
    await deliver(m);
  }

  async function deliver(m: LocalMessage) {
    m.state = "sending";
    renderLocal();
    showError(null);
    const payload = () => ({
      clientMsgId: m.key, text: m.text,
      ...(m.file ? { file: { name: m.file.name, mime: m.file.mime, data: m.file.data } } : {}),
      // Откуда пришёл — с первым сообщением (в CRM — строкой один раз)
      ...(saved.engaged ? {} : { page: pageInfo() }),
    });
    let r: ApiResult = { ok: false, status: 0, data: {} };
    if (await ensureSession()) {
      r = await call("POST", "message", payload());
      // Ключ перестал подходить — новый посетитель и ещё одна попытка
      if (r.status === 401) {
        forget();
        if (await ensureSession()) r = await call("POST", "message", payload());
      }
    }
    if (destroyed || !local.includes(m)) return; // уже пришло опросом
    if (r.ok) {
      m.state = "sent";
      if (m.file) m.file = { ...m.file, data: "" };
      if (!saved.engaged) {
        saved.engaged = true;
        persist();
      }
      renderLocal();
      void poll();
      return;
    }
    if (r.status >= 400 && r.status < 500 && r.status !== 401 && r.status !== 408 && r.status !== 429) {
      // Сервер не примет это и при повторе (не тот файл, слишком длинное): убираем из ленты, текст — обратно в поле
      local.splice(local.indexOf(m), 1);
      renderLocal();
      if (!textarea.value) {
        textarea.value = m.text;
        autosize();
      }
      updateSend();
      showError(typeof r.data.error === "string" && r.data.error ? r.data.error : texts.error);
      return;
    }
    m.state = "failed";
    renderLocal();
  }

  /* ── Открыть и закрыть ── */

  function setOpen(v: boolean, focus = true) {
    if (destroyed || v === isOpen) return;
    isOpen = v;
    panel.hidden = !v;
    wrap.dataset.open = String(v);
    launcher.setAttribute("aria-expanded", String(v));
    if (v) {
      showView();
      updateUnread();
      scrollDown();
      if (focus) focusFirst();
      schedule(order.length ? undefined : 0);
    } else {
      setBadge(unread);
      schedule();
      if (focus) launcher.focus();
    }
  }

  launcher.addEventListener("click", () => setOpen(!isOpen));
  closeBtn.addEventListener("click", () => setOpen(false));
  panel.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    setOpen(false);
  });
  composer.addEventListener("submit", (e) => {
    e.preventDefault();
    void submitComposer();
  });
  textarea.addEventListener("keydown", (e) => {
    // Enter — отправить, Shift+Enter — новая строка; пока набирается слово в IME (китайский, японский) — не отправляем
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    void submitComposer();
  });
  textarea.addEventListener("input", () => {
    autosize();
    updateSend();
  });
  attachBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const f = fileInput.files?.[0];
    fileInput.value = "";
    if (f) void pick(f);
  });
  const onVisibility = () => {
    if (isHidden()) {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      return;
    }
    if (isOpen) markSeen();
    schedule(0);
  };
  doc.addEventListener("visibilitychange", onVisibility);
  // Посетитель начал чат в другой вкладке — эта подхватывает его номер и ключ (значок, ответы), а не заводит второго
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY || destroyed) return;
    const next = readSaved();
    if (next.visitorId !== saved.visitorId) resetConversation();
    saved = next;
    showView();
    schedule(0);
  };
  window.addEventListener("storage", onStorage);

  showView();
  (options.container ?? doc.body).append(host);
  // Посетитель уже писал — спросить ответы (значок непрочитанных), не мешая загрузке страницы
  schedule(800);
  if (options.open) setOpen(true, false);

  return {
    host,
    root,
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!isOpen),
    refresh: () => poll(),
    destroy() {
      destroyed = true;
      if (timer !== undefined) clearTimeout(timer);
      doc.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("storage", onStorage);
      host.remove();
    },
  };
}

/* ── Настройки из тега <script> и запуск ───────────────────────────────────────────────────────────────────── */

/** Настройки из атрибутов: data-endpoint (относительный — от адреса самого скрипта), data-title, data-color,
 *  data-greeting, data-position="left", data-prechat="name,phone" (или "true"), data-prechat-required, data-open */
export function widgetOptionsFromScript(el: HTMLScriptElement): ChatWidgetOptions {
  const d = el.dataset;
  const yes = (v: string | undefined) => v !== undefined && v !== "false" && v !== "0";
  const fields = (d.prechat ?? "").split(/[\s,]+/).filter((x): x is ChatWidgetField => x === "name" || x === "phone" || x === "email");
  const preChat = fields.length ? { fields, required: yes(d.prechatRequired) } : yes(d.prechat) ? { required: yes(d.prechatRequired) } : null;
  return {
    // Пустой адрес — пусть mountChatWidget скажет «не задан адрес», а не шлёт запросы на адрес самого скрипта
    endpoint: d.endpoint ? new URL(d.endpoint, el.src || document.baseURI).href : "",
    ...(d.title ? { title: d.title } : {}),
    ...(d.greeting !== undefined ? { greeting: d.greeting } : {}),
    ...(d.color ? { color: d.color } : {}),
    position: d.position === "left" ? "left" : "right",
    ...(preChat ? { preChat } : {}),
    ...(yes(d.open) ? { open: true } : {}),
  };
}

/** Скрипт вставлен на сайт тегом с data-endpoint — ставим виджет сам */
function autoMount(): void {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  const here = import.meta.url;
  const scripts = Array.from(document.querySelectorAll<HTMLScriptElement>("script[data-endpoint]"));
  const me = scripts.find((s) => s.src === here) ?? scripts.find((s) => /chat-widget/i.test(s.src));
  if (!me || me.dataset.ckMounted) return;
  me.dataset.ckMounted = "1";
  const run = () => {
    try {
      mountChatWidget(widgetOptionsFromScript(me));
    } catch (e) {
      console.error("[chat-widget] не удалось поставить чат:", e);
    }
  };
  if (document.body) run();
  else document.addEventListener("DOMContentLoaded", run, { once: true });
}

autoMount();
