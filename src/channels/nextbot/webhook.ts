import { randomBytes } from "node:crypto";

/* Настройки связи с Nextbot — без базы. Перенесено из Атласа (src/lib/nextbot.ts). */

/** Ключ компании для приёма событий: «nb_» + 48 знаков. Хранит проект (у Атласа — nextbot_settings.api_key) */
export function newNextbotKey(): string {
  return "nb_" + randomBytes(24).toString("hex");
}

/** Похоже на ключ Nextbot — до запроса к базе */
export function looksLikeNextbotKey(key: string): boolean {
  return key.startsWith("nb_") && key.length >= 10 && key.length <= 100;
}

/** «app.nextbot.ru/api/…» → «https://app.nextbot.ru/api/…»: ссылку часто копируют без начала */
export function webhookUrlFix(raw: string | null | undefined): string {
  const s = String(raw ?? "").trim();
  return s && !/^[a-z]+:\/\//i.test(s) ? `https://${s.replace(/^\/+/, "")}` : s;
}

/** Ссылка вебхука допустима? null — да, иначе текст ошибки. Только https и адреса Nextbot (nextbot.ru и его поддомены):
 *  иначе руководитель любой компании мог бы заставить сервер обращаться к внутренним адресам. allowAny — только стенд
 *  проверок на своём компьютере */
export function webhookUrlProblem(raw: string | null | undefined, allowAny = false): string | null {
  if (!raw) return "Не указана ссылка вебхука";
  if (raw.length > 500 || /\s/.test(raw)) return "Ссылка вебхука должна быть одной строкой без пробелов";
  let u: URL;
  try { u = new URL(webhookUrlFix(raw)); } catch { return "Ссылка вебхука не похожа на адрес"; }
  if (allowAny && (u.protocol === "http:" || u.protocol === "https:")) return null;
  if (u.protocol !== "https:") return "Ссылка вебхука должна начинаться с https://";
  const host = u.hostname.toLowerCase();
  if (host !== "nextbot.ru" && !host.endsWith(".nextbot.ru")) return "Ссылка вебхука должна вести на nextbot.ru (Интеграции → Вебхуки в Nextbot)";
  if (u.username || u.password || (u.port && u.port !== "443")) return "Ссылка вебхука не должна содержать логин, пароль или порт";
  return null;
}
