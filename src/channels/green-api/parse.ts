import { fileWords } from "../../core/files.js";
import type { Author, Delivery } from "../../core/model.js";
import type { ChannelEvent, IncomingCall, IncomingMessage, RemoteFile } from "../../server/channel.js";
import type { ContactHint } from "../../server/store.js";
import { greenApiStateText, phoneFromChatId } from "./api.js";

/* Разбор уведомлений GREEN-API (вебхуков) в события набора — без сети и без базы.

   Виды уведомлений (typeWebhook):
   - incomingMessageReceived — клиент написал (автор «клиент»);
   - outgoingMessageReceived — написали с телефона компании (автор «менеджер с телефона»);
   - outgoingAPIMessageReceived — ушло через API: ключ повтора тот же, что вернула отправка (send), поэтому своё же
     сообщение второй раз не записывается; чужое (другая программа на том же номере) записывается от «бота»;
   - outgoingMessageStatus — ушло / дошло / прочитано / не доставлено;
   - incomingCall, outgoingCall — звонки: строка звонка в ленте, пропущенный входящий — клиент ждёт ответа;
   - stateInstanceChanged, quotaExceeded — про номер целиком (WhatsApp отключён, закончился лимит тарифа): в переписку
     клиента не пишем — их получает проект (onAlert подключения), чтобы показать администратору;
   - остальное (deviceInfo, statusInstanceChanged, incomingBlock…) — принято и пропущено.

   Ключи повтора: «ga:<idMessage>» у сообщений и статусов, «ga:call:<id>» у звонков, «ga:edit:…», «ga:del:…»,
   «ga:react:…» у исправлений, удалений и реакций. Файлы — ссылкой GREEN-API и запасным адресом «ga-file:<чат>:<номер>»:
   если ссылка устарела, подключение попросит у GREEN-API новую (метод downloadFile). */

type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Запасной адрес файла: подключение попросит у GREEN-API свежую ссылку (downloadFile) */
export const GREEN_API_FILE_SCHEME = "ga-file:";

/** Уведомление про номер целиком: WhatsApp отключён или снова подключён, закончился лимит тарифа */
export type GreenApiAlert = {
  /** state — состояние WhatsApp (подключён, отключён, заблокирован); quota — закончился лимит тарифа */
  type: "state" | "quota";
  /** Состояние как у GREEN-API: authorized, notAuthorized, blocked, sleepMode, starting, suspended */
  state?: string | undefined;
  /** Всё в порядке (WhatsApp снова подключён) — баннер можно убрать */
  ok: boolean;
  /** Что показать администратору */
  text: string;
  /** Когда (ISO) — время GREEN-API */
  at: string | null;
};

export type GreenApiParsed =
  | { kind: "events"; events: ChannelEvent[] }
  | { kind: "alert"; alert: GreenApiAlert }
  /** Принято, но в CRM не нужно — причина словами (видна в итоге приёма) */
  | { kind: "skip"; reason: string };

export type GreenApiParseOptions = {
  /** Принимать группы WhatsApp */
  groups?: boolean | undefined;
};

/** Вид чата: личный (номер или скрытый номер @lid), группа, прочее (статусы, каналы, рассылки) */
export function greenApiChatKind(chatId: string): "personal" | "group" | "other" {
  if (/^\d{5,20}@c\.us$/.test(chatId) || /^\d{5,25}@lid$/.test(chatId)) return "personal";
  if (/^\d[\d-]{4,40}@g\.us$/.test(chatId)) return "group";
  return "other";
}

