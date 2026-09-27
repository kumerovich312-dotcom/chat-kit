import { plural } from "../core/text.js";

/* Запрос к поставщику ИИ: ограничение по времени, ответ целиком строкой, ошибки — словами для сотрудника. Коды ответа
   у Claude и у сервисов с API как у OpenAI одни и те же: 401/403 — ключ, 429 — слишком много запросов, 5xx и 529 —
   сбой или перегрузка у поставщика (стоит повторить). Подробность поставщика (по-английски) — в detail: её видно
   в «не принял запрос» и по ней поставщик решает, повторить ли запрос иначе. */

export type ServiceNames = {
  /** Кто: «ИИ», «Сервис расшифровки» */
  who: string;
  /** Чей: «ИИ», «сервиса расшифровки» */
  of: string;
  /** С кем: «ИИ», «сервисом расшифровки» */
  with: string;
};

export type ServiceReply =
  | { ok: true; status: number; body: string; type: string }
  | { ok: false; status: number | null; error: string; retryable: boolean; detail: string };

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const str =(v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** Ошибка в теле ответа: у Claude {type: "error", error: {type, message}}, у OpenAI {error: {message, type, code}} */
function apiError(body: string): { type: string; message: string; code: string } {
  try {
    const j = JSON.parse(body) as { error?: unknown; message?: unknown };
    const e = j.error && typeof j.error === "object" ? (j.error as { type?: unknown; message?: unknown; code?: unknown }) : null;
    return { type: str(e?.type), message: str(e?.message) || str(j.error) || str(j.message), code: str(e?.code) };
  } catch {
    return { type: "", message: "", code: "" };
  }
}

/** Код ответа поставщика → фраза для сотрудника и «стоит ли повторить» */
export function describeHttpError(status: number, body: string, n: ServiceNames, model: string): { error: string; retryable: boolean; detail: string } {
  const e = apiError(body);
  const detail = oneLine(e.message || body).slice(0, 300);
  const said = `${e.type} ${e.code} ${e.message}`.toLowerCase();
  const fail = (error: string, retryable = false) => ({ error, retryable, detail });
  // Деньги кончились: Claude — 402 или «credit balance is too low», OpenAI — 429 с кодом insufficient_quota (повтор не поможет)
  if (status === 402 || /billing|credit balance|insufficient_quota|exceeded your current quota/.test(said)) {
    return fail(`Закончились деньги на счёте ${n.of} — пополните баланс у поставщика`);
  }
  if (status === 401 || status === 403) return fail(`Ключ ${n.of} не подходит — проверьте настройки проекта`);
  if (status === 404) return fail(`${n.who}: модель «${model}» не найдена — проверьте название модели и адрес в настройках проекта`);
  if (status === 413) return fail(`Слишком большой запрос для ${n.of} — сократите текст или запись`);
  if (status === 429) return fail(`${n.who} перегружен запросами — повторите через минуту`, true);
  if (status === 529 || status === 503 || /overloaded/.test(said)) return fail(`${n.who} сейчас перегружен — повторите чуть позже`, true);
  if (status === 408 || status === 504) return fail(`${n.who} не успел ответить — попробуйте ещё раз`, true);
  if (status >= 500) return fail(`Сбой на стороне ${n.of} (${status}) — повторите чуть позже`, true);
  if (status === 400 || status === 422) return fail(`${n.who} не принял запрос: ${clip(detail, 200) || status}`);
  return fail(`${n.who} ответил ошибкой ${status}`);
}

/** Запрос к поставщику: не дольше timeoutMs (вместе с чтением ответа); сбой связи и молчание — повторяемые ошибки */
export async function callService(
  doFetch: typeof fetch, url: string, init: RequestInit, timeoutMs: number, names: ServiceNames, model: string
): Promise<ServiceReply> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await doFetch(url, { ...init, signal: ctrl.signal, cache: "no-store" });
    const body = await res.text();
    if (!res.ok) return { ok: false, status: res.status, ...describeHttpError(res.status, body, names, model) };
    return { ok: true, status: res.status, body, type: res.headers.get("content-type") ?? "" };
  } catch {
    if (ctrl.signal.aborted) {
      const s = Math.max(1, Math.round(timeoutMs / 1000));
      return { ok: false, status: null, error: `${names.who} не ответил за ${s} ${plural(s, "секунду", "секунды", "секунд")} — попробуйте ещё раз`, retryable: true, detail: "timeout" };
    }
    return { ok: false, status: null, error: `Нет связи с ${names.with} — попробуйте ещё раз`, retryable: true, detail: "network" };
  } finally {
    clearTimeout(timer);
  }
}
