import type { AuthorType } from "./model.js";
import { companyTime } from "./team.js";
import { dayKey } from "./time.js";
import { isRealReply, type WaitMessage, type WaitSqlOptions } from "./waiting.js";

/* Статистика ответов за период — без базы: как быстро команда и бот отвечают клиентам.

   Обращение — клиент начал ждать ответа: написал или не дозвонился до нас, а до этого не ждал. Пока ждёт, его новые
   сообщения — то же обращение. Кончается первым настоящим ответом — тем же, что снимает «ждут ответа» (waiting.ts):
   наше сообщение, которое ушло или уходит (не заметка, не служебное, не недоставленное, не черновик теневого режима,
   не «передаю менеджеру»), или состоявшийся разговор по телефону.
   - Бот передал человеку («передаю менеджеру», handoff). Клиент уже ждёт — обращение продолжается: время идёт с его
     первого сообщения, передача ответом не считается. Не ждал (бот ответил, а потом передал) — с передачи начинается
     новое обращение: клиент ждёт человека. Кончается первым настоящим ответом — человека или бота.
   - «Ответ не нужен» (dismissedAt — клиент написал «спасибо») закрывает обращение без ответа: оно не в счёт ни
     в ответах, ни в «ждут сейчас».
   - Записи с одним и тем же временем (у неточных каналов — до секунды): сначала ходы клиента, потом передача, потом
     ответы, потом «ответ не нужен» — как в waitSince: ответ в ту же секунду снимает ожидание (ответ за 0 с). Из
     нескольких ответов в одно время засчитывается один: менеджер из CRM, с телефона, администратор, бот; дальше — по
     номеру и имени автора (по кодам букв, как COLLATE "C" в Postgres).
   - Состоявшийся входящий звонок записан от клиента, но это ответ: он засчитывается «менеджеру с телефона» (имя —
     call.manager).

   episodesOf — обращения одного диалога, когда сообщения уже загружены. За период по всем клиентам то же считает
   база: responseEpisodesSql (Postgres; совпадение проверено тестом на PGlite), итоги — responseStats. Период
   «Сегодня», «Эта неделя» по поясу компании — statsPeriod; сколько сообщений пришло и ушло — countMessages
   и messageCountsSql. Подробно — docs/TEAM.md. */

type When = string | number | Date;

const ms = (v: When | null | undefined): number =>
  v === null || v === undefined ? NaN : v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(v);

const iso = (t: number) => new Date(t).toISOString();

/** Клиент написал или не дозвонился до нас — то же правило, что в waiting.ts */
function clientTurn(m: WaitMessage): boolean {
  if (m.kind === "call") return m.author.type === "client" && m.call?.missed === true;
  return m.kind === "message" && m.author.type === "client";
}

/** «Передаю менеджеру» — не ответ, клиент ждёт человека (то же правило, что в waiting.ts) */
function handoffMessage(m: WaitMessage): boolean {
  return m.kind === "message" && !!m.handoff && m.author.type !== "client" && m.author.type !== "system" && m.delivery !== "failed" && !m.shadow;
}

/* ── Обращения одного диалога ────────────────────────────────────────────────────────────────────────────────── */

/** Сообщение для статистики: как для «ждут ответа», плюс канал; у автора — номер и имя сотрудника */
export type EpisodeMessage = WaitMessage & { channel?: string | null | undefined };

/** Кто ответил */
export type Replier = { type: AuthorType; id: string | null; name: string | null };

/** Обращение: клиент ждал ответа с startedAt до repliedAt */
export type Episode = {
  contactId: string;
  /** Канал, где клиент начал ждать (у передачи человеку — канал передачи) */
  channel: string | null;
  /** Когда клиент начал ждать (ISO) */
  startedAt: string;
  /** Первый настоящий ответ (ISO); null — ответа нет */
  repliedAt: string | null;
  replier: Replier | null;
  /** Ответил бот */
  byBot: boolean;
  /** «Ответ не нужен» — ожидание снято без ответа (ISO) */
  dismissedAt: string | null;
};

/** Запись для подсчёта: время, вид (0 — ход клиента, 1 — передача человеку, 2 — ответ, 3 — «ответ не нужен»), автор */
type Ev = { t: number; kind: 0 | 1 | 2 | 3; type: AuthorType | null; id: string | null; name: string | null; channel: string | null };

