import { fileWords } from "../core/files.js";
import type { ControlMode } from "../core/conversation.js";
import type { ApplyContext, ChannelAdapter, ChannelEvent, IncomingCall, IngestSummary, IncomingMessage, RemoteFile, WebhookInput } from "./channel.js";
import { sha1Hex, sha256Hex } from "./crypto.js";
import { fetchFile, MAX_FILE_BYTES } from "./download.js";
import type { ChatStore, ContactHint, WaitChange } from "./store.js";

/* Приём уведомления канала целиком: подключение разбирает запрос в события (receive), набор раскладывает их через
   переходник проекта: клиент → сообщение без повторов → «ждёт ответа» → сообщить вкладкам. Файлы скачиваются после
   ответа каналу (later): фото качается секунду и дольше, а канал ждать не должен (иначе +1–2 с к каждому сообщению).
   Особые события подключения (custom — «Полный диалог» Nextbot) раскладывает само подключение (apply). */

export type IngestHooks = {
  /** Клиент найден или заведён — например, проект заводит новому обращению заявку. Вернуть можно что угодно для ответа каналу */
  onContact?(ctx: { contactId: string; created: boolean; hint: ContactHint; event: ChannelEvent }): Promise<Record<string, unknown> | void>;
  /** Заявка, собранная ботом */
  onLead?(ctx: { contactId: string; hint: ContactHint; fields: Record<string, string | number | null> }): Promise<void>;
  /** Функция бота (свободное время записи, наличие товара): ответ текстом — его прочитает бот */
  onFunction?(name: string, args: Record<string, string | null>): Promise<{ text: string; count?: number } | null>;
  /** Кто ведёт диалог: пауза бота, «не отвечать» */
  onState?(ctx: { contactId: string; mode: ControlMode; pausedUntil: string | null; reason: string | null }): Promise<void>;
  /** Бот позвал человека */
  onHandoff?(ctx: { contactId: string; reason: string | null; summary: string | null; fields: Record<string, string> }): Promise<void>;
};

export type IngestOptions = {
  hooks?: IngestHooks | undefined;
  /** Выполнить после ответа каналу (Next.js: after из next/server). Без него — сразу, до ответа */
  later?: ((job: () => Promise<void>) => void) | undefined;
  now?: (() => number) | undefined;
  /** Скачанный файл больше этого не сохраняем */
  maxFileBytes?: number | undefined;
};

export type IngestResult = { status: number; body: unknown; summary: IngestSummary };

