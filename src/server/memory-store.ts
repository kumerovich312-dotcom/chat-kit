import type { ChatMessage } from "../core/model.js";
import { sortMessages } from "../core/order.js";
import { samePhone } from "../core/phone.js";
import { waitSince } from "../core/waiting.js";
import type { ChatStore, ContactHint, KeyValue, LiveEvent, MessagePatch, MessageQuery, NewFile, NewMessage, StoredMessage, WaitChange } from "./store.js";

/* Переходник «в памяти» — образец для проектов и основа проверок и демо-страницы. Настоящий проект делает то же самое
   запросами к своей базе (например, таблицы clients / messages / files). */

export type MemoryContact = {
  id: string;
  name: string;
  phone: string | null;
  channel: string;
  /** Адреса у подключений: «telegram:100000001», «green-api:996555000001@c.us» */
  identities: string[];
  dismissedAt: string | null;
};

export type MemoryFile = Omit<NewFile, "data"> & { id: string; contactId: string; size: number; data: Uint8Array };

export type MemoryStore = ChatStore & {
  contacts: Map<string, MemoryContact>;
  messages: ChatMessage[];
  files: Map<string, MemoryFile>;
  events: LiveEvent[];
  waits: { contactId: string; change: WaitChange }[];
  /** Сообщения клиента по порядку */
  thread(contactId: string): ChatMessage[];
  /** С какого времени клиент ждёт ответа — по правилу ядра */
  waitingSince(contactId: string): string | null;
};

