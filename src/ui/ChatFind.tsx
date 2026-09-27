"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { foldYo, searchWords } from "../core/text.js";
import { ChevronIcon, CloseIcon, SearchIcon } from "./icons.js";

/* Поиск внутри переписки (Атлас, 25.09.2026): лупа открывает строку над лентой. Находит сообщения, где есть все слова
   запроса (в любом порядке, ё = е), подсвечивает слова, «N из M» и стрелки — к более старому и новому (Enter — старее,
   Shift+Enter — новее, Esc — закрыть). Начинает с самого нового. Лента не перерисовывается: подсветка — CSS Custom
   Highlight API (::highlight(ck-find) в styles.css); текст сообщений помечен data-find, лента — data-chat-thread.
   Пришло новое сообщение — совпадения пересчитываются. Показаны не все сообщения — «искать во всей переписке» (moreHref). */

export const CHAT_FIND_EVENT = "chat-kit:find";

/** Открыть поиск по переписке (лупа в шапке) */
export function openChatFind() {
  window.dispatchEvent(new Event(CHAT_FIND_EVENT));
}

export function ChatFindButton({ className }: { className?: string | undefined }) {
  return (
    <button type="button" onClick={openChatFind} aria-label="Найти в переписке" className={`ck-iconbtn${className ? ` ${className}` : ""}`}>
      <SearchIcon />
    </button>
  );
}

type Match = { el: Element; ranges: Range[] };

function findMatches(q: string, scope: Element | null): Match[] {
  const words = searchWords(q).map((w) => w.toLowerCase());
  if (!words.length || !scope) return [];
  const out: Match[] = [];
  for (const el of scope.querySelectorAll("[data-find]")) {
    const all = foldYo(el.textContent ?? "").toLowerCase();
    if (!words.every((w) => all.includes(w))) continue;
    const ranges: Range[] = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const raw = n.nodeValue ?? "";
      const t = foldYo(raw).toLowerCase();
      // Редкие буквы меняют длину при toLowerCase — такой кусок не подсвечиваем, чтобы не промахнуться
      if (t.length !== raw.length) continue;
      for (const w of words) {
        for (let at = t.indexOf(w); at >= 0; at = t.indexOf(w, at + w.length)) {
          const r = document.createRange();
          r.setStart(n, at);
          r.setEnd(n, at + w.length);
          ranges.push(r);
        }
      }
    }
    out.push({ el, ranges });
  }
  return out;
}

type HighlightsApi = { set(name: string, h: unknown): void; delete(name: string): void };
function highlights(): HighlightsApi | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightsApi } }).CSS;
  const H = (globalThis as { Highlight?: unknown }).Highlight;
  return css?.highlights && typeof H === "function" ? css.highlights : null;
}
function paint(matches: Match[], idx: number) {
  const hl = highlights();
  if (!hl) return;
  const H = (globalThis as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight;
  hl.set("ck-find", new H(...matches.flatMap((m, i) => (i === idx ? [] : m.ranges))));
  hl.set("ck-find-current", new H(...(matches[idx]?.ranges ?? [])));
}
function unpaint() {
  const hl = highlights();
  hl?.delete("ck-find");
  hl?.delete("ck-find-current");
}

/** Строка поиска над лентой. initial — открыть сразу с этим текстом (поиск в списке диалогов нашёл слово в сообщении).
 *  Показаны не все сообщения — ссылка «искать во всей переписке»: moreHref (к адресу допишется find=<запрос>) или more
 *  (своя разметка по тексту запроса — только из браузерного кода) */
export function ChatFind({ initial = "", moreHref, more }: {
  initial?: string | undefined;
  moreHref?: string | null | undefined;
  more?: ((q: string) => ReactNode) | undefined;
}) {
  const [open, setOpen] = useState(!!initial.trim());
  const [text, setText] = useState(initial);
  const [matches, setMatches] = useState<Match[]>([]);
  const [idx, setIdx] = useState(-1);
  const [tick, setTick] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const lastText = useRef<string | null>(null);
  const scrollNext = useRef(false);

  useEffect(() => {
    const onOpen = () => { setOpen(true); window.setTimeout(() => input.current?.focus(), 0); };
    window.addEventListener(CHAT_FIND_EVENT, onOpen);
    return () => window.removeEventListener(CHAT_FIND_EVENT, onOpen);
  }, []);

  // Лента изменилась (новое сообщение, обновление страницы) — пересчитать совпадения, не дёргая прокрутку
  useEffect(() => {
    if (!open) return;
    const box = document.querySelector("[data-chat-thread]");
    if (!box) return;
    const mo = new MutationObserver(() => setTick((t) => t + 1));
    mo.observe(box, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  }, [open]);

  useEffect(() => {
    if (!open) { unpaint(); setMatches([]); setIdx(-1); lastText.current = null; return; }
    const timer = window.setTimeout(() => {
      const found = findMatches(text, document.querySelector("[data-chat-thread]"));
      const same = lastText.current === text;
      lastText.current = text;
      setMatches(found);
      // Новый запрос — с самого нового сообщения; та же строка после обновления ленты — остаёмся где были
      setIdx((i) => (same && i >= 0 && i < found.length ? i : found.length - 1));
      if (!same) scrollNext.current = true;
    }, 150);
    return () => window.clearTimeout(timer);
  }, [text, open, tick]);

  useEffect(() => {
    paint(matches, idx);
    const m = matches[idx];
    if (scrollNext.current && m) {
      scrollNext.current = false;
      const box = document.querySelector("[data-chat-thread]");
      if (box) {
        const r = m.el.getBoundingClientRect();
        const b = box.getBoundingClientRect();
        box.scrollTo?.({ top: box.scrollTop + (r.top - b.top) - box.clientHeight / 2 + r.height / 2, behavior: "smooth" });
      }
    }
  }, [matches, idx]);

  useEffect(() => () => unpaint(), []);

  if (!open) return null;
  const n = matches.length;
  const typed = text.trim().length > 0;
  const go = (d: number) => { if (!n) return; scrollNext.current = true; setIdx((i) => (i + d + n) % n); };
  const close = () => { setOpen(false); setText(""); };

  return (
    <div role="search" className="ck-find">
      <div className="ck-find__row">
        <SearchIcon />
        <input
          ref={input}
          value={text}
          autoFocus
          onChange={(e) => setText(e.target.value)}
          placeholder="Найти в переписке"
          aria-label="Найти в переписке"
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); go(e.shiftKey ? 1 : -1); }
            if (e.key === "Escape") { e.preventDefault(); close(); }
          }}
        />
        <span className={`ck-find__count${typed && !n ? " ck-find__count--none" : ""}`} aria-live="polite">{typed ? (n ? `${idx + 1} из ${n}` : "не нашли") : ""}</span>
        <button type="button" onClick={() => go(-1)} disabled={!n} aria-label="Раньше" className="ck-iconbtn"><ChevronIcon dir="up" /></button>
        <button type="button" onClick={() => go(1)} disabled={!n} aria-label="Позже" className="ck-iconbtn"><ChevronIcon dir="down" /></button>
        <button type="button" onClick={close} aria-label="Закрыть поиск по переписке" className="ck-iconbtn"><CloseIcon /></button>
      </div>
      {(more || moreHref) && typed ? (
        <div className="ck-find__more">
          Ищем в показанных сообщениях ·{" "}
          {more ? more(text.trim()) : <a className="ck-link" href={`${moreHref}${moreHref!.includes("?") ? "&" : "?"}find=${encodeURIComponent(text.trim())}`}>искать во всей переписке</a>}
        </div>
      ) : null}
    </div>
  );
}
