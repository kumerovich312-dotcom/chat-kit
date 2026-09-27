/* Телефоны клиентов — без базы и импортов. Перенесено из Атласа (src/lib/phone.ts, проверки test-units.mjs).

   Храним в едином виде «+996555140622» — приводим к международному сразу при сохранении (normalizePhone). Тогда поиск
   и проверка дублей работают при любом способе набора: 0555…, 555…, +996 555 … Показываем по-местному: «+996 555 14-06-22».

   Код страны берём из настроек компании: номер без «+» считается местным и читается по правилам этой страны (PLANS):
   «0555 14-06-22» в Кыргызстане, «8 701 123-45-67» в Казахстане, «8 029 123-45-67» в Беларуси. Номер с «+» уже
   международный — код компании к нему не приписываем.

   Сравнение (samePhone): оба номера узнаны с кодом страны — сравниваем целиком; иначе — по последним 9 цифрам. Только по 9
   цифрам нельзя: у Казахстана и России они совпадают у разных людей (+7 701 123-45-67 и +7 901 123-45-67). */

/** Только цифры номера */
export const phoneDigits = (v: unknown): string => String(v ?? "").replace(/\D/g, "");

/** Как пишут номера в стране, ключ — код страны:
 *  len — сколько цифр в номере без кода страны (от и до);
 *  trunk — что набирают перед номером внутри страны, длинное — первым: «0» в Кыргызстане, «8» в Казахстане
 *  и России, «8 0» в Беларуси. «0» узнаём везде: с него не начинается ни один номер без кода;
 *  bare: false — номер пишут только с этой приставкой (Германия): без неё не угадать, местный ли он;
 *  mask — как сгруппировать цифры после кода при показе, # — цифра. У Германии маски нет: код города там от 2 до 5 цифр,
 *  одной маской номер не сгруппировать — показываем как записан. */
type Plan = { len: [number, number]; trunk: string[]; bare?: false; mask?: string };
const PLANS: Record<string, Plan> = {
  "996": { len: [9, 9], trunk: ["0"], mask: "### ##-##-##" }, // Кыргызстан: 0555 14-06-22
  "7": { len: [10, 10], trunk: ["8", "0"], mask: "### ###-##-##" }, // Казахстан, Россия: 8 701 123-45-67
  "998": { len: [9, 9], trunk: ["8", "0"], mask: "## ###-##-##" }, // Узбекистан: 90 123-45-67, по старой привычке 8 90 …
  "992": { len: [9, 9], trunk: ["8", "0"], mask: "## ###-##-##" }, // Таджикистан: 8 90 123-45-67
  "375": { len: [9, 9], trunk: ["80", "0"], mask: "## ###-##-##" }, // Беларусь: 8 029 123-45-67, (029) 123-45-67
  "374": { len: [8, 8], trunk: ["0"], mask: "## ###-###" }, // Армения: 091 123-456
  "995": { len: [9, 9], trunk: ["0"], mask: "### ##-##-##" }, // Грузия
  "381": { len: [8, 10], trunk: ["0"], mask: "## ### ####" }, // Сербия: 064 123 4567, 011 123 4567
  "48": { len: [9, 9], trunk: ["0"], mask: "### ### ###" }, // Польша
  "49": { len: [6, 11], trunk: ["0"], bare: false }, // Германия: 030 1234567, 0151 23456789
  "420": { len: [9, 9], trunk: ["0"], mask: "### ### ###" }, // Чехия
  "90": { len: [10, 10], trunk: ["0"], mask: "### ### ## ##" }, // Турция: 0532 123 45 67
  "971": { len: [8, 9], trunk: ["0"], mask: "## ### ####" }, // ОАЭ: мобильные 050 123 4567; городские на цифру короче — как записаны
};
/** Код страны не из списка: как чаще всего — 9–10 цифр, перед ними 0 */
const OTHER: Plan = { len: [9, 10], trunk: ["0"] };

