import { Fragment, type ReactNode } from "react";
import type { AiAnswer } from "../core/composer.js";
import type { Attachment as Att, ChatMessage, MessageQuote } from "../core/model.js";
import { authorLabel, fromClient } from "../core/model.js";
import { channelLabel } from "../core/channels.js";
import { canView, fileKind, fileWords, textIsFileName } from "../core/files.js";
import { DEFAULT_TEXTS, type CardDef, type Texts } from "../core/profile.js";
import { dayKey, dayLabel, fmtClock, fmtDuration, fullTime } from "../core/time.js";
import { Attachment } from "./Attachment.js";
import { BotChip, RichText } from "./bits.js";
import { CardView } from "./Card.js";
import { FileViewerHost, type RotateResult, type ViewFile } from "./FileViewer.js";
import { CheckIcon, ClockIcon, DoubleCheckIcon, PhoneIcon, ReplyIcon } from "./icons.js";
import { Transcript } from "./Transcript.js";

/* Лента диалога — как в WhatsApp: сообщения по дням, от старых к новым; у каждого — кто написал и время до секунды.
   - клиент — белый пузырь слева;
   - бот — фиолетовый справа с меткой «ИИ-агент» (и «передал менеджеру — нужен ответ человека», если позвал человека);
   - менеджер из CRM — синий справа с именем; менеджер с телефона — синий, «менеджер с телефона»;
   - заметка команды — жёлтая карточка посередине (клиент не видит); служебное — строкой посередине; звонок — плашкой
     (с записью разговора и её текстом);
   - ответ с цитатой — цитата сверху пузыря, щелчок по ней — к исходному сообщению; «Ответить» — у каждого сообщения;
   - своя карточка проекта (запись на приём, счёт) — по описанию из паспорта проекта (cards).
   У каждой записи — data-f («кто и что»: client / bot / team, note / call, file / voice): по нему фильтр сообщений
   прячет лишнее, не перерисовывая ленту.

   Лента годится и для серверной страницы (собранной на сервере), и для браузера: в ней нет состояния, а
   интерактивные части (голосовое, окно просмотра, расшифровка) — свои маленькие клиентские компоненты. Поэтому места
   для проекта и студии — функции, которые возвращают готовую разметку (их можно звать и на сервере):
   renderActions — под сообщением («как надо было», оценка ответа бота); renderAttachmentExtra — у файла («+ В документы»);
   renderSystem — своя служебная строка; viewerPanel / viewerActions — в окне просмотра фото. «Повторить» у недоставленного —
   форма с действием resendAction (server action или обычная функция). */

