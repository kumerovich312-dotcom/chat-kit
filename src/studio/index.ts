import { createHmac } from "node:crypto";
import { AUTHOR_TYPES, type AuthorType, type Delivery } from "../core/model.js";
import type { BotCommand, ControlMode } from "../core/conversation.js";
import type { ChannelAdapter, ChannelCaps, ChannelEvent, Outgoing, ReceiveResult, SendResult, Target, WebhookInput } from "../server/channel.js";
import { safeEqual } from "../server/crypto.js";
import type { ContactHint } from "../server/store.js";

/* Подключение «своя студия» (Muras AI Studio) — ЗАГОТОВКА. API студии для CRM ещё нет: он появится на этапе 5 её плана
   (артефакт «ИИ-продажник вместо Nextbot», раздел 10.8). Пути, поля и подпись ниже — по плану; когда студия выпустит
   API, сверить с её API_CONTRACTS и поправить здесь, окно переписки и переходник проекта не меняются.

   Что уже решено в плане:
   - команды: Authorization: Bearer <ключ проекта>, Idempotency-Key у каждой команды (тот же ключ с другим телом — 409);
   - события — вебхуком с подписью X-Signature: t=<время>,v1=<HMAC-SHA256(«t.тело»)>, повторы до суток, события одного
     диалога — по порядку seq, получатель отсекает повторы по event_id;
   - автор сообщения: client / bot / operator_crm / operator_phone / operator_admin / system — те же, что в наборе.
   Не решено (записано в студии как расхождения): суффикс «.v1» у типов событий, snake_case или camelCase, точные значения
   режимов диалога — заготовка принимает оба вида. */

export type StudioOptions = {
  /** Адрес API студии: https://studio.example/v1 */
  baseUrl: string;
  /** Ключ проекта в студии (только из окружения) */
  apiKey: string;
  /** Секрет подписи вебхуков студии */
  webhookSecret: string;
  fetch?: typeof fetch | undefined;
  now?: (() => number) | undefined;
};

/** Общий конверт события студии (план 10.8) */
export type StudioEvent = {
  event_id: string;
  type: string;
  occurred_at: string;
  project_id?: string | undefined;
  conversation_id: string;
  seq?: number | undefined;
  contact?: { id: string; name?: string | null; phone?: string | null; username?: string | null } | undefined;
  channel?: string | undefined;
  data?: Record<string, unknown> | undefined;
};

export const STUDIO_CAPS: ChannelCaps = { text: true, files: true, pause: true, mute: true, start: true, statuses: true };

