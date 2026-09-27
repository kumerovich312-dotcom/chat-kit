"use client";

import { useState, useTransition } from "react";
import type { BotState } from "../core/conversation.js";
import { botStateText } from "../core/conversation.js";
import { DEFAULT_TEXTS, fill, type Texts } from "../core/profile.js";
import { untilText } from "../core/time.js";
import { MuteIcon, PauseIcon, PencilIcon, PlayIcon, SparkIcon, ThumbIcon } from "./icons.js";

/* Места для студии в окне переписки (план студии 10.5 и 4.4; решения пользователя 27.09.2026). Все действия — формы:
   годятся и серверному действию Next.js, и обычной функции.
   - BotControls — «Пауза бота / Вернуть боту / Не отвечать этому клиенту» и короткая пометка, что с ботом, — в шапке
     диалога (вариант «А + Б»). Форма: command (pause / resume / mute / unmute), hours;
   - BotDraft — «второй пилот»: на каждое сообщение клиента бот предлагает ответ, когда диалог ведёт человек (бот на
     паузе). Менеджер сам выбирает: вставить в поле и поправить, отправить как есть или скрыть;
   - BotFeedback — оценка ответа бота «хорошо / как надо было / опасно» с причиной и правильным ответом — на этом бот
     учится. Видна владельцу сразу, менеджерам — когда владелец даст доступ (решает проект: передаёт действие или нет);
   - TeachExample — «Сделать примером для бота» у ответа менеджера: хороший ответ уходит в студию на одобрение;
   - BotMemory — что бот знает о клиенте (профессия, страна, сроки, бюджет): можно поправить и удалить. */

type FormAction = (form: FormData) => void | Promise<void>;

/** Кнопки бота. header — пометка и кнопки в шапке диалога (по умолчанию); bar — полосой над лентой; buttons — только кнопки */
export function BotControls({ state, action, variant = "header", timeZone, t = DEFAULT_TEXTS }: {
  state: BotState;
  action: FormAction;
  variant?: "header" | "bar" | "buttons" | undefined;
  /** Пояс компании — «пауза до 18:30» по нему */
  timeZone?: string | undefined;
  /** Надписи со словами отрасли (паспорт проекта) */
  t?: Texts | undefined;
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
  const until = (iso: string) => untilText(iso, timeZone);
  const text = botStateText(state, until, t) ?? t.botLeads;
  // В шапке — коротко: место под кнопки
  const short = state.mode === "muted" ? t.botMutedShort : state.mode === "manager" ? (state.pausedUntil ? fill(t.botPausedUntil, { until: until(state.pausedUntil) }) : t.botPaused) : state.handoff === "requested" ? t.botCalled : t.botLeads;
  const compact = variant !== "bar";
  const dot = state.mode === "muted" ? " ck-botbar__dot--muted" : state.mode === "manager" ? " ck-botbar__dot--paused" : "";
  const sm = variant === "bar" ? "ck-btn ck-btn--sm" : "ck-btn ck-btn--sm";
  const buttons = (
    <>
      {state.mode === "bot" && canPause ? (
        <button type="button" className={`${sm} ck-btn--bot`} disabled={busy} onClick={send("pause", 12)} title={t.botPauseTitle}>
          <PauseIcon /> {t.botPause}
        </button>
      ) : null}
      {state.mode === "manager" && canPause ? (
        <button type="button" className={`${sm} ck-btn--bot`} disabled={busy} onClick={send("resume")} title={t.botResumeTitle}>
          <PlayIcon /> {t.botResume}
        </button>
      ) : null}
      {canMute ? (
        state.mode === "muted" ? (
          <button type="button" className={sm} disabled={busy} onClick={send("unmute")} title={t.botUnmuteTitle}>{compact ? t.botUnmute : t.botUnmuteLong}</button>
        ) : (
          <button type="button" className={sm} disabled={busy} onClick={send("mute")} title={t.botMuteTitle}>
            <MuteIcon /> {compact ? t.botMute : t.botMuteLong}
          </button>
        )
      ) : null}
    </>
  );
  if (variant === "buttons") return <span className="ck-head__actions">{buttons}</span>;
  if (variant === "header") {
    return (
      <span className="ck-head__actions" role="group" aria-label={t.botGroup}>
        <span className="ck-botstate" title={state.reason ? `${text} — ${state.reason}` : text}>
          <span className={`ck-botbar__dot${dot}`} aria-hidden="true" />
          {short}
        </span>
        {buttons}
      </span>
    );
  }
  return (
    <div className="ck-botbar" role="group" aria-label={t.botGroup}>
      <span className="ck-botbar__state"><span className={`ck-botbar__dot${dot}`} aria-hidden="true" />{text}</span>
      {buttons}
    </div>
  );
}

/** «Второй пилот»: ответ, который предлагает бот. Менеджер вставляет его в поле (и правит) или отправляет как есть */
export function BotDraft({ text, onInsert, sendAction, onHide, title = "Бот предлагает ответ" }: {
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
          <button type="button" className="ck-btn ck-btn--sm" disabled={busy} onClick={() => start(async () => { const fd = new FormData(); fd.set("text", text); fd.set("mode", "send"); await sendAction(fd); })}>
            Отправить как есть
          </button>
        ) : null}
        {onHide ? <button type="button" className="ck-link" onClick={onHide}>скрыть</button> : null}
      </div>
    </div>
  );
}

