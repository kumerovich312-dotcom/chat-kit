"use client";

import { useEffect, useLayoutEffect, useRef, useState, useTransition, type ReactNode } from "react";
import type { AiAnswer, ComposerMode, SendResult, Template } from "../core/composer.js";
import type { Presence } from "../core/conversation.js";
import { channelLabel as labelOf } from "../core/channels.js";
import { DEFAULT_TEXTS, fill, type ComposerAction, type Texts } from "../core/profile.js";
import { ChannelIcon } from "./bits.js";
import { BoltIcon, ClipIcon, CloseIcon, MicIcon, PencilIcon, PlusIcon, ReplyIcon, SendIcon, WandIcon } from "./icons.js";
import { usePending } from "./Pending.js";
import { BotDraft } from "./Bot.js";
import { QuickForm, QuickMenu } from "./QuickActions.js";
import { RecorderBar, useRecorder, type Recording } from "./Recorder.js";
import { presenceLine } from "./Strip.js";

/* Поле ввода — как в мессенджере: Enter отправляет, Shift+Enter — новая строка, сообщение сразу видно
   в ленте с часиками, курсор остаётся в поле. Вкладки над полем — по желанию проекта:
   «Клиенту» — ответ уходит в мессенджер, откуда клиент написал; «В историю» — клиент пишет не через подключённый канал:
   сохраняем копию (нашу реплику или ответ клиента); «Заметка» — только для команды; «Письмо» — на почту клиента
   (Enter — новая строка, Ctrl+Enter — отправить). Шаблоны — под молнией, файлы — под скрепкой (с компьютера или файл
   проекта), снимок экрана можно вставить из буфера. Ошибка — текст возвращается в поле, причина — под полем.
   Ещё (решения пользователя 27.09.2026): ответ с цитатой («Ответить» у сообщения в ленте), запись голосового
   (микрофон, пока поле пустое), «Улучшить текст» (ИИ), свои кнопки проекта — меню «+», «Айгерим уже пишет ответ» —
   чтобы не ответить клиенту вдвоём.

   Отправка — одна форма (FormData: mode, channel, direction, text, subject, file, file_id, reply_to, voice): годится и
   серверному действию Next.js, и обычной функции. Прочитать её — readComposerForm из ядра. */

export type ProjectFile = { id: string; name: string; size?: string | undefined };

type FormAction = (form: FormData) => void | Promise<void>;

export type ComposerProps = {
  /** Отправить: форма поля ввода → { error } — поле покажет причину и вернёт текст */
  action: (form: FormData) => Promise<SendResult>;
  /** Канал диалога и есть ли связь с клиентом через подключение (иначе вместо «Клиенту» — «В историю») */
  channel: string;
  channelLabel?: string | undefined;
  live: boolean;
  /** Почта клиента — вкладка «Письмо»; тема ответа на его письмо — «Re: …» и вкладка «Письмо» сразу */
  emailTo?: string | null | undefined;
  replySubject?: string | null | undefined;
  /** Только заметки — роль переписку не ведёт */
  noteOnly?: boolean | undefined;
  /** Какие вкладки показать (по умолчанию — все подходящие) */
  modes?: readonly ComposerMode[] | undefined;
  templates?: readonly Template[] | undefined;
  /** Подписи разделов шаблонов: { order: "По заказу клиента" } */
  templateGroups?: Readonly<Record<string, string>> | undefined;
  /** «Свои шаблоны — в настройках» */
  templatesHref?: string | null | undefined;
  /** Файлы клиенту: с компьютера (upload) и/или файлы проекта (документы из заявки клиента) */
  files?: {
    upload?: boolean | undefined;
    accept?: string | undefined;
    maxBytes?: number | undefined;
    hint?: string | undefined;
    projectTitle?: string | undefined;
    project?: readonly ProjectFile[] | undefined;
  } | undefined;
  initialText?: string | undefined;
  autoFocus?: boolean | undefined;
  /** «Второй пилот»: ответ, который предлагает бот на последнее сообщение клиента (показывается, пока его не скрыли).
   *  sendAction — «Отправить как есть» (по умолчанию — то же действие, что у поля) */
  copilot?: { text: string; title?: string | undefined; sendAction?: ((form: FormData) => Promise<SendResult>) | undefined } | null | undefined;
  /** Своё над полем — получает функцию «вставить текст в поле» (только из браузерного кода) */
  above?: ((insert: (text: string) => void) => ReactNode) | undefined;
  /** Надписи со словами отрасли (паспорт проекта) */
  t?: Texts | undefined;
  /** Запись голосового из браузера (нужна отправка файлов с компьютера) */
  voice?: boolean | undefined;
  /** «Улучшить текст»: форма text, mode (polish / shorter / friendlier / fix), channel → { text } или { error } */
  improveAction?: ((form: FormData) => Promise<AiAnswer>) | undefined;
  /** Свои кнопки проекта — меню «+» (паспорт: actions) и действие для кнопок с формой */
  actions?: readonly ComposerAction[] | undefined;
  onAction?: ((form: FormData) => Promise<SendResult>) | undefined;
  /** Подстановки в текст кнопок: { client: "Айбек", id: "15" } */
  actionVars?: Readonly<Record<string, string>> | undefined;
  /** «Я пишу ответ» — раз в 5 секунд, пока сотрудник набирает (форма state=typing); проект разносит коллегам */
  typing?: FormAction | undefined;
  /** Кто из коллег сейчас в диалоге — «Айгерим уже пишет ответ» над полем */
  presence?: readonly Presence[] | undefined;
  meId?: string | null | undefined;
  /** Ответ с цитатой: «Ответить» у сообщений ленты (по умолчанию — да) */
  replies?: boolean | undefined;
};

