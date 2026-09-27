import { isChatChannel } from "../../core/channels.js";
import type { Author } from "../../core/model.js";
import type { ApplyContext, ApplySummary, ChannelAdapter, ChannelCaps, DownloadResult, IngestSummary, Outgoing, ReceiveResult, SendResult, Target, WebhookInput } from "../../server/channel.js";
import { sha1Hex, sha256Hex } from "../../server/crypto.js";
import { fetchFile, isPrivateHost } from "../../server/download.js";
import type { ChatStore, ContactHint, NewMessage, WaitChange } from "../../server/store.js";
import { mediaCandidates, mediaFolders, mediaRef, mediaText, mediaTitle, type MediaRef } from "./media.js";
import { kvMedia, memoryMedia, type NextbotMedia } from "./media-store.js";
import { blank, isHandoff, nextbotTime, parseDialogDump, parseEvent, type ParsedEvent } from "./parse.js";
import { planDump, type PlannedMedia } from "./plan.js";
import { webhookUrlProblem } from "./webhook.js";

/* Подключение Nextbot — перенесено из Атласа (src/lib/nextbot.ts), отделено от его базы: всё, что Атлас делал запросами,
   идёт через переходник проекта (ChatStore) и маленькое хранилище подключения (NextbotMedia).

   Nextbot → CRM: POST с ключом (handleNextbotRequest), события client_message / bot_message / manager_message / lead /
   vacancies / ping. CRM → Nextbot: «Ссылка вебхука» — forwarded_output (клиенту), output (заметка боту, клиент не видит),
   notification (служебная отметка). Написать первым клиенту, который не писал в Nextbot, нельзя.

   Обходы Nextbot живут только здесь: разбор «Полного диалога», угадывание времени (поле time, пояс по разнице часов)
   и автора (Nextbot подписывает одинаково и бота, и менеджера с телефона). */

export type NextbotSettings = {
  /** Интеграция включена */
  enabled: boolean;
  /** «Ссылка вебхука» Nextbot — куда слать ответы менеджеров (https на *.nextbot.ru) */
  webhookUrl: string | null;
  /** Заметка боту при первом ответе менеджера за 6 часов, чтобы не перебивал; {менеджер} — имя */
  managerNote?: string | null | undefined;
  /** Телефонный код страны компании («+996»): номер, написанный боту по-местному, приводим к международному */
  phoneCode?: string | undefined;
  /** Только стенд проверок: любые адреса вебхука и поддельное хранилище файлов на этом компьютере */
  allowAnyWebhook?: boolean | undefined;
};

export type NextbotLogEntry = {
  direction: "in" | "out";
  kind: string;
  status: string;
  dialogId?: string | null | undefined;
  contactId?: string | null | undefined;
  httpStatus?: number | null | undefined;
  error?: string | null | undefined;
  payload?: unknown;
};

export type NextbotOptions = {
  settings: NextbotSettings;
  /** Переходник — для заметки боту при первом ответе менеджера (проверить, писал ли менеджер за 6 часов) */
  store?: ChatStore | undefined;
  /** Хранилище подключения: какие ссылки на файлы уже забраны, папки хранилища, были ли события бота.
   *  Не задано — в store.state, а без него — в памяти процесса */
  media?: NextbotMedia | undefined;
  /** Есть ли клиенту куда положить файл (у Атласа файл лежит в сделке). Нет — строка-файл остаётся текстом */
  canStoreFiles?: ((contactId: string) => Promise<boolean>) | undefined;
  /** Журнал обмена («Настройки → Nextbot»): что пришло и что ушло */
  log?: ((e: NextbotLogEntry) => Promise<void> | void) | undefined;
  fetch?: typeof fetch | undefined;
  now?: (() => number) | undefined;
};

export const NEXTBOT_CAPS: ChannelCaps = { text: true, files: true, pause: false, mute: false, start: false, statuses: false };

/** Заметка боту по умолчанию (как в Атласе) */
export const DEFAULT_MANAGER_NOTE =
  "Менеджер {менеджер} подключился к диалогу и отвечает клиенту сам. Не отвечай клиенту, пока менеджер ведёт разговор; если клиент спросит — скажи, что менеджер скоро ответит.";