const RANK: Partial<Record<string, number>> = { operator_crm: 0, operator_phone: 1, operator_admin: 2, bot: 3 };
const rank = (type: string | null) => (type === null ? 4 : RANK[type] ?? 4);

/** Строки по кодам символов — как COLLATE "C" в Postgres; пустое значение — в конце (как NULLS LAST) */
function cmpText(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.codePointAt(i)!;
    const y = b.codePointAt(i)!;
    if (x !== y) return x < y ? -1 : 1;
    if (x > 0xffff) i++;
  }
  return a.length - b.length;
}

/** Порядок записей — один и тот же у episodesOf и responseEpisodesSql */
function byOrder(a: Ev, b: Ev): number {
  return a.t - b.t || a.kind - b.kind || rank(a.type) - rank(b.type) || cmpText(a.id, b.id) || cmpText(a.name, b.name) || cmpText(a.channel, b.channel);
}

/** Автор строки для статистики: состоявшийся входящий звонок (записан от клиента) — ответ менеджера с телефона */
function statAuthor(m: EpisodeMessage): { type: AuthorType; id: string | null; name: string | null } {
  if (m.kind === "call" && m.author.type === "client" && m.call && !m.call.missed) return { type: "operator_phone", id: null, name: m.call.manager ?? null };
  return { type: m.author.type, id: m.author.id ?? null, name: m.author.name ?? null };
}

/** Обращения одного диалога от старых к новым. dismissedAt — «Ответ не нужен» (последняя отметка, как у waitSince).
 *  Последнее обращение без ответа и без отметки есть тогда и только тогда, когда waitSince не null */
export function episodesOf(
  messages: readonly EpisodeMessage[],
  contactId: string | number,
  opts: { dismissedAt?: When | null | undefined } = {}
): Episode[] {
  const evs: Ev[] = [];
  for (const m of messages) {
    const t = Date.parse(m.at);
    if (!Number.isFinite(t)) continue;
    const kind = clientTurn(m) ? 0 : handoffMessage(m) ? 1 : isRealReply(m) ? 2 : -1;
    if (kind === -1) continue;
    evs.push({ t, kind, ...statAuthor(m), channel: m.channel ?? null });
  }
  const dismissed = ms(opts.dismissedAt);
  if (Number.isFinite(dismissed)) evs.push({ t: dismissed, kind: 3, type: null, id: null, name: null, channel: null });
  evs.sort(byOrder);

  const id = String(contactId);
  const out: Episode[] = [];
  let open: { t: number; channel: string | null } | null = null;
  for (const e of evs) {
    if (e.kind <= 1) {
      if (!open) open = { t: e.t, channel: e.channel };
      continue;
    }
    if (!open) continue;
    const reply = e.kind === 2;
    out.push({
      contactId: id, channel: open.channel, startedAt: iso(open.t),
      repliedAt: reply ? iso(e.t) : null,
      replier: reply && e.type ? { type: e.type, id: e.id, name: e.name } : null,
      byBot: reply && e.type === "bot",
      dismissedAt: reply ? null : iso(e.t),
    });
    open = null;
  }
  if (open) out.push({ contactId: id, channel: open.channel, startedAt: iso(open.t), repliedAt: null, replier: null, byBot: false, dismissedAt: null });
  return out;
}

/** Когда клиент последний раз написал или не дозвонился (ISO); null — ни разу. Для статуса диалога (effectiveStatus):
 *  написал после того, как диалог закрыли или отложили, — диалог снова открыт */
export function lastClientAt(messages: readonly WaitMessage[]): string | null {
  let best = -Infinity;
  let at: string | null = null;
  for (const m of messages) {
    if (!clientTurn(m)) continue;
    const t = Date.parse(m.at);
    if (t > best) {
      best = t;
      at = m.at;
    }
  }
  return at;
}

/** То же в SQL: подзапрос «последний ход клиента» (timestamptz или NULL) — для effectiveStatusSql. Условия пишутся
 *  для строки x (как у waitSinceSql); внешний запрос не должен называть свою таблицу x */
export function lastClientAtSql(o: Pick<WaitSqlOptions, "table" | "contactColumn" | "contactRef" | "timeColumn" | "scope" | "clientMessage">): string {
  return `(SELECT MAX(x.${o.timeColumn}) FROM ${o.table} x WHERE x.${o.contactColumn} = ${o.contactRef}`
    + `${o.scope ? ` AND (${o.scope})` : ""} AND (${o.clientMessage}))`;
}