type Staged = { kind: "upload"; file: File; name: string; voice?: boolean } | { kind: "project"; id: string; name: string };
type Reply = { id: string; who: string; text: string };

const DEFAULT_MAX = 10 * 1024 * 1024;
const IMPROVE_MODES: readonly { mode: string; label: string }[] = [
  { mode: "polish", label: "Улучшить" },
  { mode: "fix", label: "Исправить ошибки" },
  { mode: "shorter", label: "Короче" },
  { mode: "friendlier", label: "Дружелюбнее" },
];

export function Composer(p: ComposerProps) {
  const t = p.t ?? DEFAULT_TEXTS;
  const label = p.channelLabel ?? labelOf(p.channel);
  const noteTab = { key: "note" as const, label: t.tabNote, about: t.tabNoteAbout };
  const all: { key: ComposerMode; label: string; about: string }[] = p.noteOnly ? [noteTab] : [
    p.live
      ? { key: "send", label: t.tabSend, about: fill(t.tabSendAbout, { channel: label }) }
      : { key: "copy", label: t.tabCopy, about: t.tabCopyAbout },
    noteTab,
    ...(p.emailTo ? [{ key: "email" as const, label: t.tabEmail, about: `на почту ${p.emailTo}` }] : []),
  ];
  const tabs = p.modes ? all.filter((x) => p.modes!.includes(x.key)) : all;
  // Ответ на письмо — письмом, с той же темой: так клиент увидит его в той же цепочке писем
  const reSubject = !p.replySubject ? "" : /^(re|ответ|отв)\s*:/i.test(p.replySubject) ? p.replySubject : `Re: ${p.replySubject}`;
  const first = tabs[0]?.key ?? "note";
  const [mode, setMode] = useState<ComposerMode>(p.replySubject != null && tabs.some((x) => x.key === "email") ? "email" : first);
  const [text, setText] = useState(p.initialText ?? "");
  const [subject, setSubject] = useState(reSubject);
  const [dir, setDir] = useState<"out" | "in">("out");
  const [staged, setStaged] = useState<Staged | null>(null);
  const [menu, setMenu] = useState<"files" | "templates" | "actions" | "improve" | null>(null);
  const [quick, setQuick] = useState<ComposerAction | null>(null);
  const [reply, setReply] = useState<Reply | null>(null);
  const [undo, setUndo] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [touch, setTouch] = useState(false);
  const [improving, startImprove] = useTransition();
  const [, start] = useTransition();
  const { add } = usePending();
  const recorder = useRecorder();
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const lastPing = useRef(0);

  const f = p.files;
  const canFiles = mode === "send" && !!f && (!!f.upload || (f.project?.length ?? 0) > 0);
  const canVoice = mode === "send" && !!p.voice && !!f?.upload;
  const ready = !!text.trim() || (mode === "send" && !!staged);
  const sendLabel = mode === "send" ? t.sendToClient : mode === "copy" ? "Сохранить в историю" : mode === "note" ? "Сохранить заметку" : "Отправить письмо";
  const vars = p.actionVars ?? {};
  const recording = recorder.phase.kind === "rec" || recorder.phase.kind === "ready";
  const colleague = presenceLine(p.presence ?? [], p.meId, Date.now());

  // Поле растёт вместе с текстом, дальше — прокрутка внутри
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + 1, 180)}px`;
    // Полоса прокрутки — только когда текст не влез в 180 px (иначе дробные пиксели строки рисуют лишнюю полосу)
    el.style.overflowY = el.scrollHeight > 180 ? "auto" : "hidden";
  }, [text, mode, staged, recording]);

  useEffect(() => { if (p.autoFocus) area.current?.focus(); }, [p.autoFocus]);
  // На телефоне Enter — новая строка, отправка — кнопкой (как в мобильных мессенджерах)
  useEffect(() => { setTouch(window.matchMedia?.("(pointer: coarse)").matches ?? false); }, []);
  // Меню закрываются щелчком мимо и Esc
  useEffect(() => {
    if (!menu) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setMenu(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [menu]);
  // «Ответить» у сообщения в ленте (лента может быть серверной — слушаем щелчки на странице)
  useEffect(() => {
    if (p.replies === false) return;
    const onClick = (e: MouseEvent) => {
      const b = (e.target as Element | null)?.closest?.("[data-ck-reply]");
      if (!b) return;
      e.preventDefault();
      setReply({ id: b.getAttribute("data-ck-reply") ?? "", who: b.getAttribute("data-ck-reply-who") ?? "", text: b.getAttribute("data-ck-reply-text") ?? "" });
      setMode((m) => (m === "note" || m === "copy" ? first : m));
      area.current?.focus();
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [p.replies, first]);
  // Ошибка микрофона — под полем
  useEffect(() => { if (recorder.phase.kind === "error") setError(recorder.phase.message); }, [recorder.phase]);

  const stageFile = (file: File, voice = false) => {
    const max = f?.maxBytes ?? DEFAULT_MAX;
    if (file.size > max) { setError(`Файл больше ${Math.round(max / 1024 / 1024)} МБ — сожмите его или разбейте на части`); return false; }
    setStaged({ kind: "upload", file, name: file.name || "файл", voice });
    setError("");
    return true;
  };

  const insert = (x: string) => { setText(x); setMenu(null); area.current?.focus(); };
  const [hidden, setHidden] = useState<string | null>(null);
  const copilot = p.copilot && p.copilot.text.trim() && hidden !== p.copilot.text ? p.copilot : null;

  const ping = () => {
    if (!p.typing || Date.now() - lastPing.current < 5000) return;
    lastPing.current = Date.now();
    const fd = new FormData();
    fd.set("state", "typing");
    void Promise.resolve(p.typing(fd)).catch(() => {});
  };

  const submit = (voiceFile?: File) => {
    const body = text.trim();
    const file: Staged | null = voiceFile ? { kind: "upload", file: voiceFile, name: voiceFile.name, voice: true } : mode === "send" ? staged : null;
    if (!body && !file) return;
    const fd = new FormData();
    fd.set("mode", mode);
    fd.set("channel", mode === "email" ? "email" : p.channel);
    fd.set("direction", mode === "copy" ? dir : "out");
    fd.set("text", voiceFile ? "" : body);
    if (mode === "email") fd.set("subject", subject.trim());
    if (file?.kind === "upload") fd.set("file", file.file);
    if (file?.kind === "upload" && file.voice) fd.set("voice", "1");
    if (file?.kind === "project") fd.set("file_id", file.id);
    if (reply && (mode === "send" || mode === "email")) fd.set("reply_to", reply.id);
    const pending = {
      key: `${Date.now()}-${Math.random()}`,
      text: voiceFile ? "" : body,
      file: file ? (file.kind === "upload" && file.voice ? "Голосовое сообщение" : file.name) : null,
      kind: mode === "note" ? ("note" as const) : mode === "copy" && dir === "in" ? ("in" as const) : ("out" as const),
      status: mode === "send" || mode === "email" ? "отправляется" : "сохраняется",
    };
    // Поле очищается сразу — можно писать следующее, пока это уходит
    const sentSubject = subject;
    const sentReply = reply;
    if (!voiceFile) {
      setText("");
      setSubject(reSubject);
      setStaged(null);
    }
    setReply(null);
    setUndo(null);
    setMenu(null);
    setError("");
    setNote("");
    area.current?.focus();
    const restore = (msg: string) => {
      setError(msg);
      if (voiceFile) { setStaged((s) => s ?? { kind: "upload", file: voiceFile, name: voiceFile.name, voice: true }); return; }
      setText((x) => x || body);
      if (mode === "email") setSubject(sentSubject);
      if (file) setStaged((s) => s ?? file);
      if (sentReply) setReply((r) => r ?? sentReply);
    };
    start(async () => {
      add(pending);
      try {
        const r = await p.action(fd);
        if (r && r.error) restore(r.error);
      } catch {
        restore("Не отправилось: нет связи с сервером. Текст вернули в поле — отправьте ещё раз.");
      }
    });
  };

  const sendVoice = (rec: Recording) => {
    const name = `Голосовое ${new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }).replace(":", "-")}.${rec.ext}`;
    const file = new File([rec.blob], name, { type: rec.mime });
    const max = f?.maxBytes ?? DEFAULT_MAX;
    if (file.size > max) { setError(`Голосовое больше ${Math.round(max / 1024 / 1024)} МБ — запишите покороче`); return; }
    submit(file);
  };

  const improve = (m: string) => startImprove(async () => {
    setMenu(null);
    if (!p.improveAction || !text.trim()) return;
    const before = text;
    const fd = new FormData();
    fd.set("text", text.trim());
    fd.set("mode", m);
    fd.set("channel", mode === "email" ? "email" : p.channel);
    try {
      const r = await p.improveAction(fd);
      if (r.text?.trim()) { setText(r.text.trim()); setUndo(before); setError(""); }
      else setError(r.error ?? "Не получилось улучшить текст");
    } catch {
      setError("Нет связи с сервером — попробуйте ещё раз");
    }
    area.current?.focus();
  });

  const pickAction = (a: ComposerAction) => {
    setMenu(null);
    if (a.kind === "insert") insert(fill(a.text ?? "", vars));
    else if (a.kind === "link" && a.href) window.open(fill(a.href, vars), "_blank", "noopener,noreferrer");
    else if (a.kind === "form") setQuick(a);
  };

  const placeholder =
    mode === "note" ? t.notePlaceholder
    : mode === "email" ? "Текст письма…"
    : mode === "copy" ? (dir === "in" ? t.copyInPlaceholder : t.copyOutPlaceholder)
    : staged ? "Подпись к файлу (можно без неё)"
    : "Сообщение…";

  const showMic = canVoice && !ready && !recording;
  let lastGroup: string | undefined;
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="ck-composer">
      {copilot ? (
        <BotDraft text={copilot.text} title={copilot.title ?? t.copilotTitle} onInsert={insert} onHide={() => setHidden(copilot.text)}
          sendAction={async (fd) => { fd.set("channel", p.channel); fd.set("direction", "out"); setHidden(copilot.text); await (copilot.sendAction ?? p.action)(fd); }} />
      ) : null}
      {quick && p.onAction ? (
        <QuickForm action={quick} vars={vars} onAction={p.onAction}
          onClose={(done) => { setQuick(null); if (done) setNote(`«${quick.label}» — готово`); area.current?.focus(); }} />
      ) : null}
      {p.above?.(insert)}
      {colleague?.typing ? <div className="ck-colleague" role="status"><PencilIcon /> {colleague.text}</div> : null}
      <div className="ck-composer__bar">
        {tabs.length > 1 || mode === "copy" ? (
          <div className="ck-seg" role="group" aria-label="Куда пишем">
            {tabs.map((x) => (
              <button key={x.key} type="button" title={x.about} aria-pressed={mode === x.key} className="ck-seg__item"
                onClick={() => { setMode(x.key); setMenu(null); setError(""); area.current?.focus(); }}>
                {x.key === "send" ? <ChannelIcon channel={p.channel} size={14} /> : null}
                {x.label}
              </button>
            ))}
          </div>
        ) : null}
        {mode === "copy" && (
          <div className="ck-seg" role="group" aria-label="Кто написал" style={{ marginLeft: "auto" }}>
            {(["out", "in"] as const).map((d) => (
              <button key={d} type="button" aria-pressed={dir === d} className="ck-seg__item" onClick={() => { setDir(d); area.current?.focus(); }}>
                {d === "out" ? t.dirOut : t.dirIn}
              </button>
            ))}
          </div>
        )}
      </div>

      {reply && (mode === "send" || mode === "email") ? (
        <div className="ck-replybar">
          <ReplyIcon />
          <span className="ck-replybar__body">
            <span className="ck-replybar__who">{reply.who || t.replyTo}</span>
            <span className="ck-replybar__text">{reply.text}</span>
          </span>
          <button type="button" className="ck-iconbtn" style={{ width: 24, height: 24 }} aria-label="Не отвечать на это сообщение" onClick={() => setReply(null)}><CloseIcon /></button>
        </div>
      ) : null}

      <div ref={box} style={{ position: "relative" }}>
        {menu === "templates" && (
          <div className="ck-pop ck-scroll">
            <div className="ck-pop__head">Шаблоны — текст подставится в поле</div>
            {(p.templates ?? []).map((x, i) => {
              const head = x.group !== lastGroup && x.group && p.templateGroups?.[x.group];
              lastGroup = x.group;
              return (
                <div key={`${x.group ?? ""}-${x.label}-${i}`}>
                  {head ? <div className="ck-pop__head ck-pop__sep">{head}</div> : null}
                  <button type="button" className="ck-pop__item" onClick={() => insert(x.text)}>
                    <span className="ck-pop__title">{x.label}</span>
                    <span className="ck-pop__sub">{x.text.split("\n")[0]}</span>
                  </button>
                </div>
              );
            })}
            {p.templatesHref ? <a href={p.templatesHref} className="ck-pop__item ck-pop__sep ck-link" style={{ display: "block" }}>Свои шаблоны — в настройках</a> : null}
          </div>
        )}
        {menu === "files" && f && (
          <div className="ck-pop ck-scroll">
            {f.upload && (
              <button type="button" className="ck-pop__item" onClick={() => picker.current?.click()}>
                <span className="ck-pop__title">С компьютера…</span>
                <span className="ck-pop__sub">{f.hint ?? t.fileHint}</span>
              </button>
            )}
            {(f.project?.length ?? 0) > 0 && <div className="ck-pop__head">{f.projectTitle ?? t.projectFiles}</div>}
            {(f.project ?? []).map((x) => (
              <button key={x.id} type="button" className="ck-pop__item" style={{ display: "flex", gap: 8, alignItems: "baseline" }}
                onClick={() => { setStaged({ kind: "project", id: x.id, name: x.name }); setMenu(null); setError(""); area.current?.focus(); }}>
                <span className="ck-pop__title" style={{ flex: 1, minWidth: 0 }}>{x.name}</span>
                {x.size ? <span className="ck-mono" style={{ color: "var(--ck-muted)", fontSize: "var(--ck-text-xs)" }}>{x.size}</span> : null}
              </button>
            ))}
          </div>
        )}
        {menu === "actions" && (p.actions?.length ?? 0) > 0 && <QuickMenu actions={p.actions!} vars={vars} onPick={pickAction} />}
        {menu === "improve" && (
          <div className="ck-pop ck-pop--right">
            <div className="ck-pop__head">{t.improve}</div>
            {IMPROVE_MODES.map((x) => <button key={x.mode} type="button" className="ck-pop__item" onClick={() => improve(x.mode)}>{x.label}</button>)}
          </div>
        )}
        {f?.upload && (
          <input ref={picker} type="file" accept={f.accept ?? "application/pdf,image/jpeg,image/png"} hidden tabIndex={-1}
            onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; setMenu(null); if (file) stageFile(file); area.current?.focus(); }} />
        )}

        {recording ? (
          <RecorderBar r={recorder} onSend={sendVoice} />
        ) : (
          <div className={`ck-field${mode === "note" ? " ck-field--note" : ""}`}>
            {(p.actions?.length ?? 0) > 0 && p.onAction && mode !== "note" && (
              <button type="button" className="ck-round" aria-label={t.projectActions} title={t.projectActions} aria-expanded={menu === "actions"} onClick={() => setMenu(menu === "actions" ? null : "actions")}>
                <PlusIcon />
              </button>
            )}
            {canFiles && (
              <button type="button" className="ck-round" aria-label="Прикрепить файл" aria-expanded={menu === "files"} onClick={() => setMenu(menu === "files" ? null : "files")}>
                <ClipIcon />
              </button>
            )}
            {(p.templates?.length ?? 0) > 0 && mode !== "note" && (
              <button type="button" className="ck-round" aria-label="Шаблоны" aria-expanded={menu === "templates"} onClick={() => setMenu(menu === "templates" ? null : "templates")}>
                <BoltIcon />
              </button>
            )}
            <div className="ck-field__main">
              {mode === "email" && (
                <input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} aria-label="Тема письма"
                  placeholder={`Тема письма на ${p.emailTo ?? "почту"}`} className="ck-field__subject" />
              )}
              {staged && mode === "send" && (
                <span className="ck-field__file">
                  {staged.kind === "upload" && staged.voice ? <MicIcon /> : <ClipIcon />}
                  <span>{staged.name}</span>
                  <button type="button" className="ck-iconbtn" style={{ width: 20, height: 20 }} onClick={() => setStaged(null)} aria-label="Убрать файл"><CloseIcon /></button>
                </span>
              )}
              <textarea
                ref={area}
                name="text"
                rows={1}
                value={text}
                aria-label={mode === "note" ? "Текст заметки" : mode === "email" ? "Текст письма" : "Текст сообщения"}
                onChange={(e) => { setText(e.target.value); if (undo !== null) setUndo(null); if (mode === "send" || mode === "email") ping(); }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
                  // Письмо — длинный текст: Enter переносит строку, отправка — Ctrl+Enter. Ctrl+Enter работает везде
                  const send = e.ctrlKey || e.metaKey || (mode !== "email" && !e.shiftKey && !touch);
                  if (send) { e.preventDefault(); submit(); }
                }}
                onPaste={(e) => {
                  // Снимок экрана из буфера — сразу как файл клиенту
                  const file = canFiles && f?.upload ? e.clipboardData.files?.[0] : undefined;
                  if (file && /^image\/(png|jpeg)$/.test(file.type)) { e.preventDefault(); stageFile(file); }
                }}
                placeholder={placeholder}
              />
            </div>
            {p.improveAction && text.trim() && mode !== "note" ? (
              <button type="button" className="ck-round" aria-label={t.improve} title={t.improve} disabled={improving} aria-expanded={menu === "improve"}
                onClick={() => setMenu(menu === "improve" ? null : "improve")}>
                <WandIcon />
              </button>
            ) : null}
            {showMic ? (
              <button type="button" className="ck-round ck-send ck-send--ready" aria-label="Записать голосовое" title="Записать голосовое" onClick={() => { setError(""); void recorder.start(); }}>
                <MicIcon />
              </button>
            ) : (
              <button type="submit" aria-label={sendLabel} className={`ck-round ck-send${ready ? (mode === "note" ? " ck-send--note" : " ck-send--ready") : ""}`}>
                <SendIcon />
              </button>
            )}
          </div>
        )}
      </div>

      {error ? (
        <div className="ck-hint ck-hint--error" role="alert">{error}</div>
      ) : improving ? (
        <div className="ck-hint">Улучшаю текст…</div>
      ) : undo !== null ? (
        <div className="ck-hint">Текст улучшен · <button type="button" className="ck-link" onClick={() => { setText(undo); setUndo(null); area.current?.focus(); }}>{t.improveUndo}</button></div>
      ) : note ? (
        <div className="ck-hint" role="status">{note}</div>
      ) : !touch && !recording ? (
        <div className="ck-hint">{mode === "email" ? "Ctrl+Enter — отправить письмо" : "Enter — отправить, Shift+Enter — новая строка"}</div>
      ) : null}
    </form>
  );
}