/** Причины «как надо было» — из студии (раздел 4.4 плана, MVP §11.2). Коды — предварительные: в студии пока только слова */
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

export type Rating = "good" | "fix" | "dangerous";

/** Оценка ответа бота: «хорошо» одним нажатием; «как надо было» и «опасно» — причина и правильный ответ.
 *  Форма: message_id, rating (good / fix / dangerous), reasons (через запятую), ideal_reply */
export function BotFeedback({ messageId, action, given, t = DEFAULT_TEXTS }: { messageId: string; action: FormAction; given?: Rating | null | undefined; t?: Texts | undefined }) {
  const [rating, setRating] = useState<Rating | null>(null);
  const [done, setDone] = useState<Rating | null>(given ?? null);
  const [reasons, setReasons] = useState<string[]>([]);
  const [ideal, setIdeal] = useState("");
  const [busy, start] = useTransition();
  const submit = (r: Rating) => start(async () => {
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
        {done === "good" ? "✓ хороший ответ" : done === "fix" ? t.teachFixDone : "⚠ отмечено: опасный ответ"}
        <button type="button" className="ck-link" onClick={() => setRating(done)} style={{ marginLeft: 4, fontSize: "inherit" }}>изменить</button>
      </span>
    );
  }
  if (!rating) {
    return (
      <span className="ck-teach">
        <button type="button" className="ck-btn ck-btn--sm" disabled={busy} onClick={() => submit("good")} title="Хороший ответ"><ThumbIcon /> Хорошо</button>
        <button type="button" className="ck-btn ck-btn--sm" onClick={() => setRating("fix")} title="Ответ надо было дать иначе"><PencilIcon /> Как надо было</button>
        <button type="button" className="ck-btn ck-btn--sm" onClick={() => setRating("dangerous")} title="Ответ опасный: обещание, выдуманная цена, ошибка в документах">⚠ Опасно</button>
      </span>
    );
  }
  return (
    <div className="ck-draft ck-teach__form">
      <div className="ck-draft__head">{rating === "dangerous" ? "⚠ Опасный ответ — что не так?" : "Как надо было ответить?"}</div>
      <div className="ck-teach__reasons">
        {FEEDBACK_REASONS.map((r) => (
          <button key={r.code} type="button" className="ck-chip" aria-current={reasons.includes(r.code) ? "true" : undefined}
            onClick={() => setReasons((x) => (x.includes(r.code) ? x.filter((c) => c !== r.code) : [...x, r.code]))}>
            {r.label}
          </button>
        ))}
      </div>
      <textarea value={ideal} onChange={(e) => setIdeal(e.target.value)} rows={3} className="ck-textarea" placeholder={t.teachIdealPlaceholder} />
      <div className="ck-draft__actions">
        <button type="button" className="ck-btn ck-btn--sm ck-btn--primary" disabled={busy || (!ideal.trim() && reasons.length === 0)} onClick={() => submit(rating)}>Сохранить</button>
        <button type="button" className="ck-link" onClick={() => setRating(null)}>отмена</button>
      </div>
    </div>
  );
}

