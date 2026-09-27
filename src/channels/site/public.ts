import { textIsFileName } from "../../core/files.js";
import { formatForChannel } from "../../core/markup.js";
import type { Attachment, ChatMessage } from "../../core/model.js";

/* Что из переписки видит посетитель сайта. В базе проекта у диалога есть и то, что посетителю показывать нельзя:
   заметки команды, служебные строки, звонки, черновики бота (теневой режим), недоставленное, переписка из других
   каналов (менеджер мог объединить клиента с его WhatsApp). Посетителю — только его сообщения из виджета и наши ответы,
   в коротком виде без внутренних подробностей (номеров клиента, сотрудников, адресов файлов CRM). */

export type SitePublicAttachment = { name: string; mime: string; url: string; size?: number | null | undefined };

/** Сообщение для виджета. Тот же вид описан в src/widget/chat-widget.ts (виджет без импортов) — менять вместе */
export type SitePublicMessage = {
  id: string;
  at: string;
  from: "visitor" | "company";
  text: string;
  /** Кто ответил: имя сотрудника (showAgentNames) или бота (botName); иначе null */
  author: string | null;
  /** Номер сообщения у виджета — так виджет узнаёт своё отправленное и убирает «отправляется…» */
  clientMsgId: string | null;
  attachment: SitePublicAttachment | null;
};

/** Ссылка на файл для посетителя — он не вошёл в CRM, поэтому ссылка подписанная (signFileLink); null — не показывать */
export type SiteFileUrl = (att: Attachment, message: ChatMessage) => string | null | Promise<string | null>;

export type SitePublicOptions = {
  visitorId: string;
  /** Показывать имя сотрудника под ответом (только первое слово: «Айгерим») */
  showAgentNames?: boolean | undefined;
  /** Подпись под ответами бота; нет — без подписи */
  botName?: string | null | undefined;
  /** Каналы, чьи сообщения видит посетитель: по умолчанию только «site» */
  channels?: readonly string[] | undefined;
  fileUrl?: SiteFileUrl | undefined;
};

const SITE_ONLY = ["site"] as const;

/** Ключ повтора сообщений посетителя: «site:<посетитель>:<номер у виджета>» (у файла — ещё «:file:0») */
export const siteMessagePrefix = (visitorId: string): string => `site:${visitorId}:`;

/** Видно ли сообщение посетителю: его сообщения, пришедшие из виджета, и наши ответы в чат на сайте */
export function visibleToVisitor(m: ChatMessage, visitorId: string, channels: readonly string[] = SITE_ONLY): boolean {
  if (m.kind !== "message" || m.shadow || m.delivery === "failed" || !channels.includes(m.channel)) return false;
  // Сообщение клиента — только своё: внесённые менеджером копии и сообщения другого посетителя (если клиентов склеили) — нет
  if (m.author.type === "client") return !!m.externalId?.startsWith(siteMessagePrefix(visitorId));
  return m.author.type !== "system";
}

/** Номер сообщения у виджета по ключу повтора */
export function clientMsgIdOf(m: Pick<ChatMessage, "externalId">, visitorId: string): string | null {
  const prefix = siteMessagePrefix(visitorId);
  if (!m.externalId?.startsWith(prefix)) return null;
  return m.externalId.slice(prefix.length).split(":")[0] || null;
}

const firstWord = (name: string | null | undefined) => name?.trim().split(/\s+/)[0] || null;

/** Одно сообщение в виде для посетителя (видимость проверяет visibleToVisitor) */
export async function toPublicMessage(m: ChatMessage, o: SitePublicOptions): Promise<SitePublicMessage> {
  const mine = m.author.type === "client";
  const att = m.attachments?.[0];
  let attachment: SitePublicAttachment | null = null;
  if (att && o.fileUrl) {
    let url: string | null = null;
    try {
      url = await o.fileUrl(att, m);
    } catch (e) {
      console.error("[chat-kit site] не удалось подписать ссылку на файл:", e);
    }
    if (url) attachment = { name: att.name, mime: att.mime, url, ...(att.size ? { size: att.size } : {}) };
  }
  // Ответ бота написан разметкой Markdown — посетителю чистым текстом («подпись (адрес)»); человек — как написал
  let text = m.author.type === "bot" ? formatForChannel(m.text, "plain") : m.text;
  if (attachment && textIsFileName(text, [attachment])) text = "";
  const author = mine ? null : m.author.type === "bot" ? (o.botName?.trim() || null) : o.showAgentNames ? firstWord(m.author.name) : null;
  return { id: m.id, at: m.at, from: mine ? "visitor" : "company", text, author, clientMsgId: mine ? clientMsgIdOf(m, o.visitorId) : null, attachment };
}

/** Переписка диалога → то, что видит посетитель, по порядку */
export async function toPublicMessages(list: readonly ChatMessage[], o: SitePublicOptions): Promise<SitePublicMessage[]> {
  const out: SitePublicMessage[] = [];
  for (const m of list) if (visibleToVisitor(m, o.visitorId, o.channels)) out.push(await toPublicMessage(m, o));
  return out;
}
