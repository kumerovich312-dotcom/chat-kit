"use client";

import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

/* Прокручиваемая лента: при открытии диалога — к последнему сообщению; пришло новое — вниз, если человек и так был
   внизу (читает старое — не дёргаем). Фото и голосовые догружаются позже и делают ленту выше — пока человек внизу,
   лента остаётся внизу. data-chat-thread — здесь ищет поиск по переписке (ChatFind).
   Листаем только саму ленту (scrollTo), а не scrollIntoView: тот двигает и внешние блоки — страница «уезжала» бы. */

export function ChatScroller({ children, className, lastKey, dialogKey }: {
  children: ReactNode;
  className?: string | undefined;
  /** Номер последнего сообщения: сменился — пришло новое */
  lastKey: string | number;
  /** Номер диалога: сменился — открыт другой диалог */
  dialogKey: string | number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const shown = useRef<string | number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (shown.current !== dialogKey) {
      shown.current = dialogKey;
      el.scrollTop = el.scrollHeight;
      nearBottom.current = true;
      return;
    }
    if (nearBottom.current) el.scrollTo?.({ top: el.scrollHeight, behavior: "smooth" });
  }, [lastKey, dialogKey]);

  // Догрузились картинки и волны голосовых — лента выросла: если человек был внизу, остаёмся внизу
  useEffect(() => {
    const el = ref.current;
    const inner = content.current;
    if (!el || !inner || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => { if (nearBottom.current) el.scrollTop = el.scrollHeight; });
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      data-chat-thread=""
      className={`ck-scroll${className ? ` ${className}` : ""}`}
      onScroll={(e) => {
        const el = e.currentTarget;
        nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
      }}
    >
      <div ref={content} className="ck-thread">{children}</div>
    </div>
  );
}
