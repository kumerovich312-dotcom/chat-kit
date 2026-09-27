import type { ChannelEvent, IncomingMessage, RemoteFile } from "../../server/channel.js";
import { sha1Hex } from "../../server/crypto.js";
import type { ContactHint } from "../../server/store.js";

/* Уведомления Instagram (object: "instagram") → события набора. Без сети и без базы.

   Уведомление: entry[] — по аккаунту компании (entry.id — номер профессионального аккаунта Instagram), в каждом
   messaging[] (и standby[] — если диалог сейчас ведёт другое приложение). Кнопка «Тест» в кабинете Meta присылает то же
   в виде changes[{ field: "messages", value: {…} }] — его понимаем тоже.
   - message — сообщение клиента; с is_echo — сообщение, которое компания отправила сама (из приложения Instagram или
     через API — тогда оно уже записано под тем же ключом ig:<mid>);
   - read — клиент прочитал наше сообщение;
   - postback — клиент нажал кнопку (вопрос-подсказку в начале диалога);
   - referral — клиент пришёл из рекламы или по ссылке ig.me;
   - message_edit — сообщение изменили;
   - reaction — реакции в переписку не пишем (решение пользователя: реакции пока не делаем). */

/** Особое событие: сообщение компании («эхо»). Подключение раскладывает его само (apply): сначала проверяет, не
 *  отправлено ли оно через набор, и только потом записывает как «менеджер с телефона» */
export const ECHO_EVENT = "instagram:echo";

export type EchoData = {
  /** Автор — «менеджер с телефона», ключ — ig:<mid> */
  message: IncomingMessage;
  /** Собеседник — номер клиента у Instagram (IGSID) */
  recipient: string;
  /** Слова вместо файла, пока он скачивается: «Фото», «Видео» */
  placeholder: string;
};

export type ParsedInstagram = {
  events: ChannelEvent[];
  /** Ссылки на голосовые: Instagram отдаёт их в mp4, который по содержимому не отличить от видео */
  audioUrls: string[];
};

type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
/** Только http(s): ссылка из уведомления идёт в текст и на скачивание */
const webUrl = (v: unknown): string => {
  const s = str(v).trim();
  return /^https?:\/\/\S+$/i.test(s) ? s : "";
};
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Время события: миллисекунды (messaging) или секунды строкой (кнопка «Тест» в кабинете) → ISO */
export function igTime(v: unknown): string | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n < 1e12 ? n * 1000 : n).toISOString();
}

/** Клиент у набора: номер у Instagram (IGSID); имя и ник — если подключение спросит профиль */
export function instagramContact(igsid: string): ContactHint {
  return { source: "instagram", externalId: igsid, channel: "instagram" };
}

/** Вложения, которые скачиваем файлом; слова вместо них, пока файл качается */
const FILE_TYPES: Readonly<Record<string, string>> = {
  image: "Фото", animated_image: "Фото", sticker: "Стикер", video: "Видео", audio: "Голосовое сообщение", file: "Документ",
};

export const UNSUPPORTED_TEXT = "Instagram не передал это сообщение (такой вид не поддерживается) — посмотрите его в приложении Instagram";

/** «Публикация «Название»: ссылка» */
function linkLine(kind: string, title: string, url: string): string {
  return `${kind}${title ? ` «${short(title, 100)}»` : ""}${url ? `: ${url}` : ""}`;
}

/** Реклама или ссылка ig.me, с которой клиент пришёл */
function referralText(r: Obj): string | null {
  const ad = str(r.ad_id);
  const title = str(obj(r.ads_context_data)?.ad_title).trim();
  const ref = str(r.ref).trim();
  if (ad || str(r.source).toUpperCase() === "ADS") {
    return `Клиент пришёл из рекламы${title ? ` «${short(title, 100)}»` : ""}${ad ? ` (объявление ${ad})` : ""}`;
  }
  return ref ? `Клиент пришёл по ссылке с меткой «${short(ref, 100)}»` : null;
}

