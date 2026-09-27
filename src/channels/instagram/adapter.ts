import { fileKind, fileWords, textIsFileName } from "../../core/files.js";
import { formatForChannel } from "../../core/markup.js";
import type { ApplyContext, ApplySummary, ChannelAdapter, ChannelCaps, ChannelEvent, DownloadResult, Outgoing, ReceiveResult, SendResult, Target, WebhookInput } from "../../server/channel.js";
import { sha1Hex, sha256Hex } from "../../server/crypto.js";
import { fetchFile, MAX_FILE_BYTES } from "../../server/download.js";
import type { ChatStore, WaitChange } from "../../server/store.js";
import { appSecretProof, graphFailure, headerOf, verifyMetaSignature } from "./meta.js";
import { ECHO_EVENT, parseInstagramWebhook, type EchoData } from "./parse.js";
import { splitMessageText } from "./split.js";

/* Подключение Instagram Direct — официальный API сообщений Meta (Instagram Messaging API).

   Два способа подключить аккаунт — у каждого свой адрес API и свой ключ:
   - вход через Instagram (по умолчанию): https://graph.instagram.com/<версия>, ключ аккаунта Instagram (живёт 60 дней,
     продлевается — refreshInstagramToken), страница Facebook не нужна;
   - вход через Facebook: https://graph.facebook.com/<версия>, ключ страницы Facebook, к которой привязан аккаунт.
   Отправка в обоих — POST /me/messages: «me» — тот, чей ключ (аккаунт Instagram или страница).

   Instagram → CRM: вебхук (receive) с подписью X-Hub-Signature-256; адрес проверяется GET-запросом (metaVerifyChallenge).
   CRM → Instagram: текст (до 1000 байт — длинный делим на части) и файлы ссылкой. Правила Instagram:
   - написать первым нельзя: только ответ клиенту, который написал сам;
   - ответить можно в течение 24 часов после последнего сообщения клиента; человек (не бот) — до 7 дней с меткой
     HUMAN_AGENT, если Meta выдала приложению это разрешение (humanAgentTag);
   - сообщения, которые компания отправила из приложения Instagram, приходят «эхом» — пишем их как «менеджер с
     телефона»; эхо наших же сообщений (отправленных через набор) второй раз не записываем. */

export type InstagramOptions = {
  /** Ключ доступа (только из окружения проекта или его базы): аккаунта Instagram или страницы Facebook */
  accessToken: string;
  /** Секрет приложения Meta — им подписаны уведомления. Несколько — на время смены секрета */
  appSecret: string | readonly string[];
  /** Номер профессионального аккаунта Instagram — как в уведомлениях (entry.id; при входе через Instagram — user_id
   *  из GET /me?fields=user_id). Задан — уведомления других аккаунтов пропускаются (одно приложение на несколько
   *  компаний), и по нему узнаются наши сообщения. Отправка всё равно идёт на /me/messages */
  igUserId?: string | undefined;
  /** Адрес Graph API с версией: по умолчанию вход через Instagram (instagramApiBase()) */
  apiBase?: string | undefined;
  /** Ответ человека после 24 часов — ещё раз с меткой HUMAN_AGENT (до 7 дней; нужно разрешение Human Agent от Meta) */
  humanAgentTag?: boolean | undefined;
  /** Спрашивать у Instagram имя и ник клиента (GET /<IGSID>?fields=name,username), помнить сутки. Сбой не мешает приёму */
  fetchProfile?: boolean | undefined;
  /** Подписывать запросы appsecret_proof (если в приложении включено «Требовать секрет приложения») */
  appSecretProof?: boolean | undefined;
  /** Предел одного сообщения в байтах UTF-8 (1000): длиннее — несколько сообщений */
  maxTextBytes?: number | undefined;
  /** Предел скачиваемого файла (10 МБ) */
  maxFileBytes?: number | undefined;
  /** Сколько ждать перед записью эха (3000 мс): за это время проект успевает записать номер сообщения, отправленного
   *  через набор, — и эхо не задвоит его. Ожидание идёт после ответа Instagram (ingest с later: after) */
  echoDelayMs?: number | undefined;
  fetch?: typeof fetch | undefined;
};

/** Версия Graph API. Старую версию Meta со временем переводит на более новую сама; поднимать — вместе с проверкой */
export const INSTAGRAM_GRAPH_VERSION = "v23.0";

