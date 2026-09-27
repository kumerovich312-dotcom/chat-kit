import { Fragment } from "react";
import type { MessageCard } from "../core/model.js";
import { formatCardValue, type CardDef, type ProfileIcon } from "../core/profile.js";
import {
  BoxIcon, BriefcaseIcon, CalendarIcon, CheckIcon, ClockIcon, DocIcon, MoneyIcon, PhoneIcon, PinIcon, ReceiptIcon, StarIcon, UserIcon,
} from "./icons.js";

/* Своя карточка проекта в ленте — запись на приём, вакансия, счёт, заказ. Как её показать, описано в паспорте проекта
   (profile.cards[вид]): заголовок, значок, цвет, поля и статус. Данные — у сообщения (ChatMessage.card). Карточка без
   состояния — годится и для серверной страницы. */

export function ProfileIconView({ icon }: { icon: ProfileIcon | undefined }) {
  switch (icon) {
    case "calendar": return <CalendarIcon />;
    case "briefcase": return <BriefcaseIcon />;
    case "receipt": return <ReceiptIcon />;
    case "box": return <BoxIcon />;
    case "doc": return <DocIcon />;
    case "star": return <StarIcon />;
    case "pin": return <PinIcon />;
    case "user": return <UserIcon />;
    case "money": return <MoneyIcon />;
    case "check": return <CheckIcon />;
    case "clock": return <ClockIcon />;
    case "phone": return <PhoneIcon />;
    default: return <DocIcon />;
  }
}

/** Ссылка из данных карточки — только на сайт (http, https) или адрес внутри CRM («/deals/15») */
function safeHref(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return /^https?:\/\//i.test(s) || (s.startsWith("/") && !s.startsWith("//")) ? s : null;
}

export function CardView({ card, def, timeZone, currency }: {
  card: MessageCard;
  /** Описание вида из паспорта; нет — карточка покажет все поля как есть */
  def?: CardDef | undefined;
  timeZone?: string | undefined;
  currency?: string | undefined;
}) {
  const d = card.data;
  const fields = def ? def.fields : Object.keys(d).map((key) => ({ key, label: key, format: "text" as const }));
  const titleValue = def?.titleKey ? d[def.titleKey] : null;
  const title = titleValue !== null && titleValue !== undefined && titleValue !== "" ? String(titleValue) : def?.title ?? card.type;
  const statusValue = def?.statusKey ? d[def.statusKey] : null;
  const status = statusValue !== null && statusValue !== undefined ? def?.statuses?.[String(statusValue)] ?? { label: String(statusValue) } : null;
  const link = def?.linkKey ? safeHref(d[def.linkKey]) : null;
  const shown = fields.filter((f) => f.key !== def?.titleKey && f.key !== def?.statusKey && f.key !== def?.linkKey && d[f.key] !== null && d[f.key] !== undefined && d[f.key] !== "");
  return (
    <div className={`ck-card ck-tone--${def?.tone ?? "accent"}`} data-find="">
      <div className="ck-card__head">
        <span className="ck-card__icon"><ProfileIconView icon={def?.icon} /></span>
        <span className="ck-card__title">{title}</span>
        {status ? <span className={`ck-badge ck-tone--${"tone" in status && status.tone ? status.tone : "gray"}`}>{status.label}</span> : null}
      </div>
      {shown.length > 0 ? (
        <dl className="ck-card__fields">
          {shown.map((f) => (
            <Fragment key={f.key}>
              <dt>{f.label}</dt>
              <dd>{formatCardValue(d[f.key], f.format, { timeZone, currency })}</dd>
            </Fragment>
          ))}
        </dl>
      ) : null}
      {link ? <a href={link} className="ck-link ck-card__link" target={link.startsWith("/") ? undefined : "_blank"} rel="noopener noreferrer">Открыть</a> : null}
    </div>
  );
}
