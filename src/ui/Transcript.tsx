"use client";

import { useState, useTransition } from "react";
import type { AiAnswer } from "../core/composer.js";
import { DEFAULT_TEXTS, type Texts } from "../core/profile.js";
import { ChevronIcon, TextIcon } from "./icons.js";

/* Текст голосового и записи звонка. Есть расшифровка — показываем её (свернуть можно); нет — кнопка «Расшифровать»:
   действие проекта (форма message_id, attachment_id) отдаёт текст через «розетку ИИ», проект сохраняет его у файла,
   и в следующий раз он придёт готовым (Attachment.transcript). Текст ищется поиском по переписке (data-find). */

export function Transcript({ messageId, attachmentId, text, action, t = DEFAULT_TEXTS }: {
  messageId: string;
  attachmentId: string;
  text?: string | null | undefined;
  action?: ((form: FormData) => Promise<AiAnswer>) | undefined;
  t?: Pick<Texts, "transcribe" | "transcript"> | undefined;
}) {
  const [value, setValue] = useState<string | null>(text?.trim() || null);
  const [open, setOpen] = useState(true);
  const [error, setError] = useState("");
  const [busy, start] = useTransition();
  if (value) {
    return (
      <div className="ck-transcript">
        <button type="button" className="ck-transcript__head" aria-expanded={open} onClick={() => setOpen(!open)}>
          <TextIcon /> {t.transcript} <ChevronIcon dir={open ? "up" : "down"} />
        </button>
        {open ? <div className="ck-transcript__text" data-find="">{value}</div> : null}
      </div>
    );
  }
  if (!action) return null;
  const run = () => start(async () => {
    setError("");
    const fd = new FormData();
    fd.set("message_id", messageId);
    fd.set("attachment_id", attachmentId);
    try {
      const r = await action(fd);
      if (r.text?.trim()) setValue(r.text.trim());
      else setError(r.error ?? "Не получилось расшифровать — попробуйте ещё раз");
    } catch {
      setError("Нет связи с сервером — попробуйте ещё раз");
    }
  });
  return (
    <div className="ck-transcript">
      <button type="button" className="ck-btn ck-btn--sm ck-btn--ghost" disabled={busy} onClick={run}>
        <TextIcon /> {busy ? "Расшифровываю…" : t.transcribe}
      </button>
      {error ? <span className="ck-transcript__error" role="alert">{error}</span> : null}
    </div>
  );
}
