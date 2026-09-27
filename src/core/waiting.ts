import type { ChatMessage } from "./model.js";

/* «Ждут ответа» — одно правило для списка диалогов, счётчика в меню и уведомления.

   Клиент написал, а ему ещё никто не ответил — ни бот, ни менеджер, ни внесённая вручную копия ответа.
   - Не в счёт: заметки команды, служебные строки, недоставленное сообщение, черновик теневого режима.
   - Звонки: состоявшийся разговор (call без «пропущен») — ответ; пропущенный входящий — клиент ждёт, как если бы
     написал; пропущенный исходящий и звонок без сведений (call не заполнен) ожидание не меняют.
   - «Ответ не нужен» (dismissedAt — клиент написал «спасибо») снимает ожидание до следующего сообщения клиента.
   - Бот ответил «передаю вас менеджеру» (handoff) — это не ответ: бот сам не справился, клиент ждёт человека —
     с первого своего сообщения после последнего настоящего ответа, а если такого нет — с момента передачи.

   waitSince — для диалога, который уже загружен целиком (окно переписки, проверки). Для списка из тысяч клиентов
   проект считает то же самое в базе: waitSinceSql собирает подзапрос по тем же правилам (проверено на Postgres). */

export type WaitMessage = Pick<ChatMessage, "at" | "kind" | "author"> &
  Partial<Pick<ChatMessage, "delivery" | "handoff" | "shadow" | "call">>;

const time = (v: string | Date | null | undefined): number => (v === null || v === undefined ? NaN : v instanceof Date ? v.getTime() : Date.parse(v));

/** Сообщение переписки (не заметка, не служебное, не звонок) */
function isChat(m: WaitMessage): boolean {
  return m.kind === "message";
}

/** Клиент написал или не дозвонился до нас — теперь ждёт ответа */
function isClientTurn(m: WaitMessage): boolean {
  if (m.kind === "call") return m.author.type === "client" && m.call?.missed === true;
  return isChat(m) && m.author.type === "client";
}

/** Настоящий ответ клиенту: наше сообщение, которое ушло или уходит, не «передаю менеджеру» и не черновик;
 *  или состоявшийся разговор по телефону */
export function isRealReply(m: WaitMessage): boolean {
  if (m.kind === "call") return !!m.call && !m.call.missed && m.author.type !== "system";
  return isChat(m) && m.author.type !== "client" && m.author.type !== "system" && m.delivery !== "failed" && !m.handoff && !m.shadow;
}

/** С какого времени клиент ждёт ответа (ISO-время), null — не ждёт */
export function waitSince(messages: readonly WaitMessage[], dismissedAt?: string | Date | null): string | null {
  let since = -Infinity;
  for (const m of messages) if (isRealReply(m)) since = Math.max(since, time(m.at));
  const dismissed = time(dismissedAt);
  if (Number.isFinite(dismissed)) since = Math.max(since, dismissed);
  let firstIn = Infinity;
  let firstInAt: string | null = null;
  let lastHandoff = -Infinity;
  let lastHandoffAt: string | null = null;
  for (const m of messages) {
    const t = time(m.at);
    if (!(t > since)) continue;
    if (isClientTurn(m)) {
      if (t < firstIn) { firstIn = t; firstInAt = m.at; }
    } else if (isChat(m) && m.handoff && m.author.type !== "client" && m.author.type !== "system" && m.delivery !== "failed" && !m.shadow && t > lastHandoff) {
      lastHandoff = t;
      lastHandoffAt = m.at;
    }
  }
  return firstInAt ?? lastHandoffAt;
}

/** «ждёт 25 мин», «ждёт 3 ч», «ждёт 2 дн» — сколько клиент ждёт ответа */
export function waitText(ms: number): string {
  const min = Math.max(1, Math.floor(ms / 60_000));
  if (min < 60) return `ждёт ${min} мин`;
  const h = Math.floor(min / 60);
  if (h < 24) return `ждёт ${h} ч`;
  return `ждёт ${Math.floor(h / 24)} дн`;
}

