import type { ComposerMode } from "./composer.js";

/* Паспорт проекта — всё, чем проект отличается от других, в одном месте: слова отрасли (клиент, пациент, кандидат),
   что включено в окне, метки диалогов, свои карточки в ленте (запись на приём, счёт), свои кнопки в поле ввода
   (кнопка «+»), цвета. Основа набора при этом не меняется — проект только заполняет паспорт:

     const profile = defineProfile({
       company: "Клиника «Пример»", timeZone: "Asia/Bishkek", phoneCode: "+996",
       words: { client: NOUNS.patient, manager: NOUNS.administrator, order: NOUNS.appointment },
       tags: [{ code: "vip", label: "VIP", tone: "violet" }],
       cards: { appointment: { title: "Запись на приём", icon: "calendar", fields: [{ key: "at", label: "Когда", format: "datetime" }] } },
       actions: [{ id: "appointment", label: "Записать на приём", kind: "form", fields: [{ key: "at", label: "Когда", type: "datetime-local", required: true }] }],
     });

   Паспорт — простые данные (без функций): его можно хранить в базе и передавать из серверной страницы в браузерные
   части окна. Тексты с подстановкой пишутся с {скобками} — их заполняет fill(). */

/** Слово в нужных формах: «клиент» — кто, «клиента» — кого, «клиенту» — кому, «клиенты», «клиентов», «о клиенте» */
export type Noun = { one: string; of: string; to: string; many: string; ofMany: string; about: string };

/** Готовые слова для частых отраслей */
export const NOUNS = {
  client: { one: "клиент", of: "клиента", to: "клиенту", many: "клиенты", ofMany: "клиентов", about: "клиенте" },
  patient: { one: "пациент", of: "пациента", to: "пациенту", many: "пациенты", ofMany: "пациентов", about: "пациенте" },
  candidate: { one: "кандидат", of: "кандидата", to: "кандидату", many: "кандидаты", ofMany: "кандидатов", about: "кандидате" },
  buyer: { one: "покупатель", of: "покупателя", to: "покупателю", many: "покупатели", ofMany: "покупателей", about: "покупателе" },
  student: { one: "ученик", of: "ученика", to: "ученику", many: "ученики", ofMany: "учеников", about: "ученике" },
  guest: { one: "гость", of: "гостя", to: "гостю", many: "гости", ofMany: "гостей", about: "госте" },
  manager: { one: "менеджер", of: "менеджера", to: "менеджеру", many: "менеджеры", ofMany: "менеджеров", about: "менеджере" },
  administrator: { one: "администратор", of: "администратора", to: "администратору", many: "администраторы", ofMany: "администраторов", about: "администраторе" },
  recruiter: { one: "рекрутёр", of: "рекрутёра", to: "рекрутёру", many: "рекрутёры", ofMany: "рекрутёров", about: "рекрутёре" },
  consultant: { one: "консультант", of: "консультанта", to: "консультанту", many: "консультанты", ofMany: "консультантов", about: "консультанте" },
  bot: { one: "бот", of: "бота", to: "боту", many: "боты", ofMany: "ботов", about: "боте" },
  assistant: { one: "ассистент", of: "ассистента", to: "ассистенту", many: "ассистенты", ofMany: "ассистентов", about: "ассистенте" },
  order: { one: "заявка", of: "заявки", to: "заявке", many: "заявки", ofMany: "заявок", about: "заявке" },
  appointment: { one: "запись", of: "записи", to: "записи", many: "записи", ofMany: "записей", about: "записи" },
  purchase: { one: "заказ", of: "заказа", to: "заказу", many: "заказы", ofMany: "заказов", about: "заказе" },
  deal: { one: "сделка", of: "сделки", to: "сделке", many: "сделки", ofMany: "сделок", about: "сделке" },
} as const satisfies Record<string, Noun>;

/** Слова отрасли */
export type Words = {
  /** С кем переписываемся: клиент, пациент, кандидат */
  client: Noun;
  /** Кто отвечает из команды: менеджер, администратор, рекрутёр */
  manager: Noun;
  /** Бот в словах: бот, ассистент */
  bot: Noun;
  /** Подпись бота у сообщения: «ИИ-агент», «ИИ-администратор» */
  botLabel: string;
  /** Что ведёт проект по клиенту: заявка, запись, заказ, сделка */
  order: Noun;
};

export const DEFAULT_WORDS: Words = { client: NOUNS.client, manager: NOUNS.manager, bot: NOUNS.bot, botLabel: "ИИ-агент", order: NOUNS.order };

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
/** «о клиенте», «об ученике» */
const about = (n: Noun) => `${/^[аеёиоуыэюя]/i.test(n.about) ? "об" : "о"} ${n.about}`;

