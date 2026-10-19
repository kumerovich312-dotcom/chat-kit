"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { DEFAULT_TEXTS, type ProfileStage, type Texts } from "../core/profile.js";
import { ChevronIcon } from "./icons.js";

/* Этап того, что проект ведёт по клиенту (заявка, запись, сделка), — меню-кнопкой рядом с именем в шапке: «Новый ▾»
   (макет пользователя 19.10.2026). Этапы — из паспорта проекта (stages), сохраняет проект: форма stage — код этапа.
   Без действия — просто метка этапа. */

type FormAction = (form: FormData) => void | Promise<void>;

export function StageMenu({ stage, stages, action, t = DEFAULT_TEXTS }: {
  stage?: string | null | undefined;
  stages: readonly ProfileStage[];
  action?: FormAction | undefined;
  t?: Pick<Texts, "stage"> | undefined;
}) {
  const [value, setValue] = useState(stage ?? null);
  const [seen, setSeen] = useState(stage ?? null);
  const [open, setOpen] = useState(false);
  const [busy, start] = useTransition();
  const box = useRef<HTMLSpanElement>(null);
  // Пришёл новый этап с сервера — берём его
  if ((stage ?? null) !== seen) { setSeen(stage ?? null); setValue(stage ?? null); }
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);

  const current = stages.find((s) => s.code === value) ?? null;
  if (!current && !action) return null;
  const tone = current?.tone ?? "accent";
  const pick = (code: string) => start(async () => {
    setOpen(false);
    if (!action || code === value) return;
    const before = value;
    setValue(code);
    const fd = new FormData();
    fd.set("stage", code);
    try { await action(fd); } catch { setValue(before); }
  });
  if (!action) return <span className={`ck-stage ck-tone--${tone}`} title={t.stage}>{current!.label}</span>;
  return (
    <span ref={box} className="ck-strip__menu">
      <button type="button" className={`ck-stage ck-tone--${tone}`} aria-expanded={open} aria-busy={busy || undefined} title={t.stage} onClick={() => setOpen(!open)}>
        {current?.label ?? t.stage} <ChevronIcon />
      </button>
      {open ? (
        <div className="ck-pop ck-pop--down">
          <div className="ck-pop__head">{t.stage}</div>
          {stages.map((s) => (
            <button key={s.code} type="button" className="ck-pop__item ck-pop__check" aria-pressed={s.code === value} onClick={() => pick(s.code)}>
              <span className={`ck-dot ck-tone--${s.tone ?? "accent"}`} aria-hidden="true" /> {s.label}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}