/** Номера аккаунтов Instagram в уведомлении (entry[].id) — чтобы проект с несколькими компаниями выбрал, чьё это
 *  уведомление, ещё до приёма. Подпись этим не проверяется: её проверит receive() подключения этой компании */
export function instagramAccounts(body: string): string[] {
  try {
    const root = obj(JSON.parse(body));
    return [...new Set(arr(root?.entry).map((e) => str(obj(e)?.id)).filter(Boolean))];
  } catch {
    return [];
  }
}

/** Уведомление Instagram → события набора. igUserId — номер нашего аккаунта: записи других аккаунтов пропускаем */
export function parseInstagramWebhook(body: unknown, o: { igUserId?: string | undefined } = {}): ParsedInstagram {
  const events: ChannelEvent[] = [];
  const audioUrls: string[] = [];
  const root = obj(body);
  if (!root || root.object !== "instagram") return { events, audioUrls };

  for (const rawEntry of arr(root.entry)) {
    const entry = obj(rawEntry);
    if (!entry) continue;
    const account = str(entry.id);
    // Уведомление пришло для другого аккаунта (одно приложение Meta на несколько компаний)
    if (o.igUserId && account && account !== o.igUserId) continue;
    const ours = (id: string) => !!id && (id === account || id === o.igUserId);
    const fromChanges = arr(entry.changes).map((c) => obj(obj(c)?.value)).filter((v): v is Obj => !!v && (!!obj(v.sender) || !!obj(v.recipient)));
    const items = [...arr(entry.messaging), ...arr(entry.standby), ...fromChanges];

    for (const rawItem of items) {
      const item = obj(rawItem);
      if (!item) continue;
      const sender = str(obj(item.sender)?.id);
      const recipient = str(obj(item.recipient)?.id);
      const at = igTime(item.timestamp);
      const notice = (igsid: string, key: string, text: string) => events.push({ type: "notice", contact: instagramContact(igsid), key, text });

      const msg = obj(item.message);
      if (msg) {
        const mid = str(msg.mid);
        const echo = msg.is_echo === true || ours(sender);
        const igsid = echo ? recipient : sender;
        if (!mid || !igsid || ours(igsid)) continue;
        const key = `ig:${mid}`;
        if (msg.is_deleted === true) {
          notice(igsid, `${key}:deleted`, echo ? "Сообщение удалено в приложении Instagram" : "Клиент удалил сообщение");
          continue;
        }
        const ref = obj(msg.referral);
        const refText = ref && !echo ? referralText(ref) : null;
        if (ref && refText) notice(igsid, `ig:ref:${igsid}:${sha1Hex(`${str(ref.ad_id)}|${str(ref.ref)}|${str(ref.source)}`).slice(0, 16)}`, refText);
        if (msg.is_unsupported === true) {
          if (!echo) events.push({ type: "message", contact: instagramContact(igsid), message: { externalId: key, at, author: { type: "client" }, text: UNSUPPORTED_TEXT } });
          continue;
        }

        const text = str(msg.text);
        const lines: string[] = [];
        const files: RemoteFile[] = [];
        let placeholder = "";
        for (const rawA of arr(msg.attachments)) {
          const a = obj(rawA);
          if (!a) continue;
          const type = str(a.type).toLowerCase();
          const p = obj(a.payload);
          const url = webUrl(p?.url);
          const title = str(p?.title).trim();
          const fileWord = FILE_TYPES[type];
          if (fileWord && url) {
            files.push({ urls: [url] });
            if (type === "audio") audioUrls.push(url);
            placeholder ||= fileWord;
          } else if (type === "story_mention") {
            // История пропадёт через сутки — её фото или видео забираем себе файлом
            lines.push(url ? `Упоминание вашего аккаунта в истории: ${url}` : "Упоминание вашего аккаунта в истории");
            if (url) files.push({ urls: [url], caption: "История клиента" });
          } else if (type === "share" || type === "ig_post") {
            lines.push(linkLine("Публикация", title, url));
          } else if (type === "ig_reel" || type === "reel") {
            lines.push(linkLine("Рилс", title, url));
          } else if (type === "like_heart") {
            lines.push("Стикер «сердечко»");
          } else if (type === "fallback") {
            if (url && !text.includes(url)) lines.push(title ? `${short(title, 100)}: ${url}` : url);
          } else {
            lines.push(url ? `Вложение (${type || "без типа"}): ${url}` : `Вложение (${type || "без типа"}), которое Instagram не показывает`);
          }
        }
        const replyTo = obj(msg.reply_to);
        const story = obj(replyTo?.story);
        if (story) {
          const url = webUrl(story.url);
          lines.push(url ? `Ответ на вашу историю: ${url}` : "Ответ на вашу историю");
        }
        const full = [text.trim() ? text : "", ...lines].filter(Boolean).join("\n");
        if (!full && !files.length) continue;
        const replyMid = str(replyTo?.mid);
        const message: IncomingMessage = {
          externalId: key, at,
          author: echo ? { type: "operator_phone" } : { type: "client" },
          text: full,
          files: files.length ? files : undefined,
          replyTo: replyMid ? { externalId: `ig:${replyMid}` } : null,
        };
        if (echo) {
          const data: EchoData = { message, recipient: igsid, placeholder };
          events.push({ type: "custom", name: ECHO_EVENT, contact: instagramContact(igsid), data });
        } else {
          events.push({ type: "message", contact: instagramContact(igsid), message });
        }
        continue;
      }

      // Клиент прочитал наше сообщение (Instagram присылает номер последнего прочитанного)
      const read = obj(item.read);
      if (read) {
        const mid = str(read.mid);
        if (mid && sender && !ours(sender)) events.push({ type: "status", externalId: `ig:${mid}`, delivery: "read" });
        continue;
      }

      // Кнопка: вопрос-подсказка в начале диалога или кнопка из шаблона — это сообщение клиента
      const pb = obj(item.postback);
      if (pb) {
        if (!sender || ours(sender)) continue;
        const title = str(pb.title).trim();
        const payload = str(pb.payload).trim();
        const t = title || (payload ? `Нажата кнопка: ${short(payload, 200)}` : "");
        if (!t) continue;
        const mid = str(pb.mid);
        const key = mid ? `ig:${mid}` : `ig:pb:${sender}:${sha1Hex(`${str(item.timestamp)}|${payload}|${title}`).slice(0, 16)}`;
        events.push({ type: "message", contact: instagramContact(sender), message: { externalId: key, at, author: { type: "client" }, text: t } });
        continue;
      }

      // Клиент пришёл из рекламы или по ссылке ig.me — служебной строкой, один раз на рекламу или метку
      const rf = obj(item.referral);
      if (rf) {
        const t = sender && !ours(sender) ? referralText(rf) : null;
        if (t) notice(sender, `ig:ref:${sender}:${sha1Hex(`${str(rf.ad_id)}|${str(rf.ref)}|${str(rf.source)}`).slice(0, 16)}`, t);
        continue;
      }

      // Сообщение изменили: новый текст — служебной строкой (прежний остаётся в переписке)
      const ed = obj(item.message_edit);
      if (ed) {
        const mid = str(ed.mid);
        const t = str(ed.text).trim();
        const mine = ours(sender);
        const igsid = mine ? recipient : sender;
        if (!mid || !t || !igsid) continue;
        const n = str(ed.num_edit) || sha1Hex(t).slice(0, 12);
        notice(igsid, `ig:${mid}:edit:${n}`, `${mine ? "Сообщение изменено в приложении Instagram" : "Клиент изменил сообщение"}: «${short(t, 500)}»`);
      }
      // reaction, optin, передача диалога между приложениями — пропускаем
    }
  }
  return { events, audioUrls };
}
