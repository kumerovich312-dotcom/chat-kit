import type { DialogStatus, Presence } from "./conversation.js";
import { dayDiff, dayKey, fmtClock } from "./time.js";

/* Работа команды с диалогами — без базы и без React: статус и «отложить до», раздача новых диалогов по очереди,
   метки, «коллега уже отвечает». Проект хранит у себя статус, когда его поставили, до какого времени отложен,
   ответственного и метки; набор даёт правила и слова. Для списка из тысяч диалогов статус считает база —
   effectiveStatusSql (то же правило, совпадение проверено на Postgres). Подробно — docs/TEAM.md. */

type When = string | number | Date;

const ms = (v: When | null | undefined): number =>
  v === null || v === undefined ? NaN : v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(v);

const HOUR = 3_600_000;

/* ── Статус диалога ───────────────────────────────────────────────────────────────────────────────────────────── */

/** Статус, как его хранит проект у диалога */
export type StatusState = {
  /** Открыт, отложен, закрыт; не задан — открыт */
  status?: DialogStatus | null | undefined;
  /** Когда статус поставили: клиент написал позже — диалог снова открыт */
  statusAt?: When | null | undefined;
  /** До какого времени отложен; не задано — пока клиент не напишет */
  snoozedUntil?: When | null | undefined;
};

/** Статус диалога сейчас:
 *  - отложенный снова открыт, когда пришло время (now >= snoozedUntil) или клиент написал после того, как отложили;
 *  - закрытый снова открыт, когда клиент написал после закрытия.
 *  «Клиент написал» — время его последнего сообщения или пропущенного звонка (lastClientAt из stats.ts или своя
 *  колонка). Время статуса не известно — по сообщениям клиента диалог не открываем. */
export function effectiveStatus(s: StatusState, ctx: { now: When; lastClientAt?: When | null | undefined }): DialogStatus {
  const status = s.status ?? "open";
  if (status !== "snoozed" && status !== "closed") return "open";
  if (ms(ctx.lastClientAt) > ms(s.statusAt)) return "open";
  if (status === "closed") return "closed";
  return ms(ctx.now) >= ms(s.snoozedUntil) ? "open" : "snoozed";
}

export type StatusSqlOptions = {
  /** Статус: колонка «c.status» со значениями 'open' | 'snoozed' | 'closed' (NULL — открыт) или своё выражение,
   *  если проект хранит статус иначе: «CASE c.state WHEN 2 THEN 'closed' … END» */
  status: string;
  /** Когда поставили статус: «c.status_at» */
  statusAt: string;
  /** До какого времени отложен: «c.snoozed_until» */
  snoozedUntil: string;
  /** Последнее сообщение клиента: своя колонка «c.last_client_at» или подзапрос lastClientAtSql(…) */
  lastClientAt: string;
  /** «Сейчас»: по умолчанию now() */
  now?: string | undefined;
};

/** Выражение «статус сейчас» ('open' | 'snoozed' | 'closed', текстом) — для списка диалогов, вкладок «Открытые /
 *  Отложенные / Закрытые» и счётчиков. То же правило, что effectiveStatus (проверено на Postgres,
 *  tests/core/team.test.ts). Внутри — только имена из настроек проекта, не данные пользователя: подставлять можно. */
export function effectiveStatusSql(o: StatusSqlOptions): string {
  const status = `(${o.status})::text`;
  const clientAfter = `(${o.lastClientAt}) > (${o.statusAt})`;
  return `(CASE WHEN ${status} = 'snoozed' AND (${clientAfter} OR (${o.snoozedUntil}) <= (${o.now ?? "now()"})) THEN 'open'`
    + ` WHEN ${status} = 'closed' AND ${clientAfter} THEN 'open'`
    + ` WHEN ${status} IN ('snoozed', 'closed') THEN ${status} ELSE 'open' END)`;
}

/* ── «Отложить до» ───────────────────────────────────────────────────────────────────────────────────────────── */