export type NextbotPayload = {
  dialog_id: number | string;
  text?: string | undefined;
  message_type: "forwarded_output" | "output" | "notification";
  message_id?: string | undefined;
  content_type?: "text" | "image" | "document" | "audio" | undefined;
  image_url?: string | undefined;
  document_url?: string | undefined;
};

const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** Ссылки, где файла нет или он не подходит, — час не пробуем снова (в памяти процесса) */
const badUrls = new Map<string, number>();
/** Ссылки, которые сейчас скачиваются: следующее событие с той же ссылкой (Nextbot пришлёт её снова через секунду) не
 *  должно скачать файл второй раз */
const inFlight = new Set<string>();

function rememberBad(url: string) {
  if (badUrls.size >= 1000) {
    const first = badUrls.keys().next().value;
    if (first !== undefined) badUrls.delete(first);
  }
  badUrls.set(url, Date.now());
}

export type NextbotAdapter = ChannelAdapter & {
  /** Заметка боту (клиент её не видит) */
  note(dialogId: string, text: string, contactId?: string): Promise<SendResult>;
  /** Служебная отметка в диалоге: смена этапа сделки */
  notification(dialogId: string, text: string, contactId?: string): Promise<SendResult>;
  /** Проверка связи из настроек: отметка «Проверка связи с CRM» в диалоге */
  test(dialogId: string): Promise<SendResult>;
  /** Отправить готовый пакет (для особых случаев) */
  post(payload: NextbotPayload, kind: string, contactId?: string | null, logText?: string): Promise<{ ok: boolean; error: string | null; httpStatus: number | null }>;
};

