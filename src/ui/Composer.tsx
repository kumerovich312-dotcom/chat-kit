"use client";

import { useEffect, useLayoutEffect, useRef, useState, useTransition, type ReactNode } from "react";
import type { ComposerMode, SendResult, Template } from "../core/composer.js";
import { channelLabel as labelOf } from "../core/channels.js";
import { ChannelIcon } from "./bits.js";
import { BoltIcon, ClipIcon, CloseIcon, SendIcon } from "./icons.js";
import { usePending } from "./Pending.js";
import { BotDraft } from "./Bot.js";

/* Поле ввода — как в мессенджере (Атлас, 26.09.2026): Enter отправляет, Shift+Enter — новая строка, сообщение сразу видно
   в ленте с часиками, курсор остаётся в поле. Вкладки над полем — по желанию проекта:
   «Клиенту» — ответ уходит в мессенджер, откуда клиент написал; «В историю» — клиент пишет не через подключённый канал:
   сохраняем копию (нашу реплику или ответ клиента); «Заметка» — только для команды; «Письмо» — на почту клиента
   (Enter — новая строка, Ctrl+Enter — отправить). Шаблоны — под молнией, файлы — под скрепкой (с компьютера или файл
   проекта), снимок экрана можно вставить из буфера. Ошибка — текст возвращается в поле, причина — под полем.

   Отправка — одна форма (FormData: mode, channel, direction, text, subject, file, file_id): годится и серверному действию
   Next.js, и обычной функции. Прочитать её — readComposerForm из ядра. */

export type ProjectFile = { id: string; name: string; size?: string | undefined };

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
  /** Подписи разделов шаблонов: { deal: "По сделке клиента" } */
  templateGroups?: Readonly<Record<string, string>> | undefined;
  /** «Свои шаблоны — в настройках» */
  templatesHref?: string | null | undefined;
  /** Файлы клиенту: с компьютера (upload) и/или файлы проекта (скан из сделки) */
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
};

type Staged = { kind: "upload"; file: File; name: string } | { kind: "project"; id: string; name: string };

const DEFAULT_MAX = 10 * 1024 * 1024;

