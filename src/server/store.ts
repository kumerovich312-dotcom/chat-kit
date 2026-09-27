import type { Author, CallInfo, Delivery, MessageCard, MessageKind, MessageQuote } from "../core/model.js";

/* «Переходник» к базе проекта (ChatStore). Каждый проект хранит клиентов, сообщения, файлы, сотрудников и права сам
   и пишет один файл, который умеет пять вещей:
   1) найти или создать клиента по телефону или внешнему номеру;
   2) записать сообщение без повторов;
   3) сохранить файл;
   4) отметить «ждёт ответа»;
   5) сообщить открытым вкладкам.
   Разделение компаний (org_id в каждом запросе или правила строк в базе) остаётся внутри переходника: набор
   о компаниях не знает — проект создаёт переходник уже для своей компании (например, по ключу из вебхука).

   Остальные методы — по желанию: их просят подключения с «неточными» каналами (Nextbot), чтобы не задвоить
   сообщения и поставить их в правильном порядке. */

/** По чему найти или завести клиента */
export type ContactHint = {
  /** Подключение, откуда пришло: «telegram», «green-api», «nextbot», «site»… */
  source: string;
  /** Номер собеседника у подключения: чат Telegram, адрес WhatsApp, диалог Nextbot, почта, посетитель сайта */
  externalId: string;
  /** Канал: whatsapp, instagram, telegram… */
  channel: string;
  /** Телефон в международном виде, если известен */
  phone?: string | null | undefined;
  /** Телефон подлинный — из самого мессенджера (WhatsApp), а не назван собеседником. Только по такому номеру можно
   *  привязать диалог к уже известному клиенту: в Instagram и Telegram посторонний мог бы назвать чужой номер
   *  и получить чужую переписку */
  phoneTrusted?: boolean | undefined;
  /** Почта — у писем и у посетителя сайта, если он её оставил */
  email?: string | null | undefined;
  name?: string | null | undefined;
  username?: string | null | undefined;
};

export type ContactRef = {
  contactId: string;
  /** Клиента только что завели */
  created: boolean;
  /** Как клиент записан в проекте — по имени Nextbot узнаёт его реплики в «Полном диалоге» */
  name?: string | null | undefined;
  /** Канал, через который клиент уже писал, — если в событии канал не указан (заявка) */
  channel?: string | null | undefined;
};

export type NewMessage = {
  kind: MessageKind;
  author: Author;
  channel: string;
  text: string;
  /** Когда написано — ISO-время с миллисекундами (набор уже поставил его в правильный порядок) */
  at: string;
  /** Ключ повтора: второе сообщение с тем же ключом не записывается */
  externalId?: string | null | undefined;
  delivery?: Delivery | null | undefined;
  deliveryError?: string | null | undefined;
  handoff?: boolean | undefined;
  subject?: string | null | undefined;
  /** Сохранённый файл (saveFile) — сообщение с вложением */
  fileId?: string | null | undefined;
  /** Ответ на сообщение: номер цитируемого у канала (externalId) — переходник найдёт его у себя; текст — если не найдёт */
  replyTo?: MessageQuote | null | undefined;
  shadow?: boolean | undefined;
  /** Звонок (kind: "call") */
  call?: CallInfo | null | undefined;
  /** Карточка проекта */
  card?: MessageCard | null | undefined;
};

export type SavedMessage = {
  id: string;
  /** Такое сообщение уже было (тот же ключ повтора) — ничего не записано */
  duplicate: boolean;
};

export type NewFile = {
  data: Uint8Array;
  /** Тип по содержимому файла, а не по имени */
  mime: string;
  ext: string;
  /** Как назвать в переписке: «Фото от клиента», «Договор.docx» */
  name: string;
  sha1: string;
  sha256: string;
  /** Откуда скачан */
  sourceUrl?: string | null | undefined;
  /** Файл пришёл от клиента (иначе — наш: менеджер с рабочего номера, бот) */
  fromClient: boolean;
};

export type SavedFile = { fileId: string };

/** Что изменилось в ожидании ответа: клиент написал, ответили, бот позвал человека */
export type WaitChange =
  | { type: "client_wrote"; at: string }
  | { type: "answered"; at: string }
  | { type: "handoff"; at: string };

/** Что сообщить открытым вкладкам */
export type LiveEvent = {
  contactId: string | null;
  /** message — новое сообщение, status — доставка, state — пауза бота и прочее, file — файл забран */
  kind: "message" | "status" | "state" | "file";
  wait?: WaitChange | undefined;
};

/** Уже записанное сообщение — для сверки неточных каналов */
export type StoredMessage = {
  id: string;
  at: string;
  author: Author;
  text: string;
  externalId?: string | null | undefined;
  fileId?: string | null | undefined;
  delivery?: Delivery | null | undefined;
};

export type MessageQuery = {
  /** Сообщения с этими ключами повтора */
  externalIds?: readonly string[] | undefined;
  /** Наши сообщения с этими текстами (в любое время) */
  outgoingTexts?: readonly string[] | undefined;
  /** И ещё последние N наших сообщений */
  lastOutgoing?: number | undefined;
};

export type MessagePatch = {
  author?: Author | undefined;
  handoff?: boolean | undefined;
  fileId?: string | undefined;
  text?: string | undefined;
  delivery?: Delivery | undefined;
  deliveryError?: string | null | undefined;
  externalId?: string | undefined;
};

/** Маленькое хранилище «ключ → значение» для подключений (папки хранилища Nextbot, время последних событий) */
export interface KeyValue {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  /** Удалить ключ (по желанию: подключения убирают за собой отработанные записи) */
  delete?(key: string): Promise<void>;
}

export interface ChatStore {
  /** 1. Найти или создать клиента */
  findOrCreateContact(hint: ContactHint): Promise<ContactRef>;
  /** 2. Записать сообщение без повторов (ключ повтора — externalId) */
  saveMessage(contactId: string, msg: NewMessage): Promise<SavedMessage>;
  /** 3. Сохранить файл (сжать фото, если проект так делает, — его дело) */
  saveFile(contactId: string, file: NewFile): Promise<SavedFile>;
  /** 4. Отметить «ждёт ответа». Проект, который считает ожидание запросом (waitSinceSql), может ничего не делать */
  markWaiting(contactId: string, change: WaitChange): Promise<void>;
  /** 5. Сообщить открытым вкладкам: обновить список и переписку, позвонить */
  notify(event: LiveEvent): Promise<void> | void;

  /* ── По желанию: нужны подключениям с неточными каналами (Nextbot) ───────────────────────────── */

  /** Есть ли где-то сообщение с таким ключом повтора (до того, как узнали клиента) */
  messageExists?(externalId: string): Promise<{ id: string; contactId: string } | null>;
  /** Уже записанные сообщения клиента по ключам, текстам и последние наши */
  findMessages?(contactId: string, q: MessageQuery): Promise<StoredMessage[]>;
  /** Поправить записанное сообщение: автора (бот, а не «менеджер с телефона»), файл, доставку */
  updateMessage?(ref: { id: string } | { externalId: string }, patch: MessagePatch): Promise<void>;
  /** «Ключ → значение» для подключений */
  state?: KeyValue | undefined;
}
