import { normalizeChannel, type ChatChannel } from "../../core/channels.js";
import { normalizePhone, phoneDigits } from "../../core/phone.js";

/* Разбор события Nextbot — без базы. Правила проверены на настоящем Nextbot (сентябрь 2026).

   Nextbot → CRM: сценарий Nextbot («Новое сообщение клиента», «… агента», «… менеджера») или функция («Передать заявку»,
   свой запрос бота к CRM — свободное время, наличие товара) вызывает Custom API или Python Script, который шлёт POST
   с ключом и словарём args. Названия полей у Nextbot бывают разными — ищем по спискам вариантов во всём теле и в args
   (верхний уровень важнее). */

export type EventKind = "client_message" | "bot_message" | "manager_message" | "lead" | "ping" | "function";

export type ParsedEvent = {
  kind: EventKind;
  dialogId: string | null;
  messageId: string | null;
  /** Текст сообщения. У сообщения клиента — поле client_message («Текст последнего сообщения клиента»); пусто, если
   *  прислан только «Полный диалог» (тогда сообщения берутся из dump) */
  text: string;
  /** «Полный диалог» (поле full_dialog или, в первой настройке, text) — конец переписки: в нём самое свежее */
  dump: string | null;
  channel: ChatChannel;
  name: string | null;
  phone: string | null;
  username: string | null;
  attachments: string[];
  /** Общие поля заявки; всё остальное, что прислал бот, — в fields */
  lead: { country: string | null; city: string | null; amount: number | null; comment: string | null };
  /** Имя функции бота (event: "function" и поле function или имя события из списка функций проекта) */
  functionName: string | null;
  /** Свободный запрос функции (поле query) */
  query: string | null;
  /** «Ответ ИИ-агента» в событии сообщения клиента (поле agent): в этот момент бот ещё не ответил, поэтому там обычно его
   *  прошлый ответ — добавляем, если такого ответа в переписке ещё нет */
  agentText: string | null;
  /** «Последняя ошибка отправки сообщения» Nextbot (поле errors) — строкой в переписке, один раз */
  sendError: string | null;
  /** Тестовый чат Nextbot — окно проверки бота в конструкторе (мессенджер «Тестовый чат», имя WindowChat): не клиент */
  testChat: boolean;
  /** Время события у Nextbot (поле time = «Текущее дата/время (текст)», YYYY-MM-DD HH:MM:SS) — как если бы это был UTC;
   *  настоящий пояс узнаёт nextbotTime */
  sentAt: number | null;
  /** Все присланные поля (ключи маленькими буквами) — для обработчиков проекта (заявка) */
  fields: Record<string, string>;
};

/** «2026-09-26 19:10:42» (или 2026-09-26T19:10:42, число секунд / миллисекунд) → миллисекунды, как если бы это был UTC.
 *  Только с секундами: время до минуты хуже времени прихода — сообщение встало бы на начало минуты, выше ответа бота той же
 *  минуты. Переменная «Текущее дата/время (текст)» — «2026-09-26 19:46:09», с секундами, по поясу аккаунта; другая,
 *  «Текущая дата/время», — «26.09.2026, 19:37», до минуты, — не берём */
export function parseStamp(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (/^\d{10,13}$/.test(s)) return s.length === 13 ? Number(s) : Number(s) * 1000;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
  return Number.isFinite(t) ? t : null;
}

const STAMP_KEYS = ["time", "sent_at", "sentat", "event_time", "eventtime", "datetime", "date_time", "timestamp", "current_time", "текущее дата/время", "текущее дата/время (текст)"];

/** Время события — только из полей верхнего уровня и args (у вложенных объектов бывает своё «time»): первое с секундами */
function eventStamp(body: Record<string, unknown>): number | null {
  const top = new Map<string, unknown>();
  for (const src of [body, body.args]) {
    if (!src || typeof src !== "object" || Array.isArray(src)) continue;
    for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
      const key = k.trim().toLowerCase();
      if (!top.has(key) && (typeof v === "string" || typeof v === "number")) top.set(key, v);
    }
  }
  for (const k of STAMP_KEYS) {
    const t = parseStamp(top.get(k));
    if (t !== null) return t;
  }
  return null;
}

