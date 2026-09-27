/* Модель сообщения — одна для всех проектов и каналов. Без базы и без React: годится и для сервера, и для браузера.

   Автор — как в плане ИИ-студии (раздел 10.2, решение D-041): клиент, бот, менеджер из CRM, менеджер с телефона,
   администратор студии, служебное. Каждый проект хранит сообщения в своей базе по-своему и переводит их в этот вид
   (например, поле «кто написал» client / bot / manager / phone). */

/** Кто написал */
export type AuthorType = "client" | "bot" | "operator_crm" | "operator_phone" | "operator_admin" | "system";

export const AUTHOR_TYPES: readonly AuthorType[] = ["client", "bot", "operator_crm", "operator_phone", "operator_admin", "system"];

export type Author = {
  type: AuthorType;
  /** Имя сотрудника («Айгерим») или бота; у клиента обычно пусто */
  name?: string | null | undefined;
  /** Номер автора в проекте — по нему «Вы:» перед своим сообщением в списке диалогов */
  id?: string | null | undefined;
};

/** Вид записи в ленте: сообщение (пузырь), заметка команды (клиент не видит), служебная строка, звонок */
export type MessageKind = "message" | "note" | "system" | "call";

/** Доставка нашего сообщения: pending — отправляется (часики), sent — ушло (галочка), delivered и read — дошло
 *  и прочитано (две галочки), failed — не доставлено (причина и «повторить») */
export type Delivery = "pending" | "sent" | "delivered" | "read" | "failed";

export const DELIVERY_RANK: Readonly<Record<Delivery, number>> = { pending: 1, sent: 2, delivered: 3, read: 4, failed: 0 };

/** Вложение: файл лежит у проекта, набор знает только адрес, по которому браузер его откроет (права проверяет проект) */
export type Attachment = {
  id: string;
  name: string;
  mime: string;
  size?: number | null | undefined;
  /** Адрес файла на сайте проекта: «/files/15», «/api/inbox/media/15» */
  url: string;
  /** Метка содержимого: после поворота фото новая — браузер не покажет прежнюю картинку из кэша */
  version?: string | null | undefined;
  /** Длина голосового или записи в секундах — показать до загрузки */
  durationSec?: number | null | undefined;
  /** Расшифровка голосового или записи звонка (кнопка «Расшифровать» — «розетка ИИ») */
  transcript?: string | null | undefined;
};

/** Цитата: на какое сообщение ответили. Проект заполняет, что знает; окно найдёт исходное в ленте по id */
export type MessageQuote = {
  /** Номер цитируемого сообщения в базе проекта — по нему лента прокрутит к исходному */
  id?: string | null | undefined;
  /** Номер цитируемого сообщения у канала */
  externalId?: string | null | undefined;
  /** Кто написал и начало текста — если исходного сообщения в ленте нет */
  author?: Author | null | undefined;
  text?: string | null | undefined;
  /** Цитируют файл — его имя и тип (фото, голосовое) */
  attachment?: { name: string; mime: string } | null | undefined;
};

/** Карточка проекта в ленте: запись на приём, вакансия, счёт, заказ. Как её показать — описано в паспорте проекта
 *  (profile.cards[type]); текст сообщения — запасной вид для канала и поиска */
export type MessageCard = {
  /** Вид карточки из паспорта: «appointment», «vacancy», «invoice» */
  type: string;
  /** Данные карточки: «date» → «2026-10-12T15:00», «doctor» → «Д-р Асанова» */
  data: Readonly<Record<string, string | number | boolean | null>>;
};

export type CallInfo = {
  /** Входящий (звонил клиент) или исходящий (звонили мы) */
  direction?: "in" | "out" | undefined;
  durationSec?: number | null | undefined;
  /** Запись разговора — адрес на сайте проекта */
  recordUrl?: string | null | undefined;
  missed?: boolean | undefined;
  /** Кто из команды говорил */
  manager?: string | null | undefined;
};

export type ChatMessage = {
  /** Номер записи в базе проекта (строкой: у одних проектов числа, у студии — UUID) */
  id: string;
  /** Когда написано — ISO-время с миллисекундами: время канала, если оно точное, иначе время приёма */
  at: string;
  /** Номер по порядку в диалоге, если канал его даёт (студия): порядок по нему надёжнее времени */
  seq?: number | null | undefined;
  kind: MessageKind;
  author: Author;
  /** Канал: whatsapp, telegram, instagram, email… (channels.ts) */
  channel: string;
  text: string;
  /** Тема письма (канал email) */
  subject?: string | null | undefined;
  attachments?: readonly Attachment[] | undefined;
  delivery?: Delivery | null | undefined;
  deliveryError?: string | null | undefined;
  /** Бот передал клиента человеку («передаю менеджеру»): это не ответ — клиент снова ждёт человека */
  handoff?: boolean | undefined;
  /** Номер сообщения у канала — по нему повтор не записывается второй раз */
  externalId?: string | null | undefined;
  /** Ответ на сообщение — цитата */
  replyTo?: MessageQuote | null | undefined;
  /** Черновик теневого режима студии: бот предложил ответ, но клиенту он не ушёл */
  shadow?: boolean | undefined;
  call?: CallInfo | null | undefined;
  /** Карточка проекта (запись на приём, счёт) — у сообщения клиенту или у заметки команды */
  card?: MessageCard | null | undefined;
};

/** Сообщение написал клиент (входящее) */
export function fromClient(m: Pick<ChatMessage, "author">): boolean {
  return m.author.type === "client";
}

/** Сообщение наше — бот или человек из команды (исходящее) */
export function fromUs(m: Pick<ChatMessage, "author">): boolean {
  return m.author.type !== "client" && m.author.type !== "system";
}

/** Ответ человека: менеджер из CRM, с телефона или администратор студии */
export function fromHuman(m: Pick<ChatMessage, "author">): boolean {
  return m.author.type === "operator_crm" || m.author.type === "operator_phone" || m.author.type === "operator_admin";
}

/** Подпись автора под сообщением: «ИИ-агент», «менеджер с телефона», имя сотрудника */
export function authorLabel(a: Author, opts: { botName?: string | undefined; meId?: string | null | undefined } = {}): string {
  switch (a.type) {
    case "client":
      return a.name?.trim() || "клиент";
    case "bot":
      return opts.botName ?? "ИИ-агент";
    case "operator_phone":
      return a.name?.trim() ? `${a.name.trim()} · с телефона` : "менеджер с телефона";
    case "operator_admin":
      return a.name?.trim() || "администратор";
    case "operator_crm":
      if (opts.meId && a.id && opts.meId === a.id) return "вы";
      return a.name?.trim() || "менеджер";
    case "system":
      return "служебное";
  }
}
