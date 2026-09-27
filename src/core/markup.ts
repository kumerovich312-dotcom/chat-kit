/* Разметка текста — без базы и без React.

   ИИ пишет ответ разметкой Markdown (**жирный**, *курсив*, `код`, [ссылка](https://…), списки, # заголовки). Каналы
   понимают разное: WhatsApp — *жирный* _курсив_ ~зачёркнутый~ `код`, Telegram — HTML (<b>, <i>, <s>, <code>, <a>),
   остальные — чистый текст. formatForChannel переводит ответ под канал перед отправкой.

   В окне переписки текст показывается с разметкой, но без вставки HTML: parseRich даёт дерево, окно рисует его своими
   элементами (набор никогда не вставляет присланный текст как HTML — так требует безопасность студии).
   Диалект «whatsapp» — для сообщений клиента из WhatsApp: *так* там жирный, как видит менеджер у себя в телефоне. */

export type RichNode =
  | { t: "text"; v: string }
  | { t: "b" | "i" | "s"; c: RichNode[] }
  | { t: "code"; v: string; block: boolean }
  | { t: "link"; href: string; c: RichNode[] };

export type Dialect = "markdown" | "whatsapp";

/** Правило разметки: найденное выражение → узел и сколько знаков он занял (у адреса хвостовая точка не его) */
type Rule = { re: RegExp; make: (m: RegExpExecArray, dialect: Dialect) => { node: RichNode; len: number } | null };

const L = "\\p{L}\\p{N}";
/** Знак для регулярки: в режиме u лишняя обратная косая черта — ошибка (\_ и \~ нельзя), нужна только у * */
const q = (ch: string) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Одиночный знак выделения: не внутри слова, без пробела у краёв, без этого же знака внутри, в одной строке */
const single = (ch: string) => new RegExp(`(?<![${L}${q(ch)}])${q(ch)}(?=[^\\s${q(ch)}])([^\\n${q(ch)}]*?[^\\s${q(ch)}])${q(ch)}(?![${L}${q(ch)}])`, "u");

const whole = (m: RegExpExecArray, node: RichNode) => ({ node, len: m[0].length });

