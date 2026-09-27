import { formatForChannel } from "../core/markup.js";
import type { Author } from "../core/model.js";
import type { BotCommand, ControlMode } from "../core/conversation.js";
import type { ChannelAdapter, ChannelCaps, Outgoing, ReceiveResult, SendResult, Target, WebhookInput } from "../server/channel.js";
import { safeEqual } from "../server/crypto.js";
import { bearerKey } from "../server/request.js";

/* Подключение «шлюз WhatsApp TishCRM» (apps/wa-gateway: библиотека Baileys, вход по QR, одна сессия на клинику).

   Шлюз передаёт сообщения не по сети, а через общую с кабинетом базу:
   - входящее и ответ с телефона клиники шлюз сам пишет в dialogs / messages (повтор отсекает по wa_message_id), файлы
     кладёт в uploads, а кабинету шлёт только «пациент написал»: POST /api/internal/events, «Authorization: Bearer
     <WA_GATEWAY_TOKEN>», тело { event: "message_in", org_id, dialog_id }. Здесь это событие «обновить экраны»;
   - исходящее кабинет кладёт в очередь wa_outbox — шлюз раз в 1,5 с забирает и отправляет (адрес «nb:<диалог>» — через
     Nextbot). Кладёт строку переходник проекта (enqueue): набор о таблицах TishCRM не знает;
   - доставку и прочтение шлюз сам пишет в messages.delivery.
   По сети шлюз умеет только управление: POST /connect, /disconnect, /nextbot-test с тем же токеном (порт WA_GATEWAY_PORT,
   по умолчанию 3010). Пауза ИИ-ответа — статус диалога «operator» в базе (шлюз не отвечает такому диалогу): его ставит
   проект (setMode). Секреты (токен, адрес) — только из окружения проекта. */

/** Строка очереди исходящих шлюза (у TishCRM — таблица wa_outbox) */
export type WaOutboxRow = {
  /** Адрес: «996555000001@s.whatsapp.net», «<lid>@lid» или «nb:<номер диалога Nextbot>» */
  jid: string;
  text: string;
  /** Файл: путь внутри папки uploads, как его читает шлюз */
  media?: { path: string; type: WaMediaType; mime: string; name: string } | null | undefined;
  /** Номер сообщения в базе — по нему шлюз отметит доставку */
  messageId?: string | null | undefined;
};

export type WaMediaType = "image" | "video" | "audio" | "voice" | "document";

export type WaGatewayOptions = {
  /** Адрес шлюза (WA_GATEWAY_URL), например http://wa:3010 */
  url: string;
  /** Общий токен шлюза и кабинета (WA_GATEWAY_TOKEN) */
  token: string;
  /** Клиника */
  orgId: string | number;
  /** Положить исходящее в очередь шлюза */
  enqueue(row: WaOutboxRow): Promise<void>;
  /** Кто ведёт диалог: TishCRM — dialogs.status = 'operator' (ИИ молчит) / 'ai'. Не задано — паузы нет */
  setMode?: ((target: Target, mode: ControlMode) => Promise<void>) | undefined;
  fetch?: typeof fetch | undefined;
};

export type WaGatewayAdapter = ChannelAdapter & {
  /** Начать подключение WhatsApp: QR появится в базе (wa_sessions) */
  connect(): Promise<SendResult>;
  /** Выйти из WhatsApp и забыть сессию */
  disconnect(): Promise<SendResult>;
  /** Проверка связи с Nextbot через шлюз — тем же путём, каким уходят ответы */
  testNextbot(dialogId: string, text?: string): Promise<SendResult>;
};

/** Телефон → адрес WhatsApp: «+996 555 00-00-01» → «996555000001@s.whatsapp.net» */
export function waJid(phone: string): string | null {
  const d = phone.replace(/\D/g, "");
  return d.length >= 9 ? `${d}@s.whatsapp.net` : null;
}

/** Адрес WhatsApp → телефон «+996555000001»; у адреса «@lid» номер скрыт — null */
export function phoneFromJid(jid: string): string | null {
  const m = jid.match(/^(\d{7,15})@s\.whatsapp\.net$/);
  return m ? `+${m[1]}` : null;
}

/** Диалог Nextbot в TishCRM записан адресом «nb:<номер>» */
export const isNextbotJid = (jid: string) => jid.startsWith("nb:");

/** Автор TishCRM (messages.author) → автор набора */
export function authorFromTish(author: string): Author {
  if (author === "patient") return { type: "client" };
  if (author === "ai") return { type: "bot", name: "ИИ-администратор" };
  if (author === "phone") return { type: "operator_phone" };
  if (author === "system") return { type: "system" };
  if (author === "operator:NextBot") return { type: "operator_admin", name: "менеджер в Nextbot" };
  if (author.startsWith("operator:")) return { type: "operator_crm", name: author.slice("operator:".length) || null };
  if (author.startsWith("auto:")) return { type: "operator_crm", name: `${author.slice("auto:".length) || "автоматизация"} · автоматически` };
  return { type: "operator_crm", name: author || null };
}