/** Адрес Graph API: вход через Instagram — graph.instagram.com, через Facebook — graph.facebook.com */
export function instagramApiBase(login: "instagram" | "facebook" = "instagram", version: string = INSTAGRAM_GRAPH_VERSION): string {
  return `https://graph.${login === "facebook" ? "facebook" : "instagram"}.com/${version}`;
}

export const INSTAGRAM_CAPS: ChannelCaps = { text: true, files: true, pause: false, mute: false, start: false, statuses: true };

const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms: number) => new Date(ms).toISOString();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

/* Память процесса — общая для всех подключений (проект может создавать подключение на каждый запрос) */

/** Наши сообщения, только что отправленные через API (ig:<mid> → когда): их эхо сразу мимо */
const sentKeys = new Map<string, number>();
/** Отправки, которые ещё идут, — по собеседнику: эхо ждёт, пока они вернут номер сообщения */
const sending = new Map<string, Set<Promise<unknown>>>();
/** Ссылки на голосовые (Instagram отдаёт их в mp4 — по содержимому как видео) */
const audioUrls = new Set<string>();
/** Профили клиентов: IGSID → имя и ник (сутки; неудачный запрос — час не повторяем) */
const profiles = new Map<string, { at: number; ok: boolean; name: string | null; username: string | null }>();

function remember<K, V>(map: Map<K, V>, key: K, value: V, max: number) {
  if (map.size >= max) {
    const first = map.keys().next().value;
    if (first !== undefined) map.delete(first);
  }
  map.set(key, value);
}

function sentRecently(key: string): boolean {
  const t = sentKeys.get(key);
  return t !== undefined && Date.now() - t < HOUR;
}

/** Instagram понимает четыре вида вложений: фото (JPG, PNG, GIF), видео, аудио и файл (PDF) */
function attachmentType(mime: string, name: string): "image" | "video" | "audio" | "file" {
  const k = fileKind(mime, name);
  return k === "image" || k === "video" || k === "audio" ? k : "file";
}

type Posted = { ok: true; mid: string | null } | { ok: false; error: string; retryable: boolean; window: boolean };

export type InstagramAdapter = ChannelAdapter & {
  /** Имя и ник клиента у Instagram (с памятью на сутки); null — не удалось */
  profile(igsid: string): Promise<{ name: string | null; username: string | null } | null>;
};