export function createNextbotAdapter(o: NextbotOptions): NextbotAdapter {
  const s = o.settings;
  const now = o.now ?? Date.now;
  const doFetch = o.fetch ?? fetch;
  const testHosts = () => (s.allowAnyWebhook ? ["127.0.0.1", "localhost"] : []);
  const mediaFor = (store: ChatStore): NextbotMedia => o.media ?? (store.state ? kvMedia(store.state) : memoryMedia);
  const log = (e: NextbotLogEntry) => {
    try { void Promise.resolve(o.log?.(e)).catch(() => {}); } catch { /* журнал не мешает приёму */ }
  };

  async function post(payload: NextbotPayload, kind: string, contactId: string | null = null, logText?: string) {
    const body = { ...payload, dialog_id: /^\d+$/.test(String(payload.dialog_id)) ? Number(payload.dialog_id) : payload.dialog_id };
    let httpStatus: number | null = null;
    let error: string | null = webhookUrlProblem(s.webhookUrl, s.allowAnyWebhook);
    if (!error && s.webhookUrl) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10_000);
      try {
        // Без перенаправлений: ссылка из настроек не должна уводить запрос во внутреннюю сеть сервера
        const res = await doFetch(s.webhookUrl, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal, redirect: "manual", cache: "no-store",
        });
        httpStatus = res.status;
        if (res.status >= 300 && res.status < 400) error = `Nextbot ответил перенаправлением (${res.status}) — проверьте ссылку вебхука`;
        else if (!res.ok) error = `Nextbot ответил ${res.status}`;
        await res.body?.cancel().catch(() => {});
      } catch {
        error = ctrl.signal.aborted ? "Nextbot не ответил за 10 секунд" : "Нет связи с Nextbot";
      } finally {
        clearTimeout(timer);
      }
    }
    log({ direction: "out", kind, status: error ? "error" : "ok", dialogId: String(payload.dialog_id), contactId, httpStatus, error, payload: logText === undefined ? body : { ...body, text: logText } });
    return { ok: !error, error, httpStatus };
  }

  async function download(url: string): Promise<DownloadResult> {
    const extra = testHosts();
    return fetchFile(url, { fetch: doFetch, allowHost: (h) => !isPrivateHost(h) || extra.includes(h) });
  }

  /** Файлы из Nextbot — скачиваем себе (ссылки временные, а фото паспорта или договор должны остаться у компании) и
   *  показываем вложением на своём месте. Знакомую ссылку не скачиваем: Nextbot шлёт ссылку на последнее фото клиента
   *  в каждом событии. Тот же файл по другой ссылке узнаём по содержимому */
  async function saveMedia(store: ChatStore, contactId: string, channel: string, outAuthor: Author, items: PlannedMedia[]) {
    const media = mediaFor(store);
    let changed = 0;
    for (const it of items) {
      const locked: string[] = [];
      try {
        const known = await media.lookup(contactId, it.urls);
        // Пока ждали очереди, файл забрало соседнее событие
        if ([...known.values()].some((x) => x.fileId)) continue;
        let got: Extract<DownloadResult, { ok: true }> | null = null;
        let gotUrl = "";
        let busy = false;
        let transient = false;
        for (const url of it.urls) {
          const key = `${contactId}|${url}`;
          if (inFlight.has(key)) { busy = true; break; }
          const bad = badUrls.get(url);
          if (bad !== undefined && Date.now() - bad < HOUR) continue;
          if (known.has(url)) continue;
          inFlight.add(key);
          locked.push(key);
          const f = await download(url);
          if (!f.ok) {
            if (f.reason === "retry") { transient = true; continue; }
            rememberBad(url);
            // Чужой тип или слишком большой — навсегда (404 бывает у фото, которое искали не в той папке, — только в памяти)
            if (f.reason === "bad") await media.remember(url, null, null);
            continue;
          }
          got = f;
          gotUrl = url;
          break;
        }
        if (busy) continue;
        const author: Author = it.out ? outAuthor : { type: "client" };
        if (!got) {
          // Файла нет ни по одной ссылке: строка дампа остаётся текстом (при сбое связи — попробуем в следующий раз)
          if (!transient && it.eid && it.text !== undefined) {
            const r = await store.saveMessage(contactId, { kind: "message", author, channel, text: it.text, at: iso(it.at), externalId: it.eid });
            if (!r.duplicate) changed++;
          }
          continue;
        }
        const hash = sha1Hex(got.data);
        const hashKey = `sha1:${contactId}:${hash}`;
        const same = (await media.lookup(contactId, [hashKey])).get(hashKey);
        if (same?.fileId) {
          await media.remember(gotUrl, same.fileId, same.at);
          continue;
        }
        const ref: MediaRef = it.ref ?? { url: gotUrl, file: gotUrl.split("?")[0]?.split("/").pop() ?? "", caption: null };
        const title = mediaTitle(ref, got.mime, got.ext, it.out);
        const text = mediaText(ref, got.mime, title);
        const file = await store.saveFile(contactId, {
          data: got.data, mime: got.mime, ext: got.ext, name: title, sha1: hash, sha256: sha256Hex(got.data), sourceUrl: gotUrl, fromClient: !it.out,
        });
        if (it.convertId && store.updateMessage) {
          await store.updateMessage({ id: it.convertId }, { fileId: file.fileId, text });
        } else {
          await store.saveMessage(contactId, {
            kind: "message", author, channel, text, at: iso(it.at), externalId: it.eid ?? `nb:file:${contactId}:${hash}`, fileId: file.fileId,
          });
        }
        await media.remember(gotUrl, file.fileId, iso(it.at));
        await media.remember(hashKey, file.fileId, iso(it.at));
        changed++;
      } catch (e) {
        console.error("[chat-kit nextbot] не удалось забрать файл:", e);
      } finally {
        for (const k of locked) inFlight.delete(k);
      }
    }
    if (changed) await store.notify({ contactId, kind: "file" });
  }

  const adapter: NextbotAdapter = {
    kind: "nextbot",
    caps: NEXTBOT_CAPS,

    receive(input: WebhookInput): ReceiveResult {
      let body: unknown;
      try {
        body = input.body ? JSON.parse(input.body) : {};
      } catch {
        return { ok: false, status: 400, error: "Тело запроса должно быть JSON" };
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, status: 400, error: "Тело запроса должно быть JSON-объектом" };
      const b = body as Record<string, unknown>;
      const ev = parseEvent(b, s.phoneCode ?? "");
      const meta = { event: ev.kind, dialogId: ev.dialogId, payload: b };
      if (ev.kind === "ping") return { ok: true, events: [{ type: "ping" }], meta };
      // Функция «Найти вакансии»: бот спрашивает данные у CRM — номер диалога не нужен
      if (ev.kind === "vacancies") {
        return {
          ok: true, meta,
          events: [{ type: "function", name: "vacancies", args: { profession: blank(ev.lead.profession), country: blank(ev.lead.country), city: blank(ev.lead.city), query: ev.query } }],
        };
      }
      // Тестовый чат Nextbot (окно проверки бота в конструкторе) — не клиент: в CRM не попадает
      if (ev.testChat) return { ok: false, status: 200, ignored: true, error: "Тестовый чат Nextbot — в CRM не попадает", meta };
      if (!ev.dialogId) {
        // Кнопка «Тестировать» в Nextbot подставляет во все переменные «test value» — это не ошибка настройки
        const isTestRun = JSON.stringify(b).toLowerCase().includes("test value");
        const error = isTestRun
          ? "Это проверка из редактора Nextbot: вместо переменных подставлено «test value». Напишите боту настоящее сообщение — тогда придут реальные данные"
          : "Нет номера диалога: пришлите dialog_id или «Ссылку на диалог» — поля, которые пришли, видны в журнале";
        return { ok: false, status: 422, error, meta };
      }
      if (ev.kind !== "lead" && !ev.text && !ev.dump && ev.attachments.length === 0) {
        return { ok: false, status: 200, ignored: true, error: "Нет текста сообщения: проверьте, в каком поле Nextbot передаёт текст (поля запроса — в журнале)", meta };
      }
      const hint: ContactHint = {
        source: "nextbot", externalId: ev.dialogId, channel: ev.channel, phone: ev.phone,
        // Телефон Nextbot передаёт только из WhatsApp — там он подлинный; в Instagram и Telegram его называет собеседник
        phoneTrusted: ev.channel === "whatsapp", name: ev.name, username: ev.username,
      };
      if (ev.kind === "lead") {
        const l = ev.lead;
        return {
          ok: true, meta,
          events: [{ type: "lead", contact: hint, fields: { ...ev.fields, country: l.country, profession: l.profession, city: l.city, amount: l.amount, comment: l.comment, age: l.age, phone: ev.phone, name: ev.name } }],
        };
      }
      return { ok: true, meta, events: [{ type: "custom", name: `nextbot:${ev.kind}`, contact: hint, data: ev }] };
    },

    async apply(event, ctx: ApplyContext): Promise<ApplySummary> {
      const ev = event.data as ParsedEvent;
      const { store, contactId } = ctx;
      const at0 = ctx.now;
      const dialogId = ev.dialogId ?? "";
      // Канал не указан в событии — берём уже известный канал клиента
      const channel = ev.channel !== "nextbot" ? ev.channel : isChatChannel(ctx.contactChannel) ? ctx.contactChannel : "nextbot";
      const text = ev.text;
      // Защита от повторов: номер сообщения из Nextbot, а если его нет — тот же текст в пределах 10 секунд
      // (клиент вполне может дважды написать «да» — за минуту второе сообщение потерялось бы)
      const externalId = ev.messageId
        ? `nb:${ev.messageId}`
        : `nb:${sha1Hex(`${dialogId}|${ev.kind}|${text}|${ev.dump ?? ""}|${Math.floor(at0 / 10000)}`).slice(0, 32)}`;
      if (store.messageExists && (await store.messageExists(externalId))) return { messageIds: [], added: 0, duplicate: true };

      // Точное время события у Nextbot (поле time, с секундами) — если прислано; иначе время прихода
      const eventAt = nextbotTime(ev.sentAt, at0);
      const media = mediaFor(store);
      const messageIds: string[] = [];
      let added = 0;
      let lastAt: number | null = null;
      const waits: WaitChange[] = [];
      const save = async (m: NewMessage) => {
        const r = await store.saveMessage(contactId, m);
        if (!r.duplicate) {
          messageIds.push(r.id);
          added++;
          lastAt = Math.max(lastAt ?? 0, Date.parse(m.at));
          if (m.kind === "message" && !m.shadow) {
            waits.push(m.author.type === "client" ? { type: "client_wrote", at: m.at } : m.handoff ? { type: "handoff", at: m.at } : { type: "answered", at: m.at });
          }
        }
        return r;
      };

      // Кто написал наш ответ, пришедший строкой «Полного диалога» или полем agent. Nextbot подписывает одинаково — именем
      // ИИ-агента — и ответы бота, и сообщения менеджера с телефона. Настоящий ответ бота приходит ещё и своим событием
      // «ответ агента» (сценарий «Новое сообщение агента»). Значит, если такие события бывают (за 14 дней), ответ, которого
      // в переписке ещё нет, написал человек — «менеджер с телефона»; «бот на паузе» (VALIDATE_ACCESS_DIALOG_PAUSED) — тоже
      // человек. Без сценария различить нельзя — «ИИ-агент». Пришло событие бота позже с тем же текстом — автор исправится
      const paused = /DIALOG_PAUSED/i.test(ev.sendError ?? "");
      if (ev.kind === "bot_message") await media.noteBotEvent(at0);
      const agentEvents = paused || (await media.botEventsSince(at0 - 14 * 24 * HOUR));
      const outAuthor: Author = agentEvents ? { type: "operator_phone" } : { type: "bot" };

      let recent: string[] | null = null;
      const knownOut = async (answer: string) => {
        recent ??= store.findMessages ? (await store.findMessages(contactId, { lastOutgoing: 30 })).filter((m) => m.author.type !== "client").map((m) => m.text) : [];
        return recent.includes(answer);
      };
      const addAgentAnswer = async (answer: string, atMs: number) => {
        const body = answer.trim();
        if (!body || (await knownOut(body))) return;
        await save({ kind: "message", author: outAuthor, channel, text: body, at: iso(atMs), handoff: outAuthor.type === "bot" && isHandoff(body) });
      };

      // «Последняя ошибка отправки сообщения» Nextbot: строкой в переписке, одна и та же — один раз. «Диалог на паузе» —
      // не сбой доставки: Nextbot остановил бота, потому что менеджер ответил сам
      if (ev.sendError) {
        const line = paused
          ? "ИИ-агент в этом диалоге на паузе: менеджер ответил клиенту сам (с телефона) — дальше отвечает человек"
          : `Nextbot не доставил сообщение клиенту: ${ev.sendError}`;
        await save({ kind: "system", author: { type: "system" }, channel, text: line, at: iso(at0), externalId: `nb:${dialogId}:notice:${sha1Hex(line).slice(0, 32)}` });
      }

      const files = o.canStoreFiles ? await o.canStoreFiles(contactId) : true;
      let mediaJobs: PlannedMedia[] = [];
      const lines = ev.kind === "client_message" && ev.dump ? parseDialogDump(ev.dump, [ctx.contactName, ev.name]) : [];
      if (lines.length >= 2) {
        // Что из дампа уже есть в переписке — одним запросом на весь дамп (длинный диалог приходит целиком с каждым сообщением)
        const eids = lines.map((l) => `nb:${dialogId}:${sha1Hex(`${l.at ?? ""}|${l.author}|${l.text}`).slice(0, 32)}`);
        const outTexts = [...new Set(lines.filter((l) => l.out).map((l) => l.text))];
        const found = store.findMessages ? await store.findMessages(contactId, { externalIds: eids, outgoingTexts: outTexts }) : [];
        const eidSet = new Set(eids);
        const knownEid = new Map<string, { at: number; id: string; hasFile: boolean }>();
        const outAt = new Map<string, number[]>();
        for (const m of found) {
          if (m.externalId && eidSet.has(m.externalId)) knownEid.set(m.externalId, { at: Date.parse(m.at), id: m.id, hasFile: !!m.fileId });
          if (m.author.type !== "client" && outTexts.includes(m.text)) outAt.set(m.text, [...(outAt.get(m.text) ?? []), Date.parse(m.at)]);
        }
        // Файлы в строках дампа — и клиента, и менеджера с рабочего номера. Фото ищем в папках хранилища — по ссылкам
        // этого дампа и прежних
        const hosts = testHosts();
        const refs = lines.map((l) => (files ? mediaRef(l.text) : null));
        const dumpFolders = mediaFolders(lines.map((l) => l.text), hosts);
        const oldFolders = await media.folders();
        const folders = [...dumpFolders, ...oldFolders.filter((f) => !dumpFolders.includes(f))].slice(0, 5);
        if (dumpFolders.some((f) => !oldFolders.includes(f))) await media.saveFolders(folders);
        const cands = refs.map((r) => (r ? mediaCandidates(r, folders, hosts) : []));
        const allUrls = [...new Set(cands.flat())];
        const knownUrl = new Map<string, number | null>();
        if (allUrls.length) {
          for (const [url, v] of await media.lookup(contactId, allUrls)) knownUrl.set(url, v.fileId && v.at ? Date.parse(v.at) : null);
        }
        const plan = planDump({ lines, eids, knownEid, refs, cands, knownUrl, outAt, outSender: outAuthor.type === "bot" ? "bot" : "operator_phone", eventNow: eventAt ?? at0, arrivedAt: at0 });
        for (const x of plan.inserts) {
          await save({ kind: "message", author: x.out ? outAuthor : { type: "client" }, channel, text: x.text, at: iso(x.at), externalId: x.eid, handoff: x.handoff });
        }
        added += plan.pendingFiles;
        for (const m of plan.media) if (!m.convertId) lastAt = Math.max(lastAt ?? 0, m.at);
        mediaJobs = plan.media;
        // Сообщение клиента пришло отдельным полем (client_message), а в «Полном диалоге» его ещё нет — после дампа
        if (text && !lines.some((l) => !l.out && l.text.trim() === text.trim())) {
          await save({ kind: "message", author: { type: "client" }, channel, text, at: iso(eventAt ?? at0), externalId });
        }
        // Поле agent: ответ ИИ-агента, которого в дампе ещё нет, — после последней реплики дампа
        const agent = ev.agentText;
        if (agent && !lines.some((l) => l.out && l.text.trim() === agent.trim())) await addAgentAnswer(agent, Math.max(at0, plan.newest + 1000));
      } else {
        // Ответ бота, который уже есть (пришёл строкой дампа или полем agent), второй раз не пишем. Если его подписали
        // «менеджер с телефона» (событие бота пришло позже дампа) — исправляем на ИИ-агента
        if (ev.kind === "bot_message" && store.findMessages) {
          const prev = (await store.findMessages(contactId, { outgoingTexts: [text.trim()] }))
            .filter((m) => m.author.type !== "client" && Date.parse(m.at) > at0 - 3 * HOUR)
            .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
          if (prev?.author.type === "operator_phone" && store.updateMessage) {
            await store.updateMessage({ id: prev.id }, { author: { type: "bot" }, handoff: isHandoff(text) });
            await store.notify({ contactId, kind: "message" });
            return { messageIds: [prev.id], added: 0 };
          }
          if (await knownOut(text.trim())) return { messageIds: [], added: 0 };
        }
        // Поле agent в событии клиента без дампа: бот ещё не ответил на это сообщение, там его прошлый ответ — перед ним
        if (ev.agentText && ev.kind === "client_message") await addAgentAnswer(ev.agentText, (eventAt ?? at0) - 1000);
        const author: Author = ev.kind === "client_message" ? { type: "client" }
          : ev.kind === "bot_message" ? { type: "bot" }
          : { type: "operator_admin", name: "менеджер в Nextbot" };
        if (text) await save({ kind: "message", author, channel, text, at: iso(eventAt ?? at0), externalId, handoff: author.type === "bot" && isHandoff(text) });
      }

      for (const w of waits) await store.markWaiting(contactId, w);
      if (added || messageIds.length) await store.notify({ contactId, kind: "message", wait: waits[waits.length - 1] });

      // Файлы — после ответа Nextbot: фото секунду и дольше, а сообщение и ответ Nextbot его не ждут. Файл встаёт сразу за
      // сообщением этого события, а не на время скачивания (иначе медленное фото оказалось бы ниже ответа бота)
      if (files) {
        const fileAt = lastAt ?? eventAt ?? at0;
        const items: PlannedMedia[] = [
          ...mediaJobs,
          ...ev.attachments.map((url, i): PlannedMedia => ({ urls: [url], ref: null, at: fileAt + 1 + i, out: false })),
        ];
        if (items.length) ctx.later(() => saveMedia(store, contactId, channel, outAuthor, items));
      }
      return { messageIds, added };
    },

    respond(summary: IngestSummary, status: number) {
      const meta = summary.meta ?? {};
      const kind = String(meta.event ?? "client_message");
      log({
        direction: "in", kind, status: summary.status, dialogId: (meta.dialogId as string | null | undefined) ?? null, contactId: summary.contactId ?? null,
        error: summary.error ?? null, payload: meta.payload,
      });
      const body: Record<string, unknown> = {
        ok: summary.ok || summary.status === "ignored" && status === 200, status: summary.status, event: kind,
        ...(summary.error ? { error: summary.error } : {}),
        ...(summary.contactId ? { client_id: summary.contactId, message_id: summary.messageIds[0] ?? null, created_client: !!summary.createdContact } : {}),
        ...(summary.functionResult ? { count: summary.functionResult.count ?? 0, text: summary.functionResult.text } : {}),
        ...summary.extra,
      };
      return { status, body };
    },

    async send(to: Target, out: Outgoing): Promise<SendResult> {
      if (!s.enabled || !s.webhookUrl) return { ok: false, error: "Мессенджеры не подключены к CRM: их подключают в настройках" };
      if (!to.externalId) return { ok: false, error: "Клиент ещё не писал нам в мессенджер — ответить туда нельзя" };
      // Заметка боту, чтобы не перебивал менеджера: при первом ответе человека за 6 часов (команды «пауза» у Nextbot нет)
      const note = (s.managerNote ?? "").trim();
      if (note && out.author && out.author.type !== "bot" && to.contactId && o.store?.findMessages) {
        const since = now() - 6 * HOUR;
        const recentHuman = (await o.store.findMessages(to.contactId, { lastOutgoing: 50 })).some((m) =>
          (m.author.type === "operator_crm" || m.author.type === "operator_admin") && m.id !== out.messageId && Date.parse(m.at) > since
          && (m.delivery === "sent" || m.delivery === "delivered" || m.delivery === "read"));
        if (!recentHuman) {
          await post({ dialog_id: to.externalId, text: note.replaceAll("{менеджер}", out.author.name ?? "из CRM").replaceAll("{сотрудник}", out.author.name ?? "из CRM"), message_type: "output" }, "note", to.contactId);
        }
      }
      const base: NextbotPayload = { dialog_id: to.externalId, text: out.text, message_type: "forwarded_output", message_id: out.idempotencyKey ?? out.messageId };
      if (out.file?.url) {
        const image = out.file.mime === "image/jpeg" || out.file.mime === "image/png";
        const r = await post(
          { ...base, text: out.file.name || "Документ", content_type: image ? "image" : "document", ...(image ? { image_url: out.file.url } : { document_url: out.file.url }) },
          "file", to.contactId ?? null
        );
        if (!r.ok) return { ok: false, error: r.error ?? "Не отправилось", retryable: r.httpStatus === null || r.httpStatus >= 500 };
        // Подпись к файлу Nextbot не показывает — отдельным сообщением следом
        if (!out.text.trim() || out.text === out.file.name) return { ok: true, externalId: base.message_id ?? null };
        const t = await post({ ...base, message_id: base.message_id ? `${base.message_id}:text` : undefined }, "reply", to.contactId ?? null);
        return t.ok ? { ok: true, externalId: base.message_id ?? null } : { ok: false, error: t.error ?? "Не отправилось", retryable: t.httpStatus === null || t.httpStatus >= 500 };
      }
      const r = await post(base, "reply", to.contactId ?? null);
      return r.ok ? { ok: true, externalId: base.message_id ?? null } : { ok: false, error: r.error ?? "Не отправилось", retryable: r.httpStatus === null || r.httpStatus >= 500 };
    },

    async control() {
      return { ok: false, error: "У Nextbot нет команды «пауза»: бот сам останавливается, когда менеджер отвечает (CRM шлёт ему заметку «не перебивай»)" };
    },

    download,

    note: async (dialogId, text, contactId) => {
      const r = await post({ dialog_id: dialogId, text, message_type: "output" }, "note", contactId ?? null);
      return r.ok ? { ok: true } : { ok: false, error: r.error ?? "Не отправилось" };
    },
    notification: async (dialogId, text, contactId) => {
      const r = await post({ dialog_id: dialogId, text, message_type: "notification" }, "notification", contactId ?? null);
      return r.ok ? { ok: true } : { ok: false, error: r.error ?? "Не отправилось" };
    },
    test: async (dialogId) => {
      const r = await post({ dialog_id: dialogId, text: "Проверка связи с CRM", message_type: "notification" }, "test", null);
      return r.ok ? { ok: true } : { ok: false, error: r.error ?? "Не отправилось" };
    },
    post,
  };
  return adapter;
}
