import type { Author } from "./model.js";

/* Диалог в списке и состояние бота в диалоге — без базы. Список собирает проект (своим запросом к своей базе), окно
   переписки его только показывает. */

/** Строка списка диалогов */
export type DialogSummary = {
  /** Номер клиента (диалога) в проекте */
  id: string;
  name: string;
  /** Канал последнего сообщения — значок у аватара */
  channel?: string | null | undefined;
  /** Последнее сообщение: текст (или слова вместо файла), кто и когда написал */
  last?: { text: string; at: string; author: Author } | null | undefined;
  /** С какого времени клиент ждёт ответа (правило waitSince / waitSinceSql); null — не ждёт */
  waitSince?: string | null | undefined;
  /** Сколько сообщений клиента не прочитано */
  unread?: number | undefined;
  /** Строка под текстом: сделка, запись к врачу, «новое обращение» — что решит проект */
  subtitle?: string | null | undefined;
  /** Найдено поиском в сообщении (не в последнем) — показать его вместо последнего */
  found?: { text: string; at: string } | null | undefined;
  /** Состояние бота в диалоге — пометка «бот на паузе», «не отвечать» */
  bot?: BotState | null | undefined;
};

/** Кто ведёт диалог (план студии 10.5): бот, человек (бот на паузе) или бот молчит всегда («не отвечать этому клиенту») */
export type ControlMode = "bot" | "manager" | "muted";

export type BotState = {
  mode: ControlMode;
  /** Пауза до — после этого времени бот снова отвечает сам (null — пока не вернут кнопкой) */
  pausedUntil?: string | null | undefined;
  /** Передача человеку: requested — бот позвал, claimed — сотрудник взял */
  handoff?: "none" | "requested" | "claimed" | "failed" | undefined;
  /** Почему (для подсказки): «клиент попросил человека», «жалоба» */
  reason?: string | null | undefined;
  /** Подключение умеет паузу по команде (у Nextbot — нет: только заметка боту «не перебивай») */
  canPause?: boolean | undefined;
  /** Подключение умеет «не отвечать этому клиенту» */
  canMute?: boolean | undefined;
};

/** Команды боту из окна переписки — «розетка» передаёт их подключению */
export type BotCommand =
  | { type: "pause"; hours?: number | undefined; until?: string | undefined; reason?: string | undefined }
  | { type: "resume" }
  | { type: "mute" }
  | { type: "unmute" };

/** Пометка состояния бота словами: «бот на паузе до 18:30», «бот не отвечает этому клиенту» */
export function botStateText(s: BotState | null | undefined, fmtUntil: (iso: string) => string = (x) => x): string | null {
  if (!s) return null;
  if (s.mode === "muted") return "бот не отвечает этому клиенту";
  if (s.mode === "manager") return s.pausedUntil ? `бот на паузе до ${fmtUntil(s.pausedUntil)}` : "бот на паузе — отвечает человек";
  if (s.handoff === "requested") return "бот позвал человека";
  return null;
}
