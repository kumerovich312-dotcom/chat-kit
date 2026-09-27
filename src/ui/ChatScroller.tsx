"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/* Прокручиваемая лента: при открытии диалога — к последнему сообщению; пришло новое — вниз, если человек и так был
   внизу (читает старое — не дёргаем). Фото и голосовые догружаются позже и делают ленту выше — пока человек внизу,
   лента остаётся внизу. data-chat-thread — здесь ищет поиск по переписке (ChatFind) и фильтр сообщений.
   Листаем только саму ленту (scrollTo), а не scrollIntoView: тот двигает и внешние блоки — страница «уезжала» бы.

   Ещё:
   - щелчок по цитате — лента едет к исходному сообщению и подсвечивает его;
   - старые сообщения при прокрутке вверх (older): долистали до верха — подгружаются сами. Серверной странице — адрес
     с более длинной историей (older.href: страница откроется заново, место в ленте сохранится), браузерной — функция
     older.load. Место чтения не прыгает: сообщение, которое было наверху, остаётся на месте. */

export type OlderMessages = {
  /** Адрес страницы с более ранними сообщениями (например, ?before=<номер первого сообщения>) */
  href?: string | undefined;
  /** Или функция, которая добавит их в ленту */
  load?: (() => void | Promise<void>) | undefined;
  label?: string | undefined;
};

const ANCHOR_KEY = "chat-kit:older-anchor";

/** Номер сообщения в селекторе — с экранированием (CSS.escape есть не везде) */
const esc = (v: string) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(v) : v.replace(/[^\w-]/g, (c) => `\\${c}`));

type Anchor = { dialog: string; id: string; offset: number };

export function ChatScroller({ children, className, lastKey, dialogKey, older }: {
  children: ReactNode;
  className?: string | undefined;
  /** Номер последнего сообщения: сменился — пришло новое */
  lastKey: string | number;
  /** Номер диалога: сменился — открыт другой диалог */
  dialogKey: string | number;
  /** Есть сообщения раньше показанных */
  older?: OlderMessages | null | undefined;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const shown = useRef<string | number | null>(null);
  const anchor = useRef<Anchor | null>(null);
  const [loading, setLoading] = useState(false);

  // Вернуть на место сообщение, которое было наверху до подгрузки старых
  const restore = () => {
    const el = ref.current;
    const a = anchor.current;
    if (!el || !a) return false;
    const target = el.querySelector<HTMLElement>(`[data-message="${esc(a.id)}"]`);
    if (!target) return false;
    el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - a.offset;
    return true;
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (shown.current !== dialogKey) {
      shown.current = dialogKey;
      // Страница открылась заново после «сообщения раньше» — остаёмся там, где читали
      let saved: Anchor | null = null;
      try { saved = JSON.parse(sessionStorage.getItem(ANCHOR_KEY) ?? "null") as Anchor | null; sessionStorage.removeItem(ANCHOR_KEY); } catch { saved = null; }
      if (saved && saved.dialog === String(dialogKey)) {
        anchor.current = saved;
        nearBottom.current = false;
        if (restore()) return;
      }
      el.scrollTop = el.scrollHeight;
      nearBottom.current = true;
      return;
    }
    if (nearBottom.current) el.scrollTo?.({ top: el.scrollHeight, behavior: "smooth" });
  }, [lastKey, dialogKey]);

  // Догрузились картинки и волны голосовых или пришли старые сообщения — лента выросла: если человек был внизу,
  // остаёмся внизу; если подгружали старые — держим на месте то, что он читал
  useEffect(() => {
    const el = ref.current;
    const inner = content.current;
    if (!el || !inner || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (anchor.current) { if (restore()) { anchor.current = null; setLoading(false); } return; }
      if (nearBottom.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  // Долистали до верха — подгружаем старые
  useEffect(() => {
    const el = ref.current;
    const sentinel = top.current;
    if (!el || !sentinel || !older || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting) || loading || el.scrollHeight <= el.clientHeight) return;
      loadOlder();
    }, { root: el, rootMargin: "200px 0px 0px 0px" });
    io.observe(sentinel);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [older?.href, older?.load, loading]);

  const loadOlder = () => {
    const el = ref.current;
    if (!el || !older) return;
    // Запоминаем первое видимое сообщение и где оно было
    const box = el.getBoundingClientRect();
    const first = [...el.querySelectorAll<HTMLElement>("[data-message]")].find((x) => x.getBoundingClientRect().bottom > box.top);
    if (first) anchor.current = { dialog: String(dialogKey), id: first.dataset.message ?? "", offset: first.getBoundingClientRect().top - box.top };
    setLoading(true);
    if (older.load) { void Promise.resolve(older.load()).catch(() => setLoading(false)); return; }
    if (older.href) {
      try { if (anchor.current) sessionStorage.setItem(ANCHOR_KEY, JSON.stringify(anchor.current)); } catch { /* без памяти — просто откроем */ }
      const link = top.current?.querySelector<HTMLAnchorElement>("a[data-ck-older]");
      if (link) link.click();
      else window.location.assign(older.href);
    }
  };

  return (
    <div
      ref={ref}
      data-chat-thread=""
      className={`ck-scroll${className ? ` ${className}` : ""}`}
      onScroll={(e) => {
        const el = e.currentTarget;
        nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
      }}
      onClick={(e) => {
        // Щелчок по цитате — к исходному сообщению, с подсветкой
        const q = (e.target as Element | null)?.closest?.("[data-ck-goto]");
        const el = ref.current;
        if (!q || !el) return;
        const target = el.querySelector<HTMLElement>(`[data-message="${esc(q.getAttribute("data-ck-goto") ?? "")}"]`);
        if (!target) return;
        e.preventDefault();
        el.scrollTo?.({ top: el.scrollTop + target.getBoundingClientRect().top - el.getBoundingClientRect().top - 80, behavior: "smooth" });
        target.classList.remove("ck-flash");
        void target.offsetWidth;
        target.classList.add("ck-flash");
        setTimeout(() => target.classList.remove("ck-flash"), 1800);
      }}
    >
      <div ref={content} className="ck-thread">
        {older ? (
          <div ref={top} className="ck-older">
            {loading ? <span className="ck-older__wait">Загружаю сообщения раньше…</span>
              : older.href ? <a href={older.href} data-ck-older="" className="ck-link" onClick={(e) => { if (!anchor.current) { e.preventDefault(); loadOlder(); } }}>{older.label ?? "Показать сообщения раньше"}</a>
              : <button type="button" className="ck-link" onClick={loadOlder}>{older.label ?? "Показать сообщения раньше"}</button>}
          </div>
        ) : null}
        {children}
      </div>
    </div>
  );
}
