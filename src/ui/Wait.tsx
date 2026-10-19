"use client";

import { useEffect, useState, type ReactNode } from "react";
import { DEFAULT_TEXTS, type Texts } from "../core/profile.js";
import { waitText } from "../core/waiting.js";
import { ClockIcon, HandIcon } from "./icons.js";

/* «ждёт 25 мин» — время идёт само, без обновления страницы. Первый показ — от since и now с сервера, чтобы страница
   и браузер не разошлись (иначе React ругается на разную разметку). */

/** bare — без слова «ждёт» («53 мин», для строки списка с часиками); lateAfterMin — дольше скольких минут добавить
 *  класс ck-late (красным, а не оранжевым) */
export function WaitLabel({ since, now, className, bare = false, lateAfterMin, icon }: {
  since: string;
  now?: number | undefined;
  className?: string | undefined;
  bare?: boolean | undefined;
  lateAfterMin?: number | undefined;
  icon?: ReactNode;
}) {
  const at = Date.parse(since);
  const [ms, setMs] = useState(() => (now ?? Date.now()) - at);
  useEffect(() => {
    const tick = () => setMs(Date.now() - at);
    tick();
    const timer = window.setInterval(tick, 30_000);
    return () => window.clearInterval(timer);
  }, [at]);
  const text = waitText(ms);
  const late = lateAfterMin !== undefined && ms >= lateAfterMin * 60_000;
  const cls = [className, late ? "ck-late" : ""].filter(Boolean).join(" ");
  return <span className={cls || undefined}>{icon}{bare ? text.replace(/^ждёт /, "") : text}</span>;
}

/** Полоса над полем ввода: «ждёт 25 мин — клиент написал последним» и кнопка «Ответ не нужен» (клиент написал «спасибо» —
 *  уйдёт из «Ждут ответа» до своего следующего сообщения). dismissAction — форма без полей (server action или функция) */
export function WaitBar({ since, now, handoff = false, dismissAction, extra, t = DEFAULT_TEXTS }: {
  since: string;
  now?: number | undefined;
  /** Ждёт, потому что бот позвал человека */
  handoff?: boolean | undefined;
  dismissAction?: ((form: FormData) => void | Promise<void>) | undefined;
  extra?: ReactNode;
  /** Надписи со словами отрасли (паспорт проекта) */
  t?: Pick<Texts, "waitWhyHandoff" | "waitWhyClient" | "waitDismissTitle"> | undefined;
}) {
  return (
    <div className="ck-waitbar">
      <WaitLabel since={since} now={now} className="ck-waitbar__time" />
      <span className="ck-waitbar__why">{handoff ? t.waitWhyHandoff : t.waitWhyClient}</span>
      {extra}
      {dismissAction ? (
        <form action={dismissAction}>
          <button type="submit" className="ck-btn ck-btn--sm" title={t.waitDismissTitle}>Ответ не нужен</button>
        </form>
      ) : <span />}
    </div>
  );
}

/** Плашка под шапкой (вид «Мессенджер», макет пользователя 19.10.2026): «ИИ-агент передал чат вам» или «Клиент ждёт
 *  ответа», ниже — коротко, о чём разговор (brief: из «Кратко» или причина передачи), справа — «ждёт 13 мин».
 *  Заменяет полосу WaitBar над полем ввода */
export function HandoffBanner({ since, now, handoff = false, brief, dismissAction, t = DEFAULT_TEXTS }: {
  since: string;
  now?: number | undefined;
  handoff?: boolean | undefined;
  brief?: string | null | undefined;
  dismissAction?: ((form: FormData) => void | Promise<void>) | undefined;
  t?: Pick<Texts, "bannerHandoff" | "bannerWait" | "waitDismissTitle"> | undefined;
}) {
  return (
    <div className={`ck-banner${handoff ? " ck-banner--handoff" : ""}`} role="status">
      <span className="ck-banner__icon" aria-hidden="true">{handoff ? <HandIcon /> : <ClockIcon />}</span>
      <span className="ck-banner__body">
        <strong className="ck-banner__title">{handoff ? t.bannerHandoff : t.bannerWait}</strong>
        {brief?.trim() ? <span className="ck-banner__brief">{brief.trim()}</span> : null}
      </span>
      <WaitLabel since={since} now={now} className="ck-banner__wait" />
      {dismissAction ? (
        <form action={dismissAction}>
          <button type="submit" className="ck-link ck-banner__dismiss" title={t.waitDismissTitle}>Ответ не нужен</button>
        </form>
      ) : null}
    </div>
  );
}