/** Настоящее время события по полю time: пояс Nextbot — по разнице с нашими часами (шагом 30 минут). События «сообщение
 *  клиента» и «ответ агента» приходят раздельно и могут поменяться местами — по этому времени порядок верный при любой
 *  задержке. Не похоже на правду — null, берём время прихода: разница больше 14 часов (поясов с такой разницей нет) или
 *  время после поправки на пояс всё ещё в будущем. Время на целое число получасов раньше — это пояс, а не старое событие */
export function nextbotTime(sent: number | null, now: number): number | null {
  if (sent === null || !Number.isFinite(sent)) return null;
  const off = Math.round((sent - now) / 1_800_000) * 1_800_000;
  if (Math.abs(off) > 14 * 3_600_000) return null;
  const at = sent - off;
  return at <= now + 5_000 && at >= now - 6 * 3_600_000 ? Math.min(at, now) : null;
}

/** Поля с ответом ИИ-агента («Ответ ИИ-агента» в Custom API) */
const AGENT_KEYS = ["agent", "agent_answer", "agentanswer", "agent_reply", "ai_answer", "aianswer", "bot_answer", "botanswer", "ответ ии-агента", "ответ_ии_агента", "ответ агента"];
/** «Текст последнего сообщения клиента» — поле client_message, так советует поддержка Nextbot (26.09.2026) */
const CLIENT_TEXT_KEYS = ["client_message", "clientmessage", "last_client_message", "lastclientmessage", "текст последнего сообщения клиента"];
/** «Полный диалог» отдельным полем (full_dialog); в первой настройке он приходил в поле text */
const DUMP_KEYS = ["full_dialog", "fulldialog", "полный диалог", "полный_диалог"];
/** «Полный диалог» длиннее этого режем с начала: самое свежее — в конце */
export const DUMP_MAX = 60_000;

/** Ответ ИИ-агента «передаю вас менеджеру», «с вами свяжется менеджер»: бот сам не справился, дальше нужен человек —
 *  клиент снова в «Ждут ответа». Кириллица — явными классами: \w её не видит */
const HANDOFF = new RegExp([
  String.raw`(?:переда(?:ю|м|ла|ли|л)|переключ(?:у|аю)|подключ(?:у|аю)|позову)\s+(?:вас\s+|ваш[а-яё]*\s+(?:вопрос|заявк[а-яё]*|диалог)\s+|диалог\s+)?(?:наш[а-яё]*\s+|жив[а-яё]*\s+|старш[а-яё]*\s+)?(?:менеджер|оператор|специалист|консультант|сотрудник)`,
  String.raw`(?:менеджер|оператор|специалист|консультант|сотрудник)[а-яё]*\s+(?:скоро\s+|сейчас\s+|в\s+ближайшее\s+время\s+)?(?:свяжется|ответит|подключится|напишет|перезвонит|позвонит)`,
  String.raw`(?:свяжется|ответит|подключится|напишет|перезвонит|позвонит)\s+(?:с\s+вами\s+|вам\s+)?(?:наш\s+|живой\s+)?(?:менеджер|оператор|специалист|консультант)`,
].join("|"), "iu");

export function isHandoff(text: string | null | undefined): boolean {
  return !!text && HANDOFF.test(text);
}

/** Пустышки вместо значения: переменная Nextbot не заполнена */
export const blank = (v: string | null): string | null => (v && !/^(null|none|undefined|nan|-|—|нет|test value)$/i.test(v.trim()) ? v : null);

const KIND_ALIASES: Record<string, EventKind> = {
  client_message: "client_message", client: "client_message", input: "client_message", in: "client_message", incoming: "client_message",
  bot_message: "bot_message", agent_message: "bot_message", agent: "bot_message", bot: "bot_message", output: "bot_message",
  manager_message: "manager_message", manager: "manager_message", operator: "manager_message",
  lead: "lead", deal: "lead", order: "lead", request: "lead", заявка: "lead",
  ping: "ping", test: "ping",
  function: "function", func: "function", tool: "function", функция: "function",
};

