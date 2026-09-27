import type { Attachment } from "./model.js";

/* Файлы в сообщениях — без базы. Вид файла (фото, голосовое, PDF, Word, Excel), размер словами, что показать
   в окне просмотра. Сами файлы лежат у проекта: набор знает только адрес (Attachment.url). */

export type FileKind = "image" | "audio" | "video" | "pdf" | "doc" | "xls" | "other";

const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", heic: "image/heic",
  svg: "image/svg+xml", pdf: "application/pdf",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv", txt: "text/plain", rtf: "application/rtf",
  ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac",
  amr: "audio/amr", wav: "audio/wav", mp4: "video/mp4", mov: "video/quicktime", "3gp": "video/3gpp", webm: "video/webm",
};

/** Расширение имени файла без точки, маленькими буквами: «Договор.DOCX» → «docx» */
export function fileExt(name: string | null | undefined): string {
  const m = String(name ?? "").match(/\.([a-z0-9]{1,5})$/i);
  return m?.[1]?.toLowerCase() ?? "";
}

/** Тип файла по расширению, когда канал его не прислал */
export function mimeFromName(name: string | null | undefined): string {
  return EXT_MIME[fileExt(name)] ?? "application/octet-stream";
}

/** Вид файла — как его показывать: фото картинкой, голосовое проигрывателем, документ плашкой */
export function fileKind(mime: string | null | undefined, name?: string | null): FileKind {
  const m = String(mime ?? "").toLowerCase().split(";")[0]!.trim();
  const type = m && m !== "application/octet-stream" ? m : mimeFromName(name);
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  if (type === "application/pdf") return "pdf";
  if (type.includes("wordprocessingml") || type === "application/msword" || type === "application/rtf") return "doc";
  if (type.includes("spreadsheetml") || type === "application/vnd.ms-excel" || type === "text/csv") return "xls";
  return "other";
}

/** Надпись на значке документа: PDF, DOC, XLS; остальное — «файл» */
export function fileBadge(kind: FileKind): string {
  return kind === "pdf" ? "PDF" : kind === "doc" ? "DOC" : kind === "xls" ? "XLS" : "файл";
}

/** «29 КБ», «1,4 МБ» */
export function fmtSize(bytes: number | null | undefined): string {
  if (!bytes || bytes < 0) return "";
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} МБ`;
  return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

/** Файл открывается в окне просмотра: фото — с лупой и поворотом, PDF — встроенным просмотрщиком браузера */
export function canView(a: Pick<Attachment, "mime" | "name">): boolean {
  const k = fileKind(a.mime, a.name);
  return k === "image" || k === "pdf";
}

/** Адрес файла с меткой содержимого: после поворота фото новая метка — браузер берёт повёрнутую картинку */
export function fileHref(a: Pick<Attachment, "url" | "version">, extra?: Record<string, string>): string {
  const params = new URLSearchParams();
  if (a.version) params.set("v", a.version);
  for (const [k, v] of Object.entries(extra ?? {})) params.set(k, v);
  const q = params.toString();
  return q ? `${a.url}${a.url.includes("?") ? "&" : "?"}${q}` : a.url;
}

/** Текст сообщения — это просто имя вложения («Файл: фото.jpg»): под вложением его не повторяем */
export function textIsFileName(text: string, attachments: readonly Pick<Attachment, "name">[] | undefined): boolean {
  const t = text.trim();
  if (!t || !attachments?.length) return !t;
  return attachments.some((a) => t === a.name || t === `Файл: ${a.name}`);
}

/** Слова вместо файла — для строки в списке диалогов и уведомлений: «Фото», «Голосовое сообщение», «Документ: договор.pdf» */
export function fileWords(a: Pick<Attachment, "mime" | "name">): string {
  switch (fileKind(a.mime, a.name)) {
    case "image":
      return "Фото";
    case "audio":
      return "Голосовое сообщение";
    case "video":
      return "Видео";
    default:
      return a.name ? `Документ: ${a.name}` : "Документ";
  }
}
