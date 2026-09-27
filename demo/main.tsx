import { StrictMode, useCallback, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "../src/ui/styles.css";
import "./demo.css";
import {
  fileWords, fromClient, readComposerForm, sortMessages, textMatches, waitKey, waitSince,
  type BotState, type ChatMessage, type DialogSummary,
} from "../src/core/index.js";
import {
  BotControls, BotDraft, BotFeedback, ChatWindow, Composer, NotifyToggle, WaitAlerts,
  type LinkLike, type ListFilter, type ViewFile, type WaitEpisode,
} from "../src/ui/index.js";
import { BOT_DRAFT, CONTACTS, DEAL_FILES, ME, TEMPLATES, THREADS, TZ, type DemoContact } from "./data.js";

// Демо-страница окна переписки: примерные данные, отправка и приход сообщений — понарошку, в памяти страницы.

type Theme = "atlas" | "tish" | "studio";
type BotVariant = "bar" | "buttons" | "none";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let counter = 1000;

function readUrl() {
  const sp = new URLSearchParams(location.search);
  return {
    dialog: sp.get("dialog"),
    filter: (sp.get("show") as ListFilter | null) ?? "all",
    channel: sp.get("channel"),
    q: sp.get("q") ?? "",
    n: Number(sp.get("n") ?? 5) || 5,
  };
}

function App() {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem("demo.theme") as Theme | null) ?? "atlas");
  const [botVariant, setBotVariant] = useState<BotVariant>("bar");
  const [feedback, setFeedback] = useState(true);
  const [draft, setDraft] = useState(true);
  const [url, setUrl] = useState(readUrl);
  const [contacts, setContacts] = useState<DemoContact[]>(CONTACTS);
  const [threads, setThreads] = useState<Record<string, ChatMessage[]>>(THREADS);
  const [versions, setVersions] = useState<Record<string, number>>({});
  const [pinned, setPinned] = useState<Record<string, string>>({});
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem("demo.theme", theme); }, [theme]);
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

  // Строки списка: последнее сообщение, «ждёт ответа», непрочитанные — по правилам ядра
  const all: DialogSummary[] = useMemo(() => contacts.map((c) => {
    const list = sortMessages(threads[c.id] ?? []).filter((m) => m.kind === "message");
    const last = list[list.length - 1];
    const lastText = last ? (last.text && !(last.attachments?.length && last.text === last.attachments[0]?.name) ? last.text : last.attachments?.[0] ? fileWords(last.attachments[0]) : last.text) : "";
    return {
      id: c.id, name: c.name, channel: c.channel, subtitle: c.subtitle, unread: c.unread, bot: c.bot,
      waitSince: waitSince(threads[c.id] ?? [], c.dismissedAt),
      last: last ? { text: lastText, at: last.at, author: last.author } : null,
    };
  }).sort((a, b) => Date.parse(b.last?.at ?? "0") - Date.parse(a.last?.at ?? "0")), [contacts, threads]);

  const visible = all.filter((d) => (url.filter === "wait" ? !!d.waitSince : url.filter === "unread" ? (d.unread ?? 0) > 0 : true))
    .filter((d) => !url.channel || d.channel === url.channel)
    .filter((d) => !url.q || textMatches(d.name, url.q) || (threads[d.id] ?? []).some((m) => textMatches(m.text, url.q)));
  const shown = visible.slice(0, url.n);
  const active = contacts.find((c) => c.id === url.dialog) ?? contacts.find((c) => c.id === shown[0]?.id) ?? null;
  const messages = active ? withFiles(sortMessages(threads[active.id] ?? [])) : [];
  const since = active ? waitSince(messages, active.dismissedAt) : null;

  const link = (over: { filter?: ListFilter | undefined; channel?: string | null | undefined; more?: boolean | undefined }) => {
    const sp = new URLSearchParams();
    const filter = over.filter ?? url.filter;
    const channel = over.channel === undefined ? url.channel : over.channel;
    if (filter !== "all") sp.set("show", filter);
    if (channel) sp.set("channel", channel);
    if (url.q) sp.set("q", url.q);
    if (over.more) sp.set("n", String(url.n + 5));
    else if (url.n !== 5) sp.set("n", String(url.n));
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

  // Отправка понарошку: сообщение появляется сразу с часиками, потом галочка, две галочки, «прочитано»
  const send = async (fd: FormData) => {
    if (!active) return;
    const d = readComposerForm(fd);
    await sleep(700);
    const mid = `m${++counter}`;
    const failed = d.text.includes("ошибка доставки");
    const up = d.file ? { id: `up${counter}`, name: d.file.name, mime: d.file.type || "application/octet-stream", size: d.file.size, url: URL.createObjectURL(d.file) } : null;
    const proj = d.fileId ? messages.flatMap((m) => m.attachments ?? []).find((a) => a.id === d.fileId) ?? null : null;
    const att = up ?? proj;
    const msg: ChatMessage = {
      id: mid, at: new Date().toISOString(),
      kind: d.mode === "note" ? "note" : "message",
      author: d.mode === "copy" && d.direction === "in" ? { type: "client" } : { type: "operator_crm", name: ME.name, id: ME.id },
      channel: d.mode === "email" ? "email" : active.channel,
      text: d.text || att?.name || "",
      ...(d.subject ? { subject: d.subject } : {}),
      ...(d.mode === "send" || d.mode === "email" ? { delivery: failed ? "failed" : "sent" } : {}),
      ...(failed ? { deliveryError: "канал не принял сообщение (проверка)" } : {}),
      ...(att ? { attachments: [att] } : {}),
    };
    setThreads((t) => ({ ...t, [active.id]: [...(t[active.id] ?? []), msg] }));
    // Менеджер ответил сам — бот на паузе (как в плане студии: pauseOnManagerMessage)
    if (d.mode === "send" && active.bot.mode === "bot") {
      setContacts((cs) => cs.map((c) => (c.id === active.id ? { ...c, bot: { ...c.bot, mode: "manager", pausedUntil: new Date(Date.now() + 12 * 3_600_000).toISOString() } } : c)));
    }
    if (!failed && d.mode === "send") {
      setTimeout(() => patchMsg(active.id, mid, { delivery: "delivered" }), 1500);
      setTimeout(() => patchMsg(active.id, mid, { delivery: "read" }), 4000);
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

  const dismiss = async () => {
    if (!active) return;
    setContacts((cs) => cs.map((c) => (c.id === active.id ? { ...c, dismissedAt: new Date().toISOString() } : c)));
  };

  const botAction = async (fd: FormData) => {
    if (!active) return;
    await sleep(300);
    const cmd = String(fd.get("command"));
    const hours = Number(fd.get("hours") ?? 0);
    const next: BotState = cmd === "pause" ? { ...active.bot, mode: "manager", pausedUntil: new Date(Date.now() + hours * 3_600_000).toISOString() }
      : cmd === "resume" || cmd === "unmute" ? { ...active.bot, mode: "bot", pausedUntil: null }
      : { ...active.bot, mode: "muted" };
    setContacts((cs) => cs.map((c) => (c.id === active.id ? { ...c, bot: next } : c)));
  };

  // Клиент пишет понарошку — чтобы услышать звонок «ждёт ответа»
  const simulate = () => {
    const target = contacts.find((c) => c.id !== active?.id && c.id === "4") ?? contacts.find((c) => c.id !== active?.id)!;
    const msg: ChatMessage = { id: `m${++counter}`, at: new Date().toISOString(), kind: "message", author: { type: "client" }, channel: target.channel, text: "Здравствуйте! Подскажите, когда можно подъехать в офис?" };
    setThreads((t) => ({ ...t, [target.id]: [...(t[target.id] ?? []), msg] }));
    setContacts((cs) => cs.map((c) => (c.id === target.id ? { ...c, unread: c.unread + 1 } : c)));
  };

  const waitList: WaitEpisode[] = all.filter((d) => d.waitSince).map((d) => ({ key: waitKey(d.id, d.waitSince!), contactId: d.id, name: d.name, text: d.last?.text ?? "" }));

  const fmtUntil = (iso: string) => new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

  const rotate = async (f: ViewFile, deg: number) => {
    await sleep(500);
    const nextTurn = ((versions[f.id] ?? 0) + deg) % 360;
    setVersions((v) => ({ ...v, [f.id]: nextTurn }));
    return { ok: true, version: `r${nextTurn}` };
  };

  const composer = active ? {
    action: send,
    channel: active.channel,
    live: active.channel !== "email",
    emailTo: active.email ?? null,
    replySubject: active.channel === "email" ? [...messages].reverse().find((m) => fromClient(m) && m.subject)?.subject ?? null : null,
    templates: TEMPLATES.map((t) => (t.label === "Проверка: не доставится" ? { ...t, text: "Проверка: ошибка доставки" } : t)),
    templateGroups: { deal: "По сделке клиента" },
    templatesHref: "#настройки",
    files: { upload: true, hint: "PDF, JPG или PNG до 10 МБ — уйдёт клиенту", projectTitle: "Из сделки", project: DEAL_FILES },
  } : null;

  const side: ReactNode = active ? (
    <div className="demo-side">
      <h3>Место проекта: сделка</h3>
      <div className="demo-kv"><span>Воронка</span><span>Трудоустройство</span></div>
      <div className="demo-kv"><span>Этап</span><span>Сбор документов</span></div>
      <div className="demo-kv"><span>Сумма</span><span className="ck-mono">45 000 сом</span></div>
      <p style={{ color: "var(--ck-muted)", fontSize: 12 }}>Эту панель рисует сам проект (у Атласа — сделка, у TishCRM — запись к врачу).</p>
    </div>
  ) : null;

  return (
    <div className="demo">
      <div className="demo-bar ck">
        <span className="demo-bar__title">chat-kit · демо</span>
        <span className="demo-bar__group">Тема:
          <span className="ck-seg">
            {(["atlas", "tish", "studio"] as const).map((t) => (
              <button key={t} type="button" className="ck-seg__item" aria-pressed={theme === t} onClick={() => setTheme(t)}>
                {t === "atlas" ? "Атлас" : t === "tish" ? "TishCRM" : "Студия"}
              </button>
            ))}
          </span>
        </span>
        <span className="demo-bar__group">Кнопки бота:
          <span className="ck-seg">
            {([["bar", "А · полоса"], ["buttons", "Б · в шапке"], ["none", "нет"]] as const).map(([v, l]) => (
              <button key={v} type="button" className="ck-seg__item" aria-pressed={botVariant === v} onClick={() => setBotVariant(v)}>{l}</button>
            ))}
          </span>
        </span>
        <label className="demo-bar__group"><input type="checkbox" checked={feedback} onChange={(e) => setFeedback(e.target.checked)} /> оценка ответов бота</label>
        <label className="demo-bar__group"><input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} /> черновик ответа от бота</label>
        <NotifyToggle />
        <button type="button" className="ck-btn ck-btn--sm" onClick={simulate}>Клиент пишет (проверить звонок)</button>
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
          timeZone={TZ}
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
            channel: url.channel,
            counts: {
              wait: all.filter((d) => d.waitSince).length,
              unread: contacts.reduce((s, c) => s + c.unread, 0),
              channels: all.reduce<Record<string, number>>((acc, d) => { const k = d.channel ?? "nextbot"; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {}),
            },
            search: { action: "/", value: url.q },
            hasMore: visible.length > shown.length,
            moreLabel: `Показать ещё — сейчас ${shown.length}`,
            meId: ME.id,
          }}
          dialog={active ? {
            id: active.id,
            name: active.name,
            channel: active.channel,
            contact: active.contact,
            note: active.channel !== "email" ? "сообщения идут в CRM" : null,
            cardHref: "#карточка-клиента",
            backHref: link({}),
            headerActions: botVariant === "buttons" ? <BotControls state={active.bot} action={botAction} variant="buttons" fmtUntil={fmtUntil} /> : null,
            above: botVariant === "bar" ? <BotControls state={active.bot} action={botAction} fmtUntil={fmtUntil} /> : null,
            messages,
            thread: {
              meId: ME.id,
              resendAction: resend,
              onRotate: rotate,
              canRotate: () => true,
              renderActions: feedback ? (m) => (m.author.type === "bot" && m.kind === "message" ? <BotFeedback messageId={m.id} action={async () => { await sleep(300); }} /> : null) : undefined,
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
                  <span style={{ fontSize: 12, color: "var(--ck-muted)" }}>Место для кнопок проекта (у Атласа — пункт чек-листа сделки).</span>
                  {["Паспорт", "Диплом", "Без пункта — в «Другие файлы»"].map((doc) => (
                    <button key={doc} type="button" className={`ck-btn ck-btn--sm${pinned[a.id] === doc ? " ck-btn--on" : ""}`} onClick={() => setPinned((p) => ({ ...p, [a.id]: doc }))}>{doc}</button>
                  ))}
                </div>
              ),
            },
            waitSince: since,
            handoff: !!messages.filter((m) => m.kind === "message").at(-1)?.handoff,
            dismissAction: dismiss,
            composerNode: composer && draft && since ? (
              <Composer key={`${active.id}-draft`} {...composer} above={(insert) => <BotDraft text={BOT_DRAFT} onInsert={insert} sendAction={async (fd) => { await send(fd); }} />} />
            ) : undefined,
            composer,
            findMoreHref: null,
          } : null}
        />
      </div>
      <WaitAlerts waitList={waitList} delay={0} isOpen={(cid) => cid === active?.id} onOpen={(cid) => go(`/?dialog=${cid}`)} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
