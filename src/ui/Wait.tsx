"use client";

import { useEffect, useState, type ReactNode } from "react";
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
export function WaitBar({ since, now, handoff = false, dismissAction, extra }: {
  since: string;
  now?: number | undefined;
  /** Ждёт, потому что бот позвал человека */
  handoff?: boolean | undefined;
  dismissAction?: ((form: FormData) => void | Promise<void>) | undefined;
  extra?: ReactNode;
}) {
  return (
    <div className="ck-waitbar">
      <WaitLabel since={since} now={now} className="ck-waitbar__time" />
      <span className="ck-waitbar__why">{handoff ? "— ИИ-агент передал клиента менеджеру" : "— клиент написал последним"}</span>
      {extra}
      {dismissAction ? (
        <form action={dismissAction}>
          <button type="submit" className="ck-btn ck-btn--sm" title="Например, клиент написал «спасибо» — он уйдёт из «Ждут ответа» до своего следующего сообщения">Ответ не нужен</button>
        </form>
      ) : <span />}
    </div>
  );
}