/* ── Обращения за период в SQL (Postgres) ────────────────────────────────────────────────────────────────────── */

export type EpisodesSqlOptions = {
  /** Таблица сообщений: «messages» */
  table: string;
  /** Колонка с клиентом (диалогом): «client_id» */
  contactColumn: string;
  /** Колонка времени сообщения: «created_at» (индекс по клиенту и времени ускорит запрос) */
  timeColumn: string;
  /** Условие для строки x — своя компания: «x.org_id = $1». Только x и параметры запроса */
  scope?: string | undefined;
  /** Начало периода (включительно) и конец (не включая) — параметры запроса: «$2», «$3» */
  from: string;
  to: string;
  /** Строка x — ход клиента: его сообщение или пропущенный входящий звонок (как clientMessage у waitSinceSql) */
  clientMessage: string;
  /** Строка x — настоящий ответ (как reply у waitSinceSql) */
  reply: string;
  /** Строка x — бот передал человеку (как handoff у waitSinceSql); нет такого понятия — не задавать */
  handoff?: string | undefined;
  /** Канал строки x: «x.channel» */
  channel: string;
  /** Вид автора строки x словами набора (client, bot, operator_crm, operator_phone, operator_admin): «x.author» или
   *  «CASE x.sender WHEN 'bot' THEN 'bot' WHEN 'phone' THEN 'operator_phone' ELSE 'operator_crm' END» */
  authorType: string;
  /** Номер и имя сотрудника у строки x: «x.author_id», «x.author_name»; нет — не задавать */
  authorId?: string | undefined;
  authorName?: string | undefined;
  /** «Ответ не нужен» у клиента — выражение по номеру клиента (последняя отметка, как dismissedAt у waitSinceSql):
   *  (id) => `(SELECT c.reply_dismissed_at FROM clients c WHERE c.id = ${id})` */
  dismissedAt?: ((contact: string) => string) | undefined;
};

/** Строка ответа базы на responseEpisodesSql */
export type EpisodeRow = {
  contact_id: string | number | bigint;
  channel: string | null;
  started_at: Date | string;
  replied_at: Date | string | null;
  dismissed_at: Date | string | null;
  replier_type: string | null;
  replier_id: string | null;
  replier_name: string | null;
  by_bot: boolean | null;
};

/** Запрос «обращения, начатые за период» — те же обращения, что episodesOf (проверено на Postgres,
 *  tests/core/stats-sql.test.ts). Колонки: contact_id, channel, started_at, replied_at, dismissed_at, replier_type,
 *  replier_id, replier_name, by_bot. Внутри — только имена из настроек проекта, не данные пользователя; период —
 *  параметрами запроса.
 *
 *  Как устроен: берутся клиенты, у которых за период был ход клиента или передача человеку; их записи — от последнего
 *  ответа до начала периода (раньше него клиент точно не ждал) до конца периода, и ещё первый ответ после конца
 *  (обращение конца периода могли закрыть позже). Записи ставятся в тот же порядок, что у episodesOf; обращение
 *  начинает первый ход клиента после ответа, закрывает — первый ответ (или «ответ не нужен») после него. */
