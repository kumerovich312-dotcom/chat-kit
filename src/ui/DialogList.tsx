import type { ComponentType, ReactNode } from "react";
import type { DialogStatus, DialogSummary } from "../core/conversation.js";
import { botStateText } from "../core/conversation.js";
import { CHANNEL_LABEL } from "../core/channels.js";
import { stripRich } from "../core/markup.js";
import { DEFAULT_TEXTS, type ProfileTag, type Texts } from "../core/profile.js";
import { plural } from "../core/text.js";
import { listTime, untilText } from "../core/time.js";
import { Avatar, ChannelIcon } from "./bits.js";
import { WaitLabel } from "./Wait.js";

/* Список диалогов: поиск по имени и тексту, фильтры «Все / Ждут ответа / Непрочитанные / Мои» со счётчиками, статус
   (открытые, отложенные, закрытые), метки и каналы значками. В строке — кто написал последним: клиент — без подписи,
   бот — «ИИ-агент:» фиолетовым, менеджер с телефона — «Менеджер с телефона:», свой — «Вы:», коллега — его имя. Клиент
   ждёт ответа — вместо времени «ждёт 25 мин» красным. Под именем — оценка ИИ, только когда есть что сказать:
   «срочно», «недоволен» (выбор пользователя 27.09.2026). Длинный список — частями: «Показать ещё» (без скрытой обрезки).

   Список не ходит в базу сам: строки, счётчики и адреса даёт проект (hrefFor, link) — фильтры и поиск меняют адрес
   страницы. Ссылки — компонентом проекта (Link из Next.js), по умолчанию — обычная ссылка. Годится для серверной страницы. */

export type ListFilter = "all" | "wait" | "unread" | "mine";

/** Какие диалоги по статусу: открытые (по умолчанию), отложенные, закрытые, все */
export type ListStatus = DialogStatus | "any";

export type LinkLike = ComponentType<{ href: string; className?: string | undefined; children?: ReactNode; "aria-current"?: "true" | undefined; scroll?: boolean | undefined; title?: string | undefined }>;

const PlainLink: LinkLike = ({ href, className, children, ...rest }) => (
  <a href={href} className={className} aria-current={rest["aria-current"]} title={rest.title}>{children}</a>
);

export type ListLinkOver = {
  filter?: ListFilter | undefined;
  channel?: string | null | undefined;
  status?: ListStatus | undefined;
  tag?: string | null | undefined;
  more?: boolean | undefined;
};

export type DialogListProps = {
  dialogs: readonly DialogSummary[];
  activeId?: string | null | undefined;
  /** Адрес диалога */
  hrefFor: (d: DialogSummary) => string;
  /** Адрес списка с другим фильтром, каналом, статусом, меткой, числом строк */
  link: (over: ListLinkOver) => string;
  filter?: ListFilter | undefined;
  channel?: string | null | undefined;
  /** Статус в списке; не задан — строка статусов не показывается */
  status?: ListStatus | undefined;
  tag?: string | null | undefined;
  /** Счётчики: ждут ответа, непрочитанных сообщений, мои, по статусам, по каналам */
  counts?: {
    wait?: number | undefined;
    unread?: number | undefined;
    mine?: number | undefined;
    status?: Readonly<Partial<Record<DialogStatus, number>>> | undefined;
    channels?: Readonly<Record<string, number>> | undefined;
  } | undefined;
  /** Каналы-чипы (по умолчанию — те, по которым есть диалоги) */
  channels?: readonly string[] | undefined;
  /** Метки из паспорта проекта — чипы фильтра и цвета меток в строках */
  tags?: readonly ProfileTag[] | undefined;
  /** Показать фильтр «Мои» (включено «Ответственный») */
  mine?: boolean | undefined;
  /** Поиск: адрес формы (GET) и имя поля; текущий запрос */
  search?: { action: string; name?: string | undefined; value?: string | undefined; hidden?: Readonly<Record<string, string>> | undefined } | undefined;
  /** Есть ещё строки */
  hasMore?: boolean | undefined;
  moreLabel?: string | undefined;
  title?: string | undefined;
  /** Кто смотрит — «Вы:» перед своим сообщением */
  meId?: string | null | undefined;
  /** Надписи со словами отрасли (паспорт проекта) */
  t?: Texts | undefined;
  timeZone?: string | undefined;
  now?: number | undefined;
  Link?: LinkLike | undefined;
  /** Пусто — своё пояснение */
  empty?: ReactNode;
};