/** Подставить значения в текст паспорта: fill("бот на паузе до {until}", { until: "18:30" }) */
export function fill(text: string, vars: Readonly<Record<string, string | number>>): string {
  return text.replace(/\{(\w+)\}/g, (all, key: string) => (key in vars ? String(vars[key]) : all));
}

/** Все надписи окна, где встречаются слова отрасли. Любую можно заменить в паспорте (texts) */
export type Texts = ReturnType<typeof makeTexts>;

/** Надписи окна из слов отрасли */
export function makeTexts(w: Words = DEFAULT_WORDS) {
  const C = w.client, M = w.manager, B = w.bot;
  return {
    // Кто написал
    authorClient: C.one,
    authorBot: w.botLabel,
    authorManager: M.one,
    authorPhone: `${M.one} с телефона`,
    /** {name} — имя сотрудника */
    authorPhoneNamed: "{name} · с телефона",
    authorAdmin: "администратор",
    authorSystem: "служебное",
    authorMe: "вы",
    fromClient: `от ${C.of}`,
    // Список диалогов
    listTitle: "Переписка",
    listPrefixBot: `${w.botLabel}: `,
    listPrefixPhone: `${cap(M.one)} с телефона: `,
    listPrefixMe: "Вы: ",
    listPrefixManager: `${cap(M.one)}: `,
    listAllAnswered: `Все ${C.many} получили ответ`,
    listEmpty: "Диалогов пока нет",
    listNoName: "Без имени",
    listSearch: "Поиск по имени и тексту",
    listMine: "Мои",
    listOpen: "Открытые",
    listSnoozed: "Отложенные",
    listClosed: "Закрытые",
    // Лента
    handoffBadge: `передал ${M.to} — нужен ответ человека`,
    shadowBadge: `черновик ${B.of} — ${C.to} не ушёл`,
    reply: "Ответить",
    replyTo: "Ответ на сообщение",
    // Поле ввода
    tabSend: cap(C.to),
    /** {channel} — канал */
    tabSendAbout: `ответ уйдёт ${C.to} в {channel}`,
    tabCopy: "В историю",
    tabCopyAbout: `${C.one} не пишет нам через подключённый канал: сообщение сохранится в истории, ${C.to} не уйдёт`,
    tabNote: "Заметка",
    tabNoteAbout: `видит только команда, ${C.to} не уходит`,
    tabEmail: "Письмо",
    sendToClient: `Отправить ${C.to}`,
    notePlaceholder: `Заметка для команды — ${C.one} её не увидит`,
    copyInPlaceholder: `Что написал ${C.one}…`,
    copyOutPlaceholder: `Что мы написали ${C.to}…`,
    dirIn: `${C.one} написал`,
    dirOut: "мы написали",
    fileHint: `Файл уйдёт ${C.to}`,
    projectFiles: `Файлы ${C.of}`,
    projectActions: "Действия",
    // Бот
    botLeads: `${B.one} ведёт диалог`,
    botPaused: `${B.one} на паузе`,
    /** {until} — «18:30» */
    botPausedUntil: `${B.one} на паузе до {until}`,
    botPausedHuman: `${B.one} на паузе — отвечает человек`,
    botMutedShort: `${B.one} не отвечает`,
    botMuted: `${B.one} не отвечает этому ${C.to}`,
    botCalled: `${B.one} позвал человека`,
    botPause: `Пауза ${B.of}`,
    botPauseTitle: `${cap(B.one)} замолчит на 12 часов — отвечает человек`,
    botResume: `Вернуть ${B.to}`,
    botResumeTitle: `${cap(B.one)} ответит на следующее сообщение ${C.of}`,
    botMute: "Не отвечать",
    botMuteLong: `Не отвечать этому ${C.to}`,
    botMuteTitle: `Не отвечать этому ${C.to}: ${B.one} не будет отвечать ему ни в одном канале — пишет только человек`,
    botUnmute: `Разрешить ${B.to}`,
    botUnmuteLong: `${cap(B.one)} снова может отвечать`,
    botUnmuteTitle: `${cap(B.one)} снова может отвечать этому ${C.to}`,
    botGroup: `${cap(B.one)} в этом диалоге`,
    copilotTitle: `${cap(B.one)} предлагает ответ`,
    teachFixDone: `✎ ${B.one} научится: как надо было`,
    teachIdealPlaceholder: `Как надо было ответить — ${B.one} научится на этом примере`,
    teachExample: `Сделать примером для ${B.of}`,
    teachExampleTitle: `Хороший ответ — ${B.one} будет отвечать так же, когда вы одобрите пример`,
    teachExampleHead: `Пример для ${B.of}: вопрос ${C.of} выше → этот ответ`,
    memoryTitle: `Что ${B.one} знает ${about(C)}`,
    memoryEmpty: `${cap(B.one)} пока ничего не узнал — узнает из разговора.`,
    memoryFromCard: `Из карточки ${C.of}`,
    // Ожидание ответа
    waitWhyHandoff: `— ${w.botLabel} передал ${C.of} ${M.to}`,
    waitWhyClient: `— ${C.one} написал последним`,
    waitDismissTitle: `Например, ${C.one} написал «спасибо» — он уйдёт из «Ждут ответа» до следующего сообщения`,
    alertClientWrote: `${cap(C.one)} написал`,
    // Полоса под шапкой: статус, метки, ответственный
    statusOpen: "Открыт",
    statusSnoozed: "Отложен",
    /** {until} — «до 18:00» */
    statusSnoozedUntil: "Отложен {until}",
    statusClosed: "Закрыт",
    snooze: "Отложить",
    close: "Закрыть диалог",
    reopen: "Открыть снова",
    assignee: "Ответственный",
    assigneeNone: "не назначен",
    addTag: "метка",
    urgent: "срочно",
    unhappy: "недоволен",
    happy: "доволен",
    // Кнопки в шапке
    filter: "Фильтр сообщений",
    files: `Все файлы ${C.of}`,
    summary: "Кратко",
    summaryTitle: "Кратко о переписке",
    // Фильтр ленты
    filterAll: "Все",
    filterClient: cap(C.one),
    filterBot: cap(B.one),
    filterTeam: "Команда",
    filterNotes: "Заметки",
    filterFiles: "Файлы",
    filterVoice: "Голосовые",
    filterCalls: "Звонки",
    // ИИ
    transcribe: "Расшифровать",
    transcript: "Текст голосового",
    improve: "Улучшить текст",
    improveUndo: "Вернуть как было",
  };
}

