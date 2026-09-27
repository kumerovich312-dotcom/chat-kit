import { metaSignature } from "../../../src/channels/instagram/index.js";
import type { WebhookInput } from "../../../src/server/index.js";

// Поддельная Meta для проверок подключения Instagram: Graph API записывает, что ему прислали, и отвечает как настоящий;
// CDN отдаёт файлы. Номера аккаунтов, ключи и ссылки — вымышленные; настоящая сеть в тестах запрещена (tests/setup.ts).

export const SECRET = "test-secret-not-real-instagram";
export const TOKEN = "test-secret-not-real-ig-token";
export const GRAPH = "https://graph.instagram.com/v23.0";
/** Наш профессиональный аккаунт Instagram (entry.id) */
export const ACCOUNT = "17841400000000001";
export const T = Date.parse("2026-09-27T08:00:00Z");
export const CDN = "https://cdn.ig.test/ig_messaging_cdn/";

export type Call = { url: string; method: string; headers: Headers; body: Record<string, unknown> | null };

export const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

/** mp4 с маркой «isom»: по содержимому — видео (так Instagram отдаёт и голосовые). fill — чтобы файлы различались */
export const mp4 = (fill = 5) => new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0, ...new Array(64).fill(fill)]);

/** reply — свой ответ Graph API на запрос (n — номер запроса по порядку); без него отправка отвечает номером сообщения */
export function fakeMeta(o: { reply?: (call: Call, n: number) => Response | Promise<Response> | null } = {}) {
  const calls: Call[] = [];
  const files = new Map<string, Uint8Array>();
  const gets = new Map<string, number>();
  let n = 0;
  let seq = 0;
  const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://graph.")) {
      const call: Call = { url, method: String(init?.method ?? "GET"), headers: new Headers(init?.headers), body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null };
      calls.push(call);
      const own = await o.reply?.(call, n++);
      if (own) return own;
      if (call.method === "POST") return json({ recipient_id: (call.body?.recipient as { id?: string } | undefined)?.id, message_id: `mid-sent-${++seq}` });
      return json({ error: { message: "Unsupported get request", type: "GraphMethodException", code: 100, error_subcode: 33 } }, 400);
    }
    gets.set(url, (gets.get(url) ?? 0) + 1);
    const data = files.get(url);
    if (!data) return new Response("not found", { status: 404 });
    return new Response(new Blob([new Uint8Array(data)]), { status: 200, headers: { "content-length": String(data.byteLength) } });
  }) as typeof fetch;
  return { fetch: fetchFn, calls, files, gets, posts: () => calls.filter((c) => c.method === "POST") };
}

/** Уведомление с подписью, как его присылает Meta */
export function hook(payload: unknown, secret = SECRET): WebhookInput {
  const body = JSON.stringify(payload);
  return { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": metaSignature(secret, body) }, body, url: "https://crm.example/api/instagram" };
}

/** Уведомление Instagram: одна запись нашего аккаунта со списком событий */
export const webhook = (...messaging: unknown[]) => ({ object: "instagram", entry: [{ id: ACCOUNT, time: T, messaging }] });

/** Сообщение клиента нам */
export const fromClient = (client: string, message: Record<string, unknown>, ts = T) => ({ sender: { id: client }, recipient: { id: ACCOUNT }, timestamp: ts, message });

/** Эхо: сообщение компании клиенту */
export const echoTo = (client: string, message: Record<string, unknown>, ts = T) => ({ sender: { id: ACCOUNT }, recipient: { id: client }, timestamp: ts, message: { is_echo: true, ...message } });