export function responseEpisodesSql(o: EpisodesSqlOptions): string {
  const c = `x.${o.contactColumn}`;
  const t = `x.${o.timeColumn}`;
  const scope = o.scope ? `(${o.scope}) AND ` : "";
  const client = `(${o.clientMessage})`;
  const reply = `(${o.reply})`;
  const handoff = o.handoff ? `(${o.handoff})` : "FALSE";
  // «Ответ не нужен» — ещё одна запись клиента (вид 3), только если проект его ведёт
  const dismissedCol = o.dismissedAt ? `,\n    ${o.dismissedAt("a.contact_id")} AS dismissed_at` : "";
  const dismissedRows = o.dismissedAt
    ? "\n  UNION ALL\n  SELECT b.contact_id, b.dismissed_at, 3, NULL, NULL, NULL, NULL FROM bounds b WHERE b.dismissed_at IS NOT NULL"
    : "";
  const rank = "CASE author_type WHEN 'operator_crm' THEN 0 WHEN 'operator_phone' THEN 1 WHEN 'operator_admin' THEN 2 WHEN 'bot' THEN 3 ELSE 4 END";
  return `WITH active AS (
  SELECT DISTINCT ${c} AS contact_id FROM ${o.table} x
  WHERE ${scope}${t} >= ${o.from} AND ${t} < ${o.to} AND (${client} OR ${handoff})
), bounds AS (
  SELECT a.contact_id,
    (SELECT MAX(${t}) FROM ${o.table} x WHERE ${c} = a.contact_id AND ${scope}${reply} AND ${t} < ${o.from}) AS lo,
    (SELECT MIN(${t}) FROM ${o.table} x WHERE ${c} = a.contact_id AND ${scope}${reply} AND ${t} >= ${o.to}) AS hi${dismissedCol}
  FROM active a
), ev AS (
  SELECT ${c} AS contact_id, ${t} AS ts,
    CASE WHEN ${client} THEN 0 WHEN ${handoff} THEN 1 ELSE 2 END AS kind,
    (${o.channel})::text AS channel, (${o.authorType})::text AS author_type,
    (${o.authorId ?? "NULL"})::text AS author_id, (${o.authorName ?? "NULL"})::text AS author_name
  FROM ${o.table} x JOIN bounds b ON b.contact_id = ${c}
  WHERE ${scope}(${client} OR ${handoff} OR ${reply})
    AND ${t} >= COALESCE(b.lo, '-infinity')
    AND (${t} < ${o.to} OR (${t} = b.hi AND ${reply}))${dismissedRows}
), ord AS (
  SELECT ev.*, ROW_NUMBER() OVER (PARTITION BY contact_id
    ORDER BY ts, kind, ${rank}, author_id COLLATE "C", author_name COLLATE "C", channel COLLATE "C") AS rn
  FROM ev
), marked AS (
  SELECT ord.*,
    MAX(CASE WHEN kind >= 2 THEN rn END) OVER (PARTITION BY contact_id ORDER BY rn ROWS UNBOUNDED PRECEDING) AS after_rn,
    MIN(CASE WHEN kind >= 2 THEN rn END) OVER (PARTITION BY contact_id ORDER BY rn ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) AS closer_rn
  FROM ord
), starts AS (
  SELECT marked.*, ROW_NUMBER() OVER (PARTITION BY contact_id, after_rn ORDER BY rn) AS k FROM marked WHERE kind < 2
)
SELECT s.contact_id, s.channel, s.ts AS started_at,
  CASE WHEN r.kind = 2 THEN r.ts END AS replied_at,
  CASE WHEN r.kind = 3 THEN r.ts END AS dismissed_at,
  CASE WHEN r.kind = 2 THEN r.author_type END AS replier_type,
  CASE WHEN r.kind = 2 THEN r.author_id END AS replier_id,
  CASE WHEN r.kind = 2 THEN r.author_name END AS replier_name,
  COALESCE(r.kind = 2 AND r.author_type = 'bot', FALSE) AS by_bot
FROM starts s LEFT JOIN ord r ON r.contact_id = s.contact_id AND r.rn = s.closer_rn
WHERE s.k = 1 AND s.ts >= ${o.from} AND s.ts < ${o.to}
ORDER BY s.ts, s.contact_id`;
}

const isoOf = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());

/** Строки базы (responseEpisodesSql) → обращения для responseStats */
export function episodesFromRows(rows: readonly EpisodeRow[]): Episode[] {
  return rows.map((r) => {
    const repliedAt = isoOf(r.replied_at);
    const replier: Replier | null = repliedAt !== null && r.replier_type
      ? { type: r.replier_type as AuthorType, id: r.replier_id ?? null, name: r.replier_name ?? null }
      : null;
    return {
      contactId: String(r.contact_id),
      channel: r.channel ?? null,
      startedAt: new Date(r.started_at).toISOString(),
      repliedAt,
      replier,
      byBot: replier?.type === "bot",
      dismissedAt: repliedAt === null ? isoOf(r.dismissed_at) : null,
    };
  });
}

/* ── Итоги за период ─────────────────────────────────────────────────────────────────────────────────────────── */

export type StatsOptions = {
  /** Период: обращения, начатые с from (включительно) до to (не включая) */
  from: When;
  to: When;
  /** «Сейчас» — ответ позже этого ещё не пришёл; по умолчанию текущее время */
  now?: When | undefined;
  /** Цели в минутах: «ответили быстрее 5, 15, 60 минут» */
  targetsMin?: readonly number[] | undefined;
};

