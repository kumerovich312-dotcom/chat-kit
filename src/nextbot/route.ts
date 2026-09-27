import { ingest, type IngestHooks } from "../server/ingest.js";
import { bearerKey, jsonResponse, readWebhook } from "../server/request.js";
import type { ChannelAdapter } from "../server/channel.js";
import type { ChatStore } from "../server/store.js";
import { looksLikeNextbotKey } from "./webhook.js";

/* Приём событий Nextbot одной строкой в маршруте проекта:
     // src/app/api/nextbot/events/route.ts
     export const POST = (req: Request) => handleNextbotRequest(req, (key) => nextbotAccount(key), { later: after });
   Ключ компании — в заголовке «Authorization: Bearer nb_…» (или X-Api-Key); в адресе (?key=) не принимаем. */

export type NextbotAccount = {
  /** Интеграция включена в настройках компании */
  enabled: boolean;
  adapter: ChannelAdapter;
  store: ChatStore;
  hooks?: IngestHooks | undefined;
};

export async function handleNextbotRequest(
  req: Request,
  resolve: (key: string) => Promise<NextbotAccount | null>,
  opts: { later?: ((job: () => Promise<void>) => void) | undefined; maxBytes?: number | undefined } = {}
): Promise<Response> {
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  const key = bearerKey(headers);
  if (!key || !looksLikeNextbotKey(key)) return jsonResponse({ status: 401, body: { ok: false, error: "Нужен ключ: Authorization: Bearer nb_…" } });
  const account = await resolve(key);
  if (!account) return jsonResponse({ status: 401, body: { ok: false, error: "Неверный ключ" } });
  if (!account.enabled) return jsonResponse({ status: 403, body: { ok: false, error: "Интеграция с Nextbot выключена в настройках CRM" } });
  const input = await readWebhook(req, opts.maxBytes ?? 1024 * 1024);
  if (!input) return jsonResponse({ status: 413, body: { ok: false, error: "Слишком большой запрос" } });
  try {
    const r = await ingest(account.adapter, account.store, input, { hooks: account.hooks, later: opts.later });
    return jsonResponse(r);
  } catch (e) {
    console.error("[chat-kit nextbot] ошибка обработки события:", e);
    return jsonResponse({ status: 500, body: { ok: false, error: "Ошибка CRM при обработке события" } });
  }
}

/** GET того же адреса — проверка из браузера или Nextbot: адрес доступен, ключ верный */
export async function nextbotHealth(req: Request, resolve: (key: string) => Promise<{ enabled: boolean } | null>): Promise<Response> {
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  const key = bearerKey(headers);
  if (!key) return jsonResponse({ status: 200, body: { ok: true, service: "приём событий Nextbot", hint: "POST с ключом Authorization: Bearer nb_…" } });
  const s = looksLikeNextbotKey(key) ? await resolve(key) : null;
  if (!s) return jsonResponse({ status: 401, body: { ok: false, error: "Неверный ключ" } });
  return jsonResponse({ status: 200, body: { ok: true, enabled: s.enabled } });
}
