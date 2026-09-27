import type { Assessment, Assignee, Attachment, BotState, ChatMessage, DialogStatus } from "../src/core/index.js";
import type { ProfileInput } from "../src/core/profile.js";

// Примерные данные демо-страницы: компания, люди, номера и переписка — вымышленные.

export const ME: Assignee = { id: "u1", name: "Айгерим" };
export const MANAGERS: Assignee[] = [ME, { id: "u2", name: "Бакыт" }, { id: "u3", name: "Нурлан" }];
export const TZ = "Asia/Bishkek";

/** Паспорт демо-компании: метки, свои карточки (запись, счёт) и кнопки меню «+» */
export const PROFILE: ProfileInput = {
  company: "Сервис «Пример»",
  timeZone: TZ,
  phoneCode: "+996",
  currency: "сом",
  tags: [
    { code: "vip", label: "VIP", tone: "violet" },
    { code: "new", label: "Новый", tone: "blue" },
    { code: "complaint", label: "Жалоба", tone: "red" },
    { code: "regular", label: "Постоянный", tone: "green" },
  ],
  cards: {
    appointment: {
      title: "Запись", icon: "calendar", tone: "blue",
      fields: [{ key: "at", label: "Когда", format: "datetime" }, { key: "service", label: "Услуга" }, { key: "specialist", label: "Специалист" }],
      statusKey: "status",
      statuses: { planned: { label: "Запланирована", tone: "blue" }, confirmed: { label: "Подтверждена", tone: "green" }, cancelled: { label: "Отменена", tone: "red" } },
    },
    invoice: {
      title: "Счёт", icon: "receipt", tone: "amber",
      fields: [{ key: "sum", label: "Сумма", format: "money" }, { key: "for", label: "За что" }, { key: "until", label: "Оплатить до", format: "date" }],
      statusKey: "status",
      statuses: { waiting: { label: "Ждёт оплаты", tone: "amber" }, paid: { label: "Оплачен", tone: "green" } },
      linkKey: "link",
    },
  },
  actions: [
    {
      id: "appointment", label: "Записать", hint: "дата, время и услуга — {client} получит подтверждение", icon: "calendar", kind: "form", submitLabel: "Записать",
      fields: [
        { key: "at", label: "Когда", type: "datetime-local", required: true },
        { key: "service", label: "Услуга", type: "select", options: ["Консультация", "Диагностика", "Повторный приём"], required: true },
        { key: "specialist", label: "Специалист", placeholder: "Имя специалиста" },
      ],
    },
    {
      id: "invoice", label: "Выставить счёт", hint: "сумма и за что — уйдёт ссылкой на оплату", icon: "receipt", kind: "form", submitLabel: "Выставить",
      fields: [{ key: "sum", label: "Сумма, сом", type: "number", required: true }, { key: "for", label: "За что", required: true }],
    },
    { id: "address", label: "Адрес и часы работы", hint: "вставить в поле", icon: "pin", kind: "insert", text: "{client}, наш адрес: г. Бишкек, ул. Примерная, 1. Работаем с 9:00 до 19:00 без выходных." },
    { id: "card", label: "Открыть карточку в CRM", hint: "страница проекта", icon: "user", kind: "link", href: "#client-{id}" },
  ],
};

export type DemoContact = {
  id: string;
  name: string;
  channel: string;
  contact: string;
  subtitle: string;
  unread: number;
  bot: BotState;
  dismissedAt: string | null;
  email?: string;
  status: DialogStatus;
  statusAt: string;
  snoozedUntil?: string | null;
  tags: string[];
  assignee: Assignee | null;
  assessment?: Assessment | null;
};

const NOW = Date.now();
const at = (minutesAgo: number, sec = 0) => new Date(NOW - minutesAgo * 60_000 + sec * 1000).toISOString();

let seq = 0;
const id = () => `m${++seq}`;
const client = (min: number, text: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id: id(), at: at(min, 11), kind: "message", author: { type: "client" }, channel: "whatsapp", text, externalId: `demo:${seq}`, ...extra });
const bot = (min: number, text: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id: id(), at: at(min, 37), kind: "message", author: { type: "bot" }, channel: "whatsapp", text, ...extra });
const me = (min: number, text: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id: id(), at: at(min, 5), kind: "message", author: { type: "operator_crm", name: ME.name, id: ME.id }, channel: "whatsapp", text, delivery: "read", ...extra });
const file = (fid: string, name: string, mime: string, url: string, extra: Partial<Attachment> = {}): Attachment => ({ id: fid, name, mime, url, ...extra });

