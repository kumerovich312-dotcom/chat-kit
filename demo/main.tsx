import { StrictMode, useCallback, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "../src/ui/styles.css";
import "./demo.css";
import {
  defineProfile, effectiveStatus, fileWords, fromClient, NOUNS, plural, profileCss, readActionForm, readComposerForm, sortMessages, textMatches, waitKey, waitSince,
  type AiAnswer, type Assignee, type BotState, type ChatMessage, type DialogStatus, type DialogSummary, type Presence,
} from "../src/core/index.js";
import {
  ChatWindow, NotifyToggle, WaitAlerts,
  type LinkLike, type ListFilter, type ListLinkOver, type ListStatus, type MemoryFact, type Rating, type ViewFile, type WaitEpisode,
} from "../src/ui/index.js";
import { CONTACTS, MANAGERS, ME, MEMORY, OLDER, PROFILE, PROJECT_FILES, suggestReply, TEMPLATES, THREADS, TRANSCRIPTS, TZ, type DemoContact } from "./data.js";

// Демо-страница окна переписки: примерные данные, отправка и приход сообщений, ИИ — понарошку, в памяти страницы.
// Вверху — как паспорт проекта меняет окно: слова отрасли, светлая / тёмная тема, цвет.

type Words = "client" | "patient" | "candidate";
type Mode = "light" | "dark";
type Accent = "blue" | "green" | "violet";
type Viewer = "owner" | "manager" | "manager-teach";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let counter = 1000;

const ACCENTS: Record<Accent, Record<string, string>> = {
  blue: {},
  green: { "--ck-accent": "#0f8a5f", "--ck-accent-dark": "#0b6a49", "--ck-accent-soft": "#e3f5ec", "--ck-accent-line": "#b8e4cf", "--ck-accent-faint": "#f2fbf6", "--ck-out-meta": "rgb(11 106 73 / 75%)" },
  violet: { "--ck-accent": "#6d4ed8", "--ck-accent-dark": "#5236b3", "--ck-accent-soft": "#efeafd", "--ck-accent-line": "#d9cffa", "--ck-accent-faint": "#f8f5ff", "--ck-out-meta": "rgb(82 54 179 / 75%)" },
};

function readUrl() {
  const sp = new URLSearchParams(location.search);
  return {
    dialog: sp.get("dialog"),
    filter: (sp.get("show") as ListFilter | null) ?? "all",
    status: (sp.get("status") as ListStatus | null) ?? "open",
    tag: sp.get("tag"),
    channel: sp.get("channel"),
    q: sp.get("q") ?? "",
    n: Number(sp.get("n") ?? 7) || 7,
  };
}

/** «Кратко» понарошку: в проекте это делает «розетка ИИ» (Claude) */
function fakeSummary(name: string, list: readonly ChatMessage[]): AiAnswer {
  const fromHim = list.filter((m) => fromClient(m) && m.kind === "message");
  const last = fromHim.at(-1);
  const files = list.filter((m) => m.attachments?.length).length;
  const points = [
    `${name.split(" ")[0]} написал ${fromHim.length} ${plural(fromHim.length, "сообщение", "сообщения", "сообщений")}${files ? `, файлов в переписке — ${files}` : ""}.`,
    ...(list.some((m) => m.card?.type === "appointment") ? ["Запись уже оформлена — клиент уточняет время."] : []),
    ...(last ? [`Последний вопрос: «${last.text.replace(/\*/g, "").slice(0, 90)}»`] : []),
  ];
  return { text: "Клиент хочет прийти на консультацию утром и ждёт точного времени. Бот передал разговор менеджеру.", points };
}

/** «Улучшить текст» понарошку */
function fakeImprove(text: string, mode: string): string {
  let t = text.trim().replace(/\s+/g, " ");
  t = t[0]!.toUpperCase() + t.slice(1);
  if (!/[.!?…]$/.test(t)) t += ".";
  if (mode === "shorter") return t.split(/(?<=[.!?…])\s/)[0] ?? t;
  if (mode === "friendlier") return `${t.replace(/\.$/, "")}. Если будут вопросы — пишите, всегда рады помочь!`;
  if (mode === "fix") return t.replace(/\bщас\b/gi, "сейчас").replace(/\bчё\b/gi, "что");
  return /^здравствуйте/i.test(t) ? t : `Здравствуйте! ${t}`;
}

function App() {
  const [words, setWords] = useState<Words>(() => (localStorage.getItem("demo.words") as Words | null) ?? "client");
  const [mode, setMode] = useState<Mode>(() => (localStorage.getItem("demo.mode") as Mode | null) ?? "light");
  const [accent, setAccent] = useState<Accent>(() => (localStorage.getItem("demo.accent") as Accent | null) ?? "blue");
  const [viewer, setViewer] = useState<Viewer>("owner");
  const [url, setUrl] = useState(readUrl);
  const [contacts, setContacts] = useState<DemoContact[]>(CONTACTS);
  const [threads, setThreads] = useState<Record<string, ChatMessage[]>>(THREADS);
  const [older, setOlder] = useState<Record<string, ChatMessage[]>>(OLDER);
  const [memory, setMemory] = useState(MEMORY);
  const [versions, setVersions] = useState<Record<string, number>>({});
  const [pinned, setPinned] = useState<Record<string, string>>({});
  const [rated, setRated] = useState<Record<string, Rating>>({});
  const [examples, setExamples] = useState<string[]>([]);
  const [presence, setPresence] = useState<Record<string, Presence[]>>({});
  const [now, setNow] = useState(() => Date.now());

  const profile = useMemo(() => defineProfile({
    ...PROFILE,
    words: words === "patient" ? { client: NOUNS.patient, manager: NOUNS.administrator, order: NOUNS.appointment }
      : words === "candidate" ? { client: NOUNS.candidate, manager: NOUNS.recruiter, order: NOUNS.order } : {},
    theme: ACCENTS[accent],
  }), [words, accent]);

  useEffect(() => { document.documentElement.dataset.ckTheme = mode; localStorage.setItem("demo.mode", mode); }, [mode]);
  useEffect(() => { localStorage.setItem("demo.words", words); }, [words]);
  useEffect(() => { localStorage.setItem("demo.accent", accent); }, [accent]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  useEffect(() => { const back = () => setUrl(readUrl()); addEventListener("popstate", back); return () => removeEventListener("popstate", back); }, []);

  const go = useCallback((href: string) => {
    history.pushState(null, "", href);
    setUrl(readUrl());
  }, []);

  // Ссылки списка — без перезагрузки страницы
  const Link: LinkLike = useMemo(() => function DemoLink({ href, className, children, title, ...rest }) {
    return (
      <a href={href} className={className} title={title} aria-current={rest["aria-current"]}
        onClick={(e: MouseEvent) => { if (e.ctrlKey || e.metaKey) return; e.preventDefault(); go(href); }}>
        {children}
      </a>
    );
  }, [go]);

  const withFiles = useCallback((list: ChatMessage[]) => list.map((m) => (m.attachments?.some((a) => versions[a.id])
    ? { ...m, attachments: m.attachments.map((a) => (versions[a.id] ? { ...a, version: `r${versions[a.id]}` } : a)) }
    : m)), [versions]);

  // Отложенный диалог сам открывается, когда пришло время или клиент написал (правило ядра)
  const statusOf = (c: DemoContact): DialogStatus => effectiveStatus(
    { status: c.status, statusAt: c.statusAt, snoozedUntil: c.snoozedUntil ?? null },
    { now, lastClientAt: (threads[c.id] ?? []).filter((m) => fromClient(m)).at(-1)?.at ?? null },
  );

  // Строки списка: последнее сообщение, «ждёт ответа», непрочитанные — по правилам ядра
  const all: DialogSummary[] = useMemo(() => contacts.map((c) => {
    const list = sortMessages(threads[c.id] ?? []).filter((m) => m.kind === "message");
    const last = list[list.length - 1];
    const lastText = last ? (last.card ? last.text || "Карточка" : last.text && !(last.attachments?.length && last.text === last.attachments[0]?.name) ? last.text : last.attachments?.[0] ? fileWords(last.attachments[0]) : last.text) : "";
    return {
      id: c.id, name: c.name, channel: c.channel, subtitle: c.subtitle, unread: c.unread, bot: c.bot,
      waitSince: waitSince(threads[c.id] ?? [], c.dismissedAt),
      last: last ? { text: lastText, at: last.at, author: last.author } : null,
      status: statusOf(c), snoozedUntil: c.snoozedUntil ?? null, tags: c.tags, assignee: c.assignee, assessment: c.assessment ?? null,
    };
  }).sort((a, b) => Date.parse(b.last?.at ?? "0") - Date.parse(a.last?.at ?? "0")), [contacts, threads, now]);

  const byStatus = (d: DialogSummary) => url.status === "any" || (d.status ?? "open") === url.status;
  const visible = all.filter(byStatus)
    .filter((d) => (url.filter === "wait" ? !!d.waitSince : url.filter === "unread" ? (d.unread ?? 0) > 0 : url.filter === "mine" ? d.assignee?.id === ME.id : true))
    .filter((d) => !url.tag || (d.tags ?? []).includes(url.tag))
    .filter((d) => !url.channel || d.channel === url.channel)
    .filter((d) => !url.q || textMatches(d.name, url.q) || (threads[d.id] ?? []).some((m) => textMatches(m.text, url.q)));
  const shown = visible.slice(0, url.n);
  const active = contacts.find((c) => c.id === url.dialog) ?? contacts.find((c) => c.id === shown[0]?.id) ?? null;
  const messages = active ? withFiles(sortMessages(threads[active.id] ?? [])) : [];
  const since = active ? waitSince(messages, active.dismissedAt) : null;
  const lastChat = messages.filter((m) => m.kind === "message").at(-1);

  const link = (over: ListLinkOver) => {
    const sp = new URLSearchParams();
    const filter = over.filter ?? url.filter;
    const status = over.status ?? url.status;
    const tag = over.tag === undefined ? url.tag : over.tag;
    const channel = over.channel === undefined ? url.channel : over.channel;
    if (filter !== "all") sp.set("show", filter);
    if (status !== "open") sp.set("status", status);
    if (tag) sp.set("tag", tag);
    if (channel) sp.set("channel", channel);
    if (url.q) sp.set("q", url.q);
    if (over.more) sp.set("n", String(url.n + 5));
    else if (url.n !== 7) sp.set("n", String(url.n));
    const s = sp.toString();
    return `/${s ? `?${s}` : ""}`;
  };

  // Прочитано, когда диалог открыт
  useEffect(() => {
    if (!active || active.unread === 0) return;
    const t = setTimeout(() => setContacts((cs) => cs.map((c) => (c.id === active.id ? { ...c, unread: 0 } : c))), 800);
    return () => clearTimeout(t);
  }, [active]);

  const patchMsg = (cid: string, mid: string, patch: Partial<ChatMessage>) =>
    setThreads((t) => ({ ...t, [cid]: (t[cid] ?? []).map((m) => (m.id === mid ? { ...m, ...patch } : m)) }));
  const patchContact = (cid: string, patch: Partial<DemoContact>) => setContacts((cs) => cs.map((c) => (c.id === cid ? { ...c, ...patch } : c)));
  const setBot = (cid: string, bot: BotState) => patchContact(cid, { bot });
  const push = (cid: string, msg: ChatMessage) => setThreads((t) => ({ ...t, [cid]: [...(t[cid] ?? []), msg] }));

  // Отправка понарошку: сообщение появляется сразу с часиками, потом галочка, две галочки, «прочитано»
  const send = async (fd: FormData) => {
    if (!active) return;
    const d = readComposerForm(fd);
    await sleep(700);
    const mid = `m${++counter}`;
    const failed = d.text.includes("ошибка доставки");
    // Голосовое и файл с компьютера в демо — адрес blob: (в проекте файл сохраняет сервер и отдаёт своим адресом)
    const up = d.file ? { id: `up${counter}`, name: d.voice ? "Голосовое сообщение" : d.file.name, mime: d.file.type || "application/octet-stream", size: d.file.size, url: URL.createObjectURL(d.file) } : null;
    const proj = d.fileId ? messages.flatMap((m) => m.attachments ?? []).find((a) => a.id === d.fileId) ?? null : null;
    const att = up ?? proj;
    const msg: ChatMessage = {
      id: mid, at: new Date().toISOString(),
      kind: d.mode === "note" ? "note" : "message",
      author: d.mode === "copy" && d.direction === "in" ? { type: "client" } : { type: "operator_crm", name: ME.name, id: ME.id },
      channel: d.mode === "email" ? "email" : active.channel,
      text: d.text || att?.name || "",
      ...(d.subject ? { subject: d.subject } : {}),
      ...(d.replyTo ? { replyTo: { id: d.replyTo } } : {}),
      ...(d.mode === "send" || d.mode === "email" ? { delivery: failed ? "failed" : "sent" } : {}),
      ...(failed ? { deliveryError: "канал не принял сообщение (проверка)" } : {}),
      ...(att ? { attachments: [att] } : {}),
    };
    push(active.id, msg);
    // Менеджер ответил сам — бот на паузе (pauseOnManagerMessage)
    if (d.mode === "send" && active.bot.mode === "bot") setBot(active.id, { ...active.bot, mode: "manager", pausedUntil: new Date(Date.now() + 12 * 3_600_000).toISOString() });
    if (!failed && d.mode === "send") {
      setTimeout(() => patchMsg(active.id, mid, { delivery: "delivered" }), 1500);
      setTimeout(() => patchMsg(active.id, mid, { delivery: "read" }), 4000);
    }
    return { ok: true };
  };

  // Кнопки проекта (меню «+»): записать, выставить счёт — карточка в ленте
  const onAction = async (fd: FormData) => {
    if (!active) return;
    const a = readActionForm(fd);
    await sleep(600);
    const base = { id: `m${++counter}`, at: new Date().toISOString(), kind: "message" as const, author: { type: "operator_crm" as const, name: ME.name, id: ME.id }, channel: active.channel, delivery: "sent" as const };
    if (a.actionId === "appointment") {
      const when = a.values.at ? new Date(a.values.at).toISOString() : new Date().toISOString();
      push(active.id, { ...base, text: `Вы записаны: ${a.values.service ?? ""}`, card: { type: "appointment", data: { at: when, service: a.values.service ?? "", specialist: a.values.specialist || null, status: "planned" } } });
    } else if (a.actionId === "invoice") {
      push(active.id, { ...base, text: `Счёт: ${a.values.sum} сом — ${a.values.for}`, card: { type: "invoice", data: { sum: Number(a.values.sum), for: a.values.for ?? "", until: new Date(Date.now() + 3 * 86_400_000).toISOString(), status: "waiting", link: "https://example.kg/pay/demo" } } });
    }
    return { ok: true };
  };

  const resend = async (fd: FormData) => {
    if (!active) return;
    const mid = String(fd.get("message_id"));
    patchMsg(active.id, mid, { delivery: "pending", deliveryError: null });
    await sleep(900);
    patchMsg(active.id, mid, { delivery: "sent" });
  };

  const dismiss = async () => { if (active) patchContact(active.id, { dismissedAt: new Date().toISOString() }); };

  const botAction = async (fd: FormData) => {
    if (!active) return;
    await sleep(300);
    const cmd = String(fd.get("command"));
    const hours = Number(fd.get("hours") ?? 0);
    setBot(active.id, cmd === "pause" ? { ...active.bot, mode: "manager", pausedUntil: new Date(Date.now() + hours * 3_600_000).toISOString() }
      : cmd === "resume" || cmd === "unmute" ? { ...active.bot, mode: "bot", pausedUntil: null }
      : { ...active.bot, mode: "muted" });
  };

  const memoryAction = async (fd: FormData) => {
    if (!active) return;
    await sleep(250);
    const key = String(fd.get("key"));
    const value = String(fd.get("value") ?? "");
    setMemory((m) => ({
      ...m,
      [active.id]: fd.get("remove") ? (m[active.id] ?? []).filter((f) => f.key !== key) : (m[active.id] ?? []).map((f) => (f.key === key ? { ...f, value, source: "admin" as const } : f)),
    }));
  };

  // Полоса под шапкой: статус, метки, ответственный
  const statusAction = async (fd: FormData) => {
    if (!active) return;
    await sleep(300);
    patchContact(active.id, { status: String(fd.get("status")) as DialogStatus, snoozedUntil: fd.get("until") ? String(fd.get("until")) : null, statusAt: new Date().toISOString() });
  };
  const tagsAction = async (fd: FormData) => {
    if (!active) return;
    await sleep(200);
    const tag = String(fd.get("tag"));
    const on = fd.get("on") === "1";
    patchContact(active.id, { tags: on ? [...new Set([...active.tags, tag])] : active.tags.filter((x) => x !== tag) });
  };
  const assignAction = async (fd: FormData) => {
    if (!active) return;
    await sleep(250);
    const uid = String(fd.get("user_id") ?? "");
    patchContact(active.id, { assignee: MANAGERS.find((m) => m.id === uid) ?? null });
  };

  // ИИ понарошку
  const transcribeAction = async (fd: FormData): Promise<AiAnswer> => {
    await sleep(1200);
    const text = TRANSCRIPTS[String(fd.get("attachment_id"))];
    return text ? { text } : { text: "(пример расшифровки) Здравствуйте, подскажите, пожалуйста, свободное время на завтра." };
  };
  const summaryAction = async (): Promise<AiAnswer> => { await sleep(1300); return active ? fakeSummary(active.name, messages) : { error: "Нет диалога" }; };
  const improveAction = async (fd: FormData): Promise<AiAnswer> => { await sleep(700); return { text: fakeImprove(String(fd.get("text") ?? ""), String(fd.get("mode") ?? "polish")) }; };

  // Клиент пишет понарошку — чтобы услышать звонок «ждёт ответа»
  const simulate = () => {
    const target = contacts.find((c) => c.id !== active?.id && c.id === "4") ?? contacts.find((c) => c.id !== active?.id)!;
    push(target.id, { id: `m${++counter}`, at: new Date().toISOString(), kind: "message", author: { type: "client" }, channel: target.channel, text: "Здравствуйте! Подскажите, когда можно подъехать?" });
    patchContact(target.id, { unread: target.unread + 1 });
  };
  // Коллега пишет ответ в открытом диалоге — «Бакыт пишет ответ…» на 25 секунд
  const colleague = () => {
    if (!active) return;
    const p: Presence = { userId: "u2", name: "Бакыт", state: "typing", at: new Date().toISOString() };
    setPresence((x) => ({ ...x, [active.id]: [p] }));
    setTimeout(() => setPresence((x) => ({ ...x, [active.id]: [] })), 25_000);
  };

  const waitList: WaitEpisode[] = all.filter((d) => d.waitSince).map((d) => ({ key: waitKey(d.id, d.waitSince!), contactId: d.id, name: d.name, text: d.last?.text ?? "" }));

  const rotate = async (f: ViewFile, deg: number) => {
    await sleep(500);
    const nextTurn = ((versions[f.id] ?? 0) + deg) % 360;
    setVersions((v) => ({ ...v, [f.id]: nextTurn }));
    return { ok: true, version: `r${nextTurn}` };
  };

  const canTeach = viewer === "owner" || viewer === "manager-teach";
  const t = profile.texts;

  const side: ReactNode = active ? (
    <div className="demo-side">
      <h3>Место проекта: {profile.words.order.one}</h3>
      <div className="demo-kv"><span>Услуга</span><span>Консультация</span></div>
      <div className="demo-kv"><span>Этап</span><span>Ждём визита</span></div>
      <div className="demo-kv"><span>Сумма</span><span className="ck-mono">1 500 сом</span></div>
      <p style={{ color: "var(--ck-muted)", fontSize: 12 }}>Эту панель рисует сам проект: {profile.words.order.one} {profile.words.client.of}, запись, заказ.</p>
    </div>
  ) : null;

  const seg = <T extends string>(value: T, set: (v: T) => void, items: readonly (readonly [T, string])[]) => (
    <span className="ck-seg">
      {items.map(([v, l]) => <button key={v} type="button" className="ck-seg__item" aria-pressed={value === v} onClick={() => set(v)}>{l}</button>)}
    </span>
  );

  return (
    <div className="demo">
      <style>{profileCss(profile, ':root:not([data-ck-theme="dark"])')}</style>
      <div className="demo-bar ck">
        <span className="demo-bar__title">chat-kit · демо</span>
        <span className="demo-bar__group">Слова: {seg(words, setWords, [["client", "Клиент"], ["patient", "Пациент"], ["candidate", "Кандидат"]] as const)}</span>
        <span className="demo-bar__group">Тема: {seg(mode, setMode, [["light", "Светлая"], ["dark", "Тёмная"]] as const)}</span>
        <span className="demo-bar__group">Цвет: {seg(accent, setAccent, [["blue", "Синий"], ["green", "Зелёный"], ["violet", "Фиолетовый"]] as const)}</span>
        <span className="demo-bar__group">Кто смотрит: {seg(viewer, setViewer, [["owner", "Владелец"], ["manager", "Менеджер"], ["manager-teach", "Менеджер с доступом к обучению"]] as const)}</span>
        <NotifyToggle />
        <button type="button" className="ck-btn ck-btn--sm" onClick={simulate}>{t.alertClientWrote} (проверить звонок)</button>
        <button type="button" className="ck-btn ck-btn--sm" onClick={colleague}>Коллега пишет ответ</button>
      </div>
      <div className="demo-main" onSubmitCapture={(e) => {
        const form = e.target as HTMLFormElement;
        if (form.getAttribute("role") !== "search") return;
        e.preventDefault();
        const q = new FormData(form).get("q");
        const sp = new URLSearchParams(location.search);
        if (q) sp.set("q", String(q)); else sp.delete("q");
        sp.delete("dialog");
        go(`/?${sp.toString()}`);
      }}>
        <ChatWindow
          profile={profile}
          meId={ME.id}
          now={now}
          Link={Link}
          picked={!!url.dialog}
          side={side}
          list={{
            dialogs: shown,
            activeId: active?.id ?? null,
            hrefFor: (d) => { const sp = new URLSearchParams(location.search); sp.set("dialog", d.id); return `/?${sp.toString()}`; },
            link,
            filter: url.filter,
            status: url.status,
            tag: url.tag,
            channel: url.channel,
            counts: {
              wait: all.filter(byStatus).filter((d) => d.waitSince).length,
              unread: contacts.reduce((s, c) => s + c.unread, 0),
              mine: all.filter(byStatus).filter((d) => d.assignee?.id === ME.id).length,
              status: { snoozed: all.filter((d) => d.status === "snoozed").length, closed: all.filter((d) => d.status === "closed").length },
              channels: all.reduce<Record<string, number>>((acc, d) => { const k = d.channel ?? "nextbot"; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {}),
            },
            search: { action: "/", value: url.q },
            hasMore: visible.length > shown.length,
            moreLabel: `Показать ещё — сейчас ${shown.length}`,
          }}
          dialog={active ? {
            id: active.id,
            name: active.name,
            channel: active.channel,
            contact: active.contact,
            note: active.channel !== "email" ? "сообщения идут в CRM" : null,
            cardHref: "#карточка",
            backHref: link({}),
            bot: { state: active.bot, action: botAction },
            teach: canTeach ? {
              rate: async (fd) => { await sleep(300); setRated((r) => ({ ...r, [String(fd.get("message_id"))]: String(fd.get("rating")) as Rating })); },
              example: async (fd) => { await sleep(300); setExamples((x) => [...x, String(fd.get("message_id"))]); },
              rated,
              examples,
            } : null,
            copilot: lastChat && fromClient(lastChat) ? { text: suggestReply(lastChat.text, active.name) } : null,
            memory: { facts: (memory[active.id] ?? []) as MemoryFact[], action: canTeach ? memoryAction : undefined },
            messages,
            status: statusOf(active),
            snoozedUntil: active.snoozedUntil ?? null,
            tags: active.tags,
            assignee: active.assignee,
            managers: MANAGERS as Assignee[],
            assessment: active.assessment ?? null,
            presence: presence[active.id] ?? [],
            statusAction, tagsAction, assignAction,
            summaryAction, transcribeAction, improveAction,
            onAction,
            older: (older[active.id]?.length ?? 0) > 0 ? {
              load: async () => {
                await sleep(700);
                const extra = older[active.id] ?? [];
                setOlder((o) => ({ ...o, [active.id]: [] }));
                setThreads((th) => ({ ...th, [active.id]: [...extra, ...(th[active.id] ?? [])] }));
              },
            } : null,
            thread: {
              resendAction: resend,
              onRotate: rotate,
              canRotate: () => true,
              canListen: true,
              renderAttachmentExtra: (m, a) => (a.mime.startsWith("image/") || a.mime === "application/pdf"
                ? <div style={{ display: "flex", justifyContent: fromClient(m) ? "flex-start" : "flex-end", margin: "0 0 6px" }}>
                    {pinned[a.id]
                      ? <span className="ck-badge ck-badge--ok">✓ в документах: {pinned[a.id]}</span>
                      : <span className="ck-badge">место проекта: «+ В документы»</span>}
                  </div>
                : null),
              viewerPanel: (_m, a) => (
                <div className="demo-pin">
                  <strong style={{ fontSize: 13 }}>Куда положить</strong>
                  <span style={{ fontSize: 12, color: "var(--ck-muted)" }}>Место для кнопок проекта: в какую папку документов положить файл.</span>
                  {["Документы", "Договоры", "Без папки — в «Другие файлы»"].map((doc) => (
                    <button key={doc} type="button" className={`ck-btn ck-btn--sm${pinned[a.id] === doc ? " ck-btn--on" : ""}`} onClick={() => setPinned((p) => ({ ...p, [a.id]: doc }))}>{doc}</button>
                  ))}
                </div>
              ),
            },
            waitSince: since,
            handoff: !!lastChat?.handoff,
            dismissAction: dismiss,
            composer: {
              action: send,
              channel: active.channel,
              live: active.channel !== "email",
              emailTo: active.email ?? null,
              replySubject: active.channel === "email" ? [...messages].reverse().find((m) => fromClient(m) && m.subject)?.subject ?? null : null,
              templates: TEMPLATES.map((x) => (x.label === "Проверка: не доставится" ? { ...x, text: "Проверка: ошибка доставки" } : x)),
              templateGroups: { order: `По ${profile.words.order.to} ${profile.words.client.of}` },
              templatesHref: "#настройки",
              files: { upload: true, hint: `PDF, JPG или PNG до 10 МБ — уйдёт ${profile.words.client.to}`, projectTitle: `Из ${profile.words.order.of} ${profile.words.client.of}`, project: PROJECT_FILES },
            },
          } : null}
        />
      </div>
      <WaitAlerts waitList={waitList} delay={0} isOpen={(cid) => cid === active?.id} onOpen={(cid) => go(`/?dialog=${cid}`)} clientWrote={t.alertClientWrote} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
