"use client";

import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import type { Assessment, Assignee, DialogStatus, Presence } from "../core/conversation.js";
import { DEFAULT_TEXTS, fill, type ProfileTag, type Texts } from "../core/profile.js";
import { untilText } from "../core/time.js";
import { ChevronIcon, CloseIcon, EyeIcon, PencilIcon, PlusIcon, TagIcon, UserIcon } from "./icons.js";

/* Полоса под шапкой диалога (выбор пользователя 27.09.2026): слева — метки, дальше — оценка ИИ («срочно», «недоволен»)
   и кто из коллег сейчас в диалоге («Айгерим пишет ответ…» — чтобы не ответить клиенту вдвоём), справа — ответственный
   и статус диалога («Открыт ▾»: отложить до…, закрыть). Все изменения — формы (server actions):
   status: status (open / snoozed / closed), until — до какого времени отложен;
   tags:   tag — код метки, on — 1 поставить / 0 снять;
   assign: user_id — ответственный (пусто — снять). */

type FormAction = (form: FormData) => void | Promise<void>;

export type SnoozeChoice = { label: string; until: string };

export type StripProps = {
  status?: DialogStatus | undefined;
  snoozedUntil?: string | null | undefined;
  tags?: readonly string[] | undefined;
  /** Метки из паспорта проекта */
  tagDefs?: readonly ProfileTag[] | undefined;
  assignee?: Assignee | null | undefined;
  /** Кому можно передать диалог */
  managers?: readonly Assignee[] | undefined;
  assessment?: Assessment | null | undefined;
  presence?: readonly Presence[] | undefined;
  meId?: string | null | undefined;
  /** Варианты «отложить до» — по поясу компании (team.ts: snoozeChoices) */
  snoozeChoices?: readonly SnoozeChoice[] | undefined;
  actions?: { status?: FormAction | undefined; tags?: FormAction | undefined; assign?: FormAction | undefined } | undefined;
  t?: Texts | undefined;
  timeZone?: string | undefined;
  now?: number | undefined;
  /** Своё справа (кнопки проекта) */
  extra?: ReactNode;
};

/** Кто из коллег сейчас в диалоге: пишет ответ — важнее, чем просто смотрит. Старше минуты — не показываем */
export function presenceLine(list: readonly Presence[], meId: string | null | undefined, now: number): { typing: boolean; text: string } | null {
  const fresh = list.filter((p) => p.userId !== meId && now - Date.parse(p.at) < 60_000);
  const names = (xs: Presence[]) => [...new Set(xs.map((p) => p.name))];
  const typing = names(fresh.filter((p) => p.state === "typing"));
  if (typing.length) return { typing: true, text: `${typing.join(" и ")} ${typing.length > 1 ? "пишут" : "пишет"} ответ…` };
  const viewing = names(fresh.filter((p) => p.state === "viewing"));
  if (viewing.length) return { typing: false, text: `${viewing.join(" и ")} ${viewing.length > 1 ? "смотрят" : "смотрит"} этот диалог` };
  return null;
}

/** Меню-всплывашка: закрывается щелчком мимо и Esc */
function useMenu() {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  return { open, setOpen, box };
}

