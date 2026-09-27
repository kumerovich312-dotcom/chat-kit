import { mimeFromName } from "../../core/files.js";

/* Отправка в Telegram — правила без сети: как разрезать длинный текст, каким методом отправить файл, как подготовить
   текст человека для разметки HTML. */

/** Сообщение — до 4096 знаков, подпись к файлу — до 1024 (Telegram считает видимые знаки, без разметки) */
export const TELEGRAM_TEXT_LIMIT = 4096;
export const TELEGRAM_CAPTION_LIMIT = 1024;
/** Фото загрузкой — до 10 МБ, любой файл от бота — до 50 МБ */
export const TELEGRAM_PHOTO_LIMIT = 10 * 1024 * 1024;
export const TELEGRAM_UPLOAD_LIMIT = 50 * 1024 * 1024;

/** Текст человека для parse_mode HTML: &, < и > уходят знаками, как их набрал менеджер (разметкой не станут) */
export const telegramEscape = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Где резать: последнее подходящее место не левее середины куска (иначе части выйдут слишком мелкими).
 *  keep — сколько знаков найденного оставить в первой части (точку предложения) */
function lastCut(win: string, re: RegExp, keep: boolean, min: number, max: number): number {
  let best = -1;
  for (const m of win.matchAll(re)) {
    const cut = m.index + (keep ? m[0].length : 0);
    if (cut >= min && cut <= max) best = cut;
  }
  return best;
}

/** Длинный текст → части не длиннее max: по абзацам, потом по строкам, по предложениям, по словам. Слово длиннее max
 *  режется как есть, но не посреди эмодзи. Пробелы на стыке частей отбрасываются */
export function splitTelegramText(text: string, max: number = TELEGRAM_TEXT_LIMIT): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    // +1: разделитель сразу за пределом тоже годится
    const win = rest.slice(0, max + 1);
    const min = Math.floor(max / 2);
    let cut = lastCut(win, /\n[ \t]*\n/g, false, min, max);
    if (cut < 0) cut = lastCut(win, /\n/g, false, min, max);
    if (cut < 0) cut = lastCut(win, /[.!?…]+(?=\s)/g, true, min, max);
    if (cut < 0) cut = lastCut(win, /\s/g, false, min, max);
    if (cut < 0) {
      cut = max;
      // Не разрезать пару знаков, из которых состоит эмодзи
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut--;
    }
    const part = rest.slice(0, cut).trimEnd();
    if (part) out.push(part);
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

export type TelegramFileMethod = {
  method: "sendPhoto" | "sendDocument" | "sendVoice" | "sendAudio" | "sendVideo";
  /** Поле файла в запросе */
  field: "photo" | "document" | "voice" | "audio" | "video";
};

export const TELEGRAM_DOCUMENT: TelegramFileMethod = { method: "sendDocument", field: "document" };

/** Тип файла без параметров («audio/ogg; codecs=opus» → «audio/ogg»); не указан — по расширению имени */
export function telegramFileMime(mime: string | null | undefined, name: string | null | undefined): string {
  const m = String(mime ?? "").toLowerCase().split(";")[0]!.trim();
  return m && m !== "application/octet-stream" ? m : mimeFromName(name);
}

/** Каким методом отправить файл: фото — фото (до 10 МБ), голосовое ogg/opus — голосовым, mp3 и m4a — аудио, mp4 —
 *  видео, остальное (PDF, Word, Excel, большое фото) — документом */
export function telegramFileMethod(mime: string, size?: number | null | undefined): TelegramFileMethod {
  if (mime === "image/jpeg" || mime === "image/png" || mime === "image/webp") {
    return size && size > TELEGRAM_PHOTO_LIMIT ? TELEGRAM_DOCUMENT : { method: "sendPhoto", field: "photo" };
  }
  if (mime === "audio/ogg" || mime === "audio/opus") return { method: "sendVoice", field: "voice" };
  if (mime === "audio/mpeg" || mime === "audio/mp3" || mime === "audio/mp4" || mime === "audio/x-m4a" || mime === "audio/m4a") {
    return { method: "sendAudio", field: "audio" };
  }
  if (mime === "video/mp4") return { method: "sendVideo", field: "video" };
  return TELEGRAM_DOCUMENT;
}

/** Документ по ссылке Telegram забирает сам только в PDF, GIF и ZIP — остальные подключение скачивает и загружает само */
export const TELEGRAM_URL_DOCUMENTS: ReadonlySet<string> = new Set(["application/pdf", "image/gif", "application/zip"]);
