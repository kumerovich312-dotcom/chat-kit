import type { DownloadResult } from "./channel.js";
import { sniffFile } from "./sniff.js";

/* Скачать файл по ссылке канала — осторожно:
   - только http и https, только разрешённые адреса (allowHost), перенаправления проверяются так же — иначе ссылкой
     из сообщения можно было бы заставить сервер ходить по внутренним адресам;
   - не больше maxBytes (по умолчанию 10 МБ): большой файл не качаем целиком;
   - тип — по содержимому (sniffFile), а не по словам канала; чужой тип (архив, программа) не сохраняем;
   - 404 — «нет файла», 5xx / 408 / 429 / нет связи — «попробовать потом». */

export type FetchFileOptions = {
  maxBytes?: number | undefined;
  timeoutMs?: number | undefined;
  /** Можно ли качать с этого адреса. Без проверки — любые публичные адреса, но не внутренние (localhost, 10.*, 192.168.*) */
  allowHost?: ((host: string) => boolean) | undefined;
  fetch?: typeof fetch | undefined;
};

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Внутренний адрес: сам сервер и локальные сети */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function allowed(url: URL, allowHost: FetchFileOptions["allowHost"]): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  return allowHost ? allowHost(url.hostname) : !isPrivateHost(url.hostname);
}

export async function fetchFile(raw: string, o: FetchFileOptions = {}): Promise<DownloadResult> {
  const max = o.maxBytes ?? MAX_FILE_BYTES;
  const doFetch = o.fetch ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 20_000);
  try {
    let url: URL;
    try { url = new URL(raw); } catch { return { ok: false, reason: "bad" }; }
    let res: Response | null = null;
    for (let hop = 0; hop < 4; hop++) {
      if (!allowed(url, o.allowHost)) return { ok: false, reason: "bad" };
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
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > max) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, reason: "bad" };
    }
    // Читаем кусками: сервер мог не сказать размер — больше max не держим в памяти
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > max) {
          await reader.cancel().catch(() => {});
          return { ok: false, reason: "bad" };
        }
        chunks.push(value);
      }
    }
    const data = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { data.set(c, off); off += c.byteLength; }
    if (!data.length) return { ok: false, reason: "bad" };
    const type = sniffFile(data);
    if (!type) return { ok: false, reason: "bad" };
    return { ok: true, data, mime: type.mime, ext: type.ext };
  } catch {
    return { ok: false, reason: "retry" };
  } finally {
    clearTimeout(timer);
  }
}