export type SnoozeChoice = {
  /** Вариант: 1h, 3h, evening, tomorrow, monday, week */
  key: "1h" | "3h" | "evening" | "tomorrow" | "monday" | "week";
  /** Надпись в меню: «На 1 час», «До вечера (18:00)» */
  label: string;
  /** До какого времени отложить — точное время (ISO) */
  until: string;
  /** Подсказка рядом: «до 18:00», «до завтра 9:00», «до 3 окт 9:00» */
  hint: string;
};

/** Часы компании в момент t: год, месяц, день, час, минута, секунда */
function wall(t: number, timeZone: string | undefined) {
  const [y, mo, d] = dayKey(t, timeZone).split("-").map(Number) as [number, number, number];
  const [h, mi, s] = fmtClock(t, timeZone).split(":").map(Number) as [number, number, number];
  return { y, mo, d, h, mi, s };
}

/** Точный момент для времени по часам компании. День может «переполниться» (32 сентября — это 2 октября);
 *  переход на летнее время учтён: смещение пояса проверяется второй раз уже для найденного момента */
function atWall(y: number, mo: number, d: number, h: number, mi: number, s: number, timeZone: string | undefined): number {
  const want = Date.UTC(y, mo - 1, d, h, mi, s);
  const offset = (t: number) => {
    const w = wall(t, timeZone);
    return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(t / 1000) * 1000;
  };
  const first = offset(want);
  const second = offset(want - first);
  return want - (first === second ? first : second);
}

/** Точное время (ISO) для времени по часам компании: companyTime({ year: 2026, month: 10, day: 12, hour: 15 },
 *  "Asia/Bishkek") → «2026-10-12T09:00:00.000Z». День и месяц могут выходить за край: день 0 — последний день
 *  прошлого месяца, месяц 13 — январь следующего года */
export function companyTime(
  p: { year: number; month: number; day: number; hour?: number | undefined; minute?: number | undefined; second?: number | undefined },
  timeZone?: string | undefined
): string {
  return new Date(atWall(p.year, p.month, p.day, p.hour ?? 0, p.minute ?? 0, p.second ?? 0, timeZone)).toISOString();
}

/** Варианты «Отложить» с точным временем по поясу компании: «На 1 час», «На 3 часа», «До вечера (18:00)» (только до
 *  18:00), «Завтра утром (9:00)», «В понедельник (9:00)» (не в воскресенье — тогда это то же, что «завтра утром»),
 *  «Через неделю» (в то же время по часам компании). Часы утра и вечера можно поменять. */
export function snoozeChoices(
  now: When,
  timeZone?: string | undefined,
  o: { morningHour?: number | undefined; eveningHour?: number | undefined } = {}
): SnoozeChoice[] {
  const t = ms(now);
  if (!Number.isFinite(t)) return [];
  const morning = o.morningHour ?? 9;
  const evening = o.eveningHour ?? 18;
  const w = wall(t, timeZone);
  const out: SnoozeChoice[] = [];
  const add = (key: SnoozeChoice["key"], label: string, until: number) => {
    out.push({ key, label, until: new Date(until).toISOString(), hint: untilLabel(until, t, timeZone) });
  };
  add("1h", "На 1 час", t + HOUR);
  add("3h", "На 3 часа", t + 3 * HOUR);
  const eveningAt = atWall(w.y, w.mo, w.d, evening, 0, 0, timeZone);
  if (t < eveningAt) add("evening", `До вечера (${evening}:00)`, eveningAt);
  add("tomorrow", `Завтра утром (${morning}:00)`, atWall(w.y, w.mo, w.d + 1, morning, 0, 0, timeZone));
  // День недели по календарю компании: 0 — воскресенье, 1 — понедельник
  const weekday = new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay();
  const toMonday = weekday === 0 ? 1 : 8 - weekday;
  if (toMonday > 1) add("monday", `В понедельник (${morning}:00)`, atWall(w.y, w.mo, w.d + toMonday, morning, 0, 0, timeZone));
  add("week", "Через неделю", atWall(w.y, w.mo, w.d + 7, w.h, w.mi, w.s, timeZone) + (t % 1000));
  return out;
}

const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

/** До какого времени отложен — по поясу компании: «до 18:00», «до завтра 9:00», «до 3 окт 9:00», в другом году —
 *  «до 3 янв 2027 9:00» */
