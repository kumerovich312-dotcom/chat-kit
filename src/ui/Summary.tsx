"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import type { AiAnswer } from "../core/composer.js";
import { DEFAULT_TEXTS, type Texts } from "../core/profile.js";
import { fmtClock } from "../core/time.js";
import { CloseIcon, TextIcon } from "./icons.js";
import { usePanel } from "./Panels.js";

/* «Кратко» — краткое содержание переписки плашкой сверху ленты, по кнопке в шапке (выбор пользователя 27.09.2026):
   ИИ тратится, только когда его попросили. Действие проекта (форма без полей, диалог проект знает сам) отдаёт текст
   и главные пункты через «розетку ИИ». Плашку можно обновить и закрыть. */

export function SummaryBar({ action, t = DEFAULT_TEXTS, timeZone }: {
  action: (form: FormData) => Promise<AiAnswer>;
  t?: Pick<Texts, "summaryTitle"> | undefined;
  timeZone?: string | undefined;
}) {
  const [open, setOpen] = usePanel("summary");
  const [answer, setAnswer] = useState<{ text: string; points: readonly string[]; at: number } | null>(null);
  const [error, setError] = useState("");
  const [busy, start] = useTransition();
  const asked = useRef(false);

  const load = () => start(async () => {
    setError("");
    try {
      const r = await action(new FormData());
      if (r.text?.trim() || r.points?.length) setAnswer({ text: r.text?.trim() ?? "", points: r.points ?? [], at: Date.now() });
      else setError(r.error ?? "Не получилось — попробуйте ещё раз");
    } catch {
      setError("Нет связи с сервером — попробуйте ещё раз");
    }
  });

  // Первый раз открыли — сразу спрашиваем
  useEffect(() => {
    if (open && !asked.current) { asked.current = true; load(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;
  return (
    <div className="ck-summary" role="region" aria-label={t.summaryTitle}>
      <div className="ck-summary__head">
        <TextIcon /> <strong>{t.summaryTitle}</strong>
        {answer ? <span className="ck-summary__at">на {fmtClock(new Date(answer.at).toISOString(), timeZone, false)}</span> : null}
        <span style={{ marginLeft: "auto" }} />
        {answer ? <button type="button" className="ck-link" disabled={busy} onClick={load}>обновить</button> : null}
        <button type="button" className="ck-iconbtn" aria-label="Закрыть" onClick={() => setOpen(false)}><CloseIcon /></button>
      </div>
      {busy && !answer ? <div className="ck-summary__text ck-summary__wait">Читаю переписку…</div> : null}
      {error ? <div className="ck-summary__text ck-summary__error" role="alert">{error}</div> : null}
      {answer ? (
        <>
          {answer.text ? <div className="ck-summary__text">{answer.text}</div> : null}
          {answer.points.length ? <ul className="ck-summary__points">{answer.points.map((p, i) => <li key={i}>{p}</li>)}</ul> : null}
        </>
      ) : null}
    </div>
  );
}