export function createInstagramAdapter(o: InstagramOptions): InstagramAdapter {
  const doFetch = o.fetch ?? fetch;
  const base = (o.apiBase ?? instagramApiBase()).replace(/\/+$/, "");
  const secrets = (typeof o.appSecret === "string" ? [o.appSecret] : [...o.appSecret]).filter(Boolean);
  const proof = o.appSecretProof && secrets[0] ? appSecretProof(o.accessToken, secrets[0]) : null;
  const maxTextBytes = o.maxTextBytes ?? 1000;
  const maxFileBytes = o.maxFileBytes ?? MAX_FILE_BYTES;
  const echoDelayMs = o.echoDelayMs ?? 3000;

  /** Адрес Graph API с параметрами; ключ — в заголовке Authorization, не в адресе (адреса оседают в журналах) */
  const graphUrl = (path: string, params: Record<string, string> = {}) => {
    const u = new URL(base + path);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    if (proof) u.searchParams.set("appsecret_proof", proof);
    return u.href;
  };
  const auth = { authorization: `Bearer ${o.accessToken}` };

  async function post(body: Record<string, unknown>, tagged: boolean): Promise<Posted> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const res = await doFetch(graphUrl("/me/messages"), {
        method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal, cache: "no-store",
      });
      const data = (await res.json().catch(() => null)) as { message_id?: unknown; error?: unknown } | null;
      if (res.ok && !data?.error) return { ok: true, mid: typeof data?.message_id === "string" && data.message_id ? data.message_id : null };
      return { ok: false, ...graphFailure(res.status, data?.error, { tagged }) };
    } catch {
      return { ok: false, error: ctrl.signal.aborted ? "Instagram не ответил за 15 секунд" : "Нет связи с Instagram", retryable: true, window: false };
    } finally {
      clearTimeout(timer);
    }
  }

  async function profile(igsid: string) {
    const hit = profiles.get(igsid);
    if (hit && Date.now() - hit.at < (hit.ok ? 24 * HOUR : HOUR)) return hit.ok ? { name: hit.name, username: hit.username } : null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3_000);
    try {
      const res = await doFetch(graphUrl(`/${encodeURIComponent(igsid)}`, { fields: "name,username" }), { headers: auth, signal: ctrl.signal, cache: "no-store" });
      const d = (await res.json().catch(() => null)) as { name?: unknown; username?: unknown } | null;
      if (!res.ok || !d) throw new Error(`профиль: ${res.status}`);
      const p = {
        name: typeof d.name === "string" && d.name.trim() ? d.name.trim() : null,
        username: typeof d.username === "string" && d.username.trim() ? d.username.trim().replace(/^@/, "") : null,
      };
      remember(profiles, igsid, { at: Date.now(), ok: true, ...p }, 2000);
      return p;
    } catch {
      remember(profiles, igsid, { at: Date.now(), ok: false, name: null, username: null }, 2000);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Имя и ник клиента — в подсказки событий (новому клиенту — сразу с именем) */
  async function addProfiles(events: ChannelEvent[]) {
    const hints = events.flatMap((ev) => ("contact" in ev && ev.contact ? [ev.contact] : []));
    const ids = [...new Set(hints.map((h) => h.externalId))].slice(0, 10);
    const found = new Map(await Promise.all(ids.map(async (id) => [id, await profile(id)] as const)));
    for (const h of hints) {
      const p = found.get(h.externalId);
      if (p?.name) h.name = p.name;
      if (p?.username) h.username = p.username;
    }
  }

  /** Файл по ссылке Instagram (CDN Meta): защиты fetchFile, один повтор при сбое связи; голосовое mp4 — как аудио */
  async function download(url: string): Promise<DownloadResult> {
    let r = await fetchFile(url, { fetch: doFetch, maxBytes: maxFileBytes });
    if (!r.ok && r.reason === "retry") {
      await sleep(1500);
      r = await fetchFile(url, { fetch: doFetch, maxBytes: maxFileBytes });
    }
    if (r.ok && audioUrls.has(url) && r.mime === "video/mp4") return { ...r, mime: "audio/mp4", ext: "m4a" };
    return r;
  }

  /** Эхо — наше сообщение, отправленное через набор? По номеру (память процесса, база проекта), а на «глубокой»
   *  проверке — и по содержимому: недавнее сообщение из CRM с тем же текстом (часть длинного текста тоже) или с файлом.
   *  Так эхо не задвоится, даже если его принял другой процесс сервера или проект ещё не записал номер */
  async function isOurs(store: ChatStore, contactId: string, e: EchoData, now: number, deep: boolean): Promise<boolean> {
    const key = e.message.externalId;
    if (sentRecently(key)) return true;
    if (store.messageExists && (await store.messageExists(key))) return true;
    if (!deep || !store.findMessages) return false;
    const atMs = Date.parse(e.message.at ?? "") || now;
    const text = e.message.text.trim();
    const recent = await store.findMessages(contactId, { lastOutgoing: 20 });
    return recent.some((m) => {
      if (m.author.type === "client" || m.author.type === "operator_phone" || m.author.type === "system") return false;
      const gap = Math.abs(Date.parse(m.at) - atMs);
      if (!text) return !!m.fileId && gap < 2 * MIN;
      if (gap > 10 * MIN) return false;
      const variants = [m.text.trim(), formatForChannel(m.text, "plain").trim()];
      return variants.some((v) => v === text || (text.length >= 20 && v.includes(text)));
    });
  }

  /** Записать эхо: «менеджер с телефона», клиент больше не ждёт ответа. Эхо только с файлом — запись со словами
   *  «Фото», файл встаёт в неё, когда скачается (без updateMessage — отдельным сообщением следом) */
  async function saveEcho(store: ChatStore, contactId: string, e: EchoData, now: number) {
    const m = e.message;
    const atMs = Math.min(Date.parse(m.at ?? "") || now, now);
    const at = iso(atMs);
    const files = m.files ?? [];
    const text = m.text.trim() ? m.text : files.length ? e.placeholder || "Файл" : "";
    if (!text) return;
    const saved = await store.saveMessage(contactId, {
      kind: "message", author: m.author, channel: "instagram", text, at, externalId: m.externalId,
      ...(m.replyTo ? { replyTo: { externalId: m.replyTo.externalId, text: m.replyTo.text ?? null } } : {}),
    });
    if (saved.duplicate) return;
    const wait: WaitChange = { type: "answered", at };
    await store.markWaiting(contactId, wait);
    await store.notify({ contactId, kind: "message", wait });
    for (const [i, f] of files.entries()) {
      const key = `${m.externalId}:file:${i}`;
      if (store.messageExists && (await store.messageExists(key))) continue;
      for (const url of f.urls) {
        const got = await download(url);
        if (!got.ok) continue;
        const name = f.caption?.trim() || fileWords({ mime: got.mime, name: "" });
        const file = await store.saveFile(contactId, {
          data: got.data, mime: got.mime, ext: got.ext, name, sha1: sha1Hex(got.data), sha256: sha256Hex(got.data), sourceUrl: url, fromClient: false,
        });
        if (i === 0 && !m.text.trim() && store.updateMessage) await store.updateMessage({ id: saved.id }, { fileId: file.fileId, text: name });
        else await store.saveMessage(contactId, { kind: "message", author: m.author, channel: "instagram", text: name, at: iso(atMs + i + 1), externalId: key, fileId: file.fileId });
        await store.notify({ contactId, kind: "file" });
        break;
      }
    }
  }

  /** Одно сообщение Instagram. Отказ по правилу 24 часов у ответа человека — ещё раз с меткой HUMAN_AGENT */
  async function deliver(recipient: string, message: Record<string, unknown>, state: { tagged: boolean }, human: boolean): Promise<Posted> {
    const body = (tagged: boolean) => ({ recipient: { id: recipient }, message, ...(tagged ? { messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" } : {}) });
    let r = await post(body(state.tagged), state.tagged);
    if (!r.ok && r.window && !state.tagged && o.humanAgentTag && human) {
      state.tagged = true;
      r = await post(body(true), true);
    }
    if (r.ok && r.mid) remember(sentKeys, `ig:${r.mid}`, Date.now(), 5000);
    return r;
  }

  const adapter: InstagramAdapter = {
    kind: "instagram",
    caps: INSTAGRAM_CAPS,

    async receive(input: WebhookInput): Promise<ReceiveResult> {
      if (input.method.toUpperCase() === "GET") return { ok: false, status: 405, error: "Проверку адреса вебхука (GET) делает metaVerifyChallenge" };
      if (!verifyMetaSignature(secrets, headerOf(input.headers, "x-hub-signature-256"), input.body)) {
        return { ok: false, status: 401, error: "Подпись уведомления неверна (X-Hub-Signature-256): проверьте секрет приложения Meta" };
      }
      let body: unknown;
      try {
        body = JSON.parse(input.body);
      } catch {
        return { ok: false, status: 400, error: "Тело запроса должно быть JSON" };
      }
      const root = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
      if (!root) return { ok: false, status: 400, error: "Тело запроса должно быть JSON-объектом" };
      // Другой продукт Meta на этом адресе (Messenger, WhatsApp) — ответ 200, чтобы Meta не повторяла
      if (root.object !== "instagram") return { ok: false, status: 200, ignored: true, error: `Это уведомление не Instagram (object: ${String(root.object ?? "нет")}) — пропущено` };
      const parsed = parseInstagramWebhook(root, { igUserId: o.igUserId });
      for (const url of parsed.audioUrls) {
        if (audioUrls.size >= 1000) audioUrls.clear();
        audioUrls.add(url);
      }
      // Эхо сообщений, которые этот же сервер только что отправил, — сразу мимо
      const events = parsed.events.filter((ev) => !(ev.type === "custom" && ev.name === ECHO_EVENT && sentRecently((ev.data as EchoData).message.externalId)));
      if (o.fetchProfile) await addProfiles(events);
      return { ok: true, events, meta: { object: "instagram" } };
    },

    async apply(event, ctx: ApplyContext): Promise<ApplySummary> {
      if (event.name !== ECHO_EVENT) return { messageIds: [], added: 0 };
      const e = event.data as EchoData;
      const { store, contactId, now } = ctx;
      if (await isOurs(store, contactId, e, now, false)) return { messageIds: [], added: 0, duplicate: true };
      // Эхо могло прийти раньше, чем отправка вернула номер сообщения, а проект его записал: ждём (после ответа
      // Instagram), пока отправки этому клиенту закончатся, и проверяем ещё раз — уже и по содержимому
      ctx.later(async () => {
        const busy = [...(sending.get(e.recipient) ?? [])];
        await Promise.all([sleep(echoDelayMs), busy.length ? Promise.race([Promise.allSettled(busy), sleep(20_000)]) : null]);
        if (await isOurs(store, contactId, e, now, true)) return;
        await saveEcho(store, contactId, e, now);
      });
      return { messageIds: [], added: 1 };
    },

    async send(to: Target, out: Outgoing): Promise<SendResult> {
      const recipient = String(to.externalId ?? "").trim();
      if (!recipient) return { ok: false, error: "Клиент ещё не писал в Instagram — написать ему первым нельзя" };
      // Ответ с цитатой (out.replyTo) API Instagram не описывает — уходит обычным сообщением
      const human = out.author?.type !== "bot";
      // Ответ бота написан разметкой Markdown — Instagram её не понимает: чистый текст. Человек — как написал
      const text = (human ? out.text : formatForChannel(out.text, "plain")).trim();
      const parts: Record<string, unknown>[] = [];
      if (out.file) {
        if (!out.file.url) {
          return { ok: false, error: "Instagram принимает файл только ссылкой: загрузить сам файл через API нельзя — нужна ссылка без входа (signFileLink)" };
        }
        parts.push({ attachment: { type: attachmentType(out.file.mime, out.file.name), payload: { url: out.file.url } } });
        // Подписи к файлу в Instagram нет — текст уходит следом отдельным сообщением (если это не просто имя файла)
        if (!textIsFileName(text, [{ name: out.file.name }])) for (const t of splitMessageText(text, maxTextBytes)) parts.push({ text: t });
      } else {
        for (const t of splitMessageText(text, maxTextBytes)) parts.push({ text: t });
      }
      if (!parts.length) return { ok: false, error: "Нечего отправить: пустое сообщение" };

      const job = (async (): Promise<SendResult> => {
        const state = { tagged: false };
        let last: string | null = null;
        // По очереди: следующая часть — после ответа Instagram о предыдущей, чтобы у клиента порядок был тот же
        for (const [i, message] of parts.entries()) {
          const r = await deliver(recipient, message, state, human);
          if (!r.ok) {
            if (i === 0) return { ok: false, error: r.error, retryable: r.retryable };
            // Начало уже у клиента: повтор задвоил бы его — не повторяем
            return { ok: false, error: `Ушла только часть сообщения (${i} из ${parts.length}): ${r.error}`, retryable: false };
          }
          last = r.mid ?? last;
        }
        // Номер последней части: Instagram отмечает прочтение последнего сообщения
        return { ok: true, externalId: last ? `ig:${last}` : null };
      })();
      const set = sending.get(recipient) ?? new Set<Promise<unknown>>();
      set.add(job);
      sending.set(recipient, set);
      try {
        return await job;
      } finally {
        set.delete(job);
        if (!set.size) sending.delete(recipient);
      }
    },

    download,
    profile,
  };
  return adapter;
}

export type RefreshResult =
  | { ok: true; accessToken: string; expiresInSec: number | null }
  | { ok: false; error: string; retryable?: boolean | undefined };

/** Продлить долгий ключ входа через Instagram: живёт 60 дней, продлить можно ключ старше суток — например, раз в неделю
 *  по расписанию, новый ключ сохранить у себя. Ключ страницы Facebook (вход через Facebook) продлевать не нужно */
export async function refreshInstagramToken(accessToken: string, o: { fetch?: typeof fetch | undefined; host?: string | undefined } = {}): Promise<RefreshResult> {
  const doFetch = o.fetch ?? fetch;
  const u = new URL(`${(o.host ?? "https://graph.instagram.com").replace(/\/+$/, "")}/refresh_access_token`);
  u.searchParams.set("grant_type", "ig_refresh_token");
  u.searchParams.set("access_token", accessToken);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await doFetch(u.href, { signal: ctrl.signal, cache: "no-store" });
    const d = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown; error?: unknown } | null;
    if (res.ok && typeof d?.access_token === "string" && d.access_token) {
      return { ok: true, accessToken: d.access_token, expiresInSec: typeof d.expires_in === "number" ? d.expires_in : null };
    }
    const f = graphFailure(res.status, d?.error);
    return { ok: false, error: f.error, retryable: f.retryable };
  } catch {
    return { ok: false, error: ctrl.signal.aborted ? "Instagram не ответил за 15 секунд" : "Нет связи с Instagram", retryable: true };
  } finally {
    clearTimeout(timer);
  }
}