/** Время GREEN-API (секунды) → ISO. Нет или непонятное — null (набор поставит время приёма) */
function timeOf(v: unknown): string | null {
  const t = num(v);
  if (t === null || t <= 0) return null;
  const d = new Date(t > 1e12 ? t : t * 1000);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** Имя без телефона вместо имени: WhatsApp подставляет номер, если имени нет */
function nameOf(v: unknown): string | null {
  const s = str(v).trim();
  return s && !/^[\d\s()+.-]+$/.test(s) ? cut(s, 100) : null;
}

function contactOf(chatId: string, name: string | null): ContactHint {
  const phone = phoneFromChatId(chatId);
  // Номер из адреса чата WhatsApp подлинный — по нему можно привязать диалог к уже известному клиенту
  return { source: "green-api", externalId: chatId, channel: "whatsapp", phone, phoneTrusted: !!phone, name };
}

const skip = (reason: string): GreenApiParsed => ({ kind: "skip", reason });

export function parseGreenApiWebhook(body: Record<string, unknown>, o: GreenApiParseOptions = {}): GreenApiParsed {
  const type = str(body.typeWebhook);
  switch (type) {
    case "incomingMessageReceived":
      return messageEvents(body, "in", o);
    case "outgoingMessageReceived":
      return messageEvents(body, "phone", o);
    case "outgoingAPIMessageReceived":
      return messageEvents(body, "api", o);
    case "outgoingMessageStatus":
      return statusEvents(body);
    case "incomingCall":
      return callEvents(body, "in", o);
    case "outgoingCall":
      return callEvents(body, "out", o);
    case "stateInstanceChanged": {
      const state = str(body.stateInstance);
      const ok = state === "authorized";
      return { kind: "alert", alert: { type: "state", state, ok, at: timeOf(body.timestamp), text: ok ? "WhatsApp подключён к GREEN-API — сообщения снова приходят и уходят" : greenApiStateText(state) } };
    }
    case "quotaExceeded":
      return { kind: "alert", alert: { type: "quota", ok: false, at: timeOf(body.timestamp), text: quotaAlert(obj(body.quotaData)) } };
    default:
      return skip(`Уведомление GREEN-API «${type || "без вида"}» в CRM не нужно`);
  }
}

function quotaAlert(q: Obj): string {
  const used = num(q.used);
  const total = num(q.total);
  const counts = used !== null && total !== null ? ` (использовано ${used} из ${total})` : "";
  if (str(q.method) === "correspondents" || /CORRESPONDENTS/i.test(str(q.status))) {
    return `Закончился лимит тарифа GREEN-API: переписка только с ${total ?? 3} чатами в месяц${counts} — новые клиенты не дойдут до CRM, смените тариф в кабинете GREEN-API`;
  }
  return `Закончился лимит тарифа GREEN-API${counts} — смените тариф в кабинете GREEN-API`;
}

/* ── Сообщения ─────────────────────────────────────────────────────────────────────────────────────────────── */

/** Откуда сообщение: от клиента, с телефона компании, через API */
type Via = "in" | "phone" | "api";

type Quote = { externalId: string; text: string | null };

type Content =
  /** label — слова вместо файла («Фото», «Документ: договор.pdf»): текст «эха» своей отправки без подписи */
  | { kind: "message"; text: string; files: RemoteFile[]; replyTo: Quote | null; key?: string | undefined; label?: string | undefined }
  | { kind: "notice"; text: string; key: string }
  | { kind: "skip"; reason: string };

type Ctx = { id: string; chatId: string; sender: string; incoming: boolean; ts: string };

const drop = (reason: string): Content => ({ kind: "skip", reason });
const nonEmpty = (x: Content): Content => (x.kind === "message" && !x.text.trim() ? drop("Пустое сообщение") : x);

function messageEvents(body: Obj, via: Via, o: GreenApiParseOptions): GreenApiParsed {
  const sd = obj(body.senderData);
  const chatId = str(sd.chatId).trim();
  const id = str(body.idMessage).trim();
  if (!chatId || !id) return skip("В уведомлении нет чата или номера сообщения (chatId, idMessage)");
  const kind = greenApiChatKind(chatId);
  if (kind === "other") return skip("Статусы, каналы и рассылки WhatsApp в CRM не попадают");
  if (kind === "group" && !o.groups) return skip("Сообщение из группы WhatsApp — группы в CRM не принимаем (включаются настройкой groups)");
  // «Написать себе» с номера компании (заметки сотрудников) — не клиент
  if (chatId === str(obj(body.instanceData).wid).trim()) return skip("Переписка номера компании с самим собой в CRM не попадает");
  const incoming = via === "in";
  const content = parseContent(obj(body.messageData), { id, chatId, sender: str(sd.sender), incoming, ts: str(body.timestamp) });
  if (content.kind === "skip") return skip(content.reason);

  // Имя клиента: в личном чате — как он подписан в WhatsApp или в телефоне компании; в группе — название группы.
  // У наших сообщений senderName — это мы, имя клиента — только название чата
  const name = kind === "group" || !incoming ? nameOf(sd.chatName) : nameOf(sd.senderName) ?? nameOf(sd.senderContactName) ?? nameOf(sd.chatName);
  const contact = contactOf(chatId, name);
  if (content.kind === "notice") return { kind: "events", events: [{ type: "notice", contact, key: content.key, text: content.text }] };

  const author: Author = incoming
    ? { type: "client", name: kind === "group" ? nameOf(sd.senderName) ?? nameOf(sd.senderContactName) : null }
    : via === "phone" ? { type: "operator_phone" } : { type: "bot" };
  // «Эхо» своей отправки через API узнаётся по ключу «ga:<idMessage>»: у файла без подписи ставим текст — иначе набор
  // сохранил бы файл отдельной записью, не заметив, что сообщение уже есть
  const text = via === "api" && !content.text.trim() && content.files.length ? content.label ?? "" : content.text;
  const message: IncomingMessage = {
    externalId: content.key ?? `ga:${id}`, at: timeOf(body.timestamp), author, text, files: content.files, replyTo: content.replyTo,
  };
  return { kind: "events", events: [{ type: "message", contact, message }] };
}

/** Текст «{{SWE001}}» — GREEN-API не смог расшифровать сообщение */
function plainText(t: string): string {
  const code = t.trim().match(/^\{\{(SWE\d+)\}\}$/)?.[1];
  return code ? `WhatsApp не передал текст этого сообщения (код ${code}) — посмотрите его в телефоне` : t;
}

/** Ответ на сообщение: номер исходного (stanzaId) и, если GREEN-API прислал, его начало */
function replyOf(md: Obj): Quote | null {
  const q = obj(md.quotedMessage);
  const id = str(q.stanzaId).trim() || str(obj(md.extendedTextMessageData).stanzaId).trim();
  return id ? { externalId: `ga:${id}`, text: quotedText(q) } : null;
}

function quotedText(q: Obj): string | null {
  const own = str(q.textMessage) || str(q.text) || str(q.caption);
  let s: string;
  switch (str(q.typeMessage)) {
    case "imageMessage": s = own || "Фото"; break;
    case "videoMessage": s = own || "Видео"; break;
    case "audioMessage": s = "Голосовое сообщение"; break;
    case "documentMessage": s = str(q.fileName) || own || "Документ"; break;
    case "stickerMessage": s = "Стикер"; break;
    case "locationMessage": s = "Геопозиция"; break;
    case "contactMessage": s = str(q.displayName) ? `Контакт: ${str(q.displayName)}` : "Контакт"; break;
    default: s = own;
  }
  s = s.trim();
  return s ? cut(s, 300) : null;
}

function parseContent(md: Obj, c: Ctx): Content {
  const type = str(md.typeMessage);
  const ext = obj(md.extendedTextMessageData);
  const replyTo = type === "reactionMessage" ? null : replyOf(md);
  const msg = (text: string, quote: Quote | null = replyTo): Content => ({ kind: "message", text, files: [], replyTo: quote });
  // Нажатая кнопка или пункт списка — ответ на сообщение с кнопками (stanzaId)
  const choice = (d: Obj, text: string): Content => {
    const id = str(d.stanzaId).trim();
    return text.trim() ? msg(text, id ? { externalId: `ga:${id}`, text: null } : replyTo) : drop("Пустой выбор кнопки");
  };
  switch (type) {
    case "textMessage":
      return nonEmpty(msg(plainText(str(obj(md.textMessageData).textMessage))));
    case "extendedTextMessage":
    case "quotedMessage":
      return nonEmpty(msg(plainText(str(ext.text))));
    case "imageMessage":
    case "videoMessage":
    case "documentMessage":
    case "audioMessage":
    case "stickerMessage":
      return fileContent(type, obj(md.fileMessageData), c, replyTo);
    case "locationMessage":
    case "liveLocationMessage":
      return msg(locationText(obj(md.locationMessageData ?? md.liveLocationMessageData)));
    case "contactMessage":
      return msg(contactLine(obj(md.contactMessageData)));
    case "contactsArrayMessage": {
      const d = obj(md.messageData ?? md.contactsArrayMessageData);
      const lines = arr(d.contacts).map((x) => contactLine(obj(x)));
      return msg(lines.join("\n") || "Контакты");
    }
    case "pollMessage":
      return msg(pollText(obj(md.pollMessageData)));
    case "pollUpdateMessage":
      return msg(pollVoteText(obj(md.pollMessageData), c));
    case "buttonsResponseMessage": {
      const d = obj(md.buttonsResponseMessage);
      return choice(d, str(d.selectedButtonText) || str(d.selectedButtonId));
    }
    case "listResponseMessage": {
      const d = obj(md.listResponseMessage);
      return choice(d, str(d.title) || str(d.singleSelectReply));
    }
    case "templateButtonReplyMessage":
    case "templateButtonsReplyMessage": {
      const d = obj(md.templateButtonReplyMessage ?? md.templateButtonsReplyMessage);
      return choice(d, str(d.selectedDisplayText) || str(d.selectedId));
    }
    case "reactionMessage": {
      // Реакция клиента — служебной строкой (не сообщение: ответа не ждёт); снятая реакция и наши реакции — мимо
      const emoji = str(ext.text).trim();
      if (!c.incoming) return drop("Реакции с нашей стороны в переписку не пишем");
      if (!emoji) return drop("Клиент снял реакцию");
      return { kind: "notice", key: `ga:react:${c.id}`, text: `Клиент отреагировал на сообщение: ${cut(emoji, 20)}` };
    }
    case "editedMessage": {
      // Исправление — новой записью с цитатой исходного: менеджер видит и что было, и что стало. Клиент исправил —
      // сообщение клиента (он снова ждёт ответа); мы исправили — служебная строка
      const d = obj(md.editedMessageData);
      const text = (str(d.textMessage) || str(d.caption)).trim();
      const orig = str(d.stanzaId).trim();
      if (!text) return drop("Пустое исправление");
      const key = `ga:edit:${c.id}:${c.ts}`;
      if (!c.incoming) return { kind: "notice", key, text: `Наше сообщение исправлено в WhatsApp: «${cut(text, 300)}»` };
      return { kind: "message", key, text: `Исправлено: ${text}`, files: [], replyTo: orig ? { externalId: `ga:${orig}`, text: null } : null };
    }
    case "deletedMessage": {
      // Удалённое у всех остаётся в CRM — служебная строка, что его больше нет в WhatsApp
      const orig = str(obj(md.deletedMessageData).stanzaId).trim() || c.id;
      return {
        kind: "notice", key: `ga:del:${orig}`,
        text: c.incoming ? "Клиент удалил сообщение в WhatsApp — в CRM оно осталось" : "Наше сообщение удалено в WhatsApp — клиент его больше не видит, в CRM оно осталось",
      };
    }
    default:
      return msg(otherText(type, md));
  }
}

/** Фото, видео, голосовое, документ, стикер. Подпись — текстом сообщения, файл — отдельной записью следом
 *  (так набор раскладывает любые файлы). Название файла: у документа — его имя, у остальных — слова набора */
function fileContent(type: string, f: Obj, c: Ctx, replyTo: Quote | null): Content {
  const link = str(f.downloadUrl).trim();
  const urls = [...(/^https?:\/\//i.test(link) ? [link] : []), `${GREEN_API_FILE_SCHEME}${c.chatId}:${c.id}`];
  const caption = str(f.caption).trim();
  if (type === "stickerMessage") return { kind: "message", text: "", files: [{ urls, caption: "Стикер" }], replyTo, label: "Стикер" };
  if (type === "documentMessage") {
    const name = cut(str(f.fileName).trim(), 200) || "Документ";
    return { kind: "message", text: caption === name ? "" : caption, files: [{ urls, caption: name }], replyTo, label: `Документ: ${name}` };
  }
  const mime = str(f.mimeType) || (type === "imageMessage" ? "image/jpeg" : type === "videoMessage" ? "video/mp4" : "audio/ogg");
  return { kind: "message", text: caption, files: [{ urls, caption: null }], replyTo, label: fileWords({ mime, name: "" }) };
}

/** «Геопозиция: Кафе, ул. Примерная 1 — https://maps.google.com/?q=42.87,74.59» */
function locationText(d: Obj): string {
  const lat = num(d.latitude);
  const lon = num(d.longitude);
  const place = [str(d.nameLocation).trim(), str(d.address).trim()].filter(Boolean).join(", ");
  if (lat === null || lon === null) return place ? `Геопозиция: ${place}` : "Геопозиция";
  return `Геопозиция: ${place || `${lat}, ${lon}`} — https://maps.google.com/?q=${lat},${lon}`;
}

/** «Контакт: Айгерим, +996555000001» — имя и телефоны из визитки (vCard) */
function contactLine(d: Obj): string {
  const phones: string[] = [];
  for (const line of str(d.vcard).split(/\r?\n/)) {
    if (!/^(item\d+\.)?TEL/i.test(line)) continue;
    const waid = line.match(/waid=(\d{7,15})/i)?.[1];
    const phone = waid ? `+${waid}` : line.slice(line.lastIndexOf(":") + 1).trim();
    if (phone && !phones.includes(phone)) phones.push(phone);
  }
  const parts = [str(d.displayName).trim(), ...phones.slice(0, 5)].filter(Boolean);
  return parts.length ? `Контакт: ${parts.join(", ")}` : "Контакт";
}

function pollText(d: Obj): string {
  const options = arr(d.options).map((x) => str(obj(x).optionName).trim()).filter(Boolean);
  return [`Опрос: ${str(d.name).trim() || "без названия"}`, ...options.map((x) => `— ${x}`)].join("\n");
}

/** Голос в опросе: варианты, за которые голосует автор уведомления (у GREEN-API — все голоса опроса сразу) */
function pollVoteText(d: Obj, c: Ctx): string {
  const name = str(d.name).trim();
  const voter = [c.sender, c.chatId].filter(Boolean);
  const chosen = arr(d.votes)
    .map(obj)
    .filter((v) => arr(v.optionVoters).some((x) => voter.includes(str(x))))
    .map((v) => str(v.optionName).trim())
    .filter(Boolean);
  const poll = name ? ` «${name}»` : "";
  return chosen.length ? `Ответ в опросе${poll}: ${chosen.join(", ")}` : `Голос в опросе${poll} отменён`;
}

const OTHER_LABELS: Readonly<Record<string, string>> = {
  groupInviteMessage: "Приглашение в группу WhatsApp",
  productMessage: "Товар из каталога WhatsApp",
  orderMessage: "Заказ из каталога WhatsApp",
  buttonsMessage: "Сообщение с кнопками",
  templateMessage: "Сообщение с кнопками",
  interactiveButtons: "Сообщение с кнопками",
  interactiveButtonsReply: "Сообщение с кнопками",
  listMessage: "Сообщение со списком",
};

/** Вид сообщения, который набор не разбирает: подпись вида и найденный в нём текст — сообщение клиента не теряется */
function otherText(type: string, md: Obj): string {
  const words: string[] = [];
  for (const [k, v] of Object.entries(md)) {
    if (k === "typeMessage" || k === "quotedMessage") continue;
    const d = obj(v);
    for (const f of ["groupName", "title", "titleText", "name", "contentText", "text", "caption", "description", "footerText"]) {
      const s = str(d[f]).trim();
      if (s && !words.includes(s)) words.push(cut(s, 500));
    }
  }
  const head = OTHER_LABELS[type] ?? `Сообщение WhatsApp такого вида CRM пока не показывает${type ? ` (${type})` : ""} — посмотрите его в телефоне`;
  return [head, ...words.slice(0, 4)].join("\n");
}

/* ── Статусы ───────────────────────────────────────────────────────────────────────────────────────────────── */

const DELIVERY: Readonly<Record<string, Delivery>> = {
  sent: "sent", delivered: "delivered", read: "read",
  failed: "failed", noAccount: "failed", notInGroup: "failed", yellowCard: "failed", suspended: "failed",
};

function statusEvents(body: Obj): GreenApiParsed {
  const id = str(body.idMessage).trim();
  const status = str(body.status);
  const delivery = DELIVERY[status];
  if (!id) return skip("В статусе нет номера сообщения (idMessage)");
  if (!delivery) return skip(`Статус сообщения «${status}» набору не знаком`);
  const error = delivery === "failed" ? statusError(status, str(body.description)) : null;
  return { kind: "events", events: [{ type: "status", externalId: `ga:${id}`, delivery, error }] };
}

function statusError(status: string, description: string): string {
  if (status === "noAccount") return "У этого номера нет WhatsApp";
  if (status === "notInGroup") return "Номер не состоит в этой группе WhatsApp";
  if (status === "yellowCard" || status === "suspended") return "WhatsApp временно ограничил отправку с этого номера (подозрение на спам)";
  const d = description.replace(/\s+/g, " ").trim();
  if (/megabytes|file size/i.test(d)) return "Файл слишком большой для WhatsApp (больше 100 МБ)";
  return d ? `WhatsApp не доставил сообщение (${cut(d, 200)})` : "WhatsApp не доставил сообщение";
}

/* ── Звонки ────────────────────────────────────────────────────────────────────────────────────────────────── */

/* Входящий: GREEN-API присылает два уведомления — offer (звонит) и итог: pickUp — ответили; hungUp — отклонили у нас,
   declined — не дождались ответа (missed — прежнее название declined). Пишем один раз, по итогу: пропущенный —
   клиент ждёт ответа, состоявшийся — ответ. Исходящий (с телефона компании): pickUp — поговорили (duration — секунды),
   hungUp / invalid — не дозвонились. */

const IN_MISSED = ["hungUp", "hangUp", "declined", "missed"];
const OUT_MISSED = ["hungUp", "hangUp", "declined", "invalid", "missed"];

function callEvents(body: Obj, direction: "in" | "out", o: GreenApiParseOptions): GreenApiParsed {
  const id = str(body.idMessage).trim();
  const status = str(body.status);
  const from = str(body.from).trim() || str(obj(arr(body.participants)[0]).id).trim();
  if (!id || !from) return skip("В уведомлении о звонке нет номера звонка или собеседника");
  const kind = greenApiChatKind(from);
  if (kind === "other" || (kind === "group" && !o.groups)) return skip("Звонок не из личного чата — в CRM не записываем");
  let missed: boolean;
  if (status === "pickUp") missed = false;
  else if ((direction === "in" ? IN_MISSED : OUT_MISSED).includes(status)) missed = true;
  else if (status === "offer") return skip("Звонок ещё идёт — запишем, когда станет известно, ответили ли на него");
  else return skip(`Статус звонка «${status}» набору не знаком`);
  const duration = num(body.duration);
  const call: IncomingCall = {
    externalId: `ga:call:${id}`, at: timeOf(body.timestamp), direction, missed,
    durationSec: !missed && duration !== null && duration > 0 ? Math.round(duration) : null,
  };
  return { kind: "events", events: [{ type: "call", contact: contactOf(from, null), call }] };
}
