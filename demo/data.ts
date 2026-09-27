import type { Attachment, BotState, ChatMessage } from "../src/core/index.js";

// Примерные данные демо-страницы: люди, номера и переписка — вымышленные.

export const ME = { id: "u1", name: "Айгерим" };
export const TZ = "Asia/Bishkek";

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
};

const NOW = Date.now();
const at = (minutesAgo: number, sec = 0) => new Date(NOW - minutesAgo * 60_000 + sec * 1000).toISOString();

let seq = 0;
const id = () => `m${++seq}`;
const client = (min: number, text: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id: id(), at: at(min, 11), kind: "message", author: { type: "client" }, channel: "whatsapp", text, ...extra });
const bot = (min: number, text: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id: id(), at: at(min, 37), kind: "message", author: { type: "bot" }, channel: "whatsapp", text, ...extra });
const me = (min: number, text: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id: id(), at: at(min, 5), kind: "message", author: { type: "operator_crm", name: ME.name, id: ME.id }, channel: "whatsapp", text, delivery: "read", ...extra });
const file = (fid: string, name: string, mime: string, url: string, size?: number): Attachment => ({ id: fid, name, mime, url, ...(size ? { size } : {}) });

export const CONTACTS: DemoContact[] = [
  { id: "1", name: "Азат Тестов", channel: "whatsapp", contact: "+996 555 00-00-01", subtitle: "Польша, рабочая виза D", unread: 1, bot: { mode: "manager", pausedUntil: at(-240), canPause: true, canMute: true }, dismissedAt: null, email: "azat@example.kg" },
  { id: "2", name: "Бакыт Примеров", channel: "instagram", contact: "@bakyt_example", subtitle: "Германия, сварщик", unread: 0, bot: { mode: "bot", canPause: true, canMute: true }, dismissedAt: null },
  { id: "3", name: "Нургуль Образцова", channel: "telegram", contact: "@nurgul_demo", subtitle: "Чехия", unread: 0, bot: { mode: "bot", canPause: true, canMute: true }, dismissedAt: null },
  { id: "4", name: "Эрлан Демо", channel: "whatsapp", contact: "+996 555 00-00-04", subtitle: "новое обращение", unread: 2, bot: { mode: "bot", canPause: true, canMute: true }, dismissedAt: null },
  { id: "5", name: "Клиент из WhatsApp", channel: "whatsapp", contact: "+996 555 00-00-05", subtitle: "новое обращение", unread: 3, bot: { mode: "bot", canPause: true, canMute: true }, dismissedAt: null },
  { id: "6", name: "Жылдыз Пример", channel: "email", contact: "jyldyz@example.kg", subtitle: "Турция, сезонная работа", unread: 0, bot: { mode: "muted", canPause: true, canMute: true }, dismissedAt: null, email: "jyldyz@example.kg" },
  { id: "7", name: "Айбек Пробный", channel: "whatsapp", contact: "+996 555 00-00-07", subtitle: "Польша, договор подписан", unread: 0, bot: { mode: "bot", canPause: true, canMute: true }, dismissedAt: null },
];

