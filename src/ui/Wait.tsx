"use client";

import { useEffect, useState, type ReactNode } from "react";
import { DEFAULT_TEXTS, type Texts } from "../core/profile.js";
import { waitText } from "../core/waiting.js";

/* «ждёт 25 мин» — время идёт само, без обновления страницы. Первый показ — от since и now с сервера, чтобы страница
   и браузер не разошлись (иначе React ругается на разную разметку). */

export function WaitLabel({ since, now, className }: { since: string; now?: number | undefined; className?: string | undefined }) {
  const at = Date.parse(since);
  const [label, setLabel] = useState(() => waitText((now ?? Date.now()) - at));
  useEffect(() => {
    const tick = () => setLabel(waitText(Date.now() - at));
    tick();
    const timer = window.setInterval(tick, 30_000);
    return () => window.clearInterval(timer);
  }, [at]);
  return <span className={className}>{label}</span>;
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