/** Страна (код ISO из двух букв, как в настройках TishCRM: «KG») → телефонный код «+996». Незнакомая — пусто */
const ISO: Record<string, string> = {
  KG: "996", KZ: "7", RU: "7", UZ: "998", TJ: "992", BY: "375", AM: "374", GE: "995", RS: "381", PL: "48", DE: "49",
  CZ: "420", TR: "90", AE: "971",
};
export function phoneCodeOfCountry(iso: string | null | undefined): string {
  const code = ISO[String(iso ?? "").trim().toUpperCase()];
  return code ? `+${code}` : "";
}

/** Номер без приписок: цифры, пробелы, скобки, точки, дефисы и «+» в начале */
const PLAIN = /^[\s(]*\+?[\d\s().–—-]*$/;
/** Набран с «+», в том числе «(+49) …» */
const PLUS = /^[\s(]*\+/;
/** Там, где на межгород набирают 8, за границу звонят через «8 10» */
const exits = (plan: Plan) => (plan.trunk.some((t) => t.startsWith("8")) ? ["00", "810"] : ["00"]);

/** «0555 14-06-22» + код «+996» → «+996555140622», «8 701 123-45-67» + «+7» → «+77011234567».
 *  null — если это не номер, номер с припиской («доб. 5», «мама») или местный номер не той длины:
 *  такой номер сохраняют как записан. */
export function normalizePhone(v: unknown, countryCode = ""): string | null {
  const raw = String(v ?? "");
  const digits = phoneDigits(raw);
  if (!digits || !PLAIN.test(raw)) return null;
  const intl = intlDigits(digits, PLUS.test(raw), phoneDigits(countryCode));
  if (!intl) return null;
  let d = dropTrunkZero(intl);
  // «8 701…», «8 916…» — номер Казахстана или России по-местному: других номеров из 11 цифр на 87 и 89 нет
  if (/^8[79]\d{9}$/.test(d)) d = "7" + d.slice(1);
  return d.length >= 7 && d.length <= 15 ? "+" + d : null;
}

/** «+996 (0555) 14-06-22», «+375 (029) …», «+49 (0) 151 …» — 0 межгорода после кода страны: в международном
 *  номере его нет, а номер без кода с 0 не начинается. Коды стран не начинаются один с другого — подходит один */
function dropTrunkZero(d: string): string {
  for (const [code, plan] of Object.entries(PLANS)) {
    const rest = d.length - code.length - 1;
    if (d.startsWith(code + "0") && d[code.length + 1] !== "0" && rest >= plan.len[0] && rest <= plan.len[1]) return code + d.slice(code.length + 1);
  }
  return d;
}

/** Цифры номера с кодом страны; null — местный номер не узнали */
function intlDigits(d: string, plus: boolean, cc: string): string | null {
  // С «+» номер уже международный. «+0555…» — лишний плюс перед местным номером: кода на 0 не бывает
  if (plus && !d.startsWith("0")) return d;
  const plan = PLANS[cc] ?? OTHER;
  const exit = exits(plan).find((x) => d.startsWith(x));
  // «00» / «8 10» — выход за границу; «8 10» + местный номер Казахстана или России короче 12 цифр не бывает
  if (exit && (exit === "00" || d.length > 11)) return d.slice(exit.length);
  if (cc) {
    const fits = (n: number) => n >= plan.len[0] && n <= plan.len[1];
    const trunk = plan.trunk.find((t) => d.startsWith(t) && d[t.length] !== "0" && fits(d.length - t.length));
    if (trunk !== undefined) return cc + d.slice(trunk.length); // 0555 14-06-22, 8 701 123-45-67
    if (d.startsWith(cc) && fits(d.length - cc.length)) return d; // код страны без «+»: 996 555 14-06-22
    if (plan.bare !== false && !d.startsWith("0") && fits(d.length)) return cc + d; // 555 14-06-22
  }
  // 11 цифр и больше — международный номер без «+»: так их присылают телефония и мессенджеры.
  // Короче — местный номер не той длины: не угадываем, пусть остаётся как записан
  return d.length >= 11 && !d.startsWith("0") ? d : null;
}

/** Последние 9 цифр — ключ для поиска и запасное сравнение: не зависят от кода страны и нулей */
export const phoneTail = (v: unknown): string => phoneDigits(v).slice(-9);

/** Один ли это номер. Оба узнаны с кодом страны — сравниваем целиком (+7 701… и +7 901… — разные люди);
 *  хотя бы один не узнан (местная запись без кода, номер с припиской) — по последним 9 цифрам */
export function samePhone(a: unknown, b: unknown, countryCode = ""): boolean {
  const na = normalizePhone(a, countryCode);
  const nb = normalizePhone(b, countryCode);
  if (na && nb) return na === nb;
  const ta = phoneTail(a);
  return ta.length === 9 && ta === phoneTail(b);
}

/** Цифры для поиска по части номера: «8 701 12» → «70112», «0555 14» → «55514», «+7 701» → «7701».
 *  Приставок 0, 8, 8 0, 00 и 8 10 в сохранённом номере нет — отбрасываем их, как и 0 после кода страны. */
export function phoneSearchDigits(v: unknown, countryCode = ""): string {
  const raw = String(v ?? "");
  const d = phoneDigits(raw);
  if (PLUS.test(raw) && !d.startsWith("0")) {
    const code = Object.keys(PLANS).find((c) => d.startsWith(c + "0"));
    return code ? code + d.slice(code.length + 1) : d;
  }
  const plan = PLANS[phoneDigits(countryCode)] ?? OTHER;
  const prefix = [...exits(plan), ...plan.trunk].find((p) => d.startsWith(p)) ?? (/^8[79]/.test(d) ? "8" : "");
  return d.slice(prefix.length);
}

const MASKS = Object.entries(PLANS).flatMap(([code, p]) => (p.mask ? [{ code, mask: p.mask, len: p.mask.split("#").length - 1 }] : []));

/** Телефон для показа: «+996550311714» → «+996 550 31-17-14», «+77011234567» → «+7 701 123-45-67» — цифры сгруппированы,
 *  как принято в стране номера. Номер без «+» считается местным: код страны приписываем так же, как при сохранении.
 *  Незнакомый код, номер другой длины или с припиской («доб. 12») — как записан. Пусто — пустая строка. */
export function fmtPhone(v: unknown, countryCode = ""): string {
  const raw = String(v ?? "").trim();
  if (!/^\+?[\d\s().-]+$/.test(raw)) return raw;
  const d = phoneDigits(normalizePhone(raw, countryCode));
  const m = MASKS.find((x) => d.startsWith(x.code) && d.length === x.code.length + x.len);
  if (!m) return raw;
  let i = m.code.length;
  return `+${m.code} ${m.mask.replace(/#/g, () => d[i++] ?? "")}`;
}

/** Номер со скрытой серединой — тем, кому номер видеть нельзя: «+996 550 ••-••-11». Код страны, первая группа цифр
 *  (оператор) и две последние цифры — как есть. Короткий или пустой номер — null */
export function maskPhone(v: unknown, countryCode = ""): string | null {
  const shown = fmtPhone(v, countryCode);
  const total = shown.replace(/\D/g, "").length;
  if (total < 7) return null;
  const groups = shown.split(/\s+/);
  // Узнали формат страны: «+996 550 91-06-11» — открыты «+996 550»; не узнали — первые пять цифр
  const head = groups.length >= 3 ? ((groups[0] ?? "") + (groups[1] ?? "")).replace(/\D/g, "").length : Math.min(5, total - 4);
  let seen = 0;
  return shown.replace(/\d/g, (ch) => (++seen <= head || seen > total - 2 ? ch : "•"));
}

/** Номер для набора (ссылка tel:): «+996555140622». Старую местную запись («0555 14-06-22») приводим по правилам страны
 *  компании; у номера с припиской («доб. 5», «мама») набираем то, что до приписки. Пусто — набирать нечего. */
export function dialNumber(v: unknown, countryCode = ""): string {
  const raw = String(v ?? "").split(/[a-zа-яё]/i)[0] ?? "";
  const n = normalizePhone(raw, countryCode) ?? raw;
  const d = phoneDigits(n);
  return d.length >= 5 ? (PLUS.test(n) ? "+" : "") + d : "";
}