export function createMemoryStore(opts: { countryCode?: string; fileUrl?: (id: string) => string } = {}): MemoryStore {
  const contacts = new Map<string, MemoryContact>();
  const messages: ChatMessage[] = [];
  const files = new Map<string, MemoryFile>();
  const events: LiveEvent[] = [];
  const waits: { contactId: string; change: WaitChange }[] = [];
  const kv = new Map<string, string>();
  const byExternal = new Map<string, ChatMessage & { contactId: string }>();
  const owner = new Map<string, string>();
  let seq = 0;
  const fileUrl = opts.fileUrl ?? ((id: string) => `/files/${id}`);

  const state: KeyValue = {
    async get(key) { return kv.get(key) ?? null; },
    async set(key, value) { kv.set(key, value); },
  };

  // Цитата: исходное сообщение по номеру у канала — если оно у нас есть, берём его номер, автора и текст
  const quoteOf = (q: NonNullable<NewMessage["replyTo"]>): NonNullable<ChatMessage["replyTo"]> => {
    const orig = q.externalId ? byExternal.get(q.externalId) : q.id ? messages.find((x) => x.id === q.id) : undefined;
    if (!orig) return q;
    const a = orig.attachments?.[0];
    return { id: orig.id, externalId: orig.externalId ?? null, author: orig.author, text: orig.text, ...(a ? { attachment: { name: a.name, mime: a.mime } } : {}) };
  };

  const store: MemoryStore = {
    contacts, messages, files, events, waits,

    async findOrCreateContact(hint: ContactHint) {
      const identity = `${hint.source}:${hint.externalId}`;
      const ref = (c: MemoryContact, created: boolean) => ({ contactId: c.id, created, name: c.name, channel: c.channel });
      for (const c of contacts.values()) {
        if (!c.identities.includes(identity)) continue;
        if (hint.phone && !c.phone) c.phone = hint.phone;
        if (hint.channel && hint.channel !== "nextbot" && c.channel === "nextbot") c.channel = hint.channel;
        return ref(c, false);
      }
      // Подлинный телефон (WhatsApp) — привязываем к клиенту с тем же номером, у которого ещё нет диалога этого подключения
      if (hint.phone && hint.phoneTrusted) {
        for (const c of contacts.values()) {
          if (c.phone && samePhone(c.phone, hint.phone, opts.countryCode ?? "") && !c.identities.some((x) => x.startsWith(`${hint.source}:`))) {
            c.identities.push(identity);
            return ref(c, false);
          }
        }
      }
      const id = String(contacts.size + 1);
      const c: MemoryContact = {
        id, name: hint.name?.trim() || (hint.username ? `@${hint.username.replace(/^@/, "")}` : "Клиент"), phone: hint.phone ?? null,
        channel: hint.channel, identities: [identity], dismissedAt: null,
      };
      contacts.set(id, c);
      return ref(c, true);
    },

    async saveMessage(contactId: string, m: NewMessage) {
      if (m.externalId) {
        const dup = byExternal.get(m.externalId);
        if (dup) return { id: dup.id, duplicate: true };
      }
      const id = String(++seq);
      const file = m.fileId ? files.get(m.fileId) : undefined;
      const msg: ChatMessage = {
        id, at: m.at, kind: m.kind, author: m.author, channel: m.channel, text: m.text,
        ...(m.subject ? { subject: m.subject } : {}),
        ...(m.externalId ? { externalId: m.externalId } : {}),
        ...(m.delivery ? { delivery: m.delivery } : {}),
        ...(m.deliveryError ? { deliveryError: m.deliveryError } : {}),
        ...(m.handoff ? { handoff: true } : {}),
        ...(m.shadow ? { shadow: true } : {}),
        ...(m.replyTo ? { replyTo: quoteOf(m.replyTo) } : {}),
        ...(m.call ? { call: m.call } : {}),
        ...(m.card ? { card: m.card } : {}),
        ...(file ? { attachments: [{ id: file.id, name: file.name, mime: file.mime, size: file.size, url: fileUrl(file.id) }] } : {}),
      };
      messages.push(msg);
      owner.set(id, contactId);
      if (m.externalId) byExternal.set(m.externalId, { ...msg, contactId });
      return { id, duplicate: false };
    },

    async saveFile(contactId: string, f: NewFile) {
      // Тот же файл (по содержимому) у клиента уже есть — второй раз не храним
      for (const x of files.values()) if (x.contactId === contactId && x.sha256 === f.sha256) return { fileId: x.id };
      const id = `f${files.size + 1}`;
      files.set(id, { ...f, id, contactId, size: f.data.byteLength });
      return { fileId: id };
    },

    async markWaiting(contactId: string, change: WaitChange) {
      waits.push({ contactId, change });
    },

    notify(event: LiveEvent) {
      events.push(event);
    },

    async messageExists(externalId: string) {
      const m = byExternal.get(externalId);
      return m ? { id: m.id, contactId: m.contactId } : null;
    },

    async findMessages(contactId: string, q: MessageQuery): Promise<StoredMessage[]> {
      const mine = sortMessages(messages.filter((m) => owner.get(m.id) === contactId));
      const out = new Map<string, StoredMessage>();
      const pick = (m: ChatMessage) => out.set(m.id, {
        id: m.id, at: m.at, author: m.author, text: m.text, externalId: m.externalId ?? null, fileId: m.attachments?.[0]?.id ?? null,
        delivery: m.delivery ?? null,
      });
      const ext = new Set(q.externalIds ?? []);
      const texts = new Set(q.outgoingTexts ?? []);
      for (const m of mine) {
        if (m.externalId && ext.has(m.externalId)) pick(m);
        if (m.author.type !== "client" && m.kind === "message" && texts.has(m.text)) pick(m);
      }
      if (q.lastOutgoing) for (const m of mine.filter((x) => x.author.type !== "client" && x.kind === "message").slice(-q.lastOutgoing)) pick(m);
      return [...out.values()];
    },

    async updateMessage(ref, patch: MessagePatch) {
      const m = "id" in ref ? messages.find((x) => x.id === ref.id) : messages.find((x) => x.externalId === ref.externalId);
      if (!m) return;
      if (patch.author) m.author = patch.author;
      if (patch.handoff !== undefined) m.handoff = patch.handoff;
      if (patch.text !== undefined) m.text = patch.text;
      if (patch.delivery) m.delivery = patch.delivery;
      if (patch.deliveryError !== undefined) m.deliveryError = patch.deliveryError;
      if (patch.externalId) m.externalId = patch.externalId;
      if (patch.fileId) {
        const file = files.get(patch.fileId);
        if (file) m.attachments = [{ id: file.id, name: file.name, mime: file.mime, size: file.size, url: fileUrl(file.id) }];
      }
    },

    state,

    thread(contactId: string) {
      return sortMessages(messages.filter((m) => owner.get(m.id) === contactId));
    },

    waitingSince(contactId: string) {
      return waitSince(store.thread(contactId), contacts.get(contactId)?.dismissedAt ?? null);
    },
  };
  return store;
}
