import { fileExt } from "../../core/files.js";
import { fmtPhone, normalizePhone, phoneDigits } from "../../core/phone.js";
import { sniffFile } from "../../server/sniff.js";

/* Что присылает виджет — проверка и чистка. Всё, что пришло с сайта, написал посторонний человек: текст без управляющих
   знаков и не длиннее SITE_MAX_TEXT, файл — не больше SITE_MAX_FILE_BYTES и только фото, PDF, Word, Excel или аудио
   (тип — по содержимому), адреса страниц — без параметров, кроме меток utm_*. Телефон из формы никто не проверял:
   к известному клиенту по нему не привязываем (phoneTrusted: false). */

/** Самое длинное сообщение посетителя, знаков */
export const SITE_MAX_TEXT = 4000;
/** Самый большой файл от посетителя: 5 МБ (в запросе он ещё на треть больше — base64) */
export const SITE_MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Номер сообщения у виджета: по нему повтор после обрыва связи не записывается второй раз */
export const CLIENT_MSG_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Управляющие знаки (кроме табуляции и перевода строки) и невидимые переключатели направления письма — ими подменяют
 *  вид текста («файл.exe» выглядит как «файл.txt») */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F‪-‮⁦-⁩﻿]/g;

/** Текст посетителя: переводы строк — \n, без управляющих знаков, без пустоты по краям */
export function cleanText(v: unknown): string {
  return (typeof v === "string" ? v : "").replace(/\r\n?/g, "\n").replace(CONTROL, "").trim();
}

/** Однострочное поле (имя, телефон, почта, метка): ещё и без переводов строк и двойных пробелов */
export function oneLine(v: unknown, max: number): string {
  return cleanText(v).replace(/\s+/g, " ").slice(0, max).trim();
}

const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/* ── Форма перед чатом ──────────────────────────────────────────────────────────────────────────────────────── */

export type SiteProfile = { name: string | null; phone: string | null; email: string | null };
export type ProfileField = "name" | "phone" | "email";