/** Все пары «ключ → значение» из тела и из args (включая вложенные объекты), ключи маленькими буквами */
function flatten(obj: unknown, out: Map<string, unknown>, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 4) return;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = k.trim().toLowerCase();
    if (v !== null && typeof v === "object" && !Array.isArray(v)) flatten(v, out, depth + 1);
    else if (!out.has(key) && v !== undefined && v !== null && v !== "") out.set(key, v);
  }
}

function pick(map: Map<string, unknown>, names: readonly string[]): unknown {
  for (const n of names) {
    const v = map.get(n);
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return null;
}

const str = (v: unknown, max = 500): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

/** Номер диалога: число, строка из цифр или ссылка на диалог в Nextbot */
export function parseDialogId(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (/^\d{1,18}$/.test(s)) return s;
  const url = s.match(/nextbot[^\s]*?(\d{3,18})(?!.*\d{3,})/i) ?? s.match(/dialog[s]?\/?(?:[^\d\s]*)(\d{3,18})/i);
  return url ? (url[1] ?? null) : null;
}

/* «Полный диалог» Nextbot — вся переписка одной строкой:
     22.09.26 20-21 [Имя клиента]: Салам алейкум
     22.09.26 20-21 [ИИ-квалификатор]: Здравствуйте! Меня зовут…
   Отдельного поля «последнее сообщение» у Nextbot нет, поэтому разбираем дамп на реплики: каждая строка — своё сообщение
   со своим временем и автором. Время в дампе — по Гринвичу (UTC) и до минуты. */
const DUMP_LINE = /^(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4})?[\s,]*(\d{1,2}[:\-.]\d{2})?[\s,]*\[([^\]]{1,80})\]\s*:\s*(.*)$/;

export type DumpLine = { at: string | null; out: boolean; author: string; text: string };

