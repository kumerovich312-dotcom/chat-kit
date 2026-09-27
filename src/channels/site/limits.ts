/* Ограничение частоты для чата на сайте — счётчики в памяти процесса («окно» в минуту или час на ключ).
   Защищает CRM от заваливания: сотни сообщений в минуту, тысячи новых «посетителей» с одного адреса. Каждый процесс
   сервера считает сам (на нескольких серверах или в serverless предел выходит во столько же раз больше) — от
   случайного и простого баловства этого хватает; серьёзную защиту ставят перед сервером (прокси, WAF). */

export type SiteLimits = {
  /** Сообщений от одного посетителя в минуту */
  visitorMessages: number;
  /** Сообщений с одного адреса IP в минуту (офис за одним адресом — несколько посетителей) */
  ipMessages: number;
  /** Опросов «есть ли ответ» от одного посетителя в минуту: раз в 3 с — 20, несколько вкладок складываются */
  visitorPolls: number;
  /** Новых посетителей с одного адреса IP в час */
  ipSessions: number;
  /** Всех запросов с одного адреса IP в минуту */
  ipRequests: number;
};

export const DEFAULT_SITE_LIMITS: Readonly<SiteLimits> = { visitorMessages: 20, ipMessages: 60, visitorPolls: 60, ipSessions: 30, ipRequests: 600 };

export interface RateLimiter {
  /** Засчитать запрос. 0 — можно; иначе — через сколько секунд можно снова. Предел 0 — без ограничения */
  hit(key: string, limit: number, windowMs: number, now?: number): number;
}

/** Счётчики в памяти. Ключей не больше maxKeys: старые окна выбрасываются */
export function createRateLimiter(maxKeys = 20_000): RateLimiter {
  const windows = new Map<string, { count: number; reset: number }>();

  function sweep(now: number) {
    for (const [k, w] of windows) if (w.reset <= now) windows.delete(k);
    // Всё ещё тесно — выбрасываем самые старые (Map помнит порядок добавления)
    while (windows.size >= maxKeys) {
      const first = windows.keys().next().value;
      if (first === undefined) break;
      windows.delete(first);
    }
  }

  return {
    hit(key, limit, windowMs, now = Date.now()) {
      if (!(limit > 0)) return 0;
      let w = windows.get(key);
      if (!w || w.reset <= now) {
        if (w) windows.delete(key);
        if (windows.size >= maxKeys) sweep(now);
        w = { count: 0, reset: now + windowMs };
        windows.set(key, w);
      }
      if (w.count >= limit) return Math.max(1, Math.ceil((w.reset - now) / 1000));
      w.count++;
      return 0;
    },
  };
}

/** Адрес посетителя: первый из X-Forwarded-For (его ставит прокси перед сервером), иначе X-Real-IP; пусто — не знаем.
 *  Без прокси заголовок может подделать сам посетитель — тогда адрес лучше брать своим способом (опция ip) */
export function clientIp(headers: Record<string, string | undefined>): string {
  const first = (headers["x-forwarded-for"] ?? "").split(",")[0]?.trim() ?? "";
  return (first || headers["x-real-ip"]?.trim() || "").slice(0, 64);
}