export const CONTACTS: DemoContact[] = [
  {
    id: "1", name: "Азат Тестов", channel: "whatsapp", contact: "+996 555 00-00-01", subtitle: "консультация, запись на пятницу", unread: 1,
    bot: { mode: "manager", pausedUntil: at(-240), canPause: true, canMute: true }, dismissedAt: null, email: "azat@example.kg",
    status: "open", statusAt: at(3000), tags: ["vip"], assignee: ME,
    assessment: { mood: "negative", urgency: "high", reason: "третий раз спрашивает про время записи", at: at(12) },
  },
  {
    id: "2", name: "Бакыт Примеров", channel: "instagram", contact: "@bakyt_example", subtitle: "спрашивал про цены", unread: 0,
    bot: { mode: "bot", canPause: true, canMute: true }, dismissedAt: null, status: "open", statusAt: at(3000), tags: ["new"], assignee: null,
  },
  {
    id: "3", name: "Нургуль Образцова", channel: "telegram", contact: "@nurgul_demo", subtitle: "подбор услуги", unread: 0,
    bot: { mode: "bot", canPause: true, canMute: true }, dismissedAt: null, status: "open", statusAt: at(3000), tags: [], assignee: MANAGERS[1]!,
  },
  {
    id: "4", name: "Эрлан Демо", channel: "whatsapp", contact: "+996 555 00-00-04", subtitle: "новое обращение", unread: 2,
    bot: { mode: "bot", canPause: true, canMute: true }, dismissedAt: null, status: "open", statusAt: at(5000), tags: ["new"], assignee: null,
  },
  {
    id: "5", name: "Клиент из WhatsApp", channel: "whatsapp", contact: "+996 555 00-00-05", subtitle: "новое обращение", unread: 3,
    bot: { mode: "bot", canPause: true, canMute: true }, dismissedAt: null, status: "open", statusAt: at(60), tags: [], assignee: null,
    assessment: { mood: "neutral", urgency: "high", reason: "просит ответить срочно", at: at(8) },
  },
  {
    id: "6", name: "Жылдыз Пример", channel: "email", contact: "jyldyz@example.kg", subtitle: "ждёт прайс на весну", unread: 0,
    bot: { mode: "muted", canPause: true, canMute: true }, dismissedAt: null, email: "jyldyz@example.kg",
    status: "snoozed", statusAt: at(2000), snoozedUntil: at(-24 * 60), tags: ["regular"], assignee: ME,
  },
  {
    id: "7", name: "Айбек Пробный", channel: "whatsapp", contact: "+996 555 00-00-07", subtitle: "услуга оказана", unread: 0,
    bot: { mode: "bot", canPause: true, canMute: true }, dismissedAt: null, status: "closed", statusAt: at(2 * 24 * 60), tags: ["regular"], assignee: MANAGERS[2]!,
  },
];

const greet = me(26 * 60 + 2, "Здравствуйте, Азат! Это Айгерим. Пришлите, пожалуйста, фото документа — оформим запись.");

