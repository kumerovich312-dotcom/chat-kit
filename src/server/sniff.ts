/* Тип файла по содержимому (первым байтам), а не по имени и не по словам канала — как в Атласе (src/lib/files.ts
   detectType): фото, PDF, голосовые и видео мессенджеров, Word и Excel без макросов. Чужое (архивы, программы) — null. */

export type Sniffed = { mime: string; ext: string };

const starts = (b: Uint8Array, bytes: readonly number[], at = 0) => b.length >= at + bytes.length && bytes.every((x, i) => b[at + i] === x);
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, Math.min(to, b.length)));

/** Есть ли в данных строка (для zip-файлов Word и Excel: имена частей лежат в открытом виде) */
function has(b: Uint8Array, s: string): boolean {
  const pat = new TextEncoder().encode(s);
  outer: for (let i = 0; i + pat.length <= b.length; i++) {
    for (let j = 0; j < pat.length; j++) if (b[i + j] !== pat[j]) continue outer;
    return true;
  }
  return false;
}

export function sniffFile(b: Uint8Array): Sniffed | null {
  if (starts(b, [0x25, 0x50, 0x44, 0x46])) return { mime: "application/pdf", ext: "pdf" }; // %PDF
  if (starts(b, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", ext: "jpg" };
  if (starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: "image/png", ext: "png" };
  if (starts(b, [0x47, 0x49, 0x46, 0x38])) return { mime: "image/gif", ext: "gif" }; // GIF8
  if (b.length > 12 && ascii(b, 0, 4) === "RIFF") {
    const kind = ascii(b, 8, 12);
    if (kind === "WEBP") return { mime: "image/webp", ext: "webp" }; // фото и стикеры мессенджеров
    if (kind === "WAVE") return { mime: "audio/wav", ext: "wav" };
    return null;
  }
  // Word и Excel (docx, xlsx) — zip с [Content_Types].xml; с макросами (vbaProject) — нет
  if (starts(b, [0x50, 0x4b, 0x03, 0x04])) {
    if (has(b, "[Content_Types].xml") && !has(b, "vbaProject")) {
      if (has(b, "word/")) return { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: "docx" };
      if (has(b, "xl/")) return { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: "xlsx" };
    }
    return null;
  }
  if (starts(b, [0x4f, 0x67, 0x67, 0x53])) return { mime: "audio/ogg", ext: "ogg" }; // OggS — голосовые WhatsApp и Telegram
  if (starts(b, [0x49, 0x44, 0x33])) return { mime: "audio/mpeg", ext: "mp3" }; // ID3
  if (starts(b, [0x23, 0x21, 0x41, 0x4d, 0x52])) return { mime: "audio/amr", ext: "amr" }; // #!AMR
  if (starts(b, [0x1a, 0x45, 0xdf, 0xa3])) return { mime: "video/webm", ext: "webm" };
  // «ftyp» на 4-м байте: m4a — голос, qt — видео iPhone, heic — фото iPhone, остальное — видео mp4
  if (starts(b, [0x66, 0x74, 0x79, 0x70], 4) && b.length > 12) {
    const brand = ascii(b, 8, 12).toLowerCase();
    if (brand.startsWith("m4a") || brand.startsWith("m4b")) return { mime: "audio/mp4", ext: "m4a" };
    if (brand.startsWith("qt")) return { mime: "video/quicktime", ext: "mov" };
    if (brand.startsWith("heic") || brand.startsWith("heix") || brand.startsWith("mif1")) return { mime: "image/heic", ext: "heic" };
    if (brand.startsWith("3gp")) return { mime: "video/3gpp", ext: "3gp" };
    return { mime: "video/mp4", ext: "mp4" };
  }
  // MP3 без тега ID3: кадр начинается с 0xFF 0xE0…0xFF
  if (b.length > 2 && b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0) return { mime: "audio/mpeg", ext: "mp3" };
  return null;
}
