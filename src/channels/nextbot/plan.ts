import type { DumpLine } from "./parse.js";
import { isHandoff } from "./parse.js";
import type { MediaRef } from "./media.js";

/* Раскладка «Полного диалога» Nextbot на сообщения — без базы:
   что из дампа уже записано, где новое сообщение встанет в истории и какие файлы забрать.

   Время реплики: минута — из дампа (Nextbot пишет до минуты и по Гринвичу), а внутри минуты — строго после предыдущей
   реплики дампа, уже известной с точным временем (ответ бота, ответ из CRM). Иначе клиент, написавший в ту же минуту, что
   ответил бот, оказался бы в истории выше ответа и выпал бы из «Ждут ответа». Последняя реплика клиента — та, что прислала
   это событие, — ставится «сейчас» в пределах своей минуты. Если самая свежая реплика «в будущем» — у этого Nextbot другой
   пояс: сдвигаем на разницу (шагом 30 минут). */

export type KnownLine = { at: number; id: string; hasFile: boolean };

export type PlanInput = {
  lines: readonly DumpLine[];
  /** Ключ повтора каждой строки: «nb:<диалог>:<sha1(время|автор|текст)[0..32]>» — не менять: по нему узнаются уже записанные строки */
  eids: readonly string[];
  /** Строки, уже записанные в переписку (по ключу) — время и есть ли у них файл */
  knownEid: ReadonlyMap<string, KnownLine>;
  /** Файл строки (null — строка не файл или файлу негде лежать) */
  refs: readonly (MediaRef | null)[];
  /** Где искать файл строки */
  cands: readonly (readonly string[])[];
  /** Ссылки, по которым файл уже забирали: время сообщения с ним у клиента; null — по ссылке не файл */
  knownUrl: ReadonlyMap<string, number | null>;
  /** Наши сообщения этого клиента по тексту — их время (ответ бота событием, ответ из CRM) */
  outAt: ReadonlyMap<string, readonly number[]>;
  /** Кто автор наших строк дампа: бот или менеджер с телефона */
  outSender: "bot" | "operator_phone";
  /** Время события (точное, если Nextbot прислал поле time) или время прихода */
  eventNow: number;
  /** Время прихода — по нему узнаём сдвиг пояса */
  arrivedAt: number;
};

export type PlannedLine = { eid: string; text: string; out: boolean; at: number; handoff: boolean };

export type PlannedMedia = {
  urls: string[];
  ref: MediaRef | null;
  at: number;
  out: boolean;
  /** Строка дампа — сообщение с файлом получает её ключ */
  eid?: string | undefined;
  /** Текст строки — если файла не найдётся, строка останется текстом */
  text?: string | undefined;
  /** Строка, записанная раньше текстом: файл прикрепляется к ней */
  convertId?: string | undefined;
};

export type Plan = {
  inserts: PlannedLine[];
  media: PlannedMedia[];
  /** Самое свежее время строки дампа (со сдвигом) — ответ из поля agent встаёт после него */
  newest: number;
  /** Строк-файлов, которые встанут в историю, когда файл скачается */
  pendingFiles: number;
};

const MINUTE = 60_000;

export function planDump(p: PlanInput): Plan {
  const stamps = p.lines.map((l) => (l.at ? Date.parse(`${l.at.replace(" ", "T")}:00Z`) : NaN));
  const known = stamps.filter(Number.isFinite);
  const newest = known.length ? Math.max(...known) : NaN;
  let shift = 0;
  if (Number.isFinite(newest) && newest > p.arrivedAt + 10 * MINUTE) {
    shift = Math.round((newest - p.arrivedAt) / 1_800_000) * 1_800_000;
    if (shift > 14 * 3_600_000) shift = 0;
  }
  const inserts: PlannedLine[] = [];
  const media: PlannedMedia[] = [];
  const lastIdx = p.lines.length - 1;
  let floor = 0;
  let pendingFiles = 0;
  p.lines.forEach((line, i) => {
    const stamp = stamps[i] ?? NaN;
    const base = Number.isFinite(stamp) ? stamp - shift : NaN;
    const urls = [...(p.cands[i] ?? [])];
    const eid = p.eids[i]!;
    const ref = p.refs[i] ?? null;
    // Файл строки уже в переписке (время его сообщения) / по всем ссылкам уже пробовали — там не файл
    const fileAt = urls.map((u) => p.knownUrl.get(u)).find((x): x is number => typeof x === "number");
    const tried = urls.length > 0 && urls.every((u) => p.knownUrl.has(u));
    const byEid = p.knownEid.get(eid);
    if (byEid) {
      floor = Math.max(floor, byEid.at);
      // Строка-файл, записанная раньше текстом: забираем файл и прикрепляем к ней
      if (!byEid.hasFile && urls.length && !tried && fileAt === undefined) {
        media.push({ urls, ref, at: byEid.at, out: line.out, convertId: byEid.id });
      }
      return;
    }
    if (fileAt !== undefined) { floor = Math.max(floor, fileAt); return; }
    const seen = line.out && Number.isFinite(base)
      ? (p.outAt.get(line.text) ?? []).find((at) => Math.abs(at - base) <= 3 * 3_600_000)
      : undefined;
    if (seen !== undefined) { floor = Math.max(floor, seen); return; }
    let when = Number.isFinite(base) ? Math.max(base, floor + 1) : Math.max(p.eventNow, floor + 1);
    if (i === lastIdx && !line.out && Number.isFinite(base)) when = Math.max(when, Math.min(p.eventNow, base + MINUTE - 1));
    when = Math.min(when, Math.max(p.eventNow, floor + 1));
    floor = when;
    if (urls.length && !tried) {
      // Файл: сообщение с ним появится, когда файл скачается (после ответа Nextbot), — на этом же месте в истории
      media.push({ urls, ref, at: when, out: line.out, eid, text: line.text });
      pendingFiles++;
      return;
    }
    inserts.push({ eid, text: line.text, out: line.out, at: when, handoff: line.out && p.outSender === "bot" && isHandoff(line.text) });
  });
  return { inserts, media, newest: Number.isFinite(newest) ? newest - shift : 0, pendingFiles };
}
