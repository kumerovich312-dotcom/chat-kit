import { parseRich, type RichNode } from "../../core/markup.js";

/* Текст письма — без библиотек, только разбор строк:
   - HTML → читаемый текст (письмо пришло только в HTML): абзацы и переносы, списки, ссылки «текст (адрес)», цитаты —
     строками «> »;
   - отрезать прошлую переписку и подпись: клиент отвечает поверх всей цепочки писем, а в ленте нужен только его ответ.
     Узнаём Gmail, Outlook, Яндекс, Mail.ru, Apple Mail и Thunderbird — по-русски и по-английски;
   - HTML ответа клиенту: абзацы и ссылки; ответ бота — с его разметкой (**жирный**, *курсив*, [ссылка](…)). */

/** Тема, если ответ не на письмо клиента и проект тему не передал */
export const DEFAULT_SUBJECT = "Ответ на ваше письмо";

const own = <T>(map: Readonly<Record<string, T>>, key: string): T | undefined => (Object.hasOwn(map, key) ? map[key] : undefined);

/* ── HTML → текст ─────────────────────────────────────────────────────────────────────────────────────────── */

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", laquo: "«", raquo: "»", ndash: "–", mdash: "—",
  hellip: "…", copy: "©", reg: "®", trade: "™", euro: "€", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", bdquo: "„",
  sbquo: "‚", bull: "•", middot: "·", times: "×", deg: "°", numero: "№", sect: "§", plusmn: "±", larr: "←", rarr: "→",
  minus: "−", shy: "", zwnj: "", zwj: "", thinsp: " ", ensp: " ", emsp: " ",
};

/** «&laquo;Привет&raquo; &amp; &#1087;ока» → «Привет» & пока. Незнакомое имя остаётся как было */
export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(?:#(\d{1,7});?|#[xX]([0-9a-fA-F]{1,6});?|([a-zA-Z][a-zA-Z0-9]{1,31});)/g, (m: string, dec?: string, hex?: string, name?: string) => {
    if (name !== undefined) return own(ENTITIES, name) ?? own(ENTITIES, name.toLowerCase()) ?? m;
    const code = dec !== undefined ? Number(dec) : parseInt(hex ?? "", 16);
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "";
    return String.fromCodePoint(code);
  });
}

/** Содержимое — не текст: стили, скрипты, заголовок страницы */
const SKIP = new Set(["head", "style", "script", "title", "template", "noscript", "svg", "object", "iframe", "xml"]);
/** Блоки — с новой строки */
const BLOCK = new Set([
  "p", "div", "section", "article", "header", "footer", "main", "aside", "nav", "table", "thead", "tbody", "tfoot", "tr",
  "ul", "ol", "dl", "dt", "dd", "h1", "h2", "h3", "h4", "h5", "h6", "form", "fieldset", "address", "figure", "figcaption",
  "center", "caption", "details", "summary",
]);
/** Абзацы — с пустой строкой вокруг */
const PARA = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "table", "ul", "ol", "blockquote", "pre", "hr"]);

/** Строка текста: куски склеиваются в конце (длинная строка не пересобирается при каждом куске); filled — есть не только
 *  пробелы, space — кончается пробелом */
type Line = { depth: number; pre: boolean; parts: string[]; filled: boolean; space: boolean };
const newLine = (depth: number, pre: boolean): Line => ({ depth, pre, parts: [], filled: false, space: false });

