"use client";

import { useEffect, useState } from "react";
import { DEFAULT_TEXTS, type Texts } from "../core/profile.js";
import { FilterIcon, GalleryIcon, TextIcon } from "./icons.js";

/* Кнопки в шапке диалога и то, что они открывают (выбор пользователя 27.09.2026):
   - фильтр сообщений — кнопка в шапке, строка кнопок открывается над лентой (ThreadFilter);
   - все файлы клиента — галерея поверх окна (ClientGallery);
   - «Кратко» — плашка с кратким содержанием сверху ленты (SummaryBar).
   Шапка может быть серверной, поэтому кнопка и то, что она открывает, связаны событием окна, а не общим состоянием. */

export type PanelName = "filter" | "gallery" | "summary";

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

export function FilterButton({ t = DEFAULT_TEXTS }: { t?: Pick<Texts, "filter"> | undefined }) {
  const pressed = usePressed("filter");
  return (
    <button type="button" className="ck-iconbtn" aria-label={t.filter} title={t.filter} aria-pressed={pressed} onClick={() => togglePanel("filter")}>
      <FilterIcon />
    </button>
  );
}

export function GalleryButton({ t = DEFAULT_TEXTS, count }: { t?: Pick<Texts, "files"> | undefined; count?: number | undefined }) {
  return (
    <button type="button" className="ck-iconbtn" aria-label={t.files} title={count ? `${t.files}: ${count}` : t.files} onClick={() => togglePanel("gallery", true)}>
      <GalleryIcon />
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