export type ThreadProps = {
  messages: readonly ChatMessage[];
  /** Пояс компании: время одно и то же на сервере и в браузере */
  timeZone?: string | undefined;
  /** Кто смотрит — «вы» вместо своего имени */
  meId?: string | null | undefined;
  /** Как зовут бота в подписи («ИИ-агент», «ИИ-администратор») — по умолчанию из паспорта */
  botName?: string | undefined;
  /** Надписи со словами отрасли (паспорт проекта) */
  t?: Texts | undefined;
  /** Как зовут собеседника — подпись его сообщений в цитатах и «Ответить» */
  clientName?: string | undefined;
  /** Свои карточки проекта (паспорт: cards) и валюта для денег в них */
  cards?: Readonly<Record<string, CardDef>> | undefined;
  currency?: string | undefined;
  /** «Ответить» у сообщений — цитату подхватывает поле ввода */
  canReply?: boolean | undefined;
  /** «Расшифровать» у голосового и записи звонка: форма message_id, attachment_id → { text } или { error } */
  transcribeAction?: ((form: FormData) => Promise<AiAnswer>) | undefined;
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

/** Кто написал — для подписи файла в окне просмотра и галерее */
export function whoWrote(m: ChatMessage, t: Texts = DEFAULT_TEXTS): string {
  return fromClient(m) ? t.fromClient : m.author.type === "bot" ? t.authorBot : m.author.type === "operator_phone" ? t.authorPhone : m.author.name ?? "мы";
}

/** Слова для фильтра сообщений: кто (client / bot / team / system) и что (note, call, file, voice) */
export function filterTokens(m: ChatMessage): string {
  const out: string[] = [];
  const a = m.author.type;
  out.push(a === "client" ? "client" : a === "bot" ? "bot" : a === "system" ? "system" : "team");
  if (m.kind === "note") out.push("note");
  if (m.kind === "call") out.push("call");
  const atts = m.attachments ?? [];
  if (atts.length) out.push("file");
  if (atts.some((x) => fileKind(x.mime, x.name) === "audio")) out.push("voice");
  return out.join(" ");
}

export function ChatThread(p: ThreadProps) {
  const now = p.now ?? Date.now();
  const t = p.t ?? DEFAULT_TEXTS;
  const groups: { key: string; label: string; items: ChatMessage[] }[] = [];
  for (const m of p.messages) {
    const key = dayKey(m.at, p.timeZone);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(m);
    else groups.push({ key, label: dayLabel(m.at, p.timeZone, now), items: [m] });
  }
  // Клиент пишет в двух мессенджерах — под сообщением подписываем канал
  const bothChannels = new Set(p.messages.filter((m) => m.kind === "message").map((m) => m.channel)).size > 1;
  const byId = new Map(p.messages.map((m) => [m.id, m]));

  // Фото и PDF ленты — в окне просмотра; панели проекта собираются заранее (их можно собрать и на сервере)
  const files: ViewFile[] = [];
  const panels: Record<string, ReactNode> = {};
  const actions: Record<string, ReactNode> = {};
  for (const m of p.messages) {
    for (const a of m.attachments ?? []) {
      if (!canView(a) || files.some((f) => f.id === a.id)) continue;
      files.push({
        id: a.id, name: a.name || "Файл", mime: a.mime, url: a.url, version: a.version ?? null,
        meta: `${dayLabel(m.at, p.timeZone, now)}, ${fmtClock(m.at, p.timeZone)} · ${whoWrote(m, t)}`,
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
          {g.items.map((m) => <Item key={m.id} m={m} p={p} t={t} bothChannels={bothChannels} byId={byId} />)}
        </div>
      ))}
    </>
  );
}

/** Подпись автора; у собеседника без имени в сообщении — его имя из диалога */
function labelOf(a: ChatMessage["author"], p: Pick<ThreadProps, "meId" | "botName" | "clientName">, t: Texts): string {
  if (a.type === "client" && !a.name?.trim() && p.clientName) return p.clientName;
  return authorLabel(a, { meId: p.meId, t, ...(p.botName ? { botName: p.botName } : {}) });
}

/** Цитата сверху пузыря: кто и что написал; щелчок — к исходному сообщению (если оно в ленте) */
function Quote({ q, byId, t, p }: { q: MessageQuote; byId: ReadonlyMap<string, ChatMessage>; t: Texts; p: ThreadProps }) {
  const orig = q.id ? byId.get(q.id) : undefined;
  const author = q.author ?? orig?.author ?? null;
  const att = q.attachment ?? orig?.attachments?.[0] ?? null;
  const text = q.text?.trim() || orig?.text?.trim() || (att ? fileWords(att) : "сообщение");
  const inner = (
    <>
      <span className="ck-quote__who">{author ? labelOf(author, p, t) : t.replyTo}</span>
      <span className="ck-quote__text">{text}</span>
    </>
  );
  return orig ? <a href={`#ck-m-${orig.id}`} className="ck-quote" data-ck-goto={orig.id}>{inner}</a> : <div className="ck-quote">{inner}</div>;
}

function Item({ m, p, t, bothChannels, byId }: { m: ChatMessage; p: ThreadProps; t: Texts; bothChannels: boolean; byId: ReadonlyMap<string, ChatMessage> }) {
  const time = fmtClock(m.at, p.timeZone);
  const title = fullTime(m.at, p.timeZone);
  const f = filterTokens(m);
  const card = m.card ? <CardView card={m.card} def={p.cards?.[m.card.type]} timeZone={p.timeZone} currency={p.currency} /> : null;
  const atts = (m.attachments ?? []).map((a) => (
    <Fragment key={a.id}>
      <Attachment a={a} />
      {fileKind(a.mime, a.name) === "audio" ? (
        <Transcript messageId={m.id} attachmentId={a.id} text={a.transcript} action={p.transcribeAction} t={t} />
      ) : null}
      {p.renderAttachmentExtra?.(m, a)}
    </Fragment>
  ));
  if (m.kind === "system") {
    const own = p.renderSystem?.(m);
    return own ? <div data-f={f} data-message={m.id}>{own}</div> : <div className="ck-sys" data-f={f} data-find="" title={title}>{m.text}</div>;
  }
  if (m.kind === "note") {
    const by = m.author.type === "bot" ? p.botName ?? t.authorBot : authorLabel(m.author, { meId: p.meId, t });
    return (
      <div className="ck-note" id={`ck-m-${m.id}`} data-message={m.id} data-f={f}>
        <div className="ck-note__head" title={title}>{`${t.tabNote} · ${by} · ${time}`}</div>
        {card}
        {m.text && !card ? <RichText text={m.text} /> : null}
        {atts}
        <Actions node={p.renderActions?.(m)} />
      </div>
    );
  }
  if (m.kind === "call") {
    const inbound = m.call?.direction ? m.call.direction === "in" : fromClient(m);
    const d = m.call?.durationSec ?? 0;
    const who = m.call?.manager ?? (!inbound ? m.author.name : null);
    return (
      <div className={`ck-call${m.call?.missed ? " ck-call--missed" : ""}`} id={`ck-m-${m.id}`} data-message={m.id} data-f={f}>
        <div className="ck-call__head" title={title}>
          <PhoneIcon />
          {`${inbound ? (m.call?.missed ? "Пропущенный звонок" : "Входящий звонок") : m.call?.missed ? "Не дозвонились" : "Исходящий звонок"} · ${time}${d ? ` · ${fmtDuration(d)}` : ""}${who ? ` · ${who}` : ""}`}
        </div>
        {m.text && !/^(Входящий|Исходящий|Пропущенный) звонок|^Не дозвонились|^Запись разговора$/.test(m.text) ? <RichText text={m.text} /> : null}
        {p.canListen ? atts : null}
        {p.canListen && !m.attachments?.length && m.call?.recordUrl ? <audio controls preload="none" src={m.call.recordUrl} aria-label="Запись разговора" /> : null}
      </div>
    );
  }

  const client = fromClient(m);
  const bot = m.author.type === "bot";
  const label = client || bot ? null : authorLabel(m.author, { meId: p.meId, t });
  const onlyFile = !!m.attachments?.length && textIsFileName(m.text, m.attachments);
  const cls = client ? "ck-msg ck-msg--in" : bot ? "ck-msg ck-msg--bot" : "ck-msg ck-msg--out";
  const snippet = (m.text.trim() || (m.attachments?.[0] ? fileWords(m.attachments[0]) : "")).slice(0, 120);
  return (
    <div className={`${cls}${m.shadow ? " ck-msg--shadow" : ""}`} id={`ck-m-${m.id}`} data-message={m.id} data-f={f}>
      {p.canReply && !m.shadow ? (
        <button type="button" className="ck-msg__reply" aria-label={t.reply} title={t.reply}
          data-ck-reply={m.id} data-ck-reply-who={labelOf(m.author, p, t)} data-ck-reply-text={snippet}>
          <ReplyIcon />
        </button>
      ) : null}
      {(bot || m.shadow) && (
        <div className="ck-msg__head">
          {bot ? <BotChip label={p.botName ?? t.authorBot} /> : null}
          {m.handoff ? <span className="ck-badge ck-badge--warn">{t.handoffBadge}</span> : null}
          {m.shadow ? <span className="ck-badge ck-badge--bot">{t.shadowBadge}</span> : null}
        </div>
      )}
      {m.replyTo ? <Quote q={m.replyTo} byId={byId} t={t} p={p} /> : null}
      {m.subject ? <div className="ck-msg__subject" data-find="">✉ {m.subject}</div> : null}
      {atts}
      {card}
      {!onlyFile && m.text && !card ? <RichText text={m.text} dialect={client && m.channel === "whatsapp" ? "whatsapp" : "markdown"} /> : null}
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