/** «22.09.26» + «20-21» → «2026-09-22 20:21» — время Nextbot, по Гринвичу (UTC) */
function dumpTime(day: string | undefined, time: string | undefined): string | null {
  if (!day || !time) return null;
  const d = day.split(/[.\-/]/).map((x) => x.trim());
  const t = time.split(/[:\-.]/).map((x) => x.trim());
  if (d.length !== 3 || t.length !== 2) return null;
  const year = d[2]!.length === 2 ? 2000 + Number(d[2]) : Number(d[2]);
  const [dd, mm, hh, mi] = [Number(d[0]), Number(d[1]), Number(t[0]), Number(t[1])];
  if (![year, dd, mm, hh, mi].every(Number.isFinite)) return null;
  if (year < 2000 || year > 2100 || mm < 1 || mm > 12 || dd < 1 || dd > 31 || hh > 23 || mi > 59) return null;
  const p = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${p(year, 4)}-${p(mm)}-${p(dd)} ${p(hh)}:${p(mi)}`;
}

/** Разбор «Полного диалога» на реплики. clientNames — как зовут клиента: его реплики входящие, остальные — наши */
export function parseDialogDump(text: string, clientNames: readonly (string | null | undefined)[]): DumpLine[] {
  const names = clientNames.filter(Boolean).map((n) => String(n).trim().toLowerCase());
  const out: DumpLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(DUMP_LINE);
    if (!m || !m[3]) {
      // Продолжение многострочной реплики
      const last = out[out.length - 1];
      if (last) last.text += `\n${line}`;
      continue;
    }
    const author = m[3].trim();
    const isClient = names.includes(author.toLowerCase()) || /^(пользователь|клиент|user|client)$/i.test(author);
    out.push({ at: dumpTime(m[1], m[2]), out: !isClient, author, text: (m[4] ?? "").trim() });
  }
  return out.filter((l) => l.text);
}

/** Это «Полный диалог»: хотя бы две строки вида «22.09.26 20-21 [Автор]: текст» */
function looksLikeDump(v: string | null): v is string {
  if (!v) return false;
  let n = 0;
  for (const line of v.split(/\r?\n/)) if (DUMP_LINE.test(line.trim()) && ++n >= 2) return true;
  return false;
}

/** Конец длинного текста по целым строкам — в «Полном диалоге» самое свежее внизу */
function tailLines(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(-max);
  const nl = cut.indexOf("\n");
  return nl >= 0 ? cut.slice(nl + 1) : cut;
}

/** «Полный диалог»: «25.12.24 14-30 [Пользователь]: Привет» — последняя реплика нужной стороны */
export function lastDialogLine(v: unknown, kind: string): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const mine = kind === "client_message" ? /\[(пользователь|клиент|user|client)\]/i : /\[(бот|агент|ассистент|bot|assistant|менеджер|оператор)\]/i;
  const lines = v.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!mine.test(line)) continue;
    const after = line.slice(line.search(/\]/) + 1).replace(/^\s*:\s*/, "").trim();
    if (after) return after.slice(0, 4000);
  }
  return null;
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[^\d.,]/g, "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** phoneCode — телефонный код страны компании: номер, который клиент написал боту по-местному
 *  («0555 00-00-01», «8 701 000-00-01»), приводим к единому виду, как в карточке клиента.
 *  functionNames — имена событий, которые проект считает функциями бота (сценарий Nextbot шлёт event: "<имя>") */
export function parseEvent(body: Record<string, unknown>, phoneCode = "", functionNames: readonly string[] = []): ParsedEvent {
  const map = new Map<string, unknown>();
  // Поля верхнего уровня важнее одноимённых в args
  flatten(Object.fromEntries(Object.entries(body).filter(([k]) => k !== "args")), map);
  flatten(body.args, map);

  // Тип события — только из тела запроса (в args бывают свои поля «type»)
  const rawKind = String(body.event ?? body.event_type ?? body.kind ?? "client_message").trim().toLowerCase();
  const ownFunction = functionNames.some((n) => n.trim().toLowerCase() === rawKind);
  const kind: EventKind = ownFunction ? "function" : KIND_ALIASES[rawKind] ?? "client_message";

  let dialogId = parseDialogId(pick(map, ["dialog_id", "dialogid", "id диалога", "dialog"]));
  if (!dialogId) dialogId = parseDialogId(pick(map, ["dialog_url", "dialog_link", "ссылка на диалог", "ссылка_на_диалог", "linkdialog", "link_dialog", "link", "linkdialoginmessenger"]));
  if (!dialogId) {
    // Последний шанс: любое значение со ссылкой на диалог Nextbot
    for (const v of map.values()) {
      if (typeof v === "string" && /nextbot/i.test(v) && /dialog/i.test(v)) { dialogId = parseDialogId(v); if (dialogId) break; }
    }
  }

  // Вложения: фото, документы и голосовые. У Nextbot это lastUserImageLink / lastUserDocumentLink / lastUserVideoLink,
  // а списки (userImageLinks) приходят строкой через запятую
  const attachments: string[] = [];
  const addUrls = (v: unknown) => {
    if (typeof v !== "string") return;
    for (const part of v.split(/[,\s]+/)) if (/^https?:\/\//.test(part)) attachments.push(part.trim());
  };
  for (const k of [
    "image_url", "document_url", "audio_url", "video_url", "file_url", "attachment",
    "picture", "photo", "image", "img", "video", "document", "doc", "file", "voice", "audio", "media",
    "lastuserimagelink", "lastuserdocumentlink", "lastuservideolink", "lastuseraudiolink", "lastuservoicelink",
    "userimagelinks", "uservideolinks", "userdocumentlinks", "image_urls", "document_urls",
  ]) addUrls(map.get(k));
  for (const k of ["image_urls", "document_urls", "attachments", "files"]) {
    const v = (body as Record<string, unknown>)[k] ?? (body.args as Record<string, unknown> | undefined)?.[k];
    if (Array.isArray(v)) for (const x of v) if (typeof x === "string" && /^https?:\/\//.test(x)) attachments.push(x);
  }
  const phone = pick(map, ["phone", "phonenumberwhatsapp", "номер телефона из whatsapp", "phone_number", "phonenumber", "телефон", "номер телефона", "wazzupcontactphone", "maxbotcontactphone"]);

  // "" — безымянный параметр функции (бывает у Nextbot). assistantMessage — ответ ИИ-агента: берём его только для события
  // bot_message, иначе ответ бота уехал бы как реплика клиента
  const raw = pick(map, [
    "text", "message", "message_text", "messagetext", "last_message", "lastmessage",
    "lastusermessage", "usermessage", "user_message", "сообщение", "текст", "текст сообщения", "content", "",
    ...(kind === "bot_message" ? ["assistantmessage", ...AGENT_KEYS] : []),
  ]);
  const rawText = raw === null ? null : String(raw).trim() || null;
  const dumpField = pick(map, DUMP_KEYS);
  // «Полный диалог» — отдельным полем full_dialog или (первая настройка) в поле text: тогда text — вся переписка
  const dumpText = [rawText, dumpField === null ? null : String(dumpField)].find(looksLikeDump) ?? null;
  const dump = kind === "client_message" && dumpText ? tailLines(dumpText, DUMP_MAX) : null;
  const clientText = kind === "client_message" ? str(pick(map, CLIENT_TEXT_KEYS), 4000) : null;
  const messengerRaw = pick(map, ["messenger", "мессенджер", "channel", "канал", "platform", "source"]);
  const senderName = str(pick(map, ["name", "nameuser", "имя в мессенджере", "client_name", "clientname", "имя клиента", "имя", "fullname", "full_name", "first_name", "wazzupcontactname", "maxbotcontactname"]), 120);

  const fields: Record<string, string> = {};
  for (const [k, v] of map) if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") fields[k] = String(v).slice(0, 2000);

  return {
    kind,
    dialogId,
    messageId: str(pick(map, ["message_id", "messageid", "msg_id", "id сообщения"]), 120),
    // Если текста нет совсем — последняя реплика собеседника из «Полного диалога» (у события бота — его ответ)
    text: clientText ?? (rawText && rawText !== dumpText ? rawText.slice(0, 4000) : null)
      ?? (dump ? null : lastDialogLine(dumpText ?? map.get("fulldialog"), kind)) ?? "",
    dump,
    agentText: kind === "client_message" ? blank(str(pick(map, AGENT_KEYS), 4000)) : null,
    sendError: blank(str(pick(map, ["errors", "error_message", "last_error", "lasterror", "send_error", "senderror", "ошибка отправки", "последняя ошибка отправки сообщения"]), 500)),
    // Окно проверки бота в конструкторе Nextbot: мессенджер «Тестовый чат», имя «WindowChat»
    testChat: /тестов|test\s*chat|window\s*chat/i.test(String(messengerRaw ?? "")) || /^window\s*chat$/i.test(senderName ?? ""),
    sentAt: eventStamp(body),
    channel: normalizeChannel(messengerRaw),
    name: senderName,
    // Номер, который не узнали (с припиской, не той длины), — как прислан; меньше 7 цифр — не телефон («нет», «-»)
    phone: normalizePhone(phone, phoneCode) ?? (phoneDigits(phone).length >= 7 ? str(phone, 40) : null),
    username: str(pick(map, ["username", "user_name", "telegramusername", "login", "userid", "user_id", "id пользователя", "linkinusermessanger"]), 120),
    attachments: [...new Set(attachments)].slice(0, 5),
    lead: {
      country: str(pick(map, ["country", "страна"]), 80),
      city: str(pick(map, ["city", "город"]), 80),
      amount: toNumber(pick(map, ["amount", "budget", "бюджет", "сумма"])),
      comment: str(pick(map, ["comment", "комментарий", "summary", "итог", "note", "заметка"]), 2000),
    },
    functionName: kind !== "function" ? null : ownFunction ? rawKind : str(pick(map, ["function", "function_name", "functionname", "tool", "функция"]), 80),
    query: blank(str(pick(map, ["query", "запрос", "search", "поиск"]), 120)),
    fields,
  };
}
