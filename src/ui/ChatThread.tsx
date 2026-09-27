import { Fragment, type ReactNode } from "react";
import type { Attachment as Att, ChatMessage } from "../core/model.js";
import { authorLabel, fromClient } from "../core/model.js";
import { channelLabel } from "../core/channels.js";
import { canView, textIsFileName } from "../core/files.js";
import { dayKey, dayLabel, fmtClock, fmtDuration, fullTime } from "../core/time.js";
import { Attachment } from "./Attachment.js";
import { BotChip, RichText } from "./bits.js";
import { FileViewerHost, type RotateResult, type ViewFile } from "./FileViewer.js";
import { CheckIcon, ClockIcon, DoubleCheckIcon, PhoneIcon } from "./icons.js";

/* Лента диалога — как в WhatsApp: сообщения по дням, от старых к новым; у каждого — кто написал и время до секунды.
   - клиент — белый пузырь слева;
   - бот — фиолетовый справа с меткой «ИИ-агент» (и «передал менеджеру — нужен ответ человека», если позвал человека);
   - менеджер из CRM — синий справа с именем; менеджер с телефона — синий, «менеджер с телефона»;
   - заметка команды — жёлтая карточка посередине (клиент не видит); служебное — строкой посередине; звонок — плашкой.

   Лента годится и для серверной страницы (Атлас собирает её на сервере), и для браузера: в ней нет состояния, а
   интерактивные части (голосовое, окно просмотра) — свои маленькие клиентские компоненты. Поэтому места для проекта
   и студии — функции, которые возвращают готовую разметку (их можно звать и на сервере):
   renderActions — под сообщением («как надо было», оценка ответа бота); renderAttachmentExtra — у файла («+ В документы»);
   renderSystem — своя служебная строка; viewerPanel / viewerActions — в окне просмотра фото. «Повторить» у недоставленного —
   форма с действием resendAction (server action или обычная функция). */

export type ThreadProps = {
  messages: readonly ChatMessage[];
  /** Пояс компании: время одно и то же на сервере и в браузере */
  timeZone?: string | undefined;
  /** Кто смотрит — «вы» вместо своего имени */
  meId?: string | null | undefined;
  /** Как зовут бота в подписи («ИИ-агент», «ИИ-администратор») */
  botName?: string | undefined;
  /** «повторить» у недоставленного: форма с полем message_id */
  resendAction?: ((form: FormData) => void | Promise<void>) | undefined;
  /** Под сообщением: действия проекта и студии */
  renderActions?: ((m: ChatMessage) => ReactNode) | undefined;
  /** У вложения: «+ В документы» и прочее */
  renderAttachmentExtra?: ((m: ChatMessage, a: Att) => ReactNode) | undefined;
  /** Своя служебная строка (например, «Возможный дубль» со ссылкой «Объединить карточки») */
  renderSystem?: ((m: ChatMessage) => ReactNode) | undefined;
  /** Запись звонка — только тем, кому можно слушать */
  canListen?: boolean | undefined;
  /** Повернуть фото в самом файле (server action или функция) — кнопки поворота в окне просмотра */
  onRotate?: ((file: ViewFile, degrees: number) => Promise<RotateResult>) | undefined;
  /** Кому можно поворачивать: по файлу и сообщению */
  canRotate?: ((m: ChatMessage, a: Att) => boolean) | undefined;
  /** Панель справа в окне просмотра («Куда положить») */
  viewerPanel?: ((m: ChatMessage, a: Att) => ReactNode) | undefined;
  /** Кнопки проекта в шапке окна просмотра */
  viewerActions?: ((m: ChatMessage, a: Att) => ReactNode) | undefined;
  /** «Сейчас» — для подписей «сегодня» и «вчера» */
  now?: number | undefined;
};

const who = (m: ChatMessage) => (fromClient(m) ? "от клиента" : m.author.type === "bot" ? "ИИ-агент" : m.author.type === "operator_phone" ? "менеджер с телефона" : m.author.name ?? "мы");

export function ChatThread(p: ThreadProps) {
  const now = p.now ?? Date.now();
  const groups: { key: string; label: string; items: ChatMessage[] }[] = [];
  for (const m of p.messages) {
    const key = dayKey(m.at, p.timeZone);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(m);
    else groups.push({ key, label: dayLabel(m.at, p.timeZone, now), items: [m] });
  }
  // Клиент пишет в двух мессенджерах — под сообщением подписываем канал
  const bothChannels = new Set(p.messages.filter((m) => m.kind === "message").map((m) => m.channel)).size > 1;

  // Фото и PDF ленты — в окне просмотра; панели проекта собираются заранее (их можно собрать и на сервере)
  const files: ViewFile[] = [];
  const panels: Record<string, ReactNode> = {};
  const actions: Record<string, ReactNode> = {};
  for (const m of p.messages) {
    for (const a of m.attachments ?? []) {
      if (!canView(a) || files.some((f) => f.id === a.id)) continue;
      files.push({
        id: a.id, name: a.name || "Файл", mime: a.mime, url: a.url, version: a.version ?? null,
        meta: `${dayLabel(m.at, p.timeZone, now)}, ${fmtClock(m.at, p.timeZone)} · ${who(m)}`,
        canRotate: !!p.onRotate && (p.canRotate ? p.canRotate(m, a) : true),
      });
      const panel = p.viewerPanel?.(m, a);
      if (panel) panels[a.id] = panel;
      const act = p.viewerActions?.(m, a);
      if (act) actions[a.id] = act;
    }
  }

  return (
    <>
      {files.length > 0 && <FileViewerHost files={files} onRotate={p.onRotate} panels={panels} actions={actions} />}
      {groups.map((g) => (
        <div key={g.key} className="ck-day">
          <div className="ck-day__label">{g.label}</div>
          {g.items.map((m) => <Item key={m.id} m={m} p={p} bothChannels={bothChannels} />)}
        </div>
      ))}
    </>
  );
}

