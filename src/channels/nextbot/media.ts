/* Файлы в «Полном диалоге» Nextbot — без базы и импортов. Перенесено из Атласа (src/lib/nextbot-media.ts).
   Голосовое и документ Nextbot пишет строкой-ссылкой на хранилище номера WhatsApp (через Green API — DigitalOcean Spaces:
   https://<хранилище>.digitaloceanspaces.com/<номер>/<uuid>.docx), у документа строкой ниже — настоящее название
   («ДОГОВОР - 2026 (1)»); фото — одним именем файла («<uuid>.jpg»), а лежит оно в той же папке. Так и у клиента, и у
   менеджера с рабочего номера. Ссылки на другие сайты в тексте клиента не скачиваем — только из хранилищ мессенджера. */

const EXT = "jpe?g|png|webp|gif|heic|pdf|docx?|xlsx?|pptx?|rtf|txt|oga|ogg|opus|mp3|m4a|aac|amr|wav|mp4|mov|3gp|webm";
const URL_RE = new RegExp(`^https?://([^\\s/?#]+)((?:/[^\\s/?#]+)*)/([^\\s/?#]+\\.(?:${EXT}))(?:\\?\\S*)?$`, "i");
const NAME_RE = new RegExp(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(?:${EXT})$`, "i");

export type MediaRef = {
  /** Ссылка на файл; null — в строке только имя файла (фото), ссылку собирают из папки хранилища */
  url: string | null;
  /** Имя файла в хранилище («<uuid>.jpg») */
  file: string;
  /** Строки под ссылкой: название документа или подпись к фото */
  caption: string | null;
};

/** Строка «Полного диалога» — файл? Первая строка — ссылка или имя файла, остальное — название или подпись */
export function mediaRef(text: string): MediaRef | null {
  const [first = "", ...rest] = String(text ?? "").split("\n");
  const head = first.trim();
  const caption = rest.join("\n").trim() || null;
  const u = head.match(URL_RE);
  if (u) return { url: head, file: u[3] ?? "", caption };
  if (NAME_RE.test(head)) return { url: null, file: head, caption };
  return null;
}

/** Хранилища мессенджера, откуда забираем файлы строк дампа: DigitalOcean Spaces (WhatsApp через Green API) и хранилище
 *  самого Nextbot. extra — свои адреса (проверки: поддельное хранилище на 127.0.0.1) */
export function mediaHostAllowed(url: string, extra: readonly string[] = []): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return /(^|\.)digitaloceanspaces\.com$/.test(host) || host === "storage.nextbot.ru" || extra.includes(host);
}

/** Папка хранилища по ссылке на файл: «https://…/<номер>/x.docx» → «https://…/<номер>/» */
export function mediaFolder(url: string): string {
  const clean = url.split("?")[0] ?? url;
  return clean.slice(0, clean.lastIndexOf("/") + 1);
}

/** Папки хранилища в тексте дампа (по ссылкам на голосовые и документы) — там же ищутся фото, записанные одним именем */
export function mediaFolders(texts: readonly string[], extra: readonly string[] = []): string[] {
  const out: string[] = [];
  for (const t of texts) {
    const r = mediaRef(t);
    if (r?.url && mediaHostAllowed(r.url, extra)) {
      const f = mediaFolder(r.url);
      if (!out.includes(f)) out.push(f);
    }
  }
  return out;
}

/** Где искать файл строки: своя ссылка или имя файла в каждой известной папке (сначала — папки этого же диалога) */
export function mediaCandidates(ref: MediaRef, folders: readonly string[], extra: readonly string[] = []): string[] {
  if (ref.url) return mediaHostAllowed(ref.url, extra) ? [ref.url] : [];
  return folders.slice(0, 3).map((f) => f + ref.file);
}

/** Название файла в переписке: у документа — настоящее (строка под ссылкой) с расширением файла; у фото, голосового и
 *  видео — словами (подпись к фото остаётся текстом сообщения) */
export function mediaTitle(ref: MediaRef, mime: string, ext: string, out: boolean): string {
  if (mime.startsWith("image/")) return out ? "Фото" : "Фото от клиента";
  if (mime.startsWith("audio/")) return "Голосовое сообщение";
  if (mime.startsWith("video/")) return out ? "Видео" : "Видео от клиента";
  const own = (ref.caption ?? "").split("\n")[0]!.trim().replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").slice(0, 120).trim();
  if (own) return new RegExp(`\\.${ext}$`, "i").test(own) ? own : `${own}.${ext}`;
  return `${out ? "Документ" : "Документ от клиента"}.${ext}`;
}

/** Текст сообщения с файлом: подпись к фото или видео; у документа и голосового — название (под вложением не повторяется) */
export function mediaText(ref: MediaRef, mime: string, title: string): string {
  if ((mime.startsWith("image/") || mime.startsWith("video/")) && ref.caption) return ref.caption;
  return title;
}