/** Адрес из атрибута href */
function hrefOf(attrs: string): string {
  const m = attrs.match(/(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i);
  return decodeEntities(m?.[1] ?? m?.[2] ?? m?.[3] ?? "").trim();
}

/** Адрес для сравнения: без https:// и mailto:, без косых черт в конце */
function bare(s: string): string {
  const t = s.slice(0, 2000).trim().toLowerCase().replace(/^(?:https?:\/\/|mailto:)/, "");
  let end = t.length;
  while (end > 0 && t[end - 1] === "/") end--;
  return t.slice(0, end);
}

/** Что дописать после текста ссылки: « (адрес)», если текст — не сам адрес. Ссылка-картинка (значки в подписи) — ничего */
function linkTail(href: string, text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (/^mailto:/i.test(href)) {
    const addr = href.slice(7).split("?")[0] ?? "";
    return !addr || bare(t) === bare(addr) ? "" : ` (${addr})`;
  }
  if (/^tel:/i.test(href)) return /\d/.test(t) ? "" : ` (${href.slice(4)})`;
  if (!/^https?:\/\//i.test(href) || bare(t) === bare(href)) return "";
  return ` (${href})`;
}

/** HTML длиннее — обрезаем: письмо приходит от кого угодно, разбор не должен занимать сервер надолго */
const MAX_HTML = 2 * 1024 * 1024;

/** HTML письма → читаемый текст: абзацы и переносы строк, списки «- пункт», ссылки «текст (адрес)», таблицы — строками,
 *  цитаты (blockquote) — строками «> ». Стили, скрипты и картинки выбрасываются */
export function htmlToText(input: string): string {
  const html = input.length > MAX_HTML ? input.slice(0, MAX_HTML) : input;
  const lower = html.toLowerCase();
  const lines: Line[] = [];
  let depth = 0;
  let pre = 0;
  let gap = false;
  let cur = newLine(0, false);
  const links: { href: string; text: string }[] = [];
  const lists: { ordered: boolean; n: number }[] = [];

  const flush = () => {
    lines.push(cur);
    cur = newLine(depth, pre > 0);
  };
  const block = (para: boolean) => {
    if (cur.filled) flush();
    else cur = newLine(depth, pre > 0);
    if (para) gap = true;
  };
  const emit = (raw: string) => {
    let s = raw;
    if (!cur.parts.length) {
      if (!pre) s = s.replace(/^ +/, "");
      if (!s) return;
      // Пустая строка между абзацами (одна, сколько бы блоков ни закрылось)
      const last = lines[lines.length - 1];
      if (gap && last && last.filled) lines.push(newLine(Math.min(depth, last.depth), false));
      gap = false;
      cur.depth = depth;
      cur.pre = pre > 0;
    } else if (!pre && cur.space && s.startsWith(" ")) {
      s = s.slice(1);
      if (!s) return;
    }
    cur.parts.push(s);
    cur.space = s.endsWith(" ");
    if (!cur.filled && /\S/.test(s)) cur.filled = true;
    // Текст ссылки нужен только сравнить с адресом — хватит начала
    for (const l of links) if (l.text.length < 500) l.text += s;
  };
  const text = (raw: string) => {
    const t = decodeEntities(raw);
    if (pre) {
      t.replace(/\r\n?/g, "\n").split("\n").forEach((part, i) => {
        if (i) flush();
        if (part) emit(part);
      });
    } else {
      const s = t.replace(/\s+/g, " ");
      if (s) emit(s);
    }
  };

  // Тег не длиннее, чем до следующего «<»: незакрытая кавычка или «>» не заставят перечитывать письмо с каждого «<»
  const re = /<!--[\s\S]*?(?:-->|$)|<![^<>]*>|<\?[^<>]*>|<(\/?)([a-zA-Z][\w:-]*)((?:[^<>"']|"[^"<>]*"|'[^'<>]*')*)>|[^<]+|</g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tok = m[0];
    const tag = m[2];
    if (tag === undefined) {
      if (tok.length > 1 && (tok.startsWith("<!") || tok.startsWith("<?"))) continue; // комментарии, <!DOCTYPE>
      text(tok);
      continue;
    }
    const name = tag.toLowerCase();
    const closing = m[1] === "/";
    const attrs = m[3] ?? "";
    if (!closing && SKIP.has(name) && !attrs.trimEnd().endsWith("/")) {
      // <style>…</style> и подобное — целиком мимо
      const end = lower.indexOf(`</${name}`, re.lastIndex);
      if (end < 0) break;
      const gt = html.indexOf(">", end);
      re.lastIndex = gt < 0 ? html.length : gt + 1;
      continue;
    }
    switch (name) {
      case "br":
        flush();
        break;
      case "blockquote":
        block(true);
        depth = Math.max(0, depth + (closing ? -1 : 1));
        break;
      case "pre":
        block(true);
        pre = Math.max(0, pre + (closing ? -1 : 1));
        break;
      case "ul":
      case "ol":
        block(true);
        if (closing) lists.pop();
        else lists.push({ ordered: name === "ol", n: 0 });
        break;
      case "li": {
        block(false);
        if (closing) break;
        const list = lists[lists.length - 1];
        emit(list?.ordered ? `${++list.n}. ` : "- ");
        break;
      }
      case "a":
        if (!closing) {
          if (links.length >= 16) links.shift(); // незакрытые ссылки без конца — не копим
          links.push({ href: hrefOf(attrs), text: "" });
        } else {
          const l = links.pop();
          if (l) emit(linkTail(l.href, l.text));
        }
        break;
      case "td":
      case "th":
        if (closing) emit(" ");
        break;
      case "hr":
        block(true);
        break;
      default:
        if (BLOCK.has(name)) block(PARA.has(name));
    }
  }
  if (cur.parts.length) lines.push(cur);

  return lines
    .map((l) => {
      const joined = l.parts.join("");
      const t = l.pre ? joined.trimEnd() : joined.replace(/[ \t]+/g, " ").trim();
      return l.depth ? `${"> ".repeat(Math.min(l.depth, 5))}${t}`.trimEnd() : t;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "");
}

/* ── Ответ без прошлой переписки ──────────────────────────────────────────────────────────────────────────── */

/* Письмо присылает кто угодно: выражения ниже не должны «задумываться» на длинных строках. Поэтому нигде нет двух
   повторов подряд, которые могут взять одни и те же знаки (\s*:?\s* на строке из тысяч пробелов перебирало бы
   миллиарды вариантов), а длинные строки подписью к цитате не считаются. */

/** Строка цитаты: «> текст» */
const QUOTED = /^\s*>/;
/** Пересланное письмо — это само содержание: его не режем */
const FORWARD = /^(?:-|\s)*(?:forwarded message|пересылаемое сообщение|пересланное сообщение|пересылаемое письмо|переслано|begin forwarded message|начало переадресованного сообщения)(?::|-|\s)*$/iu;
/** Невидимые знаки, которые вставляют почтовые программы: пробел нулевой ширины, метка порядка байтов */
const INVISIBLE = new RegExp(`[${String.fromCharCode(0x200b, 0x200c, 0x200d, 0x2060, 0xfeff)}]`, "g");
const NBSP = new RegExp(String.fromCharCode(0xa0), "g");
/** Текст письма длиннее — обрезаем до разбора (ответ клиента — в начале или среди цитат, а не за сотнями тысяч знаков) */
const MAX_SPLIT = 300_000;
/** Outlook: «-----Original Message-----», «-----Исходное сообщение-----» */
const ORIGINAL = /^\s*-{2,}\s*(?:original message|исходное сообщение|оригинальное сообщение|исходное письмо|оригінальне повідомлення)\s*-{2,}\s*$/iu;
/** Outlook: черта перед «От: …» */
const RULE = /^\s*_{8,}\s*$/;
/** Шапка прошлого письма у Outlook: «От: … / Отправлено: … / Кому: … / Тема: …» */
const H_FROM = /^\s*\*?(?:from|от|від)\s*:\*?\s*\S/iu;
const H_DATE = /^\s*\*?(?:sent|date|отправлено|дата|надіслано)\s*:/iu;
const H_OTHER = /^\s*\*?(?:to|cc|subject|кому|копия|тема)\s*:/iu;
/** «… Компания <hello@company.example>:» — Gmail по-русски, Яндекс, Mail.ru */
const EMAIL_END = /<\s*[^\s<>@]+@[^\s<>@]+>"?\s*:$/u;
/** «… написал(а):», «… пишет:», «… wrote:» */
const WROTE = /(?:wrote|написал\(а\)|написала|написал|пишет)\s*:$/iu;
/** Начало подписи к цитате, если почта перенесла её на вторую строку: «On …», дата, день недели */
const ATTR_START = /^(?:on\s|\d{1,2}[\s./-]|(?:пн|вт|ср|чт|пт|сб|вс|mon|tue|wed|thu|fri|sat|sun|понедельник|вторник|среда|четверг|пятница|суббота|воскресенье)[\p{L}.]*,?\s)/iu;
/** Хвосты почтовых программ на телефоне: «Отправлено с iPhone», «Sent from my iPhone», «Get Outlook for Android» */
const FOOTER = /^(?:sent from my .+|sent from (?:mail|outlook|yahoo mail)\b.*|get outlook for (?:ios|android).*|отправлено (?:с|из|через) .{1,80}|получить outlook для (?:ios|android).*)$/iu;

/** Подпись к цитате в одну строку: «On Fri, Sep 26, 2026 at 10:00 Company <hello@company.example> wrote:»,
 *  «26.09.2026 10:00, Компания пишет:», «пт, 26 сент. 2026 г. в 10:00, Компания <hello@company.example>:» */
function isAttribution(line: string): boolean {
  const t = line.trim();
  if (t.length < 8 || t.length > 400 || !t.endsWith(":")) return false;
  if (/^on\s/i.test(t) && /\bwrote:$/i.test(t)) return true;
  const digit = /\d/.test(t);
  if (WROTE.test(t) && (digit || t.includes("@"))) return true;
  return digit && EMAIL_END.test(t);
}

/** Сколько строк занимает подпись к цитате с этой строки (0 — не она). Gmail переносит длинную подпись на вторую строку */
function attributionAt(lines: readonly string[], i: number): number {
  const first = (lines[i] ?? "").trim();
  if (!first || QUOTED.test(first)) return 0;
  if (isAttribution(first)) return 1;
  if (!ATTR_START.test(first)) return 0;
  let s = first;
  for (let k = 1; k < 3; k++) {
    const next = (lines[i + k] ?? "").trim();
    if (!next || QUOTED.test(next)) return 0;
    s += s.endsWith("<") ? next : ` ${next}`;
    if (isAttribution(s)) return k + 1;
  }
  return 0;
}

/** Шапка прошлого письма Outlook: «От:», в следующих строках — «Отправлено:» / «Дата:» и «Кому:» / «Тема:» */
function headerBlockAt(lines: readonly string[], i: number): boolean {
  if (!H_FROM.test(lines[i] ?? "")) return false;
  let date = false;
  let other = false;
  for (let k = i + 1; k < Math.min(lines.length, i + 7); k++) {
    const l = lines[k] ?? "";
    if (!l.trim()) break;
    if (H_DATE.test(l)) date = true;
    else if (H_OTHER.test(l)) other = true;
  }
  return date && other;
}

/** Первая непустая строка начиная с from (номер) или -1 */
function nextFilled(lines: readonly string[], from: number): number {
  for (let k = from; k < lines.length; k++) if (lines[k]!.trim()) return k;
  return -1;
}

/** С этой строки начинается прошлая переписка (ответ сверху, цитата снизу). Подпись «… wrote:» режет всё ниже, только
 *  если цитата идёт до конца письма (или она без «>»): ответ снизу или вперемешку с цитатой так не потеряется.
 *  endsQuoted — последняя непустая строка письма — цитата */
function quoteStarts(lines: readonly string[], i: number, endsQuoted: boolean): boolean {
  const l = lines[i] ?? "";
  if (ORIGINAL.test(l)) return true;
  if (RULE.test(l)) {
    const next = nextFilled(lines, i + 1);
    return next >= 0 && headerBlockAt(lines, next);
  }
  if (headerBlockAt(lines, i)) return true;
  const n = attributionAt(lines, i);
  if (!n) return false;
  const first = nextFilled(lines, i + n);
  return first < 0 || !QUOTED.test(lines[first]!) || endsQuoted;
}

/** Хвост «Отправлено с iPhone» в конце — долой */
function dropFooter(lines: readonly string[]): string[] {
  const out = [...lines];
  for (;;) {
    while (out.length && !out[out.length - 1]!.trim()) out.pop();
    const last = out[out.length - 1];
    if (last === undefined || !FOOTER.test(last.trim())) return out;
    out.pop();
  }
}

const tidy = (lines: readonly string[]) => lines.map((l) => l.trimEnd()).join("\n").replace(/\n{3,}/g, "\n\n").trim();

/** Начало строки до n знаков — по границе слова */
export function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const space = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\n"));
  return `${(space > n * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Начало цитаты — для подписи «в ответ на …», если исходного письма в переписке нет */
function quoteText(lines: readonly string[]): string {
  const plain = lines.map((l) => l.replace(/^\s*(?:>\s?)+/, ""));
  const words: string[] = [];
  let len = 0;
  for (let i = 0; i < plain.length && len < 400; i++) {
    const l = plain[i]!;
    const n = attributionAt(plain, i);
    if (n) {
      i += n - 1;
      continue;
    }
    if (ORIGINAL.test(l) || RULE.test(l) || H_FROM.test(l) || H_DATE.test(l) || H_OTHER.test(l) || !l.trim()) continue;
    words.push(l.trim());
    len += l.length;
  }
  return clip(words.join(" ").replace(/\s+/g, " ").trim(), 300);
}

export type ReplyParts = {
  /** Что написал клиент — без прошлой переписки, подписи «-- » и хвостов «Отправлено с iPhone» */
  reply: string;
  /** Начало цитаты прошлого письма (до 300 знаков) — пусто, если цитаты нет */
  quote: string;
};

/** Отделить ответ клиента от прошлой переписки. Ответ сверху — режем от «On … wrote:», «… написал(а):»,
 *  «-----Original Message-----», шапки «От: … Отправлено: …»; строки «>» (ответ снизу или вперемешку) — убираем;
 *  подпись после «-- » — долой. forward — пересланное письмо: содержание целиком, режем только хвосты */
export function splitReply(input: string, o: { forward?: boolean | undefined } = {}): ReplyParts {
  const text = input.length > MAX_SPLIT ? input.slice(0, MAX_SPLIT) : input;
  let lines = text.replace(/\r\n?/g, "\n").replace(INVISIBLE, "").replace(NBSP, " ").split("\n");
  if (o.forward) return { reply: tidy(dropFooter(lines)), quote: "" };

  // Пересланное письмо внутри ответа («---------- Forwarded message ---------») — оставляем как есть
  let forwarded: string[] = [];
  const fw = lines.findIndex((l) => FORWARD.test(l));
  if (fw >= 0) {
    forwarded = lines.slice(fw);
    lines = lines.slice(0, fw);
  }

  // Ответ сверху: всё от начала прошлой переписки — прочь (если выше есть хоть строка ответа)
  let cut: string[] = [];
  let seen = false;
  let last = lines.length - 1;
  while (last >= 0 && !lines[last]!.trim()) last--;
  const endsQuoted = last >= 0 && QUOTED.test(lines[last]!);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (seen && quoteStarts(lines, i, endsQuoted)) {
      cut = lines.slice(i);
      lines = lines.slice(0, i);
      break;
    }
    if (l.trim() && !QUOTED.test(l)) seen = true;
  }

  // Строки «>» и подпись к ним — ответ снизу или вперемешку с цитатой
  const quoted: string[] = [];
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (QUOTED.test(l)) {
      quoted.push(l);
      continue;
    }
    const n = attributionAt(lines, i);
    if (n) {
      const next = nextFilled(lines, i + n);
      if (next < 0 || QUOTED.test(lines[next]!)) {
        quoted.push(...lines.slice(i, i + n));
        i += n - 1;
        continue;
      }
    }
    kept.push(l);
  }

  // Подпись: всё после строки «-- »
  const sig = kept.findIndex((l) => l.trimEnd() === "--");
  if (sig >= 0) kept.length = sig;

  let reply = tidy(dropFooter(kept));
  if (forwarded.length) reply = [reply, tidy(forwarded)].filter(Boolean).join("\n\n");
  return { reply, quote: quoteText(cut.length ? cut : quoted) };
}

/* ── Тема ответа ──────────────────────────────────────────────────────────────────────────────────────────── */

/** Тема ответа: «Re: <тема письма клиента>». Уже начинается с «Re:» / «Ответ:» — как есть (то же правило, что у поля
 *  ввода окна). Пусто — тема по умолчанию */
export function replySubject(subject: string | null | undefined, fallback = DEFAULT_SUBJECT): string {
  const s = String(subject ?? "").replace(/\s+/g, " ").trim();
  if (!s) return fallback;
  return /^(?:re|ответ|отв)(?:\[\d+\])?\s*:/iu.test(s) ? s : `Re: ${s}`;
}

/** Пересланное письмо по теме: «Fwd: …», «FW: …», «Пересл.: …» */
export function isForwardSubject(subject: string | null | undefined): boolean {
  return /^(?:fwd?|пересл(?:ано)?)\s*[.:]/iu.test(String(subject ?? "").trim());
}

/* ── Закодированные заголовки ─────────────────────────────────────────────────────────────────────────────── */

function qBytes(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const hex = s.slice(i + 1, i + 3);
    if (c === "_") out.push(0x20);
    else if (c === "=" && /^[0-9a-fA-F]{2}$/.test(hex)) {
      out.push(parseInt(hex, 16));
      i += 2;
    } else out.push(c.charCodeAt(0) & 0xff);
  }
  return new Uint8Array(out);
}

/** Тема или имя в сыром виде заголовка: «=?UTF-8?B?0J/RgNC40LLQtdGC?=» → «Привет» (base64 и quoted-printable;
 *  utf-8, windows-1251, koi8-r). Мост, который передаёт заголовки как есть, может прислать и так */
export function decodeMimeWords(s: string): string {
  if (!s.includes("=?")) return s;
  return s
    .replace(/(=\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)\s+(?==\?[^?\s]+\?[bBqQ]\?)/g, "$1")
    .replace(/=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g, (m: string, charset: string, enc: string, data: string) => {
      try {
        const bytes = enc.toUpperCase() === "B" ? Uint8Array.from(atob(data), (c) => c.charCodeAt(0)) : qBytes(data);
        return new TextDecoder((charset.split("*")[0] ?? "utf-8").toLowerCase()).decode(bytes);
      } catch {
        return m;
      }
    });
}

/* ── HTML ответа клиенту ──────────────────────────────────────────────────────────────────────────────────── */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const lineHtml = (s: string) => esc(s).replace(/\n/g, "<br>\n");

/** Текст человека: как набран, только адреса — ссылками. Хвостовая точка и скобка — не часть адреса */
function linkify(s: string): string {
  let out = "";
  let last = 0;
  for (const m of s.matchAll(/https?:\/\/[^\s<>"'«»]+/g)) {
    const raw = m[0];
    let open = 0;
    let close = 0;
    for (const ch of raw) {
      if (ch === "(") open++;
      else if (ch === ")") close++;
    }
    let end = raw.length;
    while (end > 0 && ".,;:!?)]}»".includes(raw[end - 1]!)) {
      if (raw[end - 1] === ")") {
        if (open >= close) break;
        close--;
      }
      end--;
    }
    const href = raw.slice(0, end);
    const at = m.index ?? 0;
    out += `${lineHtml(s.slice(last, at))}<a href="${esc(href)}">${esc(href)}</a>`;
    last = at + href.length;
  }
  return out + lineHtml(s.slice(last));
}

/** Ответ бота: разметка Markdown → теги письма (как у Telegram: жирный, курсив, зачёркнутый, код, ссылки) */
function richHtml(nodes: RichNode[]): string {
  let s = "";
  for (const n of nodes) {
    switch (n.t) {
      case "text":
        s += lineHtml(n.v);
        break;
      case "b":
      case "i":
      case "s":
        s += `<${n.t}>${richHtml(n.c)}</${n.t}>`;
        break;
      case "code":
        s += n.block || n.v.includes("\n") ? `<pre style="white-space:pre-wrap;margin:0">${esc(n.v)}</pre>` : `<code>${esc(n.v)}</code>`;
        break;
      case "link":
        s += `<a href="${esc(n.href)}">${richHtml(n.c)}</a>`;
        break;
    }
  }
  return s;
}

/** Заголовок Markdown без закрывающих решёток: «Заказ ##» → «Заказ» (без выражений с перебором — строка бывает длинной) */
function headingText(rest: string): string {
  const t = rest.trimEnd();
  let end = t.length;
  while (end > 0 && t[end - 1] === "#") end--;
  if (end === t.length) return t;
  return end === 0 || /\s/.test(t[end - 1]!) ? t.slice(0, end).trimEnd() : t;
}

/** Строки Markdown, которых нет в письме: «# Заголовок» → жирная строка, «* пункт» → «- пункт» */
const mdLines = (p: string) =>
  p.split("\n").map((line) => {
    const h = line.match(/^\s{0,3}#{1,6}\s+/);
    const title = h ? headingText(line.slice(h[0].length)) : "";
    if (title) return `**${title}**`;
    return line.replace(/^(\s*)[*•]\s+/, "$1- ");
  }).join("\n");

/** Текст ответа → простой HTML письма: абзацы, переносы строк, ссылки. markdown — ответ бота: его **жирный**, *курсив*,
 *  [ссылка](https://…) становятся разметкой; текст человека — как набран. Всё присланное экранируется */
export function mailHtml(text: string, o: { markdown?: boolean | undefined } = {}): string {
  const paras = text.replace(/\r\n?/g, "\n").trim().split(/\n[ \t]*\n+/).filter((p) => p.trim());
  const body = paras.map((p) => `<p style="margin:0 0 12px">${o.markdown ? richHtml(parseRich(mdLines(p))) : linkify(p)}</p>`).join("\n");
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5">\n${body}\n</div>`;
}
