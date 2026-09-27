import { Buffer } from "node:buffer";
import { fileExt } from "../../core/files.js";
import type { DownloadResult } from "../../server/channel.js";
import { isPrivateHost } from "../../server/download.js";
import { sniffFile } from "../../server/sniff.js";

/* Вложения писем. Почтовый сервис присылает файлы прямо в вебхуке (base64): набор кладёт их в ссылку data: — ingest
   отдаёт её обратно подключению (download) уже после ответа вебхуку, файл сохраняется как у любого канала.
   Тип — по содержимому (sniffFile): фото, PDF, Word и Excel без макросов, аудио и видео. Простой текст и CSV — по словам
   письма, если внутри действительно текст. Остальное (архивы, программы, страницы HTML, старые Word и Excel, в которых
   бывают макросы) не сохраняем. */

/** Размер словами для сообщений об ошибке: «10 МБ», «1,5 МБ», «512 КБ» */
export function sizeWords(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${String(Math.round((bytes / 1024 / 1024) * 10) / 10).replace(".", ",")} МБ`;
  return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

/** Имя файла без путей и служебных знаков */
export function safeFileName(name: string | null | undefined): string {
  return String(name ?? "").replace(/[\u0000-\u001f\u007f\\/]/g, "").replace(/\s+/g, " ").trim().slice(0, 150);
}

/** Сколько байт в base64 (без расшифровки) */
export function base64Bytes(b64: string): number {
  const clean = b64.replace(/\s+/g, "");
  return Math.max(0, Math.floor((clean.length * 3) / 4) - (clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0));
}

/** base64 → байты; битое — null. Годится и base64url (с «-» и «_») */
export function decodeBase64(b64: string): Uint8Array | null {
  const clean = b64.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1) return null;
  const buf = Buffer.from(clean, "base64");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** Файл → ссылка data: с именем: «data:application/pdf;name=%D0%94….pdf;base64,JVBERi0…» */
export function toDataUrl(mime: string, base64: string, name?: string | null): string {
  const type = /^[\w.+-]+\/[\w.+-]+$/.test(mime.trim()) ? mime.trim().toLowerCase() : "application/octet-stream";
  const n = name ? `;name=${encodeURIComponent(name)}` : "";
  return `data:${type}${n};base64,${base64.replace(/\s+/g, "")}`;
}

export type DataUrlFile = { mime: string; name: string | null; data: Uint8Array };

/** Ссылка data: → тип, имя и байты. Не data: или битая — null; больше maxBytes — "big" (не расшифровывая) */
export function decodeDataUrl(url: string, maxBytes: number): DataUrlFile | "big" | null {
  const comma = url.indexOf(",");
  if (!url.startsWith("data:") || comma < 0) return null;
  const params = url.slice(5, comma).split(";").map((p) => p.trim());
  const isBase64 = params[params.length - 1]?.toLowerCase() === "base64";
  const first = params[0] ?? "";
  const mime = first.includes("/") ? first.toLowerCase() : "text/plain";
  let name: string | null = null;
  for (const p of params.slice(1)) {
    const m = p.match(/^(?:file)?name=(.*)$/i);
    if (!m) continue;
    try { name = decodeURIComponent(m[1] ?? ""); } catch { name = m[1] ?? null; }
  }
  const payload = url.slice(comma + 1);
  if (isBase64) {
    if (base64Bytes(payload) > maxBytes) return "big";
    const data = decodeBase64(payload);
    return data ? { mime, name, data } : null;
  }
  let raw: string;
  try { raw = decodeURIComponent(payload); } catch { return null; }
  const data = new TextEncoder().encode(raw);
  return data.byteLength > maxBytes ? "big" : { mime, name, data };
}

/** Похоже на простой текст: нет нулевых байтов и это не страница HTML и не картинка SVG */
function looksLikeText(b: Uint8Array): boolean {
  const head = b.subarray(0, 4096);
  if (!head.length || head.includes(0)) return false;
  const decoded = new TextDecoder("utf-8").decode(head);
  // Метка порядка байтов (BOM) в начале — не текст
  const start = (decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded).trimStart().slice(0, 64).toLowerCase();
  return !/^<(?:!doctype|html|head|body|script|svg|\?xml)/.test(start);
}

/** Какой это файл и можно ли его сохранить: тип по содержимому; текст и CSV — по словам письма. Нельзя — null */
export function mailFileType(data: Uint8Array, declaredMime: string, name: string | null): { mime: string; ext: string } | null {
  const sniffed = sniffFile(data);
  if (sniffed) return sniffed;
  const mime = (declaredMime.split(";")[0] ?? "").trim().toLowerCase();
  const ext = fileExt(name);
  const kind = mime === "text/csv" || ext === "csv" ? "csv" : mime === "text/plain" || ext === "txt" ? "txt" : null;
  if (!kind || !looksLikeText(data)) return null;
  return kind === "csv" ? { mime: "text/csv", ext: "csv" } : { mime: "text/plain", ext: "txt" };
}

/** Скачать вложение из ссылки data: (download подключения) */
export function downloadDataUrl(url: string, maxBytes: number): DownloadResult {
  const d = decodeDataUrl(url, maxBytes);
  if (d === null || d === "big" || !d.data.length) return { ok: false, reason: "bad" };
  const type = mailFileType(d.data, d.mime, d.name);
  return type ? { ok: true, data: d.data, mime: type.mime, ext: type.ext } : { ok: false, reason: "bad" };
}

export type FetchBytesResult = { ok: true; data: Uint8Array } | { ok: false; reason: "missing" | "big" | "retry" | "bad" };

/** Забрать файл по ссылке для исходящего письма (файл компании — тип не проверяем, но осторожно, как fetchFile набора):
 *  только http и https, без внутренних адресов (если не разрешены allowHost), перенаправления проверяются так же,
 *  не больше maxBytes */
export async function fetchBytes(
  raw: string,
  o: { maxBytes: number; fetch?: typeof fetch | undefined; allowHost?: ((host: string) => boolean) | undefined; timeoutMs?: number | undefined }
): Promise<FetchBytesResult> {
  const doFetch = o.fetch ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 20_000);
  const allowed = (u: URL) =>
    (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password && (o.allowHost ? o.allowHost(u.hostname) : !isPrivateHost(u.hostname));
  try {
    let url: URL;
    try { url = new URL(raw); } catch { return { ok: false, reason: "bad" }; }
    let res: Response | null = null;
    for (let hop = 0; hop < 4; hop++) {
      if (!allowed(url)) return { ok: false, reason: "bad" };
      res = await doFetch(url.href, { signal: ctrl.signal, redirect: "manual", cache: "no-store" });
      if (res.status < 300 || res.status >= 400) break;
      const next = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (!next) return { ok: false, reason: "missing" };
      url = new URL(next, url);
      res = null;
    }
    if (!res) return { ok: false, reason: "bad" };
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return res.status >= 500 || res.status === 408 || res.status === 429 ? { ok: false, reason: "retry" } : { ok: false, reason: "missing" };
    }
    if (Number(res.headers.get("content-length") ?? 0) > o.maxBytes) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, reason: "big" };
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > o.maxBytes) {
          await reader.cancel().catch(() => {});
          return { ok: false, reason: "big" };
        }
        chunks.push(value);
      }
    }
    if (!total) return { ok: false, reason: "missing" };
    const data = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      data.set(c, off);
      off += c.byteLength;
    }
    return { ok: true, data };
  } catch {
    return { ok: false, reason: "retry" };
  } finally {
    clearTimeout(timer);
  }
}