/** Доля ответов быстрее цели */
export type TargetShare = {
  /** Цель в минутах */
  min: number;
  /** Ответили за это время или быстрее */
  hit: number;
  /** Из скольких. В общих итогах и по каналам — ответы и те, кто ждёт уже дольше цели (кто ждёт меньше — ещё может
   *  успеть и не в счёт); у людей, бота и сотрудника — только их ответы */
  of: number;
  /** hit / of (0…1); null — пока не из чего считать */
  share: number | null;
};

/** Время первого ответа, в секундах */
export type ResponseTimes = {
  /** Обращений с ответом */
  answered: number;
  /** Медиана: половина ответов быстрее; null — ответов нет */
  medianSec: number | null;
  avgSec: number | null;
  /** 90 % ответов быстрее */
  p90Sec: number | null;
  /** По целям targetsMin, в том же порядке */
  within: TargetShare[];
};

export type ResponseGroup = ResponseTimes & {
  /** Обращений за период */
  episodes: number;
  /** Ждут ответа сейчас */
  unanswered: number;
  /** «Ответ не нужен» */
  dismissed: number;
  /** Сколько ждёт тот, кто ждёт дольше всех; null — никто не ждёт */
  longestWaitSec: number | null;
};

export type ManagerStats = ResponseTimes & { id: string | null; name: string | null; type: AuthorType };

export type ChannelStats = ResponseGroup & { channel: string | null };

export type ResponseStats = ResponseGroup & {
  from: string;
  to: string;
  now: string;
  /** Диалогов, где клиент ждал ответа (было обращение за период) */
  dialogs: number;
  /** Ответили люди (сотрудники, с телефона, администратор) */
  humans: ResponseTimes;
  /** Ответил бот */
  bot: ResponseTimes;
  /** По сотрудникам (только ответы людей): больше ответов — выше */
  byManager: ManagerStats[];
  /** По каналам: больше обращений — выше */
  byChannel: ChannelStats[];
};

type Row = { e: Episode; state: "answered" | "waiting" | "dismissed"; sec: number };

/** Квантиль с линейной интерполяцией — как percentile_cont в Postgres */
function quantile(sorted: readonly number[], q: number): number | null {
  if (!sorted.length) return null;
  const h = (sorted.length - 1) * q;
  const lo = Math.floor(h);
  const a = sorted[lo]!;
  const b = sorted[Math.min(lo + 1, sorted.length - 1)]!;
  return a + (h - lo) * (b - a);
}

const round = (v: number | null) => (v === null ? null : Math.round(v));

function timesOf(rows: readonly Row[], targets: readonly number[], countWaiting: boolean): ResponseTimes {
  const answered = rows.filter((r) => r.state === "answered").map((r) => r.sec).sort((a, b) => a - b);
  const waiting = countWaiting ? rows.filter((r) => r.state === "waiting").map((r) => r.sec) : [];
  return {
    answered: answered.length,
    medianSec: round(quantile(answered, 0.5)),
    avgSec: answered.length ? round(answered.reduce((s, x) => s + x, 0) / answered.length) : null,
    p90Sec: round(quantile(answered, 0.9)),
    within: targets.map((min) => {
      const limit = min * 60;
      const hit = answered.filter((s) => s <= limit).length;
      const of = answered.length + waiting.filter((s) => s > limit).length;
      return { min, hit, of, share: of ? hit / of : null };
    }),
  };
}

function groupOf(rows: readonly Row[], targets: readonly number[]): ResponseGroup {
  let unanswered = 0;
  let dismissed = 0;
  let longest = -Infinity;
  for (const r of rows) {
    if (r.state === "waiting") {
      unanswered++;
      longest = Math.max(longest, r.sec);
    } else if (r.state === "dismissed") dismissed++;
  }
  return { episodes: rows.length, unanswered, dismissed, longestWaitSec: unanswered ? Math.round(longest) : null, ...timesOf(rows, targets, true) };
}

/** Итоги за период: сколько обращений, сколько с ответом и сколько ждут сейчас, время первого ответа (медиана,
 *  среднее, 90 %), доля ответов быстрее целей — всего, отдельно люди и бот, по сотрудникам и по каналам. Обращения
 *  берутся начатые в периоде; ответ позже now считается ещё не пришедшим (итоги «на момент») */