export const THREADS: Record<string, ChatMessage[]> = {
  "1": [
    client(26 * 60 + 12, "Салам алейкум! Можно записаться на консультацию?"),
    bot(26 * 60 + 12, "Здравствуйте, Азат! Да, конечно. Свободное время на этой неделе:\n- **среда** — 11:00 и 15:00\n- **пятница** — 10:00\nПодробнее: [услуги и цены](https://example.kg/prices)"),
    client(26 * 60 + 10, "Голосовое сообщение", {
      attachments: [file("f-voice-1", "Голосовое сообщение", "audio/wav", "/files/voice-1.wav", {
        size: 224044, transcript: "Здравствуйте, я хотел бы уточнить: можно ли прийти в пятницу утром и сколько длится консультация?",
      })],
    }),
    bot(26 * 60 + 9, "Спасибо! По времени и деталям вам лучше поговорить с менеджером — сейчас передам вас нашему менеджеру.", { handoff: true }),
    { id: id(), at: at(26 * 60 + 5), kind: "note", author: { type: "operator_crm", name: ME.name, id: ME.id }, channel: "whatsapp", text: "Постоянный клиент, просит утро. Перезвонить после 18:00." },
    greet,
    client(80, "Вот фото", { attachments: [file("f-doc", "Фото от клиента", "image/jpeg", "/photos/document.svg")] }),
    { id: id(), at: at(78), kind: "system", author: { type: "system" }, channel: "whatsapp", text: "ИИ-агент в этом диалоге на паузе: менеджер ответил клиенту сам (с телефона) — дальше отвечает человек" },
    { id: id(), at: at(76, 40), kind: "message", author: { type: "operator_phone" }, channel: "whatsapp", text: "Получили, спасибо! Договор пришлю сегодня." },
    me(40, "Договор (пример).pdf", { attachments: [file("f-contract", "Договор (пример).pdf", "application/pdf", "/files/contract.pdf", { size: 1200 })] }),
    me(39, "Анкета.docx", { attachments: [file("f-docx", "Анкета.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "/files/questionnaire.docx", { size: 3100 })], delivery: "delivered" }),
    me(38, "Записала вас на пятницу:", {
      card: { type: "appointment", data: { at: at(-3 * 24 * 60 + 600), service: "Консультация", specialist: "Д. Асанова", status: "planned" } },
    }),
    { id: id(), at: at(30), kind: "call", author: { type: "client" }, channel: "call", text: "Пропущенный звонок", call: { direction: "in", missed: true } },
    client(12, "А во сколько точно? Мне *очень* важно прийти утром", { replyTo: { id: greet.id } }),
  ],
  "2": [
    client(190, "Здравствуйте, сколько стоит диагностика?", { channel: "instagram" }),
    bot(190, "Здравствуйте, Бакыт! Диагностика — 1 500 сом, длится 40 минут. Хотите, запишу вас на удобное время?", { channel: "instagram" }),
    client(185, "Да, а можно в выходные?", { channel: "instagram" }),
    bot(185, "Да, по субботам работаем с 10:00 до 16:00. Пришлите удобное время — я запишу.", { channel: "instagram" }),
    client(60, "Скрин прайса, про который спрашивал", { channel: "instagram", attachments: [file("f-price-shot", "Фото от клиента", "image/jpeg", "/photos/screenshot.svg")] }),
    bot(59, "Да, это наш прайс. Записать вас на субботу в 11:00?", { channel: "instagram" }),
  ],
  "3": [
    client(300, "Добрый день! Подскажите, какая услуга мне подойдёт?", { channel: "telegram" }),
    { id: id(), at: at(290), kind: "message", author: { type: "operator_crm", name: "Бакыт", id: "u2" }, channel: "telegram", text: "Здравствуйте, Нургуль! Расскажите, что вас беспокоит, — подберём.", delivery: "read" },
    client(280, "Нужна консультация по уходу", { channel: "telegram" }),
    me(275, "Отправила вам подборку услуг и цен.", { channel: "telegram", delivery: "failed", deliveryError: "Telegram не принял сообщение: клиент ограничил сообщения" }),
  ],
  "4": [
    client(2 * 24 * 60 + 30, "Здравствуйте"),
    client(2 * 24 * 60 + 29, "Хочу записаться, что для этого нужно?"),
  ],
  "5": [
    client(9, "Салам"),
    client(8, "Сколько стоят ваши услуги?"),
    client(8, "Ответьте пожалуйста, срочно"),
  ],
  "6": [
    { id: id(), at: at(3 * 24 * 60), kind: "message", author: { type: "client" }, channel: "email", subject: "Вопрос по ценам", text: "Здравствуйте! Пришлите, пожалуйста, цены на весенний сезон." },
    { id: id(), at: at(3 * 24 * 60 - 50), kind: "message", author: { type: "operator_crm", name: ME.name, id: ME.id }, channel: "email", subject: "Re: Вопрос по ценам", text: "Добрый день, Жылдыз! Новые цены будут в марте — пришлю сразу. Текущий прайс во вложении.", delivery: "sent", attachments: [file("f-xlsx", "Прайс.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "/files/price.xlsx", { size: 2800 })] },
    me(3 * 24 * 60 - 49, "Счёт на предоплату сезона:", {
      channel: "email", delivery: "sent",
      card: { type: "invoice", data: { sum: 4500, for: "Предоплата весеннего сезона", until: at(-7 * 24 * 60), status: "waiting", link: "https://example.kg/pay/demo" } },
    }),
  ],
  "7": [
    {
      id: id(), at: at(5 * 24 * 60), kind: "call", author: { type: "operator_phone", name: "Нурлан" }, channel: "call", text: "Исходящий звонок",
      call: { direction: "out", durationSec: 312, manager: "Нурлан" },
      attachments: [file("f-voice-2", "Запись разговора", "audio/wav", "/files/voice-2.wav", { size: 112044 })],
    },
    client(4 * 24 * 60, "Спасибо, всё понравилось!"),
    bot(4 * 24 * 60 - 1, "Рады помочь, Айбек! Будем ждать вас снова."),
    client(3 * 24 * 60, "Голосовое сообщение", { attachments: [file("f-voice-3", "Голосовое сообщение", "audio/wav", "/files/voice-1.wav", { size: 224044 })] }),
    { id: id(), at: at(3 * 24 * 60 - 20), kind: "message", author: { type: "operator_crm", name: "Нурлан", id: "u3" }, channel: "whatsapp", text: "Айбек, спасибо за отзыв! Скидка 10% на следующий визит уже в вашей карточке.", delivery: "read" },
  ],
};

/** Раньше показанных: подгружаются при прокрутке вверх (диалог 1) */
export const OLDER: Record<string, ChatMessage[]> = {
  "1": [
    client(9 * 24 * 60, "Здравствуйте, вы работаете в воскресенье?"),
    bot(9 * 24 * 60 - 1, "Здравствуйте! Да, в воскресенье с 10:00 до 16:00."),
    client(9 * 24 * 60 - 3, "Спасибо, приду в следующий раз"),
  ],
};

/** Расшифровки голосовых и записей для кнопки «Расшифровать» (понарошку) */
export const TRANSCRIPTS: Record<string, string> = {
  "f-voice-2": "— Айбек, добрый день, это Нурлан из сервиса «Пример». Удобно говорить?\n— Да, здравствуйте.\n— Напоминаю про визит в четверг в 15:00. Всё в силе?\n— Да, приду.",
  "f-voice-3": "Спасибо большое, всё прошло отлично. Хочу записать ещё и жену на следующую неделю.",
};

/** Шаблоны под молнией — свои и «по заказу» */
export const TEMPLATES = [
  { label: "Приветствие", text: "Здравствуйте! Это Айгерим, сервис «Пример». Чем могу помочь?", group: "own" },
  { label: "Попросить фото", text: "Пришлите, пожалуйста, фото документа — оформим запись.", group: "own" },
  { label: "Напоминание о визите", text: "Азат, напоминаем: вы записаны на пятницу в 10:00. Ждём вас!", group: "order" },
  { label: "Напоминание об оплате", text: "Азат, напоминаем об оплате — 1 500 сом до пятницы.", group: "order" },
  { label: "Проверка: не доставится", text: "Это сообщение покажет, как выглядит ошибка доставки", group: "own" },
];

/** Файлы проекта для скрепки («Из заявки клиента») */
export const PROJECT_FILES = [
  { id: "f-contract", name: "Договор (пример).pdf", size: "1 КБ" },
  { id: "f-docx", name: "Анкета.docx", size: "3 КБ" },
];

/** Что бот узнал о клиентах (память бота) */
export const MEMORY: Record<string, { key: string; label: string; value: string; source?: "bot" | "crm" | "admin" }[]> = {
  "1": [
    { key: "service", label: "Услуга", value: "консультация", source: "bot" },
    { key: "time", label: "Удобное время", value: "утро, пятница", source: "bot" },
    { key: "docs", label: "Документы", value: "фото прислал", source: "crm" },
  ],
  "2": [
    { key: "service", label: "Услуга", value: "диагностика", source: "bot" },
    { key: "time", label: "Удобное время", value: "выходные", source: "bot" },
  ],
  "4": [{ key: "service", label: "Услуга", value: "пока не выбрал", source: "bot" }],
};

/** «Второй пилот»: что бот предложил бы ответить на последнее сообщение клиента */
export function suggestReply(clientText: string, name: string): string {
  const first = name.split(/\s+/)[0] ?? "";
  const hi = first && !/^клиент/i.test(first) ? `${first}, ` : "";
  if (/во сколько|время|утр/i.test(clientText)) return `${hi}в пятницу свободно 10:00 — записать вас на это время?`;
  if (/стоят|цен|стоимост/i.test(clientText)) return `${hi}консультация — 1 000 сом, диагностика — 1 500 сом. На какую услугу вас записать?`;
  if (/записаться|нужно/i.test(clientText)) return `${hi}для записи напишите удобный день и время — я всё оформлю.`;
  return `${hi}спасибо за сообщение! Уточню и отвечу в течение часа.`;
}
