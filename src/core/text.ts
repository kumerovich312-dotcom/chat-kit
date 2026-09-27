/* Поиск и слова — одни правила во всём окне: слова запроса в любом порядке,
   ё = е, регистр не важен, знак № не мешает. Без базы и импортов. */

/** ё → е: «Алёна» находится и как «Алена» */
export function foldYo(s: string): string {
  return s.replace(/ё/g, "е").replace(/Ё/g, "Е");
}

/** Слова запроса (до пяти), ё → е, знак № в начале слова не мешает */
export function searchWords(q: string): string[] {
  return foldYo(q).split(/\s+/).map((w) => w.replace(/^№/, "")).filter(Boolean).slice(0, 5);
}

/** Каждое слово запроса есть где-то в тексте */
export function textMatches(hay: string, q: string): boolean {
  const h = foldYo(hay).toLowerCase().replace(/№/g, "");
  return searchWords(q).every((w) => h.includes(w.toLowerCase()));
}

/** Русское число: plural(3, "сообщение", "сообщения", "сообщений") → «сообщения» */
export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = Math.abs(n) % 10;
  const m100 = Math.abs(n) % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

/** Инициалы для кружка: «Айбек Токтогулов» → «АТ», «@nick» → «N», пусто → «?» */
export function initials(name: string | null | undefined): string {
  const words = String(name ?? "").replace(/[@+]/g, " ").trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  const letters = words.slice(0, 2).map((w) => [...w.replace(/[^\p{L}\p{N}]/gu, "")][0] ?? "");
  return letters.join("").toUpperCase() || "?";
}