/** Ключ одного ожидания: клиент и с какого времени он ждёт. Уведомление звучит один раз на ключ — клиент дописал ещё
 *  пару сообщений, пока ждёт, — второй раз не звоним; ответили, а он написал снова — новое ожидание, новый звонок */
export function waitKey(contactId: string | number, since: string | number | Date): string {
  const ms = since instanceof Date ? since.getTime() : typeof since === "number" ? since : Date.parse(since);
  return `${contactId}:${ms}`;
}

/* ── То же правило в SQL (Postgres) ─────────────────────────────────────────────────────────────────────────── */

export type WaitSqlOptions = {
  /** Таблица сообщений: «messages» */
  table: string;
  /** Колонка таблицы сообщений с клиентом (диалогом): «client_id», «dialog_id» */
  contactColumn: string;
  /** Выражение внешнего запроса с номером клиента (диалога): «c.id», «d.id» */
  contactRef: string;
  /** Колонка времени сообщения: «created_at» */
  timeColumn: string;
  /** Условие для строки сообщения x — разделение компаний и прочее общее: «x.org_id = $1» */
  scope?: string | undefined;
  /** Строка x — сообщение клиента в переписке: «x.direction = 'in' AND x.channel IN (…)» */
  clientMessage: string;
  /** Строка x — настоящий ответ: «x.direction = 'out' AND x.channel IN (…) AND x.delivery IS DISTINCT FROM 'error' AND NOT x.handoff» */
  reply: string;
  /** Строка x — бот передал человеку: «x.direction = 'out' AND x.handoff»; нет такого понятия — не задавать */
  handoff?: string | undefined;
  /** Выражение внешнего запроса — «ответ не нужен»: «c.reply_dismissed_at» */
  dismissedAt?: string | undefined;
};

/** Подзапрос «с какого времени клиент ждёт ответа» (timestamptz или NULL) — для списка диалогов, фильтра «Ждут ответа»
 *  и счётчика. Внутри — только имена из настроек проекта (не данные пользователя): подставлять в SQL можно. Условия
 *  пишутся для строки с псевдонимом x. Совпадает с waitSince — проверяет тест на Postgres (tests/core/waiting-sql.test.ts). */
export function waitSinceSql(o: WaitSqlOptions): string {
  const own = (alias: string, cond: string) =>
    `${alias}.${o.contactColumn} = ${o.contactRef}${o.scope ? ` AND (${rename(o.scope, alias)})` : ""} AND (${rename(cond, alias)})`;
  const lastReply = `(SELECT MAX(r.${o.timeColumn}) FROM ${o.table} r WHERE ${own("r", o.reply)})`;
  const since = o.dismissedAt ? `GREATEST(${lastReply}, ${o.dismissedAt})` : lastReply;
  const firstIn = `(SELECT MIN(i.${o.timeColumn}) FROM ${o.table} i WHERE ${own("i", o.clientMessage)} AND i.${o.timeColumn} > w.since)`;
  const handoff = o.handoff
    ? `(SELECT MAX(h.${o.timeColumn}) FROM ${o.table} h WHERE ${own("h", o.handoff)} AND h.${o.timeColumn} > w.since)`
    : "NULL::timestamptz";
  return `(SELECT COALESCE(${firstIn}, ${handoff}) FROM (SELECT COALESCE(${since}, '-infinity'::timestamptz) AS since) w)`;
}

/** Условие написано для строки x — переносим на свой псевдоним (r, i, h), не трогая «xx.» и строки в кавычках */
function rename(cond: string, alias: string): string {
  let out = "";
  let quoted = false;
  for (let i = 0; i < cond.length; i++) {
    const ch = cond[i]!;
    if (ch === "'") quoted = !quoted;
    const prev = i > 0 ? cond[i - 1]! : " ";
    if (!quoted && ch === "x" && cond[i + 1] === "." && !/[\w.$"]/.test(prev)) {
      out += alias;
      continue;
    }
    out += ch;
  }
  return out;
}