/** «Сделать примером для бота» у ответа менеджера: пара «вопрос клиента → ответ менеджера» уходит в студию на одобрение.
 *  Форма: message_id, note (к чему пример: «возражение: дорого») */
export function TeachExample({ messageId, action, sent: already = false, t = DEFAULT_TEXTS }: { messageId: string; action: FormAction; sent?: boolean | undefined; t?: Texts | undefined }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [sent, setSent] = useState(already);
  const [busy, start] = useTransition();
  if (sent) return <span className="ck-badge ck-badge--bot">✓ пример ушёл в студию на одобрение</span>;
  if (!open) {
    return (
      <button type="button" className="ck-btn ck-btn--sm ck-btn--ghost ck-teach__example" onClick={() => setOpen(true)} title={t.teachExampleTitle}>
        <SparkIcon /> {t.teachExample}
      </button>
    );
  }
  return (
    <div className="ck-draft ck-teach__form">
      <div className="ck-draft__head"><SparkIcon /> {t.teachExampleHead}</div>
      <input value={note} onChange={(e) => setNote(e.target.value)} className="ck-input" placeholder="К чему пример (по желанию): «возражение: дорого», «сроки визы»" />
      <div className="ck-draft__actions">
        <button type="button" className="ck-btn ck-btn--sm ck-btn--primary" disabled={busy}
          onClick={() => start(async () => { const fd = new FormData(); fd.set("message_id", messageId); fd.set("note", note.trim()); await action(fd); setSent(true); })}>
          Отправить в студию
        </button>
        <button type="button" className="ck-link" onClick={() => setOpen(false)}>отмена</button>
      </div>
    </div>
  );
}

/** Факт, который бот узнал о клиенте */
export type MemoryFact = {
  key: string;
  /** Как назвать: «Профессия», «Страна», «Сроки», «Бюджет» */
  label: string;
  value: string;
  /** Откуда: bot — из разговора, crm — из карточки клиента, admin — поправили вручную */
  source?: "bot" | "crm" | "admin" | undefined;
};

/** Что бот знает о клиенте — рядом с перепиской. Поправить и удалить (форма: key, value, remove=1) */
export function BotMemory({ facts, action, title, updatedAt, t = DEFAULT_TEXTS }: {
  facts: readonly MemoryFact[];
  action?: FormAction | undefined;
  title?: string | undefined;
  updatedAt?: string | null | undefined;
  t?: Texts | undefined;
}) {
  const [edit, setEdit] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [busy, start] = useTransition();
  const save = (key: string, remove = false) => start(async () => {
    if (!action) return;
    const fd = new FormData();
    fd.set("key", key);
    fd.set("value", remove ? "" : value.trim());
    if (remove) fd.set("remove", "1");
    await action(fd);
    setEdit(null);
  });
  return (
    <div className="ck-memory">
      <div className="ck-memory__head"><SparkIcon /> {title ?? t.memoryTitle}</div>
      {facts.length === 0 ? <div className="ck-memory__empty">{t.memoryEmpty}</div> : null}
      {facts.map((f) => (
        <div key={f.key} className="ck-memory__row">
          <span className="ck-memory__label">{f.label}</span>
          {edit === f.key ? (
            <span className="ck-memory__edit">
              <input value={value} onChange={(e) => setValue(e.target.value)} className="ck-input" aria-label={f.label} autoFocus
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); save(f.key); } if (e.key === "Escape") setEdit(null); }} />
              <button type="button" className="ck-btn ck-btn--sm" disabled={busy} onClick={() => save(f.key)}>Сохранить</button>
              <button type="button" className="ck-link" onClick={() => save(f.key, true)}>удалить</button>
            </span>
          ) : (
            <span className="ck-memory__value">
              {f.value}
              {f.source === "crm" ? <span className="ck-memory__src" title={t.memoryFromCard}>CRM</span> : f.source === "admin" ? <span className="ck-memory__src" title="Поправили вручную">вручную</span> : null}
              {action ? <button type="button" className="ck-link" onClick={() => { setEdit(f.key); setValue(f.value); }}>изменить</button> : null}
            </span>
          )}
        </div>
      ))}
      {updatedAt ? <div className="ck-memory__empty">обновлено {updatedAt}</div> : null}
    </div>
  );
}