export function DialogStrip(p: StripProps) {
  const t = p.t ?? DEFAULT_TEXTS;
  const [, tick] = useState(0);
  const [busy, start] = useTransition();
  // Сразу показываем выбранное, пока сервер сохраняет; пришли новые данные — берём их
  const [tags, setTags] = useState(p.tags ?? []);
  const [status, setStatus] = useState<{ s: DialogStatus; until: string | null }>({ s: p.status ?? "open", until: p.snoozedUntil ?? null });
  const [assignee, setAssignee] = useState(p.assignee ?? null);
  useEffect(() => setTags(p.tags ?? []), [p.tags]);
  useEffect(() => setStatus({ s: p.status ?? "open", until: p.snoozedUntil ?? null }), [p.status, p.snoozedUntil]);
  useEffect(() => setAssignee(p.assignee ?? null), [p.assignee]);
  // «Пишет ответ» устаревает через минуту — перерисовываемся сами
  useEffect(() => { const id = setInterval(() => tick((x) => x + 1), 15_000); return () => clearInterval(id); }, []);

  const tagMenu = useMenu();
  const whoMenu = useMenu();
  const statusMenu = useMenu();
  const now = Date.now();
  const defs = p.tagDefs ?? [];
  const tagOf = (code: string) => defs.find((d) => d.code === code) ?? { code, label: code };
  const presence = presenceLine(p.presence ?? [], p.meId, now);
  const a = p.assessment;
  const urgent = a?.urgency === "high";
  const unhappy = a?.mood === "negative";

  const send = (action: FormAction | undefined, fields: Record<string, string>) => start(async () => {
    if (!action) return;
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    await action(fd);
  });
  const toggleTag = (code: string) => {
    const on = !tags.includes(code);
    setTags(on ? [...tags, code] : tags.filter((x) => x !== code));
    send(p.actions?.tags, { tag: code, on: on ? "1" : "0" });
  };
  const setDialogStatus = (s: DialogStatus, until: string | null = null) => {
    setStatus({ s, until });
    statusMenu.setOpen(false);
    send(p.actions?.status, { status: s, ...(until ? { until } : {}) });
  };
  const assign = (who: Assignee | null) => {
    setAssignee(who);
    whoMenu.setOpen(false);
    send(p.actions?.assign, { user_id: who?.id ?? "" });
  };

  const statusLabel = status.s === "closed" ? t.statusClosed
    : status.s === "snoozed" ? (status.until ? fill(t.statusSnoozedUntil, { until: `до ${untilText(status.until, p.timeZone, now)}` }) : t.statusSnoozed)
    : t.statusOpen;

  return (
    <div className="ck-strip" aria-busy={busy || undefined}>
      <div className="ck-strip__tags">
        {tags.map((code) => {
          const d = tagOf(code);
          return (
            <span key={code} className={`ck-tag ck-tone--${"tone" in d && d.tone ? d.tone : "gray"}`}>
              {d.label}
              {p.actions?.tags ? <button type="button" className="ck-tag__x" aria-label={`Снять метку «${d.label}»`} onClick={() => toggleTag(code)}><CloseIcon /></button> : null}
            </span>
          );
        })}
        {p.actions?.tags && defs.length > 0 ? (
          <span ref={tagMenu.box} className="ck-strip__menu">
            <button type="button" className="ck-tag ck-tag--add" aria-expanded={tagMenu.open} onClick={() => tagMenu.setOpen(!tagMenu.open)}>
              <PlusIcon /> {t.addTag}
            </button>
            {tagMenu.open ? (
              <div className="ck-pop ck-pop--down">
                {defs.map((d) => (
                  <button key={d.code} type="button" className="ck-pop__item ck-pop__check" aria-pressed={tags.includes(d.code)} onClick={() => toggleTag(d.code)}>
                    <span className={`ck-dot ck-tone--${d.tone ?? "gray"}`} aria-hidden="true" /> {d.label}
                  </button>
                ))}
              </div>
            ) : null}
          </span>
        ) : tags.length === 0 && defs.length > 0 ? <span className="ck-strip__muted"><TagIcon /> без меток</span> : null}
      </div>

      {urgent || unhappy ? (
        <span className="ck-strip__mood" title={a?.reason ?? undefined}>
          {urgent ? <span className="ck-badge ck-tone--red">{t.urgent}</span> : null}
          {unhappy ? <span className="ck-badge ck-tone--amber">{t.unhappy}</span> : null}
        </span>
      ) : null}

      {presence ? (
        <span className={`ck-strip__presence${presence.typing ? " ck-strip__presence--typing" : ""}`}>
          {presence.typing ? <PencilIcon /> : <EyeIcon />} {presence.text}
        </span>
      ) : null}

      <div className="ck-strip__right">
        {p.extra}
        {p.actions?.assign || assignee ? (
          <span ref={whoMenu.box} className="ck-strip__menu">
            <button type="button" className="ck-strip__btn" disabled={!p.actions?.assign} aria-expanded={whoMenu.open}
              title={t.assignee} onClick={() => whoMenu.setOpen(!whoMenu.open)}>
              <UserIcon /> {assignee ? assignee.name : t.assigneeNone}
              {p.actions?.assign ? <ChevronIcon /> : null}
            </button>
            {whoMenu.open ? (
              <div className="ck-pop ck-pop--down ck-pop--right">
                <div className="ck-pop__head">{t.assignee}</div>
                {(p.managers ?? []).map((m) => (
                  <button key={m.id} type="button" className="ck-pop__item ck-pop__check" aria-pressed={assignee?.id === m.id} onClick={() => assign(m)}>
                    {m.name}{m.id === p.meId ? " (вы)" : ""}
                  </button>
                ))}
                {assignee ? <button type="button" className="ck-pop__item ck-pop__sep" onClick={() => assign(null)}>Снять ответственного</button> : null}
              </div>
            ) : null}
          </span>
        ) : null}
        {p.actions?.status ? (
          <span ref={statusMenu.box} className="ck-strip__menu">
            <button type="button" className={`ck-strip__btn ck-status ck-status--${status.s}`} aria-expanded={statusMenu.open} onClick={() => statusMenu.setOpen(!statusMenu.open)}>
              <span className="ck-status__dot" aria-hidden="true" /> {statusLabel} <ChevronIcon />
            </button>
            {statusMenu.open ? (
              <div className="ck-pop ck-pop--down ck-pop--right">
                {status.s !== "open" ? <button type="button" className="ck-pop__item" onClick={() => setDialogStatus("open")}>{t.reopen}</button> : null}
                {status.s !== "closed" && (p.snoozeChoices?.length ?? 0) > 0 ? (
                  <>
                    <div className="ck-pop__head ck-pop__sep">{t.snooze}</div>
                    {p.snoozeChoices!.map((c) => (
                      <button key={c.until} type="button" className="ck-pop__item" onClick={() => setDialogStatus("snoozed", c.until)}>{c.label}</button>
                    ))}
                  </>
                ) : null}
                {status.s !== "closed" ? <button type="button" className="ck-pop__item ck-pop__sep" onClick={() => setDialogStatus("closed")}>{t.close}</button> : null}
              </div>
            ) : null}
          </span>
        ) : status.s !== "open" ? <span className={`ck-strip__btn ck-status ck-status--${status.s}`}><span className="ck-status__dot" aria-hidden="true" /> {statusLabel}</span> : null}
      </div>
    </div>
  );
}
