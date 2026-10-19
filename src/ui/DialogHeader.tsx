import type { ReactNode } from "react";
import { channelLabel } from "../core/channels.js";
import { DEFAULT_TEXTS, type Texts } from "../core/profile.js";
import { Avatar, ChannelIcon } from "./bits.js";
import { ChatFindButton } from "./ChatFind.js";
import { ChevronIcon } from "./icons.js";
import type { LinkLike } from "./DialogList.js";
import { FilterButton, GalleryButton, SideToggle, SummaryButton } from "./Panels.js";

/* Шапка открытого диалога: кружок, имя (ссылка на карточку клиента), канал и контакт, «Кратко», лупа поиска, фильтр
   сообщений, все файлы клиента и кнопки проекта (позвонить, WhatsApp / Telegram, заявка, кнопки бота). На телефоне
   слева — «‹» к списку диалогов. Кнопки «Кратко», фильтра и файлов открывают свои части окна (Panels).
   Вид «Мессенджер»: рядом с именем — этап (nameExtra), справа — переключатель бота, кнопки проекта, лупа и кнопка
   панели диалога (side); «Кратко», фильтр и файлы — в самой панели. */

export function DialogHeader({ name, channel, contact, note, cardHref, backHref, actions, nameExtra, Link, find = true, filter = false, gallery = false, summary = false, side = false, files, t = DEFAULT_TEXTS }: {
  name: string;
  channel?: string | null | undefined;
  /** Телефон, почта, @ник — или «контакт скрыт» */
  contact?: string | null | undefined;
  /** Хвост строки: «сообщения идут в CRM», «последнее сообщение 14:05» */
  note?: string | null | undefined;
  cardHref?: string | null | undefined;
  backHref?: string | null | undefined;
  actions?: ReactNode;
  /** Рядом с именем: этап заявки, своя метка проекта */
  nameExtra?: ReactNode;
  Link?: LinkLike | undefined;
  find?: boolean | undefined;
  /** Кнопка фильтра сообщений */
  filter?: boolean | undefined;
  /** Кнопка «все файлы клиента»; files — сколько их */
  gallery?: boolean | undefined;
  files?: number | undefined;
  /** Кнопка «Кратко» */
  summary?: boolean | undefined;
  /** Кнопка панели диалога справа (вид «Мессенджер») */
  side?: boolean | undefined;
  t?: Texts | undefined;
}) {
  const L = Link;
  const nameNode = cardHref
    ? (L ? <L href={cardHref} className="ck-head__name">{name}</L> : <a href={cardHref} className="ck-head__name">{name}</a>)
    : <span className="ck-head__name">{name}</span>;
  return (
    <div className="ck-head">
      {backHref ? (L ? <L href={backHref} className="ck-iconbtn ck-back" title="К списку диалогов"><ChevronIcon dir="left" /></L> : <a href={backHref} className="ck-iconbtn ck-back" aria-label="К списку диалогов"><ChevronIcon dir="left" /></a>) : null}
      <Avatar name={name} size={side ? 40 : 32} />
      <div className="ck-head__who">
        {nameExtra ? <span className="ck-head__title">{nameNode}{nameExtra}</span> : nameNode}
        <div className="ck-head__line">
          {channel ? <ChannelIcon channel={channel} size={13} /> : null}
          <span>{[channel ? channelLabel(channel) : null, contact, note].filter(Boolean).join(" · ")}</span>
        </div>
      </div>
      <div className="ck-head__actions">
        {summary ? <SummaryButton t={t} /> : null}
        {find && !side ? <ChatFindButton /> : null}
        {filter ? <FilterButton t={t} /> : null}
        {gallery ? <GalleryButton t={t} count={files} /> : null}
        {actions}
        {find && side ? <ChatFindButton /> : null}
        {side ? <SideToggle t={t} /> : null}
      </div>
    </div>
  );
}