/** Подпись вебхука: «t=<секунды>,v1=<hex HMAC-SHA256 от "t.тело">» */
export function studioSignature(secret: string, t: number, body: string): string {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

/** Подпись верна и не старше 5 минут (защита от повтора перехваченного запроса) */
export function verifyStudioSignature(secret: string, header: string | undefined, body: string, now = Date.now()): boolean {
  if (!header || !secret) return false;
  const t = Number(header.match(/(?:^|,)\s*t=(\d+)/)?.[1]);
  const v1 = header.match(/(?:^|,)\s*v1=([0-9a-f]+)/i)?.[1];
  if (!Number.isFinite(t) || !v1 || Math.abs(now / 1000 - t) > 300) return false;
  const want = studioSignature(secret, t, body).split("v1=")[1] ?? "";
  return safeEqual(want, v1.toLowerCase());
}

const pick = (o: Record<string, unknown> | undefined, ...keys: string[]): unknown => {
  for (const k of keys) if (o && o[k] !== undefined) return o[k];
  return undefined;
};
const text = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Событие студии → события набора. Тип — без суффикса «.v1»; поля — snake_case или camelCase */
export function studioEvents(ev: StudioEvent): ChannelEvent[] {
  const type = ev.type.replace(/\.v\d+$/, "");
  const d = ev.data ?? {};
  const hint: ContactHint = {
    source: "studio", externalId: ev.contact?.id ?? ev.conversation_id, channel: ev.channel ?? "nextbot",
    phone: ev.contact?.phone ?? null, phoneTrusted: ev.channel === "whatsapp", name: ev.contact?.name ?? null, username: ev.contact?.username ?? null,
  };
  switch (type) {
    case "message.created": {
      const at = text(pick(d, "author_type", "authorType"));
      const author: AuthorType = at && (AUTHOR_TYPES as readonly string[]).includes(at) ? (at as AuthorType) : "client";
      const files = (pick(d, "attachments") as { url?: string; name?: string }[] | undefined) ?? [];
      return [{
        type: "message", contact: hint,
        message: {
          externalId: `studio:${text(pick(d, "message_id", "messageId")) ?? ev.event_id}`,
          at: text(pick(d, "provider_ts", "providerTs")) ?? ev.occurred_at,
          author: { type: author, name: text(pick(d, "author_name", "authorName")) },
          text: text(pick(d, "text")) ?? "",
          files: files.filter((f) => typeof f.url === "string").map((f) => ({ urls: [f.url!], caption: f.name ?? null })),
          handoff: pick(d, "handoff") === true,
          shadow: pick(d, "is_shadow", "isShadow") === true,
          replyTo: text(pick(d, "reply_to", "replyTo")),
        },
      }];
    }
    case "message.status": {
      const status = text(pick(d, "status"));
      const map: Record<string, Delivery> = { queued: "pending", sent: "sent", delivered: "delivered", read: "read", failed: "failed" };
      const delivery = status ? map[status] : undefined;
      const id = text(pick(d, "message_id", "messageId"));
      return delivery && id ? [{ type: "status", externalId: `studio:${id}`, delivery, error: text(pick(d, "error", "reason")) }] : [];
    }
    case "conversation.state_changed": {
      const raw = text(pick(d, "control_mode", "controlMode")) ?? "bot";
      const mode: ControlMode = raw === "manager" || raw === "muted" ? raw : "bot";
      return [{ type: "state", contact: hint, mode, pausedUntil: text(pick(d, "paused_until", "pausedUntil")), reason: text(pick(d, "reason")) }];
    }
    case "handoff.requested":
      return [{
        type: "handoff", contact: hint, reason: text(pick(d, "reason")), summary: text(pick(d, "summary")),
        fields: (pick(d, "fields") as Record<string, string> | undefined) ?? {},
      }];
    case "lead.captured":
    case "lead.updated":
      return [{ type: "lead", contact: hint, fields: (pick(d, "fields") as Record<string, string | number | null> | undefined) ?? {} }];
    default:
      // conversation.created, contact.memory_updated, channel.status_changed, bot.error — пока только обновить экраны
      return [{ type: "custom", name: `studio:${type}`, contact: hint, data: ev }];
  }
}

export type StudioAdapter = ChannelAdapter & {
  /** Заметка боту: контекст разговора, клиент её не видит */
  note(conversationId: string, text: string, key: string): Promise<SendResult>;
};

export function createStudioAdapter(o: StudioOptions): StudioAdapter {
  const doFetch = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const base = o.baseUrl.replace(/\/+$/, "");

  async function command(method: string, path: string, body: unknown, idempotencyKey: string): Promise<SendResult> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const res = await doFetch(base + path, {
        method, signal: ctrl.signal, cache: "no-store",
        headers: { "content-type": "application/json", authorization: `Bearer ${o.apiKey}`, "idempotency-key": idempotencyKey },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { data?: { id?: string; message_id?: string }; error?: { messageRu?: string; code?: string } };
      if (!res.ok) {
        return { ok: false, error: data.error?.messageRu ?? `Студия ответила ${res.status}`, retryable: res.status === 408 || res.status === 429 || res.status >= 500 };
      }
      return { ok: true, externalId: data.data?.message_id ?? data.data?.id ?? null };
    } catch {
      return { ok: false, error: ctrl.signal.aborted ? "Студия не ответила за 15 секунд" : "Нет связи со студией", retryable: true };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    kind: "studio",
    caps: STUDIO_CAPS,

    receive(input: WebhookInput): ReceiveResult {
      if (!verifyStudioSignature(o.webhookSecret, input.headers["x-signature"], input.body, now())) return { ok: false, status: 401, error: "Подпись вебхука неверна" };
      let ev: StudioEvent;
      try { ev = JSON.parse(input.body) as StudioEvent; } catch { return { ok: false, status: 400, error: "Тело запроса должно быть JSON" }; }
      if (!ev?.type || !ev.conversation_id || !ev.event_id) return { ok: false, status: 422, error: "Нет типа, диалога или номера события" };
      return { ok: true, events: studioEvents(ev), meta: { event: ev.type, eventId: ev.event_id } };
    },

    async apply() {
      // Служебные события студии — только обновить экраны (ingest сообщает вкладкам сам)
      return { messageIds: [], added: 0 };
    },

    send(to: Target, out: Outgoing) {
      const key = out.idempotencyKey ?? `msg:${out.messageId ?? `${to.externalId}:${now()}`}`;
      return command("POST", `/conversations/${encodeURIComponent(to.externalId)}/messages`, {
        text: out.text,
        attachments: out.file?.url ? [{ url: out.file.url, name: out.file.name, mime: out.file.mime }] : [],
        author: { type: "operator", name: out.author?.name ?? null, external_id: out.author?.id ?? null },
      }, key);
    },

    control(to: Target, cmd: BotCommand) {
      const key = `${cmd.type}:${to.externalId}:${Math.floor(now() / 1000)}`;
      const conv = `/conversations/${encodeURIComponent(to.externalId)}`;
      const contact = `/contacts/${encodeURIComponent(to.contactId ?? to.externalId)}`;
      switch (cmd.type) {
        case "pause": return command("POST", `${conv}/pause`, { hours: cmd.hours ?? null, until: cmd.until ?? null, reason: cmd.reason ?? null }, key);
        case "resume": return command("POST", `${conv}/resume`, {}, key);
        case "mute": return command("POST", `${contact}/mute`, {}, key);
        case "unmute": return command("POST", `${contact}/unmute`, {}, key);
      }
    },

    note: (conversationId, text, key) => command("POST", `/conversations/${encodeURIComponent(conversationId)}/notes`, { text }, key),
  };
}