export async function ingest(adapter: ChannelAdapter, store: ChatStore, input: WebhookInput, opts: IngestOptions = {}): Promise<IngestResult> {
  const now = opts.now ?? Date.now;
  const jobs: (() => Promise<void>)[] = [];
  const later = (job: () => Promise<void>) => { jobs.push(job); };
  const summary: IngestSummary = { ok: true, status: "ok", messageIds: [] };

  const received = await adapter.receive(input);
  if (received.meta) summary.meta = received.meta;
  if (!received.ok) {
    summary.ok = false;
    summary.status = received.ignored ? "ignored" : "error";
    summary.error = received.error;
    return finish(adapter, summary, received.status);
  }

  let fresh = 0;
  let dups = 0;
  for (const ev of received.events) {
    switch (ev.type) {
      case "ping":
        break;
      case "function": {
        const r = (await opts.hooks?.onFunction?.(ev.name, ev.args)) ?? null;
        summary.functionResult = { name: ev.name, text: r?.text ?? "", count: r?.count };
        break;
      }
      case "refresh":
        summary.contactId = ev.contactId;
        await store.notify({ contactId: ev.contactId, kind: "message" });
        break;
      case "status":
        await store.updateMessage?.({ externalId: ev.externalId }, { delivery: ev.delivery, deliveryError: ev.error ?? null });
        await store.notify({ contactId: null, kind: "status" });
        break;
      default: {
        const hint = "contact" in ev ? ev.contact : undefined;
        if (!hint) break;
        const contact = await store.findOrCreateContact(hint);
        summary.contactId = contact.contactId;
        summary.createdContact = (summary.createdContact ?? false) || contact.created;
        const extra = await opts.hooks?.onContact?.({ contactId: contact.contactId, created: contact.created, hint, event: ev });
        if (extra) summary.extra = { ...summary.extra, ...extra };

        if (ev.type === "message") {
          const r = await saveIncoming(adapter, store, contact.contactId, hint, ev.message, now(), later, opts.maxFileBytes);
          if (r.duplicate) dups++;
          else { fresh++; summary.messageIds.push(r.id); }
        } else if (ev.type === "notice") {
          const r = await store.saveMessage(contact.contactId, {
            kind: "system", author: { type: "system" }, channel: hint.channel, text: ev.text, at: new Date(now()).toISOString(), externalId: ev.key,
          });
          if (!r.duplicate) { summary.messageIds.push(r.id); await store.notify({ contactId: contact.contactId, kind: "message" }); }
        } else if (ev.type === "state") {
          await opts.hooks?.onState?.({ contactId: contact.contactId, mode: ev.mode, pausedUntil: ev.pausedUntil ?? null, reason: ev.reason ?? null });
          await store.notify({ contactId: contact.contactId, kind: "state" });
        } else if (ev.type === "handoff") {
          await opts.hooks?.onHandoff?.({ contactId: contact.contactId, reason: ev.reason ?? null, summary: ev.summary ?? null, fields: ev.fields ?? {} });
          const wait: WaitChange = { type: "handoff", at: new Date(now()).toISOString() };
          await store.markWaiting(contact.contactId, wait);
          await store.notify({ contactId: contact.contactId, kind: "state", wait });
        } else if (ev.type === "call") {
          const r = await saveCall(adapter, store, contact.contactId, hint, ev.call, now(), later, opts.maxFileBytes);
          if (r.duplicate) dups++;
          else { fresh++; summary.messageIds.push(r.id); }
        } else if (ev.type === "lead") {
          await opts.hooks?.onLead?.({ contactId: contact.contactId, hint, fields: ev.fields });
          await store.notify({ contactId: contact.contactId, kind: "message" });
        } else if (ev.type === "custom" && adapter.apply) {
          const ctx: ApplyContext = {
            store, contactId: contact.contactId, created: contact.created, contactName: contact.name ?? null, contactChannel: contact.channel ?? null,
            now: now(), later,
          };
          const r = await adapter.apply(ev, ctx);
          summary.messageIds.push(...r.messageIds);
          if (r.duplicate) dups++;
          else fresh += Math.max(1, r.added);
        }
      }
    }
  }
  if (dups > 0 && fresh === 0 && summary.messageIds.length === 0) summary.status = "duplicate";

  // Файлы — после ответа каналу; без later — сразу (скрипты, проверки)
  if (jobs.length) {
    const run = async () => { for (const job of jobs) { try { await job(); } catch (e) { console.error("[chat-kit] файл не забран:", e); } } };
    if (opts.later) opts.later(run);
    else await run();
  }
  return finish(adapter, summary, summary.ok ? 200 : 422);
}

function finish(adapter: ChannelAdapter, summary: IngestSummary, status: number): IngestResult {
  const r = adapter.respond?.(summary, status) ?? {
    status,
    body: { ok: summary.ok, status: summary.status, error: summary.error, contact_id: summary.contactId, message_ids: summary.messageIds },
  };
  return { status: r.status, body: r.body, summary };
}

/** Сообщение канала: записать, отметить ожидание, сообщить вкладкам; файлы — в очередь после ответа */
async function saveIncoming(
  adapter: ChannelAdapter, store: ChatStore, contactId: string, hint: ContactHint, m: IncomingMessage, now: number,
  later: (job: () => Promise<void>) => void, maxBytes: number | undefined
): Promise<{ id: string; duplicate: boolean }> {
  const at = m.at && Number.isFinite(Date.parse(m.at)) ? new Date(Math.min(Date.parse(m.at), now)).toISOString() : new Date(now).toISOString();
  const files = m.files ?? [];
  const onlyFiles = !m.text.trim() && files.length > 0;
  let saved = { id: "", duplicate: false };
  if (!onlyFiles) {
    saved = await store.saveMessage(contactId, {
      kind: "message", author: m.author, channel: hint.channel, text: m.text, at, externalId: m.externalId,
      handoff: m.handoff, shadow: m.shadow,
      ...(m.subject ? { subject: m.subject } : {}),
      ...(m.replyTo ? { replyTo: { externalId: m.replyTo.externalId, text: m.replyTo.text ?? null } } : {}),
    });
    if (saved.duplicate) return saved;
  }
  const fromClient = m.author.type === "client";
  const wait: WaitChange | undefined = m.shadow ? undefined
    : fromClient ? { type: "client_wrote", at } : m.handoff ? { type: "handoff", at } : { type: "answered", at };
  if (wait) await store.markWaiting(contactId, wait);
  await store.notify({ contactId, kind: "message", wait });
  files.forEach((f, i) => {
    later(() => attachFile(adapter, store, contactId, hint, m, f, i, Date.parse(at) + i + 1, fromClient, maxBytes));
  });
  return saved.id ? saved : { id: `${m.externalId}:file`, duplicate: false };
}

