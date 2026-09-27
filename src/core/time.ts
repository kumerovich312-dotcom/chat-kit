/* Время в переписке — всегда по поясу компании (timeZone: «Asia/Bishkek»), а не компьютера или сервера: страница,
   собранная на сервере, и та же страница в браузере показывают одно и то же время. Время сообщения — до секунды. */

const cache = new Map<string, Intl.DateTimeFormat>();

function fmt(timeZone: string | undefined, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${timeZone ?? ""}|${JSON.stringify(opts)}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("ru-RU", timeZone ? { ...opts, timeZone } : opts);
    cache.set(key, f);
  }
  return f;
}

type When = string | number | Date;
const toDate = (v: When): Date => (v instanceof Date ? v : new Date(v));

function parts(v: When, timeZone: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of fmt(timeZone, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(toDate(v))) {
    out[p.type] = p.value;
  }
  return out;
}

/** «14:05:09» — время сообщения до секунды; seconds: false — «14:05» */
export function fmtClock(v: When, timeZone?: string, seconds = true): string {
  const p = parts(v, timeZone);
  return seconds ? `${p.hour}:${p.minute}:${p.second}` : `${p.hour}:${p.minute}`;
}

/** «2026-09-27» — день по поясу компании (для разбивки ленты по дням) */
export function dayKey(v: When, timeZone?: string): string {
  const p = parts(v, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

/** Сколько дней между днями по поясу компании: 0 — тот же день, -1 — вчера */
export function dayDiff(v: When, now: When, timeZone?: string): number {
  const a = Date.parse(`${dayKey(v, timeZone)}T00:00:00Z`);
  const b = Date.parse(`${dayKey(now, timeZone)}T00:00:00Z`);
  return Math.round((a - b) / 86_400_000);
}

/** Подпись дня над сообщениями: «сегодня», «вчера», «27 сентября», в прошлом году — «27 сентября 2025» */
export function dayLabel(v: When, timeZone?: string, now: When = Date.now()): string {
  const diff = dayDiff(v, now, timeZone);
  if (diff === 0) return "сегодня";
  if (diff === -1) return "вчера";
  const [y, m, d] = dayKey(v, timeZone).split("-").map(Number) as [number, number, number];
  const thisYear = Number(dayKey(now, timeZone).slice(0, 4));
  return `${d} ${MONTHS_GEN[m - 1]}${y !== thisYear ? ` ${y}` : ""}`;
}

/** Время в списке диалогов: сегодня — «14:05», вчера — «вчера», раньше — «14 сен» */
export function listTime(v: When, timeZone?: string, now: When = Date.now()): string {
  const diff = dayDiff(v, now, timeZone);
  if (diff === 0) return fmtClock(v, timeZone, false);
  if (diff === -1) return "вчера";
  const [, m, d] = dayKey(v, timeZone).split("-").map(Number) as [number, number, number];
  return `${d} ${MONTHS_SHORT[m - 1]}`;
}

/** «27 сентября, 14:05:09» — полное время для подсказки при наведении и окна просмотра файла */
export function fullTime(v: When, timeZone?: string): string {
  const [, m, d] = dayKey(v, timeZone).split("-").map(Number) as [number, number, number];
  return `${d} ${MONTHS_GEN[m - 1]}, ${fmtClock(v, timeZone)}`;
}

/** «18:30», «завтра 09:00», «14 сен 18:30» — до какого времени (пауза бота) */
export function untilText(v: When, timeZone?: string, now: When = Date.now()): string {
  const d = dayDiff(v, now, timeZone);
  const clock = fmtClock(v, timeZone, false);
  if (d === 0) return clock;
  if (d === 1) return `завтра ${clock}`;
  return `${listTime(v, timeZone, now)} ${clock}`;
}

/** «1:05» — длительность голосового или звонка */
export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