export function responseStats(episodes: readonly Episode[], o: StatsOptions): ResponseStats {
  const from = ms(o.from);
  const to = ms(o.to);
  const now = o.now === undefined ? Date.now() : ms(o.now);
  const targets = [...(o.targetsMin ?? [5, 15, 60])];
  const rows: Row[] = [];
  for (const e of episodes) {
    const start = Date.parse(e.startedAt);
    if (!(start >= from && start < to && start <= now)) continue;
    const replied = e.repliedAt ? Date.parse(e.repliedAt) : NaN;
    const dismissed = e.dismissedAt ? Date.parse(e.dismissedAt) : NaN;
    if (replied <= now) rows.push({ e, state: "answered", sec: (replied - start) / 1000 });
    else if (dismissed <= now) rows.push({ e, state: "dismissed", sec: (dismissed - start) / 1000 });
    else rows.push({ e, state: "waiting", sec: (now - start) / 1000 });
  }

  const answered = rows.filter((r) => r.state === "answered");
  const managers = new Map<string, { id: string | null; name: string | null; type: AuthorType; last: number; rows: Row[] }>();
  for (const r of answered) {
    const p = r.e.replier;
    if (!p || r.e.byBot) continue;
    const key = p.id !== null && p.id !== "" ? `id:${p.id}` : p.name?.trim() ? `name:${p.name.trim().toLowerCase()}` : `type:${p.type}`;
    const at = Date.parse(r.e.repliedAt!);
    let g = managers.get(key);
    if (!g) managers.set(key, (g = { id: p.id, name: p.name, type: p.type, last: at, rows: [] }));
    // Имя — по последнему ответу (сотрудника могли переименовать); ответы в одно время — по имени: итог не зависит
    // от порядка обращений
    if (at > g.last || (at === g.last && (cmpText(p.name, g.name) || cmpText(p.type, g.type)) < 0)) Object.assign(g, { name: p.name, type: p.type, last: at });
    g.rows.push(r);
  }
  const channels = new Map<string | null, Row[]>();
  for (const r of rows) {
    const list = channels.get(r.e.channel);
    if (list) list.push(r);
    else channels.set(r.e.channel, [r]);
  }

  return {
    from: iso(from), to: iso(to), now: iso(now),
    dialogs: new Set(rows.map((r) => r.e.contactId)).size,
    ...groupOf(rows, targets),
    humans: timesOf(answered.filter((r) => !r.e.byBot), targets, false),
    bot: timesOf(answered.filter((r) => r.e.byBot), targets, false),
    byManager: [...managers.values()]
      .map((g): ManagerStats => ({ id: g.id, name: g.name, type: g.type, ...timesOf(g.rows, targets, false) }))
      .sort((a, b) => b.answered - a.answered || (a.name ?? "").localeCompare(b.name ?? "", "ru") || cmpText(a.id, b.id) || cmpText(a.type, b.type)),
    byChannel: [...channels.entries()]
      .map(([channel, list]): ChannelStats => ({ channel, ...groupOf(list, targets) }))
      .sort((a, b) => b.episodes - a.episodes || (a.channel ?? "").localeCompare(b.channel ?? "", "ru")),
  };
}

export type StatsPeriodKind = "today" | "yesterday" | "days7" | "days30" | "week" | "month";

const PERIOD_LABELS: Record<StatsPeriodKind, string> = {
  today: "Сегодня", yesterday: "Вчера", days7: "7 дней", days30: "30 дней", week: "Эта неделя", month: "Этот месяц",
};

/** Период для статистики — от полуночи по поясу компании: «Сегодня», «Вчера», «7 дней» и «30 дней» (вместе
 *  с сегодня), «Эта неделя» (с понедельника), «Этот месяц». to — не включая */
