import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/* Отпечатки и подписи — только на сервере (node:crypto). */

export const sha1Hex = (data: string | Uint8Array): string => createHash("sha1").update(data).digest("hex");
export const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** Сравнение секретов за одно и то же время — по времени ответа нельзя подобрать ключ */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/* ── Временные ссылки на файлы ───────────────────────────────────────────────────────────────────────────────
   Nextbot и студия забирают файл, который менеджер отправил клиенту, сами — по ссылке без входа, которая живёт сутки.
   Подпись — HMAC-SHA256 от «<вид>:<номер>:<срок>» (base64url, 32 знака); вид — «file» (например, /files/<id>) или
   «media» (/api/pub/media/<id>): проект, у которого такие ссылки уже есть, переходит на набор без поломки выданных.
   Секрет — только на сервере (переменная окружения), отдельный от ключей каналов. */

export type LinkScope = "file" | "media";

export function fileSignature(secret: string, scope: LinkScope, id: string | number, exp: number): string {
  return createHmac("sha256", secret).update(`${scope}:${id}:${exp}`).digest("base64url").slice(0, 32);
}

/** Ссылка на файл без входа: «https://crm.example/files/15?exp=…&sig=…». path — адрес файла на сайте проекта */
export function signFileLink(o: { origin: string; path: string; id: string | number; secret: string; scope?: LinkScope; hours?: number; now?: number }): string {
  const exp = Math.floor((o.now ?? Date.now()) / 1000) + (o.hours ?? 24) * 3600;
  const sig = fileSignature(o.secret, o.scope ?? "file", o.id, exp);
  const base = o.origin.replace(/\/+$/, "") + o.path;
  return `${base}${base.includes("?") ? "&" : "?"}exp=${exp}&sig=${sig}`;
}

/** Проверка ссылки: подпись и срок (не в прошлом и не дальше, чем на hours вперёд). Отправлялся ли этот файл клиенту —
 *  проверяет проект по своей базе */
export function verifyFileLink(o: { id: string | number; exp: string | null; sig: string | null; secret: string; scope?: LinkScope; hours?: number; now?: number }): boolean {
  const exp = Number(o.exp);
  const now = o.now ?? Date.now();
  const hours = o.hours ?? 24;
  if (!Number.isInteger(exp) || !o.sig || exp * 1000 < now || exp * 1000 > now + (hours * 3600 + 300) * 1000) return false;
  return safeEqual(fileSignature(o.secret, o.scope ?? "file", o.id, exp), o.sig);
}