const PHONE_RE = /^\+?[\d\s().-]{5,30}$/;
const EMAIL_RE = /^[^\s@<>()[\]",;:]+@[^\s@<>()[\]",;:]+\.[^\s@<>()[\]",;:.]{2,}$/;

/** Имя, телефон и почта из формы. Пустые поля — null; телефон и почта не того вида — ошибка у поля */
export function readProfile(raw: unknown, phoneCode = ""): { ok: true; profile: SiteProfile } | { ok: false; field: ProfileField; error: string } {
  const o = record(raw) ?? {};
  const name = oneLine(o.name, 80) || null;
  const phoneRaw = oneLine(o.phone, 40);
  const emailRaw = oneLine(o.email, 120);
  let phone: string | null = null;
  if (phoneRaw) {
    const digits = phoneDigits(phoneRaw).length;
    if (!PHONE_RE.test(phoneRaw) || digits < 6 || digits > 15) return { ok: false, field: "phone", error: "Проверьте номер телефона" };
    // По-местному записанный номер («0555 00-00-01») — в международный вид по коду страны компании; не узнали — как записан
    phone = normalizePhone(phoneRaw, phoneCode) ?? phoneRaw;
  }
  let email: string | null = null;
  if (emailRaw) {
    if (!EMAIL_RE.test(emailRaw)) return { ok: false, field: "email", error: "Проверьте адрес почты" };
    email = emailRaw;
  }
  return { ok: true, profile: { name, phone, email } };
}

export const hasProfile = (p: SiteProfile): boolean => !!(p.name || p.phone || p.email);

/* ── Откуда пришёл посетитель ───────────────────────────────────────────────────────────────────────────────── */

/** Где начат чат: страница, откуда пришли на сайт (реферер первой страницы), первая страница посещения (с метками) */
export type SitePage = {
  url?: string | null | undefined;
  referrer?: string | null | undefined;
  landing?: string | null | undefined;
};

const UTM = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;

export function readPage(raw: unknown): SitePage | null {
  const o = record(raw);
  if (!o) return null;
  const s = (v: unknown) => (typeof v === "string" ? v : null);
  return { url: s(o.url), referrer: s(o.referrer), landing: s(o.landing) };
}

function parseUrl(raw: unknown): URL | null {
  if (typeof raw !== "string" || !raw || raw.length > 4000) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

/** Адрес без лишнего: без логина, параметров и #… — в параметрах бывают личные данные и ключи (ссылка сброса пароля,
 *  номер заказа). Метки utm_* берём отдельно */
const shortUrl = (u: URL) => cleanText(u.origin + u.pathname).slice(0, 300);

/** Метки рекламы из адреса: «utm_source=google» */
export function utmOf(u: URL | null): string[] {
  if (!u) return [];
  return UTM.flatMap((k) => {
    const v = oneLine(u.searchParams.get(k), 100);
    return v ? [`${k}=${v}`] : [];
  });
}

/** Строка для CRM (один раз на посетителя): где начат чат, откуда пришёл, метки, как представился.
 *  «Чат на сайте: страница https://example.kg/prices · пришёл с google.com · метки: utm_source=google · представился: Айгерим» */
export function introText(page: SitePage | null, profile: SiteProfile | null, phoneCode = ""): string | null {
  const parts: string[] = [];
  const url = parseUrl(page?.url);
  const ref = parseUrl(page?.referrer);
  if (url) parts.push(`страница ${shortUrl(url)}`);
  // Переходы внутри того же сайта — не источник
  if (ref && ref.host !== url?.host) {
    const from = cleanText(ref.host.replace(/^www\./, "") + (ref.pathname === "/" ? "" : ref.pathname)).slice(0, 200);
    parts.push(`пришёл с ${from}`);
  }
  const utm = utmOf(parseUrl(page?.landing) ?? url);
  if (utm.length) parts.push(`метки: ${utm.join(", ")}`);
  const who = profile ? [profile.name, profile.phone ? fmtPhone(profile.phone, phoneCode) : null, profile.email].filter((x): x is string => !!x) : [];
  if (who.length) parts.push(`представился: ${who.join(", ")}`);
  return parts.length ? `Чат на сайте: ${parts.join(" · ")}` : null;
}

/* ── Файл от посетителя ─────────────────────────────────────────────────────────────────────────────────────── */

export type SiteFile = { name: string; mime: string; ext: string; data: Uint8Array; base64: string };
export type FileProblem = { ok: false; status: 400 | 413 | 415; error: string };

/** Что принимаем от посетителя: фото, аудио, PDF, Word и Excel (без макросов — так решает sniffFile). Видео, архивы,
 *  программы — нет */
export function siteFileAllowed(mime: string): boolean {
  return mime.startsWith("image/") || mime.startsWith("audio/") || mime === "application/pdf"
    || mime.includes("wordprocessingml") || mime.includes("spreadsheetml");
}

/** «5 МБ», «2,5 МБ» */
export const mbText = (bytes: number): string => String(Math.round((bytes / 1024 / 1024) * 10) / 10).replace(".", ",");

const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** base64 или «data:…;base64,…» → байты. Размер проверяем до расшифровки: большой файл в память не берём */
export function decodeBase64(raw: string, maxBytes: number): { ok: true; data: Uint8Array; base64: string } | FileProblem {
  const b64 = raw.replace(/^data:[^,]*;base64,/i, "").replace(/\s+/g, "");
  if (!b64 || b64.length % 4 !== 0 || !B64_RE.test(b64)) return { ok: false, status: 400, error: "Файл повреждён — выберите его снова" };
  const size = (b64.length / 4) * 3 - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
  if (size > maxBytes) return { ok: false, status: 413, error: `Файл больше ${mbText(maxBytes)} МБ — отправьте поменьше` };
  const buf = Buffer.from(b64, "base64");
  return { ok: true, data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), base64: b64 };
}

/** Имя файла для переписки: без папок и управляющих знаков, с расширением по содержимому («скан» → «скан.pdf») */
export function siteFileName(raw: unknown, ext: string): string {
  const base = oneLine(typeof raw === "string" ? raw.split(/[\\/]/).pop() : "", 120);
  if (!base) return `Файл.${ext}`;
  const have = fileExt(base);
  return have === ext || (ext === "jpg" && have === "jpeg") ? base : `${base}.${ext}`;
}

/** Файл из запроса виджета: { name, data: base64 }. Тип — по содержимому, а не по словам браузера */
export function readSiteFile(raw: unknown, maxBytes: number): { ok: true; file: SiteFile } | FileProblem {
  const o = record(raw);
  if (!o || typeof o.data !== "string") return { ok: false, status: 400, error: "Файл не прочитался — выберите его снова" };
  const dec = decodeBase64(o.data, maxBytes);
  if (!dec.ok) return dec;
  if (!dec.data.length) return { ok: false, status: 400, error: "Пустой файл — выберите другой" };
  const type = sniffFile(dec.data);
  if (!type || !siteFileAllowed(type.mime)) return { ok: false, status: 415, error: "Такой файл не принимаем: можно фото, PDF, Word, Excel или аудио" };
  return { ok: true, file: { name: siteFileName(o.name, type.ext), mime: type.mime, ext: type.ext, data: dec.data, base64: dec.base64 } };
}

/** Файл посетителя внутри события — «data:»-ссылкой: подключение само же её и прочитает (download), по сети не ходим */
export const siteDataUrl = (f: Pick<SiteFile, "mime" | "base64">): string => `data:${f.mime};base64,${f.base64}`;
