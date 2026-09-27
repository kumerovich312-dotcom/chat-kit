import { createHmac } from "node:crypto";
import type { WebhookInput } from "../../server/channel.js";
import { safeEqual } from "../../server/crypto.js";

/* Общее для платформы Meta (Instagram, а потом — Messenger и официальный WhatsApp): проверка адреса вебхука (GET
   с hub.challenge), подпись уведомлений X-Hub-Signature-256, ключ appsecret_proof и ошибки Graph API словами.

   Meta присылает уведомления на один адрес проекта:
   - GET — один раз, когда адрес вписывают в кабинете: hub.mode=subscribe, hub.verify_token (слово, которое проект сам
     придумал и вписал в кабинете) и hub.challenge — его надо вернуть как есть, простым текстом;
   - POST — события; тело подписано: «sha256=<hex HMAC-SHA256 от тела ключом — секретом приложения>». */

/** Заголовок без учёта регистра: readWebhook пишет имена маленькими буквами, другой сервер может прислать как есть */
export function headerOf(headers: Record<string, string | undefined>, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === want && v !== undefined) return v;
  return undefined;
}

/** Подпись Meta для тела запроса: «sha256=<hex>» */
export function metaSignature(appSecret: string, body: string): string {
  return `sha256=${createHmac("sha256", appSecret).update(body, "utf8").digest("hex")}`;
}

/** Подпись верна хотя бы для одного секрета (несколько — на время смены секрета приложения). Тело — строго то, что
 *  пришло: после JSON.parse и обратно подпись не сойдётся */
export function verifyMetaSignature(appSecret: string | readonly string[], header: string | undefined, body: string): boolean {
  const got = (header ?? "").trim().toLowerCase();
  if (!/^sha256=[0-9a-f]{64}$/.test(got)) return false;
  const secrets = (typeof appSecret === "string" ? [appSecret] : [...appSecret]).filter((s) => s.length > 0);
  let ok = false;
  // Проверяем все секреты, без выхода на первом совпадении: время ответа не подскажет, какой подошёл
  for (const s of secrets) if (safeEqual(metaSignature(s, body), got)) ok = true;
  return ok;
}

export type MetaVerifyResult = { status: number; body: string };

/** Проверка адреса вебхука (GET). Слово проверки сравнивается за одно и то же время; ответ — hub.challenge простым
 *  текстом (jsonResponse не годится: в JSON строка уйдёт в кавычках, и Meta адрес не примет) */
export function metaVerifyChallenge(input: Pick<WebhookInput, "url">, verifyToken: string): MetaVerifyResult {
  const denied: MetaVerifyResult = { status: 403, body: "Проверка адреса не пройдена: слово проверки (verify token) не совпало" };
  let q: URLSearchParams;
  try {
    q = new URL(input.url ?? "", "http://localhost").searchParams;
  } catch {
    return denied;
  }
  const token = q.get("hub.verify_token") ?? "";
  const challenge = q.get("hub.challenge") ?? "";
  if (q.get("hub.mode") !== "subscribe" || !verifyToken || !challenge || challenge.length > 512) return denied;
  return safeEqual(token, verifyToken) ? { status: 200, body: challenge } : denied;
}