export function untilLabel(until: When, now: When, timeZone?: string | undefined): string {
  if (!Number.isFinite(ms(until)) || !Number.isFinite(ms(now))) return "";
  const [hh, mm] = fmtClock(until, timeZone, false).split(":");
  const clock = `${Number(hh)}:${mm}`;
  const diff = dayDiff(until, now, timeZone);
  if (diff === 0) return `до ${clock}`;
  if (diff === 1) return `до завтра ${clock}`;
  const [y, m, d] = dayKey(until, timeZone).split("-").map(Number) as [number, number, number];
  const year = y !== Number(dayKey(now, timeZone).slice(0, 4)) ? ` ${y}` : "";
  return `до ${d} ${MONTHS_SHORT[m - 1]}${year} ${clock}`;
}

/* ── Раздача новых диалогов ──────────────────────────────────────────────────────────────────────────────────── */

/** Сотрудник, которому можно дать диалог */
export type AssignCandidate = {
  id: string;
  name: string;
  /** Принимает новые диалоги (на смене); не задано — да */
  active?: boolean | null | undefined;
  /** Сколько диалогов у него сейчас в работе */
  load?: number | null | undefined;
  /** Предел диалогов в работе; не задан — без предела */
  max?: number | null | undefined;
  /** Какие каналы ведёт: ["whatsapp", "telegram"]; не задано или пусто — все */
  channels?: readonly string[] | null | undefined;
};

export type AssignOptions<T extends AssignCandidate> = {
  /** Сотрудники в постоянном порядке (например, по номеру) — по нему идёт очередь */
  candidates: readonly T[];
  /** Кому дали прошлый новый диалог */
  lastId?: string | null | undefined;
  /** round — по очереди (по умолчанию), least — у кого меньше диалогов в работе */
  strategy?: "round" | "least" | undefined;
  /** Канал нового диалога */
  channel?: string | null | undefined;
};

/** Кому дать новый диалог; null — некому (никого на смене, все заняты или канал никто не ведёт — диалог ждёт в общей
 *  очереди). Пропускаем тех, кто не на смене, у кого диалогов уже столько, сколько можно (load >= max), и кто не ведёт
 *  этот канал.
 *  - round: следующий после lastId по порядку списка, по кругу (lastId нет в списке — с начала списка);
 *  - least: у кого меньше диалогов в работе; при равенстве — тот, чья очередь ближе (после lastId по кругу).
 *  Результат зависит только от входа: одни и те же данные — тот же сотрудник. */
export function pickAssignee<T extends AssignCandidate>(o: AssignOptions<T>): T | null {
  const list = o.candidates;
  const n = list.length;
  if (!n) return null;
  const channel = o.channel?.trim().toLowerCase() || null;
  const fits = (c: T) =>
    c.active !== false
    && !(typeof c.max === "number" && (c.load ?? 0) >= c.max)
    && (!channel || !c.channels?.length || c.channels.some((x) => x.trim().toLowerCase() === channel));
  const last = o.lastId === null || o.lastId === undefined ? -1 : list.findIndex((c) => c.id === o.lastId);
  // Очередь: сначала те, кто после последнего назначенного, в конце — он сам
  const queue: T[] = [];
  for (let i = 1; i <= n; i++) {
    const c = list[(last + i + n) % n]!;
    if (fits(c)) queue.push(c);
  }
  const first = queue[0];
  if (!first || o.strategy !== "least") return first ?? null;
  let best = first;
  for (const c of queue) if ((c.load ?? 0) < (best.load ?? 0)) best = c;
  return best;
}

/* ── Метки ───────────────────────────────────────────────────────────────────────────────────────────────────── */

/** Метка из паспорта проекта: код хранится у диалога, надпись и цвет — в паспорте. ProfileTag паспорта подходит
 *  (у него вместо color — tone) */
export type TagDef = { code: string; label: string; color?: string | null | undefined };

const tagCode = (code: string | null | undefined) => (code ?? "").trim().toLowerCase();

/** Коды меток для записи в базу: без пробелов по краям, строчными буквами, без повторов и пустых; порядок — как
 *  пришли */