export function DialogList(p: DialogListProps) {
  const L = p.Link ?? PlainLink;
  const t = p.t ?? DEFAULT_TEXTS;
  const now = p.now ?? Date.now();
  const filter = p.filter ?? "all";
  const unread = p.counts?.unread ?? 0;
  const chans = p.channels ?? Object.keys(p.counts?.channels ?? {}).filter((k) => (p.counts?.channels?.[k] ?? 0) > 0 || k === p.channel);
  const filters: { key: ListFilter; label: string; n: number }[] = [
    { key: "all", label: "Все", n: 0 },
    { key: "wait", label: "Ждут ответа", n: p.counts?.wait ?? 0 },
    { key: "unread", label: "Непрочитанные", n: unread },
    ...(p.mine ? [{ key: "mine" as const, label: t.listMine, n: p.counts?.mine ?? 0 }] : []),
  ];
  const statuses: { key: ListStatus; label: string }[] = [
    { key: "open", label: t.listOpen }, { key: "snoozed", label: t.listSnoozed }, { key: "closed", label: t.listClosed },
  ];
  return (
    <div className="ck ck-list">
      <div className="ck-list__head">
        <div className="ck-list__title">
          <strong>{p.title ?? t.listTitle}</strong>
          <span className={`ck-list__unread${unread > 0 ? " ck-list__unread--some" : ""}`}>
            {unread > 0 ? `${unread} ${plural(unread, "непрочитанное", "непрочитанных", "непрочитанных")}` : "всё прочитано"}
          </span>
        </div>
        {p.search && (
          <form action={p.search.action} method="get" role="search">
            {Object.entries(p.search.hidden ?? {}).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
            <input className="ck-search" name={p.search.name ?? "q"} defaultValue={p.search.value ?? ""} placeholder={t.listSearch} aria-label={t.listSearch} />
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
        {p.status !== undefined || (p.tags?.length ?? 0) > 0 ? (
          <div className="ck-chips ck-chips--scroll">
            {p.status !== undefined ? (
              <span className="ck-seg" role="group" aria-label="Статус диалогов">
                {statuses.map((s) => {
                  const n = s.key === "any" ? 0 : p.counts?.status?.[s.key] ?? 0;
                  return (
                    <L key={s.key} href={p.link({ status: p.status === s.key ? "any" : s.key })} className="ck-seg__item" aria-current={p.status === s.key ? "true" : undefined}>
                      {s.label}{n > 0 && s.key !== "open" ? <span className="ck-count ck-count--muted">{n}</span> : null}
                    </L>
                  );
                })}
              </span>
            ) : null}
            {(p.tags ?? []).map((tg) => (
              <L key={tg.code} href={p.link({ tag: p.tag === tg.code ? null : tg.code })} className={`ck-chip ck-chip--tag ck-tone--${tg.tone ?? "gray"}`} aria-current={p.tag === tg.code ? "true" : undefined}>
                {tg.label}{p.tag === tg.code ? <span aria-hidden="true"> ✕</span> : null}
              </L>
            ))}
          </div>
        ) : null}
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
                {p.search?.value ? `По запросу «${p.search.value}» диалогов нет` : filter === "wait" ? t.listAllAnswered : filter === "unread" ? "Непрочитанных сообщений нет" : t.listEmpty}
              </div>
            )}
          </div>
        ) : null}
        {p.dialogs.map((d) => <Row key={d.id} d={d} active={d.id === p.activeId} p={p} t={t} now={now} L={L} />)}
        {p.hasMore ? <L href={p.link({ more: true })} className="ck-more" scroll={false}>{p.moreLabel ?? "Показать ещё"}</L> : null}
      </div>
    </div>
  );
}

function Row({ d, active, p, t, now, L }: { d: DialogSummary; active: boolean; p: DialogListProps; t: Texts; now: number; L: LinkLike }) {
  const last = d.found ?? d.last ?? null;
  const author = d.found ? null : d.last?.author ?? null;
  // Кто написал последним: клиент — без подписи, бот — «ИИ-агент:», сотрудник — «Вы:» или его имя
  const prefix = !author || author.type === "client" || author.type === "system" ? ""
    : author.type === "bot" ? t.listPrefixBot
    : author.type === "operator_phone" ? t.listPrefixPhone
    : p.meId && author.id === p.meId ? t.listPrefixMe
    : author.name ? `${author.name}: `
    : t.listPrefixManager;
  const bot = botStateText(d.bot, (iso) => untilText(iso, p.timeZone, now), t);
  // Оценка ИИ — только когда есть что сказать
  const urgent = d.assessment?.urgency === "high";
  const unhappy = d.assessment?.mood === "negative";
  const tagDefs = p.tags ?? [];
  const tags = (d.tags ?? []).slice(0, 2).map((code) => tagDefs.find((x) => x.code === code) ?? { code, label: code });
  const snoozed = d.status === "snoozed" && d.snoozedUntil ? `отложен до ${untilText(d.snoozedUntil, p.timeZone, now)}` : null;
  return (
    <L href={p.hrefFor(d)} className={`ck-row${d.status === "closed" ? " ck-row--closed" : ""}`} aria-current={active ? "true" : undefined}>
      <Avatar name={d.name} size={38} active={active} channel={d.channel ?? null} />
      <span className="ck-row__main">
        <span className="ck-row__top">
          <span className="ck-row__name">{d.name?.trim() || t.listNoName}</span>
          {d.waitSince ? (
            <WaitLabel since={d.waitSince} now={now} className="ck-row__wait" />
          ) : last ? (
            <span className={`ck-row__time${(d.unread ?? 0) > 0 ? " ck-row__time--unread" : ""}`}>{listTime(last.at, p.timeZone, now)}</span>
          ) : null}
        </span>
        {urgent || unhappy ? (
          <span className="ck-row__mood" title={d.assessment?.reason ?? undefined}>
            {urgent ? <span className="ck-badge ck-badge--xs ck-tone--red">{t.urgent}</span> : null}
            {unhappy ? <span className="ck-badge ck-badge--xs ck-tone--amber">{t.unhappy}</span> : null}
          </span>
        ) : null}
        <span className="ck-row__text" style={{ display: "block" }}>
          {last ? (
            <>
              {prefix ? <span className={author?.type === "bot" ? "ck-row__who--bot" : undefined}>{prefix}</span> : null}
              {stripRich(last.text.slice(0, 400), "markdown")}
            </>
          ) : "—"}
        </span>
        <span className="ck-row__bottom">
          <span className="ck-row__sub">
            {tags.map((tg) => <span key={tg.code} className={`ck-dot-tag ck-tone--${"tone" in tg && tg.tone ? tg.tone : "gray"}`}>{tg.label}</span>)}
            {snoozed ?? bot ?? d.subtitle ?? ""}
          </span>
          {(d.unread ?? 0) > 0 ? <span className="ck-count">{d.unread}</span> : null}
        </span>
      </span>
    </L>
  );
}