export const DEFAULT_TEXTS: Texts = makeTexts();

/** Цвет метки, карточки, статуса */
export type Tone = "accent" | "blue" | "green" | "amber" | "red" | "violet" | "gray";

export type ProfileTag = { code: string; label: string; tone?: Tone | undefined };

/** Значок карточки и кнопки проекта — из набора (не картинкой: так он одинаково выглядит в любой теме) */
export type ProfileIcon = "calendar" | "briefcase" | "receipt" | "box" | "doc" | "star" | "pin" | "user" | "money" | "check" | "clock" | "phone";

export type CardField = {
  key: string;
  label: string;
  /** Как показать значение: дата и время — по поясу компании, деньги — с валютой */
  format?: "text" | "date" | "datetime" | "time" | "money" | "phone" | "number" | undefined;
};

/** Своя карточка в ленте: как показать MessageCard этого вида */
export type CardDef = {
  title: string;
  icon?: ProfileIcon | undefined;
  tone?: Tone | undefined;
  /** Поле с заголовком вместо title («Консультация терапевта») */
  titleKey?: string | undefined;
  fields: readonly CardField[];
  /** Поле со статусом и подписи статусов: { confirmed: { label: "Подтверждено", tone: "green" } } */
  statusKey?: string | undefined;
  statuses?: Readonly<Record<string, { label: string; tone?: Tone | undefined }>> | undefined;
  /** Поле со ссылкой на запись в CRM — «Открыть» */
  linkKey?: string | undefined;
};

/** Поле маленькой формы кнопки проекта */
export type ActionField = {
  key: string;
  label: string;
  type?: "text" | "textarea" | "date" | "time" | "datetime-local" | "number" | "tel" | "select" | undefined;
  options?: readonly string[] | undefined;
  required?: boolean | undefined;
  placeholder?: string | undefined;
  /** Значение по умолчанию */
  value?: string | undefined;
};

/** Своя кнопка в поле ввода (меню «+»): вставить текст, открыть маленькую форму (её получает действие проекта) или
 *  открыть адрес проекта */
export type ComposerAction = {
  id: string;
  label: string;
  /** Пояснение в меню */
  hint?: string | undefined;
  icon?: ProfileIcon | undefined;
  kind: "insert" | "form" | "link";
  /** insert: текст в поле ({client} — имя собеседника) */
  text?: string | undefined;
  /** link: адрес ({id} — номер диалога) */
  href?: string | undefined;
  /** form: поля */
  fields?: readonly ActionField[] | undefined;
  submitLabel?: string | undefined;
};