/** То же для маршрута Next.js: export const GET = (req: Request) => metaVerifyResponse(req, слово из окружения) */
export function metaVerifyResponse(req: Request, verifyToken: string): Response {
  const r = metaVerifyChallenge({ url: req.url }, verifyToken);
  return new Response(r.body, { status: r.status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

/** appsecret_proof — подпись ключа доступа секретом приложения. Нужна, если в приложении включено «Требовать
 *  секрет приложения» (Настройки → Дополнительно) */
export function appSecretProof(accessToken: string, appSecret: string): string {
  return createHmac("sha256", appSecret).update(accessToken, "utf8").digest("hex");
}

/* ── Ошибки Graph API ─────────────────────────────────────────────────────────────────────────────────────────
   Meta отвечает { error: { message, type, code, error_subcode, is_transient } }. Сотруднику — коротко по-русски;
   retryable — можно повторить позже (сбой связи, 5xx, «слишком часто»). */

export const IG_ERRORS = {
  window24h: "Прошло больше 24 часов с последнего сообщения клиента — Instagram не даёт написать первым",
  window7d: "Прошло больше 7 дней с последнего сообщения клиента — Instagram не даёт написать, пока клиент не напишет сам",
  token: "Ключ Instagram недействителен или просрочен — получите новый ключ в кабинете Meta и сохраните его в настройках проекта",
  permission: "Приложению Meta не хватает прав на сообщения Instagram (instagram_business_manage_messages или instagram_manage_messages) — проверьте разрешения приложения",
  tag: "Метка HUMAN_AGENT не разрешена приложению — её выдаёт Meta после проверки (разрешение Human Agent); без неё ответить можно только в течение 24 часов",
  unavailable: "Клиент недоступен в Instagram: закрыл сообщения, заблокировал аккаунт компании или удалил свой",
  noUser: "Instagram не нашёл этого клиента — возможно, он удалил аккаунт",
  file: "Instagram не смог забрать файл по ссылке: ссылка должна открываться без входа, файл — фото, видео, аудио или PDF подходящего размера",
  rate: "Instagram просит подождать: слишком много сообщений подряд — повторите через минуту",
  temporary: "Instagram временно не отвечает — повторите чуть позже",
} as const;

export type GraphFailure = {
  error: string;
  retryable: boolean;
  /** Отказ из-за правила 24 часов (или 7 дней с меткой HUMAN_AGENT) */
  window: boolean;
};

/** Лимиты частоты: приложения, пользователя, страницы, аккаунта Instagram */
const RATE_CODES = new Set([4, 17, 32, 613, 80002, 80006]);
/** «Сообщение вне разрешённого окна» */
const WINDOW_SUBCODES = new Set([2018278, 2534022]);
/** «Не удалось забрать вложение по ссылке» */
const FILE_SUBCODES = new Set([2018008, 2018047, 2018294]);

/** Ответ Graph API с ошибкой → причина словами. tagged — запрос уже был с меткой HUMAN_AGENT */
export function graphFailure(httpStatus: number, err: unknown, o: { tagged?: boolean | undefined } = {}): GraphFailure {
  const e = err && typeof err === "object" && !Array.isArray(err) ? (err as Record<string, unknown>) : {};
  const code = Number(e.code) || 0;
  const sub = Number(e.error_subcode) || 0;
  const msg = typeof e.message === "string" ? e.message : "";
  const fail = (error: string, retryable = false, window = false): GraphFailure => ({ error, retryable, window });

  if (WINDOW_SUBCODES.has(sub) || /outside (of )?(the )?allowed (messaging )?window/i.test(msg)) {
    return fail(o.tagged ? IG_ERRORS.window7d : IG_ERRORS.window24h, false, true);
  }
  if (code === 190 || code === 102 || httpStatus === 401) return fail(IG_ERRORS.token);
  if (RATE_CODES.has(code) || httpStatus === 429) return fail(IG_ERRORS.rate, true);
  if (code === 551) return fail(IG_ERRORS.unavailable);
  if (o.tagged && /HUMAN_AGENT|\btag\b/i.test(msg)) return fail(IG_ERRORS.tag);
  if (code === 10 || (code >= 200 && code < 300)) return fail(IG_ERRORS.permission);
  if (sub === 2018001 || /no matching (instagram )?user/i.test(msg)) return fail(IG_ERRORS.noUser);
  if (FILE_SUBCODES.has(sub) || (code === 100 && /attachment|upload/i.test(msg))) return fail(IG_ERRORS.file);
  if (code === 1 || code === 2 || e.is_transient === true || httpStatus >= 500 || httpStatus === 408) return fail(IG_ERRORS.temporary, true);
  const detail = msg ? `: ${msg.slice(0, 200)}` : "";
  return fail(code ? `Instagram не принял сообщение (код ${code}${sub ? `/${sub}` : ""})${detail}` : `Instagram ответил ${httpStatus}${detail}`);
}