function Item({ m, p, bothChannels }: { m: ChatMessage; p: ThreadProps; bothChannels: boolean }) {
  const time = fmtClock(m.at, p.timeZone);
  const title = fullTime(m.at, p.timeZone);
  if (m.kind === "system") {
    const own = p.renderSystem?.(m);
    return own ? <Fragment>{own}</Fragment> : <div className="ck-sys" data-find="" title={title}>{m.text}</div>;
  }
  if (m.kind === "note") {
    const by = m.author.type === "bot" ? p.botName ?? "ИИ-агент" : authorLabel(m.author, { meId: p.meId });
    return (
      <div className="ck-note" data-message={m.id}>
        <div className="ck-note__head" title={title}>{`Заметка · ${by} · ${time}`}</div>
        <RichText text={m.text} />
        <Actions node={p.renderActions?.(m)} />
      </div>
    );
  }
  if (m.kind === "call") {
    const inbound = fromClient(m);
    const d = m.call?.durationSec ?? 0;
    return (
      <div className="ck-call" data-message={m.id}>
        <div className="ck-call__head" title={title}>
          <PhoneIcon />
          {`${inbound ? "Входящий звонок" : "Исходящий звонок"} · ${time}${d ? ` · ${fmtDuration(d)}` : m.call?.missed ? " · не состоялся" : ""}${!inbound && m.author.name ? ` · ${m.author.name}` : ""}`}
        </div>
        {m.text ? <RichText text={m.text} /> : null}
        {m.call?.recordUrl && p.canListen ? <audio controls preload="none" src={m.call.recordUrl} aria-label="Запись разговора" /> : null}
      </div>
    );
  }

  const client = fromClient(m);
  const bot = m.author.type === "bot";
  const label = client || bot ? null : authorLabel(m.author, { meId: p.meId });
  const onlyFile = !!m.attachments?.length && textIsFileName(m.text, m.attachments);
  const cls = client ? "ck-msg ck-msg--in" : bot ? "ck-msg ck-msg--bot" : "ck-msg ck-msg--out";
  return (
    <div className={`${cls}${m.shadow ? " ck-msg--shadow" : ""}`} data-message={m.id}>
      {(bot || m.shadow) && (
        <div className="ck-msg__head">
          {bot ? <BotChip {...(p.botName ? { label: p.botName } : {})} /> : null}
          {m.handoff ? <span className="ck-badge ck-badge--warn">передал менеджеру — нужен ответ человека</span> : null}
          {m.shadow ? <span className="ck-badge ck-badge--bot">черновик бота — клиенту не ушёл</span> : null}
        </div>
      )}
      {m.subject ? <div className="ck-msg__subject" data-find="">✉ {m.subject}</div> : null}
      {(m.attachments ?? []).map((a) => (
        <Fragment key={a.id}>
          <Attachment a={a} />
          {p.renderAttachmentExtra?.(m, a)}
        </Fragment>
      ))}
      {!onlyFile && m.text ? <RichText text={m.text} dialect={client && m.channel === "whatsapp" ? "whatsapp" : "markdown"} /> : null}
      <div className="ck-msg__meta" title={title}>
        <span>{`${time}${label ? ` · ${label}` : ""}${bothChannels ? ` · ${channelLabel(m.channel)}` : ""}`}</span>
        <Delivery m={m} />
      </div>
      {m.delivery === "failed" && (
        <div className="ck-msg__error">
          <span>не доставлено{m.deliveryError ? `: ${m.deliveryError}` : ""}</span>
          {p.resendAction ? (
            <form action={p.resendAction} style={{ display: "inline" }}>
              <input type="hidden" name="message_id" value={m.id} />
              <button type="submit" className="ck-link">повторить</button>
            </form>
          ) : null}
        </div>
      )}
      <Actions node={p.renderActions?.(m)} />
    </div>
  );
}

function Actions({ node }: { node: ReactNode }) {
  return node ? <div className="ck-msg__actions">{node}</div> : null;
}

/** Часики — отправляется, галочка — ушло, две — дошло, две зелёные — прочитано */
function Delivery({ m }: { m: ChatMessage }) {
  if (fromClient(m) || !m.delivery || m.delivery === "failed") return null;
  if (m.delivery === "pending") return <span className="ck-tick" style={{ color: "inherit" }}><ClockIcon /> отправляется</span>;
  if (m.channel === "email" && m.delivery === "sent") return <span>· письмо отправлено</span>;
  if (m.delivery === "sent") return <span className="ck-tick" title="отправлено"><CheckIcon /><span className="ck-sr">отправлено</span></span>;
  if (m.delivery === "delivered") return <span className="ck-tick" title="доставлено"><DoubleCheckIcon /><span className="ck-sr">доставлено</span></span>;
  return <span className="ck-tick ck-tick--read" title="прочитано"><DoubleCheckIcon /><span className="ck-sr">прочитано</span></span>;
}