export function statsPeriod(kind: StatsPeriodKind, now: When, timeZone?: string | undefined): { from: string; to: string; label: string } {
  const [year, month, d] = dayKey(now, timeZone).split("-").map(Number) as [number, number, number];
  const day = (shift: number) => companyTime({ year, month, day: d + shift }, timeZone);
  // 0 — понедельник, 6 — воскресенье
  const weekday = (new Date(Date.UTC(year, month - 1, d)).getUTCDay() + 6) % 7;
  const [from, to] =
    kind === "today" ? [day(0), day(1)]
    : kind === "yesterday" ? [day(-1), day(0)]
    : kind === "days7" ? [day(-6), day(1)]
    : kind === "days30" ? [day(-29), day(1)]
    : kind === "week" ? [day(-weekday), day(7 - weekday)]
    : [companyTime({ year, month, day: 1 }, timeZone), companyTime({ year, month: month + 1, day: 1 }, timeZone)];
  return { from, to, label: PERIOD_LABELS[kind] };
}

/** Длительность для людей: «45 с», «2 мин 5 с», «1 ч 10 мин», «2 дн 3 ч»; нет значения — «—» */
export function durationText(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return "—";
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} мин ${s % 60} с` : `${m} мин`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} ч ${m % 60} мин` : `${h} ч`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} дн ${h % 24} ч` : `${d} дн`;
}

/* ── Сколько сообщений за период ─────────────────────────────────────────────────────────────────────────────── */

export type MessageCounts = {
  /** Диалогов, где клиент писал за период */
  dialogs: number;
  /** Сообщений клиентов */
  incoming: number;
  /** Наших сообщений клиентам — ушли или уходят (без заметок, служебных, черновиков и недоставленных) */
  outgoing: number;
  /** Из них — бот */
  byBot: number;
  /** Из них — люди */
  byHumans: number;
};

/** Сколько сообщений пришло и ушло за период [from, to). Звонки не в счёт — только переписка */
export function countMessages(
  messages: readonly (EpisodeMessage & { contactId?: string | number | null | undefined })[],
  period: { from: When; to: When }
): MessageCounts {
  const from = ms(period.from);
  const to = ms(period.to);
  const dialogs = new Set<string>();
  const out: MessageCounts = { dialogs: 0, incoming: 0, outgoing: 0, byBot: 0, byHumans: 0 };
  for (const m of messages) {
    const t = Date.parse(m.at);
    if (!(t >= from && t < to) || m.kind !== "message") continue;
    if (m.author.type === "client") {
      out.incoming++;
      dialogs.add(String(m.contactId ?? ""));
      continue;
    }
    if (m.author.type === "system" || m.delivery === "failed" || m.shadow) continue;
    out.outgoing++;
    if (m.author.type === "bot") out.byBot++;
    else out.byHumans++;
  }
  out.dialogs = dialogs.size;
  return out;
}

export type CountsSqlOptions = {
  table: string;
  contactColumn: string;
  timeColumn: string;
  /** Условие для строки x — своя компания: «x.org_id = $1» */
  scope?: string | undefined;
  /** Начало периода (включительно) и конец (не включая) — параметры запроса */
  from: string;
  to: string;
  /** Строка x — сообщение клиента в переписке: «x.direction = 'in' AND x.kind = 'message'» */
  incoming: string;
  /** Строка x — наше сообщение клиенту, которое ушло или уходит: «x.direction = 'out' AND x.delivery IS DISTINCT FROM 'failed'» */
  outgoing: string;
  /** Вид автора строки x словами набора: «x.author» */
  authorType: string;
};

/** То же в SQL: одна строка с колонками dialogs, incoming, outgoing, byBot, byHumans — готовый MessageCounts */
export function messageCountsSql(o: CountsSqlOptions): string {
  const inc = `(${o.incoming})`;
  const out = `(${o.outgoing})`;
  const type = `(${o.authorType})::text`;
  const t = `x.${o.timeColumn}`;
  return `SELECT COUNT(DISTINCT CASE WHEN ${inc} THEN x.${o.contactColumn} END)::int AS "dialogs",`
    + ` (COUNT(*) FILTER (WHERE ${inc}))::int AS "incoming",`
    + ` (COUNT(*) FILTER (WHERE ${out}))::int AS "outgoing",`
    + ` (COUNT(*) FILTER (WHERE ${out} AND ${type} = 'bot'))::int AS "byBot",`
    + ` (COUNT(*) FILTER (WHERE ${out} AND ${type} IN ('operator_crm', 'operator_phone', 'operator_admin')))::int AS "byHumans"`
    + ` FROM ${o.table} x WHERE ${o.scope ? `(${o.scope}) AND ` : ""}${t} >= ${o.from} AND ${t} < ${o.to}`;
}
