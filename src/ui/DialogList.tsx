import type { ComponentType, ReactNode } from "react";
import type { DialogSummary } from "../core/conversation.js";
import { botStateText } from "../core/conversation.js";
import { CHANNEL_LABEL } from "../core/channels.js";
import { stripRich } from "../core/markup.js";
import { plural } from "../core/text.js";
import { dayDiff, fmtClock, listTime } from "../core/time.js";

/** «18:30», «завтра 09:00», «14 сен 18:30» — до какого времени бот на паузе */
export function untilText(iso: string, timeZone: string | undefined, now: number): string {
  const d = dayDiff(iso, now, timeZone);
  const clock = fmtClock(iso, timeZone, false);
  if (d === 0) return clock;
  if (d === 1) return `завтра ${clock}`;
  return `${listTime(iso, timeZone, now)} ${clock}`;
}
import { Avatar, ChannelIcon } from "./bits.js";
import { WaitLabel } from "./Wait.js";

/* Список диалогов: поиск по имени и тексту, фильтры «Все / Ждут ответа / Непрочитанные» со счётчиками, каналы значками.
   В строке — кто написал последним: клиент — без подписи, бот — «ИИ-агент:» фиолетовым, менеджер с телефона —
   «Менеджер с телефона:», свой — «Вы:», коллега — его имя. Клиент ждёт ответа — вместо времени «ждёт 25 мин» красным.
   Длинный список — частями: «Показать ещё» (без скрытой обрезки).

   Список не ходит в базу сам: строки, счётчики и адреса даёт проект (hrefFor, link) — фильтры и поиск меняют адрес
   страницы. Ссылки — компонентом проекта (Link из Next.js), по умолчанию — обычная ссылка. Годится для серверной страницы. */

export type ListFilter = "all" | "wait" | "unread";

export type LinkLike = ComponentType<{ href: string; className?: string | undefined; children?: ReactNode; "aria-current"?: "true" | undefined; scroll?: boolean | undefined; title?: string | undefined }>;

const PlainLink: LinkLike = ({ href, className, children, ...rest }) => (
  <a href={href} className={className} aria-current={rest["aria-current"]} title={rest.title}>{children}</a>
);

export type DialogListProps = {
  dialogs: readonly DialogSummary[];
  activeId?: string | null | undefined;
  /** Адрес диалога */
  hrefFor: (d: DialogSummary) => string;
  /** Адрес списка с другим фильтром, каналом, числом строк */
  link: (over: { filter?: ListFilter | undefined; channel?: string | null | undefined; more?: boolean | undefined }) => string;
  filter?: ListFilter | undefined;
  channel?: string | null | undefined;
  /** Счётчики: ждут ответа, непрочитанных сообщений, диалогов по каналам */
  counts?: { wait?: number | undefined; unread?: number | undefined; channels?: Readonly<Record<string, number>> | undefined } | undefined;
  /** Каналы-чипы (по умолчанию — те, по которым есть диалоги) */
  channels?: readonly string[] | undefined;
  /** Поиск: адрес формы (GET) и имя поля; текущий запрос */
  search?: { action: string; name?: string | undefined; value?: string | undefined; hidden?: Readonly<Record<string, string>> | undefined } | undefined;
  /** Есть ещё строки */
  hasMore?: boolean | undefined;
  moreLabel?: string | undefined;
  title?: string | undefined;
  /** Кто смотрит — «Вы:» перед своим сообщением */
  meId?: string | null | undefined;
  timeZone?: string | undefined;
  now?: number | undefined;
  Link?: LinkLike | undefined;
  /** Пусто — своё пояснение */
  empty?: ReactNode;
};

