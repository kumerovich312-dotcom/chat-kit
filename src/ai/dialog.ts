import { fileKind, fileWords, textIsFileName } from "../core/files.js";
import type { Attachment, ChatMessage } from "../core/model.js";
import { sortMessages } from "../core/order.js";
import { dayKey, fmtClock } from "../core/time.js";
import type { PersonalDataMask } from "./privacy.js";

/* Переписка — текстом для ИИ: одна строка на сообщение, от старых к новым:
     [12.10 14:03] Клиент: Здравствуйте, можно записаться на завтра?
     [12.10 14:05] Менеджер Айгерим: Да, есть время в 15:00.
     [12.10 14:06] Менеджер Айгерим (заметка команды, клиент не видел): перезвонить после обеда
     [12.10 14:10] Клиент: (голосовое, расшифровка: «Хорошо, тогда в три»)
   Служебные строки и черновики бота (клиент их не видел) не берём. Файлы — словами, голосовые и звонки — расшифровкой,
   если она есть. Берём последние сообщения: не больше lastMessages и не больше maxChars знаков — старые отбрасываются
   первыми. Время — по поясу компании, как его видят сотрудники. */

export type ConversationTextOptions = {
  /** Пояс компании («Asia/Bishkek») */
  timeZone?: string | undefined;
  /** Сколько последних сообщений взять (по умолчанию 80) */
  lastMessages?: number | undefined;
  /** Не больше стольких знаков (по умолчанию 24 000) */
  maxChars?: number | undefined;
  /** Как подписать клиента — словом проекта: «клиент», «пациент», «кандидат» */
  client?: string | undefined;
  /** Скрыть телефоны, почту и номера карт — одна маска на весь запрос */
  mask?: PersonalDataMask | null | undefined;
};

export type ConversationText = {
  text: string;
  /** Сколько сообщений попало в текст */
  count: number;
  /** Из них — от клиента */
  fromClient: number;
  /** Начало переписки не поместилось */
  truncated: boolean;
};

/** Сообщение одно — не длиннее этого (длинное письмо обрезаем) */
const MAX_TEXT = 2000;
/** Расшифровка голосового или звонка — не длиннее этого */
const MAX_TRANSCRIPT = 3000;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const cap = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** «12.10 14:03» — день и время по поясу компании; время неизвестно — null */
export function timeStamp(at: string | number | Date, timeZone?: string): string | null {
  const ms = at instanceof Date ? at.getTime() : typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(ms)) return null;
  const make = (tz: string | undefined) => {
    const [, month, day] = dayKey(ms, tz).split("-");
    return `${day}.${month} ${fmtClock(ms, tz, false)}`;
  };
  try {
    return make(timeZone);
  } catch {
    // Незнакомый пояс в настройках — лучше время сервера, чем никакого
    return make(undefined);
  }
}

/** Сообщение видно клиенту или команде по делу: без служебных строк и черновиков бота */
function shown(m: ChatMessage): boolean {
  if (m.kind === "system" || m.author.type === "system" || m.shadow) return false;
  return m.kind === "call" || !!m.text.trim() || !!m.attachments?.length;
}

function author(m: ChatMessage, client: string): string {
  switch (m.author.type) {
    case "client":
      return client;
    case "bot":
      return "Бот";
    default: {
      const name = oneLine(m.author.name ?? "");
      return name ? `Менеджер ${clip(name, 40)}` : "Менеджер";
    }
  }
}

/** Файл словами: голосовое — расшифровкой, если она есть */
function fileLine(a: Attachment): string {
  const heard = oneLine(a.transcript ?? "");
  switch (fileKind(a.mime, a.name)) {
    case "audio":
      return heard ? `(голосовое, расшифровка: «${clip(heard, MAX_TRANSCRIPT)}»)` : "(голосовое сообщение)";
    case "video":
      return heard ? `(видео, расшифровка: «${clip(heard, MAX_TRANSCRIPT)}»)` : "(видео)";
    case "image":
      return "(фото)";
    default:
      return `(документ «${clip(oneLine(a.name), 80)}»)`;
  }
}

/** Текст сообщения — только подпись файла («Голосовое сообщение», имя документа): не повторяем его рядом с файлом */
function onlyFileWords(m: ChatMessage): boolean {
  const files = m.attachments ?? [];
  const t = m.text.trim();
  return textIsFileName(m.text, files) || files.some((a) => t === fileWords(a));
}

/** Многострочное сообщение: строки с отступом, пустые — прочь */
function body(text: string): string {
  return clip(text.trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean).join("\n  "), MAX_TEXT);
}

function line(m: ChatMessage, client: string, timeZone: string | undefined): string {
  const t = timeStamp(m.at, timeZone);
  const head = t ? `[${t}] ` : "";
  const files = m.attachments ?? [];
  if (m.kind === "call") {
    const heard = files.map((a) => oneLine(a.transcript ?? "")).filter(Boolean).join(" ");
    const what = oneLine(m.text) || "звонок";
    return `${head}Звонок: ${what}${heard ? `. Расшифровка разговора: «${clip(heard, MAX_TRANSCRIPT)}»` : ""}`;
  }
  const who = author(m, client) + (m.kind === "note" ? " (заметка команды, клиент не видел)" : "");
  const parts: string[] = [];
  if (m.subject?.trim()) parts.push(`Тема: ${clip(oneLine(m.subject), 200)}.`);
  if (m.replyTo?.text?.trim()) parts.push(`(в ответ на «${clip(oneLine(m.replyTo.text), 80)}»)`);
  if (!onlyFileWords(m)) parts.push(body(m.text));
  for (const a of files) parts.push(fileLine(a));
  if (m.delivery === "failed") parts.push("(не доставлено)");
  return `${head}${who}: ${parts.join(" ")}`;
}

/** Переписка текстом для ИИ — последние сообщения, от старых к новым */
export function renderConversation(messages: readonly ChatMessage[], o: ConversationTextOptions = {}): ConversationText {
  const client = cap(oneLine(o.client ?? "") || "клиент");
  const list = sortMessages(messages).filter(shown);
  const last = list.slice(-Math.max(1, Math.floor(o.lastMessages ?? 80)));
  const max = o.maxChars ?? 24_000;
  const lines = last.map((m) => {
    const raw = line(m, client, o.timeZone);
    return { text: o.mask ? o.mask.hide(raw) : raw, client: m.author.type === "client" };
  });
  // С конца, пока помещается: свежие сообщения важнее старых. Одно сообщение берём всегда
  const kept: typeof lines = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (kept.length && total + l.text.length + 1 > max) break;
    kept.unshift(l);
    total += l.text.length + 1;
  }
  const truncated = kept.length < list.length;
  const text = (truncated ? "(начало переписки не показано)\n" : "") + kept.map((l) => l.text).join("\n");
  return { text, count: kept.length, fromClient: kept.filter((l) => l.client).length, truncated };
}
