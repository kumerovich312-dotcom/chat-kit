/* Порядок сообщений и защита от повторов — без базы.

   Порядок в ленте: номер по порядку в диалоге (seq), если он есть у обоих сообщений (студия даёт его сама); иначе время
   до миллисекунды; при равном времени — номер записи (раньше записанное — выше). Без запасного ключа сообщения с одним
   временем прыгали бы местами при каждом обновлении.

   Повтор — то же сообщение, пришедшее второй раз (канал прислал уведомление дважды, опрос вернул уже показанное): узнаём
   по номеру записи или по номеру сообщения у канала (externalId). */

export type Orderable = { id: string; at: string; seq?: number | null | undefined };

const DIGITS = /^\d+$/;

/** Номера записей: числа — как числа («93» раньше «100»), остальное (UUIDv7 студии) — как строки */
function compareIds(a: string, b: string): number {
  if (DIGITS.test(a) && DIGITS.test(b)) {
    if (a.length !== b.length) return a.length - b.length;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareMessages(a: Orderable, b: Orderable): number {
  if (typeof a.seq === "number" && typeof b.seq === "number" && a.seq !== b.seq) return a.seq - b.seq;
  const ta = Date.parse(a.at);
  const tb = Date.parse(b.at);
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
  return compareIds(a.id, b.id);
}

/** Сообщения от старых к новым (новый массив) */
export function sortMessages<T extends Orderable>(list: readonly T[]): T[] {
  return [...list].sort(compareMessages);
}

type Dedupable = Orderable & { externalId?: string | null | undefined; channel?: string | undefined };

/** Ключ повтора сообщения у канала: канал + номер сообщения у канала */
export function externalKey(m: { externalId?: string | null | undefined; channel?: string | undefined }): string | null {
  return m.externalId ? `${m.channel ?? ""}\u0000${m.externalId}` : null;
}

/** Убрать повторы: по номеру записи и по номеру сообщения у канала; остаётся первое по порядку */
export function dedupeMessages<T extends Dedupable>(list: readonly T[]): T[] {
  const ids = new Set<string>();
  const ext = new Set<string>();
  const out: T[] = [];
  for (const m of sortMessages(list)) {
    const k = externalKey(m);
    if (ids.has(m.id) || (k && ext.has(k))) continue;
    ids.add(m.id);
    if (k) ext.add(k);
    out.push(m);
  }
  return out;
}

/** Слить уже показанные сообщения с пришедшими (опрос, живое обновление): пришедшее с тем же номером заменяет прежнее
 *  (у него новый статус доставки, повёрнутое фото), повторы по номеру канала отбрасываются, порядок — общий */
export function mergeMessages<T extends Dedupable>(shown: readonly T[], incoming: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const m of shown) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);
  return dedupeMessages([...byId.values()]);
}

/** Время для сообщения, у которого канал знает время неточно (до минуты): не раньше, чем сразу после предыдущего
 *  известного сообщения (floor), и не позже «сейчас». Иначе клиент, написавший в ту же минуту, что ответил бот, встал бы
 *  в истории выше ответа и выпал бы из «Ждут ответа». wanted — время от канала (мс), null — неизвестно */
export function placeAfter(floor: number, wanted: number | null, now: number): number {
  const base = wanted === null || !Number.isFinite(wanted) ? now : wanted;
  const at = Math.max(base, floor + 1);
  return Math.min(at, Math.max(now, floor + 1));
}