export function normalizeTagCodes(codes: Iterable<string | null | undefined> | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of codes ?? []) {
    const code = tagCode(raw);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

/** Метка по коду; null — такой нет в паспорте (удалили): показать код как есть или скрыть — решает окно */
export function tagOf<T extends TagDef>(code: string, defs: readonly T[]): T | null {
  const c = tagCode(code);
  return (c && defs.find((d) => tagCode(d.code) === c)) || null;
}

/** Коды меток в порядке паспорта; неизвестные — в конце по алфавиту. Повторы убраны */
export function sortTags(codes: Iterable<string | null | undefined> | null | undefined, defs: readonly TagDef[]): string[] {
  const place = new Map<string, number>();
  defs.forEach((d, i) => {
    const c = tagCode(d.code);
    if (c && !place.has(c)) place.set(c, i);
  });
  return normalizeTagCodes(codes).sort((a, b) => {
    const pa = place.get(a);
    const pb = place.get(b);
    if (pa !== undefined && pb !== undefined) return pa - pb;
    if (pa !== undefined) return -1;
    if (pb !== undefined) return 1;
    return a.localeCompare(b, "ru");
  });
}

/* ── «Коллега уже отвечает» ──────────────────────────────────────────────────────────────────────────────────── */

export type PresenceOptions = {
  now: When;
  /** Кто смотрит — себя не показываем */
  meId?: string | null | undefined;
  /** Отметка без обновления дольше этого — человек ушёл: по умолчанию минута */
  ttlMs?: number | undefined;
  /** «Пишет ответ» без новых отметок дольше этого — уже просто смотрит: по умолчанию 10 с */
  typingTtlMs?: number | undefined;
};

/** Кто из коллег сейчас в диалоге: без себя и без устаревших отметок, по одному на человека (последняя отметка),
 *  пишущие — первыми, дальше по имени */
export function activePresence(list: readonly Presence[], o: PresenceOptions): Presence[] {
  const now = ms(o.now);
  const ttl = o.ttlMs ?? 60_000;
  const typingTtl = o.typingTtlMs ?? 10_000;
  const byUser = new Map<string, { p: Presence; t: number }>();
  for (const p of list) {
    if (o.meId !== null && o.meId !== undefined && p.userId === o.meId) continue;
    const t = ms(p.at);
    if (!(now - t <= ttl)) continue;
    const state: Presence["state"] = p.state === "typing" && now - t <= typingTtl ? "typing" : "viewing";
    const prev = byUser.get(p.userId);
    if (prev && (prev.t > t || (prev.t === t && prev.p.state === "typing"))) continue;
    byUser.set(p.userId, { p: { ...p, state }, t });
  }
  return [...byUser.values()]
    .map((x) => x.p)
    .sort((a, b) => (a.state === b.state ? 0 : a.state === "typing" ? -1 : 1) || a.name.localeCompare(b.name, "ru") || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
}

/** «Айгерим», «Айгерим и Бакыт», «Айгерим, Бакыт и Чолпон», «Айгерим, Бакыт и ещё 2» */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} и ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} и ${names[2]}`;
  return `${names[0]}, ${names[1]} и ещё ${names.length - 2}`;
}

/** Подпись над полем ввода: «Айгерим пишет ответ…», «Айгерим и Бакыт смотрят этот диалог»; кто пишет — важнее тех,
 *  кто смотрит. null — никого. Список — уже отобранный activePresence */
export function presenceText(list: readonly Presence[]): string | null {
  const names = (state: Presence["state"]) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of list) {
      if (p.state !== state || seen.has(p.userId)) continue;
      seen.add(p.userId);
      out.push(p.name.trim() || "Коллега");
    }
    return out;
  };
  const typing = names("typing");
  if (typing.length) return `${joinNames(typing)} ${typing.length === 1 ? "пишет" : "пишут"} ответ…`;
  const viewing = names("viewing");
  if (viewing.length) return `${joinNames(viewing)} ${viewing.length === 1 ? "смотрит" : "смотрят"} этот диалог`;
  return null;
}