const RULES: Rule[] = [
  { re: /```\n?([\s\S]+?)\n?```/, make: (m) => whole(m, { t: "code", v: m[1] ?? "", block: true }) },
  { re: /`([^`\n]+)`/, make: (m) => whole(m, { t: "code", v: m[1] ?? "", block: false }) },
  { re: /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/, make: (m, d) => whole(m, { t: "link", href: m[2] ?? "", c: parseRich(m[1] ?? "", d) }) },
  { re: /https?:\/\/[^\s<>"'«»]+/, make: (m) => url(m[0]) },
  { re: /(\*\*|__)(?=\S)([^\n]*?\S)\1/, make: (m, d) => whole(m, { t: "b", c: parseRich(m[2] ?? "", d) }) },
  { re: /~~(?=\S)([^\n]*?\S)~~/, make: (m, d) => whole(m, { t: "s", c: parseRich(m[1] ?? "", d) }) },
  { re: single("*"), make: (m, d) => whole(m, { t: d === "whatsapp" ? "b" : "i", c: parseRich(m[1] ?? "", d) }) },
  { re: single("_"), make: (m, d) => whole(m, { t: "i", c: parseRich(m[1] ?? "", d) }) },
  { re: single("~"), make: (m, d) => (d === "whatsapp" ? whole(m, { t: "s", c: parseRich(m[1] ?? "", d) }) : null) },
];

/** Адрес без хвостовых знаков препинания: «смотрите https://site.kg/a.pdf.» — точка не часть адреса */
function url(raw: string): { node: RichNode; len: number } | null {
  let href = raw;
  while (/[.,;:!?)\]}»]$/.test(href)) {
    if (href.endsWith(")") && (href.match(/\(/g)?.length ?? 0) >= (href.match(/\)/g)?.length ?? 0)) break;
    href = href.slice(0, -1);
  }
  if (!/^https?:\/\/[^/\s]+/.test(href)) return null;
  return { node: { t: "link", href, c: [{ t: "text", v: href }] }, len: href.length };
}

/** Текст → дерево разметки. Раньше начавшееся выделение главнее; при одном начале — более длинное (** раньше *) */
export function parseRich(text: string, dialect: Dialect = "markdown"): RichNode[] {
  const out: RichNode[] = [];
  let rest = text;
  while (rest) {
    let best: { m: RegExpExecArray; rule: Rule } | null = null;
    for (const rule of RULES) {
      const m = rule.re.exec(rest);
      if (!m) continue;
      if (!best || m.index < best.m.index || (m.index === best.m.index && m[0].length > best.m[0].length)) best = { m, rule };
    }
    if (!best) break;
    const made = best.rule.make(best.m, dialect);
    if (!made) {
      // Похоже на разметку, но в этом диалекте не она — знак остаётся текстом, ищем дальше
      push(out, rest.slice(0, best.m.index + 1));
      rest = rest.slice(best.m.index + 1);
      continue;
    }
    push(out, rest.slice(0, best.m.index));
    out.push(made.node);
    rest = rest.slice(best.m.index + made.len);
  }
  push(out, rest);
  return out;
}

function push(out: RichNode[], v: string) {
  if (!v) return;
  const last = out[out.length - 1];
  if (last && last.t === "text") last.v += v;
  else out.push({ t: "text", v });
}

/** Строки Markdown, которых нет в мессенджерах: «# Заголовок» → жирная строка, «* пункт» → «- пункт»
 *  (звёздочка в начале строки в WhatsApp выглядела бы как начало жирного) */
function blocks(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      const h = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
      if (h) return `**${h[1]}**`;
      return line.replace(/^(\s*)[*•]\s+/, "$1- ");
    })
    .join("\n");
}

export type MarkupTarget = "whatsapp" | "telegram" | "plain";

/** Ответ бота (Markdown) → текст для канала: WhatsApp — его звёздочки, Telegram — HTML (parse_mode HTML), иначе без
 *  разметки. Ссылка с подписью в WhatsApp и в тексте — «подпись (адрес)»: мессенджер сам делает адрес нажимаемым */
export function formatForChannel(text: string, target: MarkupTarget): string {
  const tree = parseRich(blocks(text), "markdown");
  if (target === "telegram") return renderTelegram(tree);
  return renderText(tree, target === "whatsapp");
}

/** Текст без разметки — для строки в списке диалогов, уведомлений и поиска */
export function stripRich(text: string, dialect: Dialect = "markdown"): string {
  return renderText(parseRich(dialect === "markdown" ? blocks(text) : text, dialect), false);
}

function renderText(nodes: RichNode[], wa: boolean): string {
  let s = "";
  for (const n of nodes) {
    switch (n.t) {
      case "text":
        s += n.v;
        break;
      case "b":
        s += wa ? `*${renderText(n.c, wa)}*` : renderText(n.c, wa);
        break;
      case "i":
        s += wa ? `_${renderText(n.c, wa)}_` : renderText(n.c, wa);
        break;
      case "s":
        s += wa ? `~${renderText(n.c, wa)}~` : renderText(n.c, wa);
        break;
      case "code":
        s += wa ? (n.block || n.v.includes("\n") ? "```" + n.v + "```" : "`" + n.v + "`") : n.v;
        break;
      case "link": {
        const label = renderText(n.c, wa);
        s += label === n.href ? n.href : `${label} (${n.href})`;
        break;
      }
    }
  }
  return s;
}

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function renderTelegram(nodes: RichNode[]): string {
  let s = "";
  for (const n of nodes) {
    switch (n.t) {
      case "text":
        s += esc(n.v);
        break;
      case "b":
      case "i":
      case "s":
        s += `<${n.t}>${renderTelegram(n.c)}</${n.t}>`;
        break;
      case "code":
        s += n.block || n.v.includes("\n") ? `<pre>${esc(n.v)}</pre>` : `<code>${esc(n.v)}</code>`;
        break;
      case "link":
        s += `<a href="${esc(n.href).replace(/"/g, "&quot;")}">${renderTelegram(n.c)}</a>`;
        break;
    }
  }
  return s;
}
