"use client";

import { createContext, useContext, useLayoutEffect, useOptimistic, useRef, type ReactNode } from "react";
import { ClipIcon, ClockIcon } from "./icons.js";

/* Сообщение, которое ещё отправляется: появляется в ленте сразу после Enter, с часиками. Когда отправка закончилась и лента
   обновилась, его место занимает настоящее сообщение — useOptimistic сам убирает временное. */

/** status — подпись у часиков: «отправляется», «сохраняется» */
export type PendingMsg = { key: string; text: string; file: string | null; kind: "out" | "in" | "note"; status: string };

const Ctx = createContext<{ items: PendingMsg[]; add: (m: PendingMsg) => void }>({ items: [], add: () => {} });

export function PendingProvider({ children }: { children: ReactNode }) {
  const [items, add] = useOptimistic<PendingMsg[], PendingMsg>([], (list, m) => [...list, m]);
  return <Ctx.Provider value={{ items, add }}>{children}</Ctx.Provider>;
}

export const usePending = () => useContext(Ctx);

/** Временные сообщения в конце ленты (внутри ChatScroller) */
export function PendingBubbles() {
  const { items } = usePending();
  const end = useRef<HTMLDivElement>(null);

  // Новое сообщение — прокручиваем ленту вниз, как в мессенджере
  useLayoutEffect(() => {
    const box = end.current?.closest("[data-chat-thread]");
    if (items.length && box) box.scrollTo?.({ top: box.scrollHeight, behavior: "smooth" });
  }, [items.length]);

  if (!items.length) return null;
  return (
    <>
      {items.map((m) =>
        m.kind === "note" ? (
          <div key={m.key} className="ck-note ck-pending">
            <div className="ck-note__head">Заметка · <ClockIcon /> {m.status}</div>
            <div className="ck-msg__text">{m.text}</div>
          </div>
        ) : (
          <div key={m.key} className={`ck-msg ${m.kind === "in" ? "ck-msg--in" : "ck-msg--out"} ck-pending`}>
            {m.file ? (
              <div className="ck-field__file" style={{ margin: "0 0 6px" }}>
                <ClipIcon />
                <span>{m.file}</span>
              </div>
            ) : null}
            {m.text ? <div className="ck-msg__text">{m.text}</div> : null}
            <div className="ck-msg__meta"><ClockIcon /> {m.status}</div>
          </div>
        )
      )}
      <div ref={end} hidden />
    </>
  );
}