/** Забрать файл сообщения: первая ссылка, где он нашёлся; сообщение с ним встаёт сразу за своим сообщением */
async function attachFile(
  adapter: ChannelAdapter, store: ChatStore, contactId: string, hint: ContactHint, m: IncomingMessage, f: RemoteFile, index: number,
  atMs: number, fromClient: boolean, maxBytes: number | undefined
): Promise<void> {
  const externalId = `${m.externalId}:file:${index}`;
  if (store.messageExists && (await store.messageExists(externalId))) return;
  for (const url of f.urls) {
    const got = adapter.download ? await adapter.download(url) : await fetchFile(url, { maxBytes: maxBytes ?? MAX_FILE_BYTES });
    if (!got.ok) continue;
    const name = f.caption?.trim() || fileWords({ mime: got.mime, name: "" });
    const saved = await store.saveFile(contactId, {
      data: got.data, mime: got.mime, ext: got.ext, name, sha1: sha1Hex(got.data), sha256: sha256Hex(got.data), sourceUrl: url, fromClient,
    });
    await store.saveMessage(contactId, {
      kind: "message", author: m.author, channel: hint.channel, text: f.caption?.trim() || name, at: new Date(atMs).toISOString(),
      externalId, fileId: saved.fileId,
    });
    await store.notify({ contactId, kind: "file" });
    return;
  }
}

/** Звонок: строка в ленте сразу, запись разговора — после ответа телефонии. Пропущенный входящий — клиент ждёт ответа,
 *  состоявшийся разговор — ответ; пропущенный исходящий ожидание не меняет */
async function saveCall(
  adapter: ChannelAdapter, store: ChatStore, contactId: string, hint: ContactHint, c: IncomingCall, now: number,
  later: (job: () => Promise<void>) => void, maxBytes: number | undefined
): Promise<{ id: string; duplicate: boolean }> {
  const at = c.at && Number.isFinite(Date.parse(c.at)) ? new Date(Math.min(Date.parse(c.at), now)).toISOString() : new Date(now).toISOString();
  const author = c.direction === "in" ? { type: "client" as const } : { type: "operator_phone" as const, name: c.manager ?? null };
  const call = { direction: c.direction, missed: !!c.missed, durationSec: c.durationSec ?? null, manager: c.manager ?? null };
  const saved = await store.saveMessage(contactId, {
    kind: "call", author, channel: "call", text: callText(c), at, externalId: c.externalId, call,
  });
  if (saved.duplicate) return saved;
  const wait: WaitChange | undefined = c.missed ? (c.direction === "in" ? { type: "client_wrote", at } : undefined) : { type: "answered", at };
  if (wait) await store.markWaiting(contactId, wait);
  await store.notify({ contactId, kind: "message", wait });
  const record = c.record;
  if (record && record.urls.length) {
    later(async () => {
      for (const url of record.urls) {
        const got = adapter.download ? await adapter.download(url) : await fetchFile(url, { maxBytes: maxBytes ?? MAX_FILE_BYTES });
        if (!got.ok) continue;
        const file = await store.saveFile(contactId, {
          data: got.data, mime: got.mime, ext: got.ext, name: record.caption?.trim() || "Запись разговора", sha1: sha1Hex(got.data),
          sha256: sha256Hex(got.data), sourceUrl: url, fromClient: c.direction === "in",
        });
        if (store.updateMessage) await store.updateMessage({ id: saved.id }, { fileId: file.fileId });
        else {
          await store.saveMessage(contactId, {
            kind: "call", author, channel: "call", text: "Запись разговора", at: new Date(Date.parse(at) + 1).toISOString(),
            externalId: `${c.externalId}:record`, fileId: file.fileId, call,
          });
        }
        await store.notify({ contactId, kind: "file" });
        return;
      }
    });
  }
  return saved;
}

/** «Входящий звонок, 3 мин 05 с», «Пропущенный звонок» */
export function callText(c: Pick<IncomingCall, "direction" | "missed" | "durationSec">): string {
  if (c.missed) return c.direction === "in" ? "Пропущенный звонок" : "Не дозвонились";
  const head = c.direction === "in" ? "Входящий звонок" : "Исходящий звонок";
  const sec = Math.max(0, Math.round(c.durationSec ?? 0));
  if (!sec) return head;
  const m = Math.floor(sec / 60);
  const rest = String(sec % 60).padStart(2, "0");
  return m ? `${head}, ${m} мин ${rest} с` : `${head}, ${sec} с`;
}
