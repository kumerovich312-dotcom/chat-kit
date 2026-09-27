import type { Author, Delivery } from "../core/model.js";
import type { BotCommand, ControlMode } from "../core/conversation.js";
import type { ChatStore, ContactHint } from "./store.js";

/* «Розетка» для каналов (ChannelAdapter) — общий вид любого подключения: Nextbot, шлюз WhatsApp TishCRM, своя студия.
   Смена подключения — настройка проекта, а не переписывание: окно переписки и переходник к базе те же.

   Подключение умеет:
   - receive — разобрать входящее уведомление (вебхук) в события;
   - send — отправить текст или файл;
   - control — пауза / возобновление бота, «не отвечать этому клиенту» (если канал умеет);
   - download — скачать файл по ссылке канала.
   Обходы конкретного канала (у Nextbot — «Полный диалог», угадывание времени и автора) живут только в его подключении:
   такие события оно раскладывает само (apply), ядро о них не знает. */

/** Входящий запрос — без привязки к Next.js: метод, заголовки, тело строкой */
export type WebhookInput = {
  method: string;
  headers: Record<string, string | undefined>;
  body: string;
  url?: string | undefined;
};

/** Файл, который канал прислал ссылкой — набор скачает его после ответа каналу */
export type RemoteFile = {
  /** Где искать — по порядку (у Nextbot фото, записанное одним именем, ищется в нескольких папках) */
  urls: string[];
  /** Название документа, подпись к фото */
  caption?: string | null | undefined;
};

export type IncomingMessage = {
  /** Ключ повтора (номер сообщения у канала) */
  externalId: string;
  /** Время от канала (ISO) — если точное; иначе набор ставит время приёма */
  at?: string | null | undefined;
  author: Author;
  text: string;
  files?: RemoteFile[] | undefined;
  /** Бот передал человеку («передаю менеджеру») */
  handoff?: boolean | undefined;
  replyTo?: string | null | undefined;
  /** Черновик теневого режима */
  shadow?: boolean | undefined;
};

/** События, в которые подключение раскладывает уведомление канала */
export type ChannelEvent =
  /** Сообщение: клиента, бота, менеджера с телефона */
  | { type: "message"; contact: ContactHint; message: IncomingMessage }
  /** Статус нашего сообщения: дошло, прочитано, не доставлено */
  | { type: "status"; externalId: string; delivery: Delivery; error?: string | null | undefined }
  /** Служебная строка в переписке (один раз): «Nextbot не доставил…», «бот на паузе» */
  | { type: "notice"; contact: ContactHint; key: string; text: string }
  /** Кто ведёт диалог: бот, человек, бот молчит всегда */
  | { type: "state"; contact: ContactHint; mode: ControlMode; pausedUntil?: string | null | undefined; reason?: string | null | undefined }
  /** Бот позвал человека: причина, резюме, собранные поля */
  | { type: "handoff"; contact: ContactHint; reason?: string | null | undefined; summary?: string | null | undefined; fields?: Record<string, string> | undefined }
  /** Заявка, собранная ботом (Nextbot «Передать заявку», студия lead.captured) */
  | { type: "lead"; contact: ContactHint; fields: Record<string, string | number | null> }
  /** Бот просит данные у CRM (функция «Найти вакансии») — ответ пишет проект */
  | { type: "function"; name: string; args: Record<string, string | null> }
  /** Сообщение уже записано в базу самим каналом (шлюз TishCRM) — только обновить экраны */
  | { type: "refresh"; contactId: string }
  /** Проверка связи */
  | { type: "ping" }
  /** Особое событие подключения — разбирает само подключение (apply) */
  | { type: "custom"; name: string; contact?: ContactHint | undefined; data: unknown };

export type ReceiveResult =
  /** meta — что подключение хочет видеть в своём ответе каналу (respond): тип события и т. п. */
  | { ok: true; events: ChannelEvent[]; meta?: Record<string, unknown> | undefined }
  /** Запрос не принят: не JSON, нет номера диалога, тестовый чат. status — HTTP-ответ каналу */
  | { ok: false; status: number; error: string; ignored?: boolean | undefined; meta?: Record<string, unknown> | undefined };