export function DialogList(p: DialogListProps) {
  const L = p.Link ?? PlainLink;
  const now = p.now ?? Date.now();
  const filter = p.filter ?? "all";
  const unread = p.counts?.unread ?? 0;
  const chans = p.channels ?? Object.keys(p.counts?.channels ?? {}).filter((k) => (p.counts?.channels?.[k] ?? 0) > 0 || k === p.channel);
  const filters: { key: ListFilter; label: string; n: number }[] = [
    { key: "all", label: "Все", n: 0 },
    { key: "wait", label: "Ждут ответа", n: p.counts?.wait ?? 0 },
    { key: "unread", label: "Непрочитанные", n: unread },
  ];
  return (
    <div className="ck ck-list">
      <div className="ck-list__head">
        <div className="ck-list__title">
          <strong>{p.title ?? "Переписка"}</strong>
          <span className={`ck-list__unread${unread > 0 ? " ck-list__unread--some" : ""}`}>
            {unread > 0 ? `${unread} ${plural(unread, "непрочитанное", "непрочитанных", "непрочитанных")}` : "всё прочитано"}
          </span>
        </div>
        {p.search && (
          <form action={p.search.action} method="get" role="search">
            {Object.entries(p.search.hidden ?? {}).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
            <input className="ck-search" name={p.search.name ?? "q"} defaultValue={p.search.value ?? ""} placeholder="Поиск по имени и тексту" aria-label="Поиск по имени и тексту" />
          </form>
        )}
        <div className="ck-chips">
          {filters.map((f) => (
            <L key={f.key} href={p.link({ filter: f.key })} className="ck-chip" aria-current={filter === f.key ? "true" : undefined}>
              {f.label}
              {f.n > 0 ? <span className="ck-count">{f.n}</span> : null}
            </L>
          ))}
        </div>
        {chans.length > 0 && (
          <div className="ck-chips">
            {chans.map((k) => (
              <L key={k} href={p.link({ channel: p.channel === k ? null : k })} className="ck-chip" aria-current={p.channel === k ? "true" : undefined}
                title={p.channel === k ? `${CHANNEL_LABEL[k] ?? k} — показать все каналы` : CHANNEL_LABEL[k] ?? k}>
                <ChannelIcon channel={k} size={14} />
                <span className="ck-mono" style={{ fontSize: "var(--ck-text-xs)" }}>{p.counts?.channels?.[k] ?? 0}</span>
                {p.channel === k ? <span aria-hidden="true">✕</span> : null}
              </L>
            ))}
          </div>
        )}
      </div>
      <div className="ck-list__rows ck-scroll">
        {p.dialogs.length === 0 ? (
          <div className="ck-empty">
            {p.empty ?? (
              <div className="ck-empty__title">
                {p.search?.value ? `По запросу «${p.search.value}» диалогов нет` : filter === "wait" ? "Все клиенты получили ответ" : filter === "unread" ? "Непрочитанных сообщений нет" : "Диалогов пока нет"}
              </div>
            )}
          </div>
        ) : null}
        {p.dialogs.map((d) => <Row key={d.id} d={d} active={d.id === p.activeId} p={p} now={now} L={L} />)}
        {p.hasMore ? <L href={p.link({ more: true })} className="ck-more" scroll={false}>{p.moreLabel ?? "Показать ещё"}</L> : null}
      </div>
    </div>
  );
}

function Row({ d, active, p, now, L }: { d: DialogSummary; active: boolean; p: DialogListProps; now: number; L: LinkLike }) {
  const last = d.found ?? d.last ?? null;
  const author = d.found ? null : d.last?.author ?? null;
  // Кто написал последним: клиент — без подписи, бот — «ИИ-агент:», сотрудник — «Вы:» или его имя
  const prefix = !author || author.type === "client" || author.type === "system" ? ""
    : author.type === "bot" ? "ИИ-агент: "
    : author.type === "operator_phone" ? "Менеджер с телефона: "
    : p.meId && author.id === p.meId ? "Вы: "
    : author.name ? `${author.name}: `
    : "Менеджер: ";
  const bot = botStateText(d.bot, (iso) => untilText(iso, p.timeZone, now));
  return (
    <L href={p.hrefFor(d)} className="ck-row" aria-current={active ? "true" : undefined}>
      <Avatar name={d.name} size={38} active={active} channel={d.channel ?? null} />
      <span className="ck-row__main">
        <span className="ck-row__top">
          <span className="ck-row__name">{d.name?.trim() || "Без имени"}</span>
          {d.waitSince ? (
            <WaitLabel since={d.waitSince} now={now} className="ck-row__wait" />
          ) : last ? (
            <span className={`ck-row__time${(d.unread ?? 0) > 0 ? " ck-row__time--unread" : ""}`}>{listTime(last.at, p.timeZone, now)}</span>
          ) : null}
        </span>
        <span className="ck-row__text" style={{ display: "block" }}>
          {last ? (
            <>
              {prefix ? <span className={author?.type === "bot" ? "ck-row__who--bot" : undefined}>{prefix}</span> : null}
              {stripRich(last.text, "markdown")}
            </>
          ) : "—"}
        </span>
        <span className="ck-row__bottom">
          <span className="ck-row__sub">{bot ?? d.subtitle ?? ""}</span>
          {(d.unread ?? 0) > 0 ? <span className="ck-count">{d.unread}</span> : null}
        </span>
      </span>
    </L>
  );
}
