"use client";

import { useEffect, useRef, useState } from "react";
import { DEFAULT_TEXTS, type Texts } from "../core/profile.js";
import { CloseIcon } from "./icons.js";
import { usePanel } from "./Panels.js";

/* Фильтр сообщений — строка кнопок над лентой, открывается кнопкой в шапке (выбор пользователя 27.09.2026): все,
   только клиент, бот, команда, заметки, файлы, голосовые, звонки. Лента не перерисовывается: у каждой записи есть
   data-f со словами «кто и что» (ChatThread), фильтр прячет лишнее атрибутом hidden — годится и для серверной ленты.
   Пришли новые сообщения — фильтр применяется к ним сразу. Закрыли строку — снова видно всё. */

export type FilterKey = "all" | "client" | "bot" | "team" | "notes" | "files" | "voice" | "calls";

const RULES: Record<FilterKey, (f: readonly string[]) => boolean> = {
  all: () => true,
  client: (f) => f.includes("client") && !f.includes("note"),
  bot: (f) => f.includes("bot") && !f.includes("note"),
  team: (f) => f.includes("team") && !f.includes("note"),
  notes: (f) => f.includes("note"),
  files: (f) => f.includes("file"),
  voice: (f) => f.includes("voice"),
  calls: (f) => f.includes("call"),
};

/** Подходит ли запись ленты (слова её data-f) под фильтр */
export function matchesFilter(tokens: string, key: FilterKey): boolean {
  return RULES[key](tokens.split(/\s+/).filter(Boolean));
}

/** Спрятать в ленте всё, что не подходит под фильтр; дни без видимых сообщений — тоже. Сколько осталось видно */
export function applyFilter(scope: ParentNode, key: FilterKey): number {
  let shown = 0;
  for (const el of scope.querySelectorAll<HTMLElement>("[data-f]")) {
    const ok = matchesFilter(el.dataset.f ?? "", key);
    el.hidden = !ok;
    if (ok) shown++;
  }
  for (const day of scope.querySelectorAll<HTMLElement>(".ck-day")) {
    day.hidden = key !== "all" && !day.querySelector("[data-f]:not([hidden])");
  }
  return shown;
}

export function ThreadFilter({ t = DEFAULT_TEXTS, keys }: {
  t?: Pick<Texts, "filterAll" | "filterClient" | "filterBot" | "filterTeam" | "filterNotes" | "filterFiles" | "filterVoice" | "filterCalls" | "filter"> | undefined;
  /** Какие кнопки показать (по умолчанию — все) */
  keys?: readonly FilterKey[] | undefined;
}) {
  const [open, setOpen] = usePanel("filter");
  const [key, setKey] = useState<FilterKey>("all");
  const [count, setCount] = useState<number | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const labels: Record<FilterKey, string> = {
    all: t.filterAll, client: t.filterClient, bot: t.filterBot, team: t.filterTeam, notes: t.filterNotes,
    files: t.filterFiles, voice: t.filterVoice, calls: t.filterCalls,
  };
  const list = keys ?? (Object.keys(labels) as FilterKey[]);

  // Применить к ленте рядом (внутри того же окна) и следить за новыми сообщениями
  useEffect(() => {
    const scope = bar.current?.closest(".ck-window__body, .ck")?.querySelector("[data-chat-thread]") ?? document.querySelector("[data-chat-thread]");
    if (!scope) return;
    const current = open ? key : "all";
    setCount(current === "all" ? null : applyFilter(scope, current));
    if (current === "all") { applyFilter(scope, "all"); return; }
    const mo = new MutationObserver(() => setCount(applyFilter(scope, current)));
    mo.observe(scope, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [open, key]);

  // Esc — закрыть
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open, setOpen]);

  return (
    <div ref={bar} className="ck-filter" hidden={!open} role="toolbar" aria-label={t.filter}>
      {open ? (
        <>
          <div className="ck-filter__chips">
            {list.map((k) => (
              <button key={k} type="button" className="ck-chip" aria-pressed={key === k} onClick={() => setKey(k)}>{labels[k]}</button>
            ))}
          </div>
          {count !== null ? <span className="ck-filter__count">{count === 0 ? "ничего нет" : `видно: ${count}`}</span> : null}
          <button type="button" className="ck-iconbtn" aria-label="Закрыть фильтр" onClick={() => { setKey("all"); setOpen(false); }}><CloseIcon /></button>
        </>
      ) : null}
    </div>
  );
}
