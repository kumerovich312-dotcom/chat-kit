import { createHmac, randomBytes } from "node:crypto";
import { safeEqual } from "../../server/crypto.js";
import { bearerKey } from "../../server/request.js";

/* Посетитель сайта и его ключ — без базы.
   Номер посетителя выдаёт сервер (16 случайных байт), ключ — подпись номера секретом проекта: HMAC-SHA256(секрет,
   номер) в base64url. Проверка — пересчётом подписи, хранить ключи не нужно. Виджет присылает оба в каждом запросе:
   «Authorization: Bearer <номер>.<ключ>» (в адресе ключ не передаём — адреса оседают в журналах прокси).
   Секрет — только на сервере (переменная окружения проекта), отдельный от ключей каналов. Сменили секрет — прежние
   ключи не подходят: виджет сам начнёт новый чат, переписка в CRM остаётся. */

/** Номер посетителя: «v_» и 22 знака base64url */
export const VISITOR_ID_RE = /^v_[A-Za-z0-9_-]{16,64}$/;

/** Короче — ключи можно подобрать перебором */
export const MIN_SECRET_LENGTH = 16;

export function newVisitorId(): string {
  return `v_${randomBytes(16).toString("base64url")}`;
}

/** Ключ посетителя: HMAC-SHA256(секрет, номер), base64url */
export function siteToken(secret: string, visitorId: string): string {
  return createHmac("sha256", secret).update(visitorId).digest("base64url");
}

/** Ключ подходит к номеру. Сравнение за одно и то же время — по времени ответа ключ не подобрать */
export function verifySiteToken(secret: string, visitorId: string, token: string): boolean {
  if (siteSecretProblem(secret) || !VISITOR_ID_RE.test(visitorId) || !token) return false;
  return safeEqual(siteToken(secret, visitorId), token);
}

/** Номер посетителя из заголовка «Authorization: Bearer <номер>.<ключ>» — только если ключ верный */
export function siteVisitor(secret: string, headers: Record<string, string | undefined>): string | null {
  const key = bearerKey(headers);
  const dot = key.indexOf(".");
  if (dot <= 0) return null;
  const visitorId = key.slice(0, dot);
  return verifySiteToken(secret, visitorId, key.slice(dot + 1)) ? visitorId : null;
}

/** Что не так с секретом — для журнала сервера; null — всё хорошо */
export function siteSecretProblem(secret: string | null | undefined): string | null {
  if (!secret) return "нет секрета чата на сайте — задайте его в окружении проекта";
  if (secret.length < MIN_SECRET_LENGTH) return `секрет чата на сайте короче ${MIN_SECRET_LENGTH} знаков — задайте длинный случайный`;
  return null;
}
