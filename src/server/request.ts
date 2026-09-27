import type { WebhookInput } from "./channel.js";

/* Связка с веб-запросом (Next.js route handler, любой сервер со стандартными Request / Response). */

/** Запрос → вход для подключения. Тело больше maxBytes (1 МБ — «Полный диалог» длинной переписки весит сотни КБ) — null */
export async function readWebhook(req: Request, maxBytes = 1024 * 1024): Promise<WebhookInput | null> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > maxBytes) return null;
  const body = await req.text();
  if (body.length > maxBytes) return null;
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  return { method: req.method, headers, body, url: req.url };
}

/** Ответ каналу JSON-ом, без кэша */
export function jsonResponse(r: { status: number; body: unknown }): Response {
  return new Response(JSON.stringify(r.body ?? null), {
    status: r.status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** Ключ из заголовка: «Authorization: Bearer …» или «X-Api-Key: …». В адресе (?key=) ключ не принимаем — адреса
 *  оседают в журналах прокси и истории браузера */
export function bearerKey(headers: Record<string, string | undefined>): string {
  const auth = headers["authorization"] ?? headers["Authorization"] ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return (m?.[1] ?? headers["x-api-key"] ?? headers["X-Api-Key"] ?? "").trim();
}
