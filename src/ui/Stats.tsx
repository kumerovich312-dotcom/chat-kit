import type { ReactNode } from "react";
import { channelLabel } from "../core/channels.js";
import { durationText, type DayStats, type ResponseStats, type SlowEpisode } from "../core/stats.js";
import { plural } from "../core/text.js";
import { fullTime } from "../core/time.js";
import { ChannelIcon } from "./bits.js";
import type { LinkLike } from "./DialogList.js";

/* Страница статистики ответов — части, из которых проект собирает страницу (данные — из ядра: responseStats,
   statsByDay, slowestEpisodes; подзапрос для Postgres — responseEpisodesSql). Без состояния — годятся для серверной
   страницы. Цель ответа (target, минуты) — одна из targetsMin, по умолчанию 15. */

const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)} %`);

/** Главные цифры периода: обращения, первый ответ (медиана и 90 %), доля в срок, ждут сейчас */
export function StatsCards({ stats, target = 15 }: { stats: ResponseStats; target?: number | undefined }) {
  const within = stats.within.find((w) => w.min === target) ?? stats.within[0];
  const cards: { label: string; value: string; sub?: string | undefined; tone?: "bad" | "good" | undefined }[] = [
    { label: "Обращений", value: String(stats.episodes), sub: `${stats.dialogs} ${plural(stats.dialogs, "диалог", "диалога", "диалогов")}` },
    { label: "Первый ответ", value: durationText(stats.medianSec), sub: stats.p90Sec !== null ? `9 из 10 — быстрее ${durationText(stats.p90Sec)}` : "ответов пока нет" },
    {
      label: within ? `Ответили за ${within.min} мин` : "В срок", value: pct(within?.share ?? null),
      sub: within ? `${within.hit} из ${within.of}` : undefined,
      tone: within?.share === null || within === undefined ? undefined : within.share >= 0.8 ? "good" : within.share < 0.5 ? "bad" : undefined,
    },
    {
      label: "Ждут сейчас", value: String(stats.unanswered), tone: stats.unanswered > 0 ? "bad" : "good",
      sub: stats.longestWaitSec !== null ? `дольше всех — ${durationText(stats.longestWaitSec)}` : "все получили ответ",
    },
  ];
  return (
    <div className="ck-stats__cards">
      {cards.map((c) => (
        <div key={c.label} className={`ck-stats__card${c.tone ? ` ck-stats__card--${c.tone}` : ""}`}>
          <div className="ck-stats__label">{c.label}</div>
          <div className="ck-stats__value">{c.value}</div>
          {c.sub ? <div className="ck-stats__sub">{c.sub}</div> : null}
        </div>
      ))}
    </div>
  );
}

/** Люди и бот: кто сколько ответил и как быстро */
export function StatsWho({ stats, target = 15, botName = "ИИ-агент" }: { stats: ResponseStats; target?: number | undefined; botName?: string | undefined }) {
  const row = (label: string, t: ResponseStats["humans"]) => {
    const w = t.within.find((x) => x.min === target);
    return (
      <tr key={label}>
        <td>{label}</td>
        <td className="ck-mono">{t.answered}</td>
        <td className="ck-mono">{durationText(t.medianSec)}</td>
        <td className="ck-mono">{pct(w?.share ?? null)}</td>
      </tr>
    );
  };
  return (
    <table className="ck-stats__table">
      <thead><tr><th>Кто отвечал</th><th>Ответов</th><th>Первый ответ</th><th>За {target} мин</th></tr></thead>
      <tbody>
        {row("Люди", stats.humans)}
        {row(botName, stats.bot)}
        {stats.byManager.map((m) => row(m.name?.trim() || (m.type === "operator_phone" ? "с телефона" : "сотрудник"), m))}
      </tbody>
    </table>
  );
}

/** По каналам: сколько обращений, как быстро отвечали, сколько ждут */
export function StatsChannels({ stats, target = 15 }: { stats: ResponseStats; target?: number | undefined }) {
  return (
    <table className="ck-stats__table">
      <thead><tr><th>Канал</th><th>Обращений</th><th>Первый ответ</th><th>За {target} мин</th><th>Ждут</th></tr></thead>
      <tbody>
        {stats.byChannel.map((c) => {
          const w = c.within.find((x) => x.min === target);
          return (
            <tr key={c.channel ?? "—"}>
              <td><span className="ck-stats__ch">{c.channel ? <ChannelIcon channel={c.channel} size={14} /> : null}{c.channel ? channelLabel(c.channel) : "—"}</span></td>
              <td className="ck-mono">{c.episodes}</td>
              <td className="ck-mono">{durationText(c.medianSec)}</td>
              <td className="ck-mono">{pct(w?.share ?? null)}</td>
              <td className={`ck-mono${c.unanswered ? " ck-stats__bad" : ""}`}>{c.unanswered}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** График по дням: столбик — медиана первого ответа, красный — дольше цели; пунктир — цель */
export function StatsChart({ days, target = 15 }: { days: readonly DayStats[]; target?: number | undefined }) {
  const limit = target * 60;
  const max = Math.max(limit * 1.5, ...days.map((d) => d.medianSec ?? 0));
  const label = (day: string) => { const [, m, d] = day.split("-"); return `${Number(d)}.${m}`; };
  return (
    <div className="ck-stats__chart" role="img" aria-label={`Скорость первого ответа по дням, цель — ${target} минут`}>
      <div className="ck-stats__target" style={{ bottom: `${(limit / max) * 100}%` }}><span>{target} мин</span></div>
      {days.map((d) => (
        <div key={d.day} className="ck-stats__col" title={`${label(d.day)}: обращений ${d.episodes}, первый ответ ${durationText(d.medianSec)}${d.unanswered ? `, ждут ${d.unanswered}` : ""}`}>
          <div className={`ck-stats__bar${(d.medianSec ?? 0) > limit ? " ck-stats__bar--late" : ""}`} style={{ height: `${d.medianSec === null ? 0 : Math.max(2, (d.medianSec / max) * 100)}%` }} />
          <div className="ck-stats__day">{label(d.day)}</div>
        </div>
      ))}
    </div>
  );
}

/** Кого дольше всех заставили ждать — со ссылкой на диалог */
export function StatsSlow({ items, nameOf, hrefFor, Link, timeZone }: {
  items: readonly SlowEpisode[];
  nameOf: (contactId: string) => string;
  hrefFor: (contactId: string) => string;
  Link?: LinkLike | undefined;
  timeZone?: string | undefined;
}) {
  if (!items.length) return <div className="ck-empty"><div className="ck-empty__title">Долгих ожиданий нет</div></div>;
  const A = Link ?? (({ href, className, children }: { href: string; className?: string | undefined; children?: ReactNode }) => <a href={href} className={className}>{children}</a>);
  return (
    <div className="ck-stats__slow">
      {items.map((e) => (
        <A key={`${e.contactId}-${e.startedAt}`} href={hrefFor(e.contactId)} className={`ck-stats__slowrow${e.waiting ? " ck-stats__slowrow--waiting" : ""}`}>
          {e.channel ? <ChannelIcon channel={e.channel} size={14} /> : null}
          <span className="ck-stats__slowname">{nameOf(e.contactId)}</span>
          <span className="ck-stats__slowwhen">{fullTime(e.startedAt, timeZone)}</span>
          <span className="ck-stats__slowwait">{e.waiting ? `ждёт ${durationText(e.waitedSec)}` : `ответ через ${durationText(e.waitedSec)}`}</span>
        </A>
      ))}
    </div>
  );
}
