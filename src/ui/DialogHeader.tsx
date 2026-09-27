import type { ReactNode } from "react";
import { channelLabel } from "../core/channels.js";
import { Avatar, ChannelIcon } from "./bits.js";
import { ChatFindButton } from "./ChatFind.js";
import { ChevronIcon } from "./icons.js";
import type { LinkLike } from "./DialogList.js";

/* Шапка открытого диалога: кружок, имя (ссылка на карточку клиента), канал и контакт, лупа поиска по переписке и кнопки
   проекта (позвонить, WhatsApp / Telegram, заявка, кнопки бота). На телефоне слева — «‹» к списку диалогов. */

export function DialogHeader({ name, channel, contact, note, cardHref, backHref, actions, Link, find = true }: {
  name: string;
  channel?: string | null | undefined;
  /** Телефон, почта, @ник — или «контакт скрыт» */
  contact?: string | null | undefined;
  /** Хвост строки: «сообщения идут в CRM», «последнее сообщение 14:05» */
  note?: string | null | undefined;
  cardHref?: string | null | undefined;
  backHref?: string | null | undefined;
  actions?: ReactNode;
  Link?: LinkLike | undefined;
  find?: boolean | undefined;
}) {
  const L = Link;
  const nameNode = cardHref
    ? (L ? <L href={cardHref} className="ck-head__name">{name}</L> : <a href={cardHref} className="ck-head__name">{name}</a>)
    : <span className="ck-head__name">{name}</span>;
  return (
    <div className="ck-head">
      {backHref ? (L ? <L href={backHref} className="ck-iconbtn ck-back" title="К списку диалогов"><ChevronIcon dir="left" /></L> : <a href={backHref} className="ck-iconbtn ck-back" aria-label="К списку диалогов"><ChevronIcon dir="left" /></a>) : null}
      <Avatar name={name} size={32} />
      <div className="ck-head__who">
        {nameNode}
        <div className="ck-head__line">
          {channel ? <ChannelIcon channel={channel} size={13} /> : null}
          <span>{[channel ? channelLabel(channel) : null, contact, note].filter(Boolean).join(" · ")}</span>
        </div>
      </div>
      <div className="ck-head__actions">
        {find ? <ChatFindButton /> : null}
        {actions}
      </div>
    </div>
  );
}