/** Автор набора → messages.author TishCRM */
export function authorToTish(a: Author): string {
  switch (a.type) {
    case "client": return "patient";
    case "bot": return "ai";
    case "operator_phone": return "phone";
    case "system": return "system";
    case "operator_admin": return "operator:NextBot";
    case "operator_crm": return `operator:${a.name ?? ""}`;
  }
}

/** Вид вложения шлюза по типу файла */
export function waMediaType(mime: string): WaMediaType {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
}

export const WA_GATEWAY_CAPS: ChannelCaps = { text: true, files: true, pause: false, mute: false, start: true, statuses: true };

export function createWaGatewayAdapter(o: WaGatewayOptions): WaGatewayAdapter {
  const doFetch = o.fetch ?? fetch;
  const base = o.url.replace(/\/+$/, "");

  async function call(path: string, body: Record<string, unknown>): Promise<SendResult> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const res = await doFetch(base + path, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${o.token}` },
        body: JSON.stringify({ orgId: o.orgId, ...body }), signal: ctrl.signal, cache: "no-store",
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.status === 401) return { ok: false, error: "Шлюз не принял токен: проверьте WA_GATEWAY_TOKEN у кабинета и шлюза" };
      if (!res.ok || data.ok === false) return { ok: false, error: data.error ? `Шлюз: ${data.error}` : `Шлюз ответил ${res.status}`, retryable: res.status >= 500 };
      return { ok: true };
    } catch {
      return { ok: false, error: ctrl.signal.aborted ? "Шлюз не ответил за 15 секунд" : "Шлюз WhatsApp не запущен или недоступен", retryable: true };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    kind: "wa-gateway",
    caps: { ...WA_GATEWAY_CAPS, pause: !!o.setMode },

    receive(input: WebhookInput): ReceiveResult {
      const key = bearerKey(input.headers);
      if (!o.token || o.token.length < 8 || !key || !safeEqual(key, o.token)) return { ok: false, status: 401, error: "unauthorized" };
      let body: { event?: unknown; org_id?: unknown; dialog_id?: unknown };
      try { body = JSON.parse(input.body || "{}") as typeof body; } catch { return { ok: false, status: 400, error: "Тело запроса должно быть JSON" }; }
      if (String(body.org_id) !== String(o.orgId)) return { ok: false, status: 403, error: "Диалог другой клиники" };
      if (body.event !== "message_in" || body.dialog_id === undefined || body.dialog_id === null) {
        return { ok: false, status: 200, ignored: true, error: "Незнакомое событие шлюза" };
      }
      return { ok: true, events: [{ type: "refresh", contactId: String(body.dialog_id) }] };
    },

    async send(to: Target, out: Outgoing): Promise<SendResult> {
      if (!to.externalId) return { ok: false, error: "Нет адреса WhatsApp у диалога" };
      if (out.file && !out.file.path) return { ok: false, error: "Шлюз отправляет файл с диска: нужен путь в папке uploads" };
      // Ответ ИИ пишет разметкой Markdown — в WhatsApp переводим в его звёздочки; текст сотрудника — как набран
      const text = out.author?.type === "bot" ? formatForChannel(out.text, isNextbotJid(to.externalId) ? "plain" : "whatsapp") : out.text;
      await o.enqueue({
        jid: to.externalId,
        text,
        media: out.file?.path ? { path: out.file.path, type: waMediaType(out.file.mime), mime: out.file.mime, name: out.file.name } : null,
        messageId: out.messageId ?? null,
      });
      // Ушло в очередь; «отправлено / доставлено / прочитано» шлюз сам запишет в базу
      return { ok: true, externalId: null };
    },

    async control(to: Target, cmd: BotCommand): Promise<SendResult> {
      if (!o.setMode) return { ok: false, error: "Пауза ИИ в шлюзе ставится статусом диалога — проект не передал setMode" };
      if (cmd.type === "pause") { await o.setMode(to, "manager"); return { ok: true }; }
      if (cmd.type === "resume") { await o.setMode(to, "bot"); return { ok: true }; }
      return { ok: false, error: "«Не отвечать этому клиенту» шлюз пока не умеет — только пауза диалога" };
    },

    connect: () => call("/connect", {}),
    disconnect: () => call("/disconnect", {}),
    testNextbot: (dialogId, text) => call("/nextbot-test", { dialogId, text: text ?? "Проверка связи с CRM" }),
  };
}