/** Что включено в окне. Выключенное не показывается, даже если проект передал действие */
export type Features = {
  /** Вкладки поля ввода; null — все подходящие */
  modes: readonly ComposerMode[] | null;
  templates: boolean;
  files: boolean;
  /** Запись голосового из браузера (микрофон) */
  voice: boolean;
  find: boolean;
  filter: boolean;
  gallery: boolean;
  bot: boolean;
  copilot: boolean;
  teach: boolean;
  memory: boolean;
  statuses: boolean;
  tags: boolean;
  assignee: boolean;
  presence: boolean;
  assessment: boolean;
  transcribe: boolean;
  summary: boolean;
  improve: boolean;
};

export const DEFAULT_FEATURES: Features = {
  modes: null, templates: true, files: true, voice: true, find: true, filter: true, gallery: true,
  bot: true, copilot: true, teach: true, memory: true,
  statuses: true, tags: true, assignee: true, presence: true, assessment: true,
  transcribe: true, summary: true, improve: true,
};

export type ChatProfile = {
  company: string;
  timeZone: string;
  /** Телефонный код страны компании: «+996» */
  phoneCode: string;
  /** Валюта для денег в карточках: «сом», «₸», «₽» */
  currency: string;
  words: Words;
  texts: Texts;
  features: Features;
  tags: readonly ProfileTag[];
  cards: Readonly<Record<string, CardDef>>;
  actions: readonly ComposerAction[];
  /** Цвета окна: { "--ck-accent": "#0f766e" } — profileCss() соберёт их в CSS */
  theme: Readonly<Record<string, string>>;
};

export type ProfileInput = {
  company?: string | undefined;
  timeZone?: string | undefined;
  phoneCode?: string | undefined;
  currency?: string | undefined;
  words?: Partial<Words> | undefined;
  texts?: Partial<Texts> | undefined;
  features?: Partial<Features> | undefined;
  tags?: readonly ProfileTag[] | undefined;
  cards?: Readonly<Record<string, CardDef>> | undefined;
  actions?: readonly ComposerAction[] | undefined;
  theme?: Readonly<Record<string, string>> | undefined;
};

/** Паспорт проекта: то, что не задано, — по умолчанию */
export function defineProfile(p: ProfileInput = {}): ChatProfile {
  const words: Words = { ...DEFAULT_WORDS, ...p.words };
  return {
    company: p.company ?? "",
    timeZone: p.timeZone ?? "UTC",
    phoneCode: p.phoneCode ?? "",
    currency: p.currency ?? "",
    words,
    texts: { ...makeTexts(words), ...p.texts },
    features: { ...DEFAULT_FEATURES, ...p.features },
    tags: p.tags ?? [],
    cards: p.cards ?? {},
    actions: p.actions ?? [],
    theme: p.theme ?? {},
  };
}

/** Цвета паспорта → CSS для <style>: «:root { --ck-accent: #0f766e; }». Берёт только переменные --ck-* и значения
 *  без знаков, которыми можно вырваться из правила: паспорт может лежать в базе и правиться в настройках */
export function profileCss(p: Pick<ChatProfile, "theme">, selector = ":root"): string {
  const rules = Object.entries(p.theme)
    .filter(([k, v]) => /^--ck-[a-z0-9-]+$/.test(k) && typeof v === "string" && v.length <= 200 && !/[;{}<>\\]/.test(v))
    .map(([k, v]) => `${k}: ${v.trim()};`);
  return rules.length ? `${selector} { ${rules.join(" ")} }` : "";
}

/** Значение поля карточки для показа: дата и время — по поясу компании, деньги — с валютой */
export function formatCardValue(v: string | number | boolean | null | undefined, format: CardField["format"], o: { timeZone?: string | undefined; currency?: string | undefined } = {}): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "да" : "нет";
  const tz = o.timeZone;
  if (format === "date" || format === "datetime" || format === "time") {
    const d = new Date(typeof v === "number" ? v : String(v));
    if (!Number.isFinite(d.getTime())) return String(v);
    const opts: Intl.DateTimeFormatOptions = format === "date" ? { day: "numeric", month: "long", year: "numeric" }
      : format === "time" ? { hour: "2-digit", minute: "2-digit" }
      : { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" };
    try {
      return new Intl.DateTimeFormat("ru-RU", { ...opts, ...(tz ? { timeZone: tz } : {}) }).format(d);
    } catch {
      return new Intl.DateTimeFormat("ru-RU", opts).format(d);
    }
  }
  if (format === "money" || format === "number") {
    const n = typeof v === "number" ? v : Number(String(v).replace(/\s/g, "").replace(",", "."));
    if (!Number.isFinite(n)) return String(v);
    const s = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(n);
    return format === "money" && o.currency ? `${s} ${o.currency}` : s;
  }
  return String(v);
}
