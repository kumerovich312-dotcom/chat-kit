"use client";

import { useState, useTransition } from "react";
import type { BotState } from "../core/conversation.js";
import { botStateText } from "../core/conversation.js";
import { MuteIcon, PauseIcon, PencilIcon, PlayIcon, SparkIcon, ThumbIcon } from "./icons.js";

/* Места для студии в окне переписки (план студии 10.5 и 4.4). Все действия — формы: годятся и серверному действию
   Next.js, и обычной функции.
   - BotControls — «Пауза бота / Вернуть боту / Не отвечать этому клиенту» (поле command: pause / resume / mute / unmute,
     hours — на сколько часов пауза);
   - BotDraft — черновик ответа от бота для менеджера: вставить в поле, отправить как есть, скрыть;
   - BotFeedback — оценка ответа бота «хорошо / исправить / опасно», причина и «как надо было ответить» — на этом бот учится. */

type FormAction = (form: FormData) => void | Promise<void>;

/** Кнопки бота. variant: bar — полоса над лентой со словами о состоянии; buttons — только кнопки (в шапку диалога) */
export function BotControls({ state, action, variant = "bar", fmtUntil }: {
  state: BotState;
  action: FormAction;
  variant?: "bar" | "buttons" | undefined;
  /** Как показать «пауза до …» (время по поясу компании) */
  fmtUntil?: ((iso: string) => string) | undefined;
}) {
  const [busy, start] = useTransition();
  const canPause = state.canPause ?? true;
  const canMute = state.canMute ?? true;
  const send = (command: string, hours?: number) => () => start(async () => {
    const fd = new FormData();
    fd.set("command", command);
    if (hours) fd.set("hours", String(hours));
    await action(fd);
  });
  const text = botStateText(state, fmtUntil) ?? "бот ведёт диалог";
  const dot = state.mode === "muted" ? " ck-botbar__dot--muted" : state.mode === "manager" ? " ck-botbar__dot--paused" : "";
  const buttons = (
    <>
      {state.mode === "bot" && canPause ? (
        <button type="button" className="ck-btn ck-btn--sm ck-btn--bot" disabled={busy} onClick={send("pause", 12)} title="Бот замолчит на 12 часов — отвечает человек">
          <PauseIcon /> Пауза бота
        </button>
      ) : null}
      {state.mode === "manager" && canPause ? (
        <button type="button" className="ck-btn ck-btn--sm ck-btn--bot" disabled={busy} onClick={send("resume")} title="Бот ответит на следующее сообщение клиента">
          <PlayIcon /> Вернуть боту
        </button>
      ) : null}
      {canMute ? (
        state.mode === "muted" ? (
          <button type="button" className="ck-btn ck-btn--sm" disabled={busy} onClick={send("unmute")}>Бот снова может отвечать</button>
        ) : (
          <button type="button" className="ck-btn ck-btn--sm" disabled={busy} onClick={send("mute")} title="Бот не будет отвечать этому клиенту ни в одном канале — пишет только человек">
            <MuteIcon /> Не отвечать этому клиенту
          </button>
        )
      ) : null}
    </>
  );
  if (variant === "buttons") return <span className="ck-head__actions">{buttons}</span>;
  return (
    <div className="ck-botbar" role="group" aria-label="Бот в этом диалоге">
      <span className="ck-botbar__state"><span className={`ck-botbar__dot${dot}`} aria-hidden="true" />{text}</span>
      {buttons}
    </div>
  );
}

/** Черновик ответа от бота: менеджер вставляет его в поле (и правит) или отправляет как есть */
export function BotDraft({ text, onInsert, sendAction, onHide, title = "ИИ предлагает ответ" }: {
  text: string;
  onInsert: (text: string) => void;
  sendAction?: FormAction | undefined;
  onHide?: (() => void) | undefined;
  title?: string | undefined;
}) {
  const [busy, start] = useTransition();
  return (
    <div className="ck-draft" role="note">
      <div className="ck-draft__head"><SparkIcon /> {title}</div>
      <div className="ck-draft__text">{text}</div>
      <div className="ck-draft__actions">
        <button type="button" className="ck-btn ck-btn--sm ck-btn--bot" onClick={() => onInsert(text)}><PencilIcon /> Вставить в поле</button>
        {sendAction ? (
          <button type="button" className="ck-btn ck-btn--sm" disabled={busy} onClick={() => start(async () => { const fd = new FormData(); fd.set("text", text); await sendAction(fd); })}>
            Отправить как есть
          </button>
        ) : null}
        {onHide ? <button type="button" className="ck-link" onClick={onHide}>скрыть</button> : null}
      </div>
    </div>
  );
}

