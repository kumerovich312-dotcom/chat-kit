import type { Presence } from "../core/conversation.js";
import { activePresence } from "../core/team.js";

/* «Коллега уже отвечает» на сервере: кто из команды сейчас открыл диалог и кто пишет ответ — чтобы двое не ответили
   клиенту одновременно. Браузер сотрудника шлёт отметки на адрес проекта (открыл диалог — раз в 20–30 с, пишет —
   раз в 3–5 с, отправил или стёр текст — снова «смотрит», закрыл диалог — leave), проект кладёт их сюда и рассылает
   список открытым вкладкам своим живым каналом (SSE или опрос). Показ — activePresence и presenceText из ядра.

   Отметки живут в памяти ОДНОГО процесса сервера и пропадают сами: без обновления дольше ttlMs — человек ушёл,
   «пишет» без обновления дольше typingTtlMs — уже просто смотрит. Таймеров нет — старое убирается при обращении.
   Проекту с несколькими процессами (несколько копий приложения, бессерверный хостинг) нужно общее хранилище: своя
   таблица «диалог, сотрудник, состояние, время отметки», Redis или «присутствие» живого канала; правило показа то же. */

export type PresenceHubOptions = {
  /** Сколько отметка живёт без обновления: по умолчанию минута */
  ttlMs?: number | undefined;
  /** «Пишет ответ» без новых отметок дольше этого — уже просто смотрит: по умолчанию 10 с */
  typingTtlMs?: number | undefined;
  now?: (() => number) | undefined;
};

export type PresenceHub = {
  /** Отметка сотрудника в диалоге (время ставит сервер). Возвращает, кто сейчас в диалоге, — разослать вкладкам */
  touch(contactId: string, p: Omit<Presence, "at">): Presence[];
  /** Сотрудник закрыл диалог. Возвращает, кто остался */
  leave(contactId: string, userId: string): Presence[];
  /** Кто сейчас в диалоге: пишущие первыми, дальше по имени */
  list(contactId: string): Presence[];
  /** Все диалоги, где кто-то есть, — для значков в списке диалогов */
  snapshot(): Record<string, Presence[]>;
};

export function createPresenceHub(o: PresenceHubOptions = {}): PresenceHub {
  const ttlMs = o.ttlMs ?? 60_000;
  const typingTtlMs = o.typingTtlMs ?? 10_000;
  const now = o.now ?? Date.now;
  /** диалог → сотрудник → последняя отметка */
  const rooms = new Map<string, Map<string, Presence>>();
  let sweptAt = 0;

  // Убрать устаревшие отметки — не чаще раза за время жизни отметки
  const sweep = (t: number) => {
    if (t - sweptAt < ttlMs) return;
    sweptAt = t;
    for (const [contactId, room] of rooms) {
      for (const [userId, p] of room) if (!(t - Date.parse(p.at) <= ttlMs)) room.delete(userId);
      if (!room.size) rooms.delete(contactId);
    }
  };

  const listAt = (contactId: string, t: number): Presence[] => {
    const room = rooms.get(contactId);
    return room ? activePresence([...room.values()], { now: t, ttlMs, typingTtlMs }) : [];
  };

  return {
    touch(contactId, p) {
      const t = now();
      sweep(t);
      const userId = String(p.userId ?? "").trim();
      if (contactId && userId) {
        let room = rooms.get(contactId);
        if (!room) rooms.set(contactId, (room = new Map()));
        room.set(userId, {
          userId,
          name: String(p.name ?? "").trim().slice(0, 100),
          state: p.state === "typing" ? "typing" : "viewing",
          at: new Date(t).toISOString(),
        });
      }
      return listAt(contactId, t);
    },

    leave(contactId, userId) {
      const t = now();
      sweep(t);
      const room = rooms.get(contactId);
      if (room) {
        room.delete(String(userId).trim());
        if (!room.size) rooms.delete(contactId);
      }
      return listAt(contactId, t);
    },

    list(contactId) {
      const t = now();
      sweep(t);
      return listAt(contactId, t);
    },

    snapshot() {
      const t = now();
      sweep(t);
      const out: [string, Presence[]][] = [];
      for (const contactId of rooms.keys()) {
        const list = listAt(contactId, t);
        if (list.length) out.push([contactId, list]);
      }
      // fromEntries, а не out[id] = …: номер диалога «__proto__» не должен задеть сам объект
      return Object.fromEntries(out);
    },
  };
}
