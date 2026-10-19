"use client";

import { useEffect, useState, type ReactNode } from "react";
import { DEFAULT_TEXTS, type Texts } from "../core/profile.js";
import { CloseIcon, FilterIcon, GalleryIcon, PanelIcon, TextIcon } from "./icons.js";

/* Кнопки в шапке диалога и то, что они открывают (выбор пользователя 27.09.2026):
   - фильтр сообщений — кнопка в шапке, строка кнопок открывается над лентой (ThreadFilter);
   - все файлы клиента — галерея поверх окна (ClientGallery);
   - «Кратко» — плашка с кратким содержанием сверху ленты (SummaryBar).
   Вид «Мессенджер» (макет пользователя 19.10.2026): кнопки «Кратко», фильтра и файлов, полоса статуса и меток — в панели
   диалога сбоку (SidePanel), её открывает кнопка справа в шапке (SideToggle).
   Шапка может быть серверной, поэтому кнопка и то, что она открывает, связаны событием окна, а не общим состоянием. */

export type PanelName = "filter" | "gallery" | "summary" | "side";

export const CHAT_PANEL_EVENT = "chat-kit:panel";

type PanelDetail = { name: PanelName; open?: boolean | undefined };

/** Открыть, закрыть или переключить часть окна: фильтр, галерею, «Кратко» */
export function togglePanel(name: PanelName, open?: boolean) {
  window.dispatchEvent(new CustomEvent<PanelDetail>(CHAT_PANEL_EVENT, { detail: { name, open } }));
}

/** Открыта ли часть окна — для того, что кнопка открывает */
export function usePanel(name: PanelName): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<PanelDetail>).detail;
      if (d?.name === name) setOpen((x) => (d.open === undefined ? !x : d.open));
    };
    window.addEventListener(CHAT_PANEL_EVENT, on);
    return () => window.removeEventListener(CHAT_PANEL_EVENT, on);
  }, [name]);
  return [open, (v: boolean) => togglePanel(name, v)];
}

/** Нажата ли кнопка — подсветить её, пока открыто */
function usePressed(name: PanelName): boolean {
  const [open] = usePanel(name);
  return open;
}

/** labeled — кнопка с надписью (в панели диалога), иначе — значок (в шапке) */
export function FilterButton({ t = DEFAULT_TEXTS, labeled = false }: { t?: Pick<Texts, "filter"> | undefined; labeled?: boolean | undefined }) {
  const pressed = usePressed("filter");
  return (
    <button type="button" className={labeled ? "ck-btn ck-btn--sm ck-side__tool" : "ck-iconbtn"} aria-label={labeled ? undefined : t.filter} title={t.filter} aria-pressed={pressed} onClick={() => togglePanel("filter")}>
      <FilterIcon />{labeled ? ` ${t.filter}` : null}
    </button>
  );
}

export function GalleryButton({ t = DEFAULT_TEXTS, count, labeled = false }: { t?: Pick<Texts, "files"> | undefined; count?: number | undefined; labeled?: boolean | undefined }) {
  return (
    <button type="button" className={labeled ? "ck-btn ck-btn--sm ck-side__tool" : "ck-iconbtn"} aria-label={labeled ? undefined : t.files} title={count ? `${t.files}: ${count}` : t.files} onClick={() => togglePanel("gallery", true)}>
      <GalleryIcon />{labeled ? <> {t.files}{count ? <span className="ck-count ck-count--muted">{count}</span> : null}</> : null}
    </button>
  );
}

export function SummaryButton({ t = DEFAULT_TEXTS }: { t?: Pick<Texts, "summary" | "summaryTitle"> | undefined }) {
  const pressed = usePressed("summary");
  return (
    <button type="button" className="ck-btn ck-btn--sm ck-btn--ghost ck-summary-btn" title={t.summaryTitle} aria-pressed={pressed} onClick={() => togglePanel("summary")}>
      <TextIcon /> {t.summary}
    </button>
  );
}

/** Кнопка панели диалога — справа в шапке (вид «Мессенджер») */
export function SideToggle({ t = DEFAULT_TEXTS }: { t?: Pick<Texts, "panel"> | undefined }) {
  const pressed = usePressed("side");
  return (
    <button type="button" className="ck-iconbtn ck-side-toggle" aria-label={t.panel} title={t.panel} aria-pressed={pressed} onClick={() => togglePanel("side")}>
      <PanelIcon />
    </button>
  );
}

const SIDE_KEY = "chat-kit.side";

/** Панель диалога сбоку: статус и метки, «Кратко», фильтр, файлы, бот, что бот знает, панель проекта. На широком экране —
 *  колонкой справа, на узком — поверх переписки. Открыта или нет — запоминается в браузере сотрудника. Содержимое не
 *  пропадает, пока панель закрыта: «Кратко» не спрашивает ИИ второй раз */
export function SidePanel({ children, t = DEFAULT_TEXTS, className }: {
  children?: ReactNode;
  t?: Pick<Texts, "panel"> | undefined;
  className?: string | undefined;
}) {
  const [open, setOpen] = usePanel("side");
  const [ready, setReady] = useState(false);
  // Как было в прошлый раз — после того как кнопка в шапке начала слушать
  useEffect(() => {
    const id = window.setTimeout(() => {
      let saved = false;
      try { saved = window.localStorage.getItem(SIDE_KEY) === "1"; } catch { /* хранилище недоступно — закрыта */ }
      if (saved) togglePanel("side", true);
      setReady(true);
    }, 0);
    return () => window.clearTimeout(id);
  }, []);
  useEffect(() => {
    if (!ready) return;
    try { window.localStorage.setItem(SIDE_KEY, open ? "1" : "0"); } catch { /* не запомним — не страшно */ }
  }, [open, ready]);
  // Поверх переписки (узкий экран) — закрыть по Esc
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector(".ck-viewer, .ck-gallery")) return;
      if (window.matchMedia?.("(max-width: 1279.98px)").matches) setOpen(false);
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open, setOpen]);
  return (
    <aside className={`ck-side ck-scroll${className ? ` ${className}` : ""}`} hidden={!open} aria-label={t.panel}>
      <div className="ck-side__head">
        <strong>{t.panel}</strong>
        <button type="button" className="ck-iconbtn" aria-label="Закрыть панель" onClick={() => setOpen(false)}><CloseIcon /></button>
      </div>
      {children}
    </aside>
  );
}
