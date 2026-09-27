import { Fragment, type ReactNode } from "react";
import { channelLabel } from "../core/channels.js";
import { parseRich, type Dialect, type RichNode } from "../core/markup.js";
import { initials } from "../core/text.js";
import { SparkIcon } from "./icons.js";

/* Мелкие части окна без состояния — годятся и для серверных компонентов. */

type Glyph = "handset" | "bubble" | "plane" | "camera" | "mail" | "globe" | "tag";

const GLYPH: Record<string, Glyph> = {
  whatsapp: "handset", telegram: "plane", instagram: "camera", vk: "bubble", max: "bubble", avito: "tag",
  site: "globe", email: "mail", sms: "bubble", nextbot: "bubble", test: "bubble", call: "handset",
};

/** Значок канала — цветной кружок со знаком (как в Атласе): зелёный WhatsApp, синий Telegram, фиолетовый Instagram */
export function ChannelIcon({ channel, size = 16, className }: { channel: string | null | undefined; size?: number; className?: string | undefined }) {
  const ch = channel ?? "nextbot";
  const glyph = GLYPH[ch] ?? "bubble";
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <span className={`ck-ch ck-ch--${ch}${className ? ` ${className}` : ""}`} style={{ width: size, height: size }} title={channelLabel(ch)}>
      {glyph === "handset" ? (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path {...common} strokeWidth={2.4} d="M5 4h4l2 5l-2.5 1.5a11 11 0 0 0 5 5l1.5 -2.5l5 2v4a2 2 0 0 1 -2 2a16 16 0 0 1 -15 -15a2 2 0 0 1 2 -2" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          {glyph === "bubble" && <path {...common} d="M3 6.5A2.5 2.5 0 0 1 5.5 4h5A2.5 2.5 0 0 1 13 6.5v2A2.5 2.5 0 0 1 10.5 11H7l-3 2v-2.3A2.5 2.5 0 0 1 3 8.5z" />}
          {glyph === "plane" && <path {...common} d="M13.5 3 2.5 7.4l3.6 1.3 1.3 3.6z M6.1 8.7 13.5 3" />}
          {glyph === "camera" && (<><rect {...common} x="3" y="3" width="10" height="10" rx="3" /><circle {...common} cx="8" cy="8" r="2.4" /></>)}
          {glyph === "mail" && (<><rect {...common} x="2.5" y="4" width="11" height="8" rx="1.6" /><path {...common} d="m3 5.5 5 3.5 5-3.5" /></>)}
          {glyph === "globe" && (<><circle {...common} cx="8" cy="8" r="5.5" /><path {...common} d="M2.5 8h11M8 2.5c1.6 1.6 2.3 3.5 2.3 5.5S9.6 11.9 8 13.5C6.4 11.9 5.7 10 5.7 8S6.4 4.1 8 2.5" /></>)}
          {glyph === "tag" && (<><path {...common} d="M8.6 2.5H13.5V7.4L7.4 13.5 2.5 8.6z" /><circle cx="10.8" cy="5.2" r="1" fill="currentColor" /></>)}
        </svg>
      )}
      <span className="ck-sr">{channelLabel(ch)}</span>
    </span>
  );
}

/** Кружок с инициалами; channel — значок канала в углу */
export function Avatar({ name, size = 38, active = false, channel }: { name: string | null | undefined; size?: number; active?: boolean; channel?: string | null | undefined }) {
  return (
    <span className={`ck-avatar${active ? " ck-avatar--active" : ""}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}>
      {initials(name)}
      {channel ? <ChannelIcon channel={channel} size={Math.round(size * 0.45)} /> : null}
    </span>
  );
}

/** Метка «ИИ-агент» над ответом бота — сплошная фиолетовая, заметнее обычных пометок (решение пользователя 24.09.2026) */
export function BotChip({ label = "ИИ-агент" }: { label?: string }) {
  return (
    <span className="ck-chip-bot">
      <SparkIcon />
      {label}
    </span>
  );
}

function renderNodes(nodes: RichNode[], key = ""): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}${i}`;
    switch (n.t) {
      case "text":
        return <Fragment key={k}>{n.v}</Fragment>;
      case "b":
        return <strong key={k}>{renderNodes(n.c, `${k}-`)}</strong>;
      case "i":
        return <em key={k}>{renderNodes(n.c, `${k}-`)}</em>;
      case "s":
        return <s key={k}>{renderNodes(n.c, `${k}-`)}</s>;
      case "code":
        return n.block ? <pre key={k}>{n.v}</pre> : <code key={k}>{n.v}</code>;
      case "link":
        return (
          <a key={k} href={n.href} target="_blank" rel="noopener noreferrer nofollow">
            {renderNodes(n.c, `${k}-`)}
          </a>
        );
    }
  });
}

/** Текст сообщения с разметкой — своими элементами, без вставки HTML. data-find — здесь ищет поиск по переписке */
export function RichText({ text, dialect = "markdown", className = "ck-msg__text" }: { text: string; dialect?: Dialect; className?: string }) {
  return (
    <div className={className} data-find="">
      {renderNodes(parseRich(text, dialect))}
    </div>
  );
}