/** Причины «исправить» — из студии (раздел 4.4 плана, MVP §11.2) */
export const FEEDBACK_REASONS: readonly { code: string; label: string }[] = [
  { code: "wrong_fact", label: "неправильный факт" },
  { code: "knowledge_missing", label: "нет знания" },
  { code: "scenario_broken", label: "нарушен сценарий" },
  { code: "wrong_style", label: "не тот стиль" },
  { code: "question_missing", label: "не задал обязательный вопрос" },
  { code: "question_repeated", label: "повторил вопрос" },
  { code: "lead_missing", label: "не создал заявку" },
  { code: "handoff_missing", label: "не передал менеджеру" },
  { code: "wrong_action", label: "неверное действие" },
];

/** Оценка ответа бота: «хорошо» одним нажатием; «исправить» и «опасно» — причина и «как надо было ответить».
 *  Форма: message_id, rating (good / fix / dangerous), reasons (через запятую), ideal_reply, comment */
export function BotFeedback({ messageId, action, given }: { messageId: string; action: FormAction; given?: "good" | "fix" | "dangerous" | null | undefined }) {
  const [rating, setRating] = useState<"good" | "fix" | "dangerous" | null>(null);
  const [done, setDone] = useState(given ?? null);
  const [reasons, setReasons] = useState<string[]>([]);
  const [ideal, setIdeal] = useState("");
  const [busy, start] = useTransition();
  const submit = (r: "good" | "fix" | "dangerous") => start(async () => {
    const fd = new FormData();
    fd.set("message_id", messageId);
    fd.set("rating", r);
    fd.set("reasons", reasons.join(","));
    fd.set("ideal_reply", ideal.trim());
    await action(fd);
    setDone(r);
    setRating(null);
  });
  if (done && !rating) {
    return (
      <span className={`ck-badge ${done === "good" ? "ck-badge--ok" : done === "fix" ? "ck-badge--warn" : "ck-badge--danger"}`}>
        {done === "good" ? "✓ хороший ответ" : done === "fix" ? "✎ отмечено: исправить" : "⚠ отмечено: опасно"}
        <button type="button" className="ck-link" onClick={() => setRating(done)} style={{ marginLeft: 4, fontSize: "inherit" }}>изменить</button>
      </span>
    );
  }
  if (!rating) {
    return (
      <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
        <button type="button" className="ck-btn ck-btn--sm" disabled={busy} onClick={() => submit("good")} title="Хороший ответ"><ThumbIcon /> Хорошо</button>
        <button type="button" className="ck-btn ck-btn--sm" onClick={() => setRating("fix")} title="Ответ надо было дать иначе"><PencilIcon /> Как надо было</button>
        <button type="button" className="ck-btn ck-btn--sm" onClick={() => setRating("dangerous")} title="Ответ опасный: обещание, выдуманная цена, ошибка в документах">⚠ Опасно</button>
      </span>
    );
  }
  return (
    <div className="ck-draft" style={{ width: "100%", textAlign: "left" }}>
      <div className="ck-draft__head">{rating === "dangerous" ? "⚠ Опасный ответ — что не так?" : "Как надо было ответить?"}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {FEEDBACK_REASONS.map((r) => (
          <button key={r.code} type="button" className={`ck-chip${reasons.includes(r.code) ? "" : ""}`} aria-current={reasons.includes(r.code) ? "true" : undefined}
            onClick={() => setReasons((x) => (x.includes(r.code) ? x.filter((c) => c !== r.code) : [...x, r.code]))}>
            {r.label}
          </button>
        ))}
      </div>
      <textarea value={ideal} onChange={(e) => setIdeal(e.target.value)} rows={3} placeholder="Как надо было ответить — бот научится на этом примере"
        style={{ width: "100%", padding: 8, border: "1px solid var(--ck-line)", borderRadius: "var(--ck-radius-sm)", font: "inherit", resize: "vertical", background: "var(--ck-surface)" }} />
      <div className="ck-draft__actions">
        <button type="button" className="ck-btn ck-btn--sm ck-btn--primary" disabled={busy || (!ideal.trim() && reasons.length === 0)} onClick={() => submit(rating)}>Сохранить</button>
        <button type="button" className="ck-link" onClick={() => setRating(null)}>отмена</button>
      </div>
    </div>
  );
}