export const THREADS: Record<string, ChatMessage[]> = {
  "1": [
    client(26 * 60 + 12, "Салам алейкум! Есть работа в Польше?"),
    bot(26 * 60 + 12, "Здравствуйте, Азат! Да, в Польше сейчас открыты вакансии:\n- **сварщик** — от 2 500 € в месяц\n- **упаковщик** — от 1 400 € в месяц\nПодробнее: [каталог вакансий](https://example.kg/jobs)"),
    client(26 * 60 + 10, "Голосовое сообщение", { attachments: [file("f-voice-1", "Голосовое сообщение", "audio/wav", "/files/voice-1.wav", 224044)] }),
    bot(26 * 60 + 9, "Спасибо! По визе и документам вам лучше поговорить с менеджером — сейчас передам вас нашему менеджеру.", { handoff: true }),
    { id: id(), at: at(26 * 60 + 5), kind: "note", author: { type: "operator_crm", name: ME.name, id: ME.id }, channel: "whatsapp", text: "Опыт сварки 5 лет, нужен вызов к 1 ноября. Перезвонить после 18:00." },
    me(26 * 60 + 2, "Здравствуйте, Азат! Это Айгерим. Пришлите, пожалуйста, фото паспорта — оформим заявку."),
    client(80, "Вот мой паспорт", { attachments: [file("f-passport", "Фото от клиента", "image/jpeg", "/photos/passport.svg")] }),
    { id: id(), at: at(78), kind: "system", author: { type: "system" }, channel: "whatsapp", text: "ИИ-агент в этом диалоге на паузе: менеджер ответил клиенту сам (с телефона) — дальше отвечает человек" },
    { id: id(), at: at(76, 40), kind: "message", author: { type: "operator_phone" }, channel: "whatsapp", text: "Получили, спасибо! Договор пришлю сегодня." },
    me(40, "Договор (пример).pdf", { attachments: [file("f-contract", "Договор (пример).pdf", "application/pdf", "/files/contract.pdf", 1200)] }),
    me(39, "Анкета.docx", { attachments: [file("f-docx", "Анкета.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "/files/questionnaire.docx", 3100)], delivery: "delivered" }),
    client(12, "Спасибо! А когда будет *виза*? Сколько ждать?"),
  ],
  "2": [
    client(190, "Здравствуйте, есть работа сварщиком в Германии?", { channel: "instagram" }),
    bot(190, "Здравствуйте, Бакыт! Да, в Мюнхене нужны сварщики: зарплата от 2 900 € в месяц, жильё за счёт работодателя. Хотите, пришлю список документов?", { channel: "instagram" }),
    client(185, "Да, пришлите", { channel: "instagram" }),
    bot(185, "Вот список:\n1. Загранпаспорт\n2. Диплом или сертификат сварщика\n3. Справка о несудимости\nКогда соберёте — пришлите фото сюда.", { channel: "instagram" }),
    client(60, "Скрин вакансии, про которую спрашивал", { channel: "instagram", attachments: [file("f-vac", "Фото от клиента", "image/jpeg", "/photos/vacancy.svg")] }),
    bot(59, "Да, это наша вакансия. Записать вас на консультацию завтра в 11:00?", { channel: "instagram" }),
  ],
  "3": [
    client(300, "Добрый день! Можно узнать про Чехию?", { channel: "telegram" }),
    me(290, "Здравствуйте, Нургуль! Да, конечно. Какая профессия вас интересует?", { channel: "telegram" }),
    client(280, "Повар", { channel: "telegram" }),
    me(275, "Отправила вам подборку вакансий повара в Праге.", { channel: "telegram", delivery: "failed", deliveryError: "Telegram не принял сообщение: клиент ограничил сообщения" }),
  ],
  "4": [
    client(2 * 24 * 60 + 30, "Здравствуйте"),
    client(2 * 24 * 60 + 29, "Хочу работать в Корее, что нужно?"),
  ],
  "5": [
    client(9, "Салам"),
    client(8, "Сколько стоят ваши услуги?"),
    client(8, "Ответьте пожалуйста"),
  ],
  "6": [
    { id: id(), at: at(3 * 24 * 60), kind: "message", author: { type: "client" }, channel: "email", subject: "Вопрос по сезонной работе", text: "Здравствуйте! Интересует сезонная работа в Турции на лето. Есть ли вакансии в отелях?" },
    { id: id(), at: at(3 * 24 * 60 - 50), kind: "message", author: { type: "operator_crm", name: ME.name, id: ME.id }, channel: "email", subject: "Re: Вопрос по сезонной работе", text: "Добрый день, Жылдыз! Да, набор на сезон откроется в марте. Прайс во вложении.", delivery: "sent", attachments: [file("f-xlsx", "Прайс.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "/files/price.xlsx", 2800)] },
  ],
  "7": [
    { id: id(), at: at(5 * 24 * 60), kind: "call", author: { type: "operator_crm", name: ME.name, id: ME.id }, channel: "call", text: "Договорились о встрече в офисе в пятницу", call: { durationSec: 312 } },
    client(4 * 24 * 60, "Я подписал договор, спасибо!"),
    bot(4 * 24 * 60 - 1, "Поздравляем, Айбек! Дальше менеджер пришлёт список документов для визы."),
    client(3 * 24 * 60, "Голосовое сообщение", { attachments: [file("f-voice-2", "Голосовое сообщение", "audio/wav", "/files/voice-2.wav", 112044)] }),
    me(3 * 24 * 60 - 20, "Айбек, всё получили. Подача в консульство — 14 октября."),
  ],
};

/** Шаблоны под молнией — свои и «по сделке» */
export const TEMPLATES = [
  { label: "Приветствие", text: "Здравствуйте! Это Айгерим, агентство «Пример». Чем могу помочь?", group: "own" },
  { label: "Попросить документы", text: "Пришлите, пожалуйста, фото паспорта и диплома — оформим заявку.", group: "own" },
  { label: "Шаблон: напоминание о документах", text: "Азат, напоминаем — для подачи не хватает:\n1. Справка о несудимости\n2. Медицинская справка", group: "deal" },
  { label: "Напоминание об оплате", text: "Азат, напоминаем об оплате второго этапа — 15 000 сом до 5 октября.", group: "deal" },
  { label: "Проверка: не доставится", text: "Это сообщение покажет, как выглядит ошибка доставки", group: "own" },
];

/** Файлы проекта для скрепки («Из сделки») */
export const DEAL_FILES = [
  { id: "f-contract", name: "Договор (пример).pdf", size: "1 КБ" },
  { id: "f-docx", name: "Анкета.docx", size: "3 КБ" },
];

/** Черновик ответа от бота для менеджера */
export const BOT_DRAFT = "Азат, виза обычно готова за 3–4 недели после подачи. Подача назначена на 14 октября — после неё я сразу напишу вам.";
