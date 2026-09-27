import type { KeyValue } from "../server/store.js";

/* Хранилище подключения Nextbot — что Атлас держал в таблицах nextbot_media и nextbot_settings.media_folders и что узнавал
   по журналу nextbot_events. Проект может отдать своё (Атлас — поверх этих таблиц, чтобы помнить уже забранные файлы);
   по умолчанию — поверх store.state («ключ → значение»). */

export type MediaInfo = {
  /** Файл, уже забранный по этой ссылке; null — по ссылке не файл (чужой тип, слишком большой) */
  fileId: string | null;
  /** Время сообщения с этим файлом у клиента */
  at: string | null;
};

export interface NextbotMedia {
  /** Что известно о ссылках (и ключах «sha1:<клиент>:<отпечаток>» — тот же файл по другой ссылке) */
  lookup(contactId: string, urls: readonly string[]): Promise<Map<string, MediaInfo>>;
  remember(url: string, fileId: string | null, at: string | null): Promise<void>;
  /** Папки хранилища номера WhatsApp — там лежат фото, которые Nextbot пишет в дамп одним именем */
  folders(): Promise<string[]>;
  saveFolders(folders: readonly string[]): Promise<void>;
  /** Были ли события «ответ агента» с этого времени (настроен ли сценарий «Новое сообщение агента») */
  botEventsSince(ms: number): Promise<boolean>;
  noteBotEvent(ms: number): Promise<void>;
}

const K_MEDIA = "nextbot:media:";
const K_FOLDERS = "nextbot:folders";
const K_BOT = "nextbot:bot_event_at";

export function kvMedia(kv: KeyValue): NextbotMedia {
  return {
    async lookup(_contactId, urls) {
      const out = new Map<string, MediaInfo>();
      for (const url of urls) {
        const raw = await kv.get(K_MEDIA + url);
        if (raw === null) continue;
        try {
          const v = JSON.parse(raw) as { f?: string | null; at?: string | null };
          out.set(url, { fileId: v.f ?? null, at: v.at ?? null });
        } catch { /* испорченная запись — как будто её нет */ }
      }
      return out;
    },
    async remember(url, fileId, at) {
      const prev = await kv.get(K_MEDIA + url);
      // Уже записанный файл не забываем (как ON CONFLICT … COALESCE в Атласе)
      if (prev && !fileId) return;
      await kv.set(K_MEDIA + url, JSON.stringify({ f: fileId, at }));
    },
    async folders() {
      return ((await kv.get(K_FOLDERS)) ?? "").split(" ").filter(Boolean);
    },
    async saveFolders(folders) {
      await kv.set(K_FOLDERS, folders.join(" "));
    },
    async botEventsSince(ms) {
      return Number((await kv.get(K_BOT)) ?? 0) >= ms;
    },
    async noteBotEvent(ms) {
      await kv.set(K_BOT, String(ms));
    },
  };
}

/** Запасной вариант без хранилища у проекта — в памяти процесса (после перезапуска забывается) */
const mem = new Map<string, string>();
export const memoryMedia: NextbotMedia = kvMedia({
  async get(key) { return mem.get(key) ?? null; },
  async set(key, value) { mem.set(key, value); },
});