/** Кому отправить */
export type Target = {
  /** Номер собеседника у подключения (как в ContactHint.externalId) */
  externalId: string;
  channel?: string | undefined;
  contactId?: string | undefined;
};

export type Outgoing = {
  text: string;
  /** Файл: у Nextbot и студии — ссылка, по которой они заберут его сами (signFileLink); у шлюза — путь на диске */
  file?: { name: string; mime: string; url?: string | undefined; path?: string | undefined } | undefined;
  /** Кто пишет — сотрудник из CRM */
  author?: Author | undefined;
  /** Номер записи сообщения в базе проекта — по нему подключение отметит доставку */
  messageId?: string | undefined;
  /** Ключ повтора отправки: повтор с тем же ключом клиенту второй раз не уйдёт (студия) */
  idempotencyKey?: string | undefined;
};

export type SendResult =
  | { ok: true; externalId?: string | null | undefined }
  | { ok: false; error: string; retryable?: boolean | undefined };

export type DownloadResult =
  | { ok: true; data: Uint8Array; mime: string; ext: string }
  /** missing — файла нет; bad — чужой тип или слишком большой; retry — сбой связи, попробовать потом */
  | { ok: false; reason: "missing" | "bad" | "retry" };

/** Что умеет канал — окно переписки показывает только доступные кнопки */
export type ChannelCaps = {
  text: boolean;
  files: boolean;
  /** Пауза бота по команде */
  pause: boolean;
  /** «Не отвечать этому клиенту» */
  mute: boolean;
  /** Написать первым клиенту, который ещё не писал */
  start: boolean;
  /** Статусы доставки и прочтения */
  statuses: boolean;
};

/** Для apply: переходник и помощники ingest */
export type ApplyContext = {
  store: ChatStore;
  contactId: string;
  created: boolean;
  /** Как клиент записан в проекте и через какой канал уже писал (ContactRef) */
  contactName?: string | null | undefined;
  contactChannel?: string | null | undefined;
  now: number;
  /** Файлы — после ответа каналу */
  later: (job: () => Promise<void>) => void;
};

export type ApplySummary = {
  messageIds: string[];
  added: number;
  /** Это событие уже было (тот же ключ повтора) */
  duplicate?: boolean | undefined;
};

export interface ChannelAdapter {
  readonly kind: string;
  readonly caps: ChannelCaps;
  receive(input: WebhookInput): Promise<ReceiveResult> | ReceiveResult;
  send(to: Target, out: Outgoing): Promise<SendResult>;
  control?(to: Target, cmd: BotCommand): Promise<SendResult>;
  download?(url: string): Promise<DownloadResult>;
  /** Особые события (custom) — подключение раскладывает само через переходник */
  apply?(event: Extract<ChannelEvent, { type: "custom" }>, ctx: ApplyContext): Promise<ApplySummary>;
  /** Ответ каналу на принятое уведомление (Nextbot читает JSON с номером клиента и статусом). status — HTTP-код,
   *  который набор ответил бы сам */
  respond?(summary: IngestSummary, status: number): { status: number; body: unknown };
}

/** Итог приёма одного уведомления */
export type IngestSummary = {
  ok: boolean;
  /** ok — принято; duplicate — такое уже было; ignored — пропущено (нет текста, тестовый чат); error — ошибка */
  status: "ok" | "duplicate" | "ignored" | "error";
  error?: string | undefined;
  contactId?: string | undefined;
  createdContact?: boolean | undefined;
  messageIds: string[];
  /** Ответ на функцию бота («Найти вакансии») */
  functionResult?: { name: string; text: string; count?: number | undefined } | undefined;
  /** Что ещё проект вернул из своих обработчиков (номер сделки и т. п.) */
  extra?: Record<string, unknown> | undefined;
  /** Что подключение передало из receive для своего ответа */
  meta?: Record<string, unknown> | undefined;
};
