"use client";

import { useState, useTransition } from "react";
import type { SendResult } from "../core/composer.js";
import { fill, type ActionField, type ComposerAction } from "../core/profile.js";
import { ProfileIconView } from "./Card.js";
import { CloseIcon } from "./icons.js";

/* Свои кнопки проекта в поле ввода — меню «+» (выбор пользователя 27.09.2026): «Записать на приём», «Отправить счёт»,
   «Отправить вакансию». Что делает кнопка, описано в паспорте проекта (profile.actions):
   insert — вставить текст в поле; link — открыть страницу проекта; form — маленькая форма над полем, её получает
   действие проекта (onAction: форма action_id + поля) — например, записывает клиента и кладёт в ленту карточку. */

export function QuickMenu({ actions, vars, onPick }: {
  actions: readonly ComposerAction[];
  /** Подстановки: {client} — имя, {id} — номер диалога */
  vars: Readonly<Record<string, string>>;
  onPick: (a: ComposerAction) => void;
}) {
  return (
    <div className="ck-pop ck-scroll">
      {actions.map((a) => (
        <button key={a.id} type="button" className="ck-pop__item ck-quick__item" onClick={() => onPick(a)}>
          <span className="ck-quick__icon"><ProfileIconView icon={a.icon} /></span>
          <span style={{ minWidth: 0 }}>
            <span className="ck-pop__title">{a.label}</span>
            {a.hint ? <span className="ck-pop__sub">{fill(a.hint, vars)}</span> : null}
          </span>
        </button>
      ))}
    </div>
  );
}

function Field({ f, value, onChange }: { f: ActionField; value: string; onChange: (v: string) => void }) {
  const common = { id: `ck-qa-${f.key}`, name: f.key, value, required: f.required, placeholder: f.placeholder, onChange: (e: { target: { value: string } }) => onChange(e.target.value) };
  if (f.type === "textarea") return <textarea {...common} rows={3} className="ck-textarea" />;
  if (f.type === "select") {
    return (
      <select {...common} className="ck-input">
        <option value="">—</option>
        {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  return <input {...common} type={f.type ?? "text"} className="ck-input" />;
}

/** Маленькая форма кнопки проекта над полем ввода */
export function QuickForm({ action, vars, onAction, onClose }: {
  action: ComposerAction;
  vars: Readonly<Record<string, string>>;
  onAction: (form: FormData) => Promise<SendResult>;
  onClose: (done: boolean) => void;
}) {
  const fields = action.fields ?? [];
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.key, f.value ? fill(f.value, vars) : ""])));
  const [error, setError] = useState("");
  const [busy, start] = useTransition();
  const missing = fields.filter((f) => f.required && !values[f.key]?.trim());
  const submit = () => start(async () => {
    if (missing.length) { setError(`Заполните: ${missing.map((f) => f.label).join(", ")}`); return; }
    const fd = new FormData();
    fd.set("action_id", action.id);
    for (const [k, v] of Object.entries(values)) fd.set(k, v);
    try {
      const r = await onAction(fd);
      if (r && r.error) setError(r.error);
      else onClose(true);
    } catch {
      setError("Нет связи с сервером — попробуйте ещё раз");
    }
  });
  return (
    <div className="ck-draft ck-quick__form" role="group" aria-label={action.label}>
      <div className="ck-draft__head">
        <ProfileIconView icon={action.icon} /> {action.label}
        <button type="button" className="ck-iconbtn" style={{ marginLeft: "auto", width: 24, height: 24 }} aria-label="Закрыть" onClick={() => onClose(false)}><CloseIcon /></button>
      </div>
      <div className="ck-quick__fields">
        {fields.map((f) => (
          <label key={f.key} className="ck-quick__field" htmlFor={`ck-qa-${f.key}`}>
            <span>{f.label}{f.required ? " *" : ""}</span>
            <Field f={f} value={values[f.key] ?? ""} onChange={(v) => { setValues((x) => ({ ...x, [f.key]: v })); setError(""); }} />
          </label>
        ))}
      </div>
      {error ? <div className="ck-hint ck-hint--error" role="alert">{error}</div> : null}
      <div className="ck-draft__actions">
        <button type="button" className="ck-btn ck-btn--sm ck-btn--primary" disabled={busy} onClick={submit}>{busy ? "Сохраняю…" : action.submitLabel ?? "Готово"}</button>
        <button type="button" className="ck-link" onClick={() => onClose(false)}>отмена</button>
      </div>
    </div>
  );
}