export function Composer(p: ComposerProps) {
  const label = p.channelLabel ?? labelOf(p.channel);
  const noteTab = { key: "note" as const, label: "Заметка", about: "видит только команда, клиенту не уходит" };
  const all: { key: ComposerMode; label: string; about: string }[] = p.noteOnly ? [noteTab] : [
    p.live
      ? { key: "send", label: "Клиенту", about: `ответ уйдёт клиенту в ${label}` }
      : { key: "copy", label: "В историю", about: "клиент не пишет нам через подключённый канал: сообщение сохранится в истории, клиенту не уйдёт" },
    noteTab,
    ...(p.emailTo ? [{ key: "email" as const, label: "Письмо", about: `на почту ${p.emailTo}` }] : []),
  ];
  const tabs = p.modes ? all.filter((t) => p.modes!.includes(t.key)) : all;
  // Ответ на письмо — письмом, с той же темой: так клиент увидит его в той же цепочке писем
  const reSubject = !p.replySubject ? "" : /^(re|ответ|отв)\s*:/i.test(p.replySubject) ? p.replySubject : `Re: ${p.replySubject}`;
  const first = tabs[0]?.key ?? "note";
  const [mode, setMode] = useState<ComposerMode>(p.replySubject != null && tabs.some((t) => t.key === "email") ? "email" : first);
  const [text, setText] = useState(p.initialText ?? "");
  const [subject, setSubject] = useState(reSubject);
  const [dir, setDir] = useState<"out" | "in">("out");
  const [staged, setStaged] = useState<Staged | null>(null);
  const [menu, setMenu] = useState<"files" | "templates" | null>(null);
  const [error, setError] = useState("");
  const [touch, setTouch] = useState(false);
  const [, start] = useTransition();
  const { add } = usePending();
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);

  const f = p.files;
  const canFiles = mode === "send" && !!f && (!!f.upload || (f.project?.length ?? 0) > 0);
  const ready = !!text.trim() || (mode === "send" && !!staged);
  const sendLabel = mode === "send" ? "Отправить клиенту" : mode === "copy" ? "Сохранить в историю" : mode === "note" ? "Сохранить заметку" : "Отправить письмо";

  // Поле растёт вместе с текстом, дальше — прокрутка внутри
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + 1, 180)}px`;
    // Полоса прокрутки — только когда текст не влез в 180 px (иначе дробные пиксели строки рисуют лишнюю полосу)
    el.style.overflowY = el.scrollHeight > 180 ? "auto" : "hidden";
  }, [text, mode, staged]);

  useEffect(() => { if (p.autoFocus) area.current?.focus(); }, [p.autoFocus]);
  // На телефоне Enter — новая строка, отправка — кнопкой (как в мобильных мессенджерах)
  useEffect(() => { setTouch(window.matchMedia?.("(pointer: coarse)").matches ?? false); }, []);
  // Меню скрепки и шаблонов закрывается щелчком мимо и Esc
  useEffect(() => {
    if (!menu) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setMenu(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [menu]);

  const stageFile = (file: File) => {
    const max = f?.maxBytes ?? DEFAULT_MAX;
    if (file.size > max) { setError(`Файл больше ${Math.round(max / 1024 / 1024)} МБ — сожмите его или разбейте на части`); return; }
    setStaged({ kind: "upload", file, name: file.name || "файл" });
    setError("");
  };

  const insert = (t: string) => { setText(t); setMenu(null); area.current?.focus(); };
  const [hidden, setHidden] = useState<string | null>(null);
  const copilot = p.copilot && p.copilot.text.trim() && hidden !== p.copilot.text ? p.copilot : null;

  const submit = () => {
    const body = text.trim();
    const file = mode === "send" ? staged : null;
    if (!body && !file) return;
    const fd = new FormData();
    fd.set("mode", mode);
    fd.set("channel", mode === "email" ? "email" : p.channel);
    fd.set("direction", mode === "copy" ? dir : "out");
    fd.set("text", body);
    if (mode === "email") fd.set("subject", subject.trim());
    if (file?.kind === "upload") fd.set("file", file.file);
    if (file?.kind === "project") fd.set("file_id", file.id);
    const pending = {
      key: `${Date.now()}-${Math.random()}`,
      text: body,
      file: file?.name ?? null,
      kind: mode === "note" ? ("note" as const) : mode === "copy" && dir === "in" ? ("in" as const) : ("out" as const),
      status: mode === "send" || mode === "email" ? "отправляется" : "сохраняется",
    };
    // Поле очищается сразу — можно писать следующее, пока это уходит
    const sentSubject = subject;
    setText("");
    setSubject(reSubject);
    setStaged(null);
    setMenu(null);
    setError("");
    area.current?.focus();
    const restore = (msg: string) => {
      setError(msg);
      setText((t) => t || body);
      if (mode === "email") setSubject(sentSubject);
      if (file) setStaged((s) => s ?? file);
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

  const placeholder =
    mode === "note" ? "Заметка для команды — клиент её не увидит"
    : mode === "email" ? "Текст письма…"
    : mode === "copy" ? (dir === "in" ? "Что написал клиент…" : "Что мы написали клиенту…")
    : staged ? "Подпись к файлу (можно без неё)"
    : "Сообщение…";

  let lastGroup: string | undefined;
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="ck-composer">
      {copilot ? (
        <BotDraft text={copilot.text} title={copilot.title} onInsert={insert} onHide={() => setHidden(copilot.text)}
          sendAction={async (fd) => { fd.set("channel", p.channel); fd.set("direction", "out"); setHidden(copilot.text); await (copilot.sendAction ?? p.action)(fd); }} />
      ) : null}
      {p.above?.(insert)}
      <div className="ck-composer__bar">
        {tabs.length > 1 || mode === "copy" ? (
          <div className="ck-seg" role="group" aria-label="Куда пишем">
            {tabs.map((t) => (
              <button key={t.key} type="button" title={t.about} aria-pressed={mode === t.key} className="ck-seg__item"
                onClick={() => { setMode(t.key); setMenu(null); setError(""); area.current?.focus(); }}>
                {t.key === "send" ? <ChannelIcon channel={p.channel} size={14} /> : null}
                {t.label}
              </button>
            ))}
          </div>
        ) : null}
        {mode === "copy" && (
          <div className="ck-seg" role="group" aria-label="Кто написал" style={{ marginLeft: "auto" }}>
            {(["out", "in"] as const).map((d) => (
              <button key={d} type="button" aria-pressed={dir === d} className="ck-seg__item" onClick={() => { setDir(d); area.current?.focus(); }}>
                {d === "out" ? "мы написали" : "клиент написал"}
              </button>
            ))}
          </div>
        )}
      </div>

      <div ref={box} style={{ position: "relative" }}>
        {menu === "templates" && (
          <div className="ck-pop ck-scroll">
            <div className="ck-pop__head">Шаблоны — текст подставится в поле</div>
            {(p.templates ?? []).map((t, i) => {
              const head = t.group !== lastGroup && t.group && p.templateGroups?.[t.group];
              lastGroup = t.group;
              return (
                <div key={`${t.group ?? ""}-${t.label}-${i}`}>
                  {head ? <div className="ck-pop__head ck-pop__sep">{head}</div> : null}
                  <button type="button" className="ck-pop__item" onClick={() => insert(t.text)}>
                    <span className="ck-pop__title">{t.label}</span>
                    <span className="ck-pop__sub">{t.text.split("\n")[0]}</span>
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
                <span className="ck-pop__sub">{f.hint ?? "Файл уйдёт клиенту"}</span>
              </button>
            )}
            {(f.project?.length ?? 0) > 0 && <div className="ck-pop__head">{f.projectTitle ?? "Файлы клиента"}</div>}
            {(f.project ?? []).map((x) => (
              <button key={x.id} type="button" className="ck-pop__item" style={{ display: "flex", gap: 8, alignItems: "baseline" }}
                onClick={() => { setStaged({ kind: "project", id: x.id, name: x.name }); setMenu(null); setError(""); area.current?.focus(); }}>
                <span className="ck-pop__title" style={{ flex: 1, minWidth: 0 }}>{x.name}</span>
                {x.size ? <span className="ck-mono" style={{ color: "var(--ck-muted)", fontSize: "var(--ck-text-xs)" }}>{x.size}</span> : null}
              </button>
            ))}
          </div>
        )}
        {f?.upload && (
          <input ref={picker} type="file" accept={f.accept ?? "application/pdf,image/jpeg,image/png"} hidden tabIndex={-1}
            onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; setMenu(null); if (file) stageFile(file); area.current?.focus(); }} />
        )}

        <div className={`ck-field${mode === "note" ? " ck-field--note" : ""}`}>
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
                <ClipIcon />
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
              onChange={(e) => setText(e.target.value)}
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
          <button type="submit" aria-label={sendLabel} className={`ck-round ck-send${ready ? (mode === "note" ? " ck-send--note" : " ck-send--ready") : ""}`}>
            <SendIcon />
          </button>
        </div>
      </div>

      {error ? (
        <div className="ck-hint ck-hint--error" role="alert">{error}</div>
      ) : !touch ? (
        <div className="ck-hint">{mode === "email" ? "Ctrl+Enter — отправить письмо" : "Enter — отправить, Shift+Enter — новая строка"}</div>
      ) : null}
    </form>
  );
}
