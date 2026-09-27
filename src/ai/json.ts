/* Ответ модели — JSON, но модели иногда оборачивают его в ```json … ```, пишут слова до и после, ставят лишнюю запятую
   или обрываются на полуслове (кончилась длина ответа). Здесь разбор «с запасом»: первый настоящий JSON-объект в тексте,
   значение поля из оборванного ответа, значение из списка при другом написании («High», «высокая»). */

/** Текст без обёртки ```…``` вокруг всего ответа */
export function stripFences(text: string): string {
  const t = text.trim();
  const m = t.match(/^```[\w-]*[ \t]*\r?\n?([\s\S]*?)\r?\n?[ \t]*```$/);
  return (m ? (m[1] ?? "") : t).trim();
}

/** Где закрывается объект, открытый в start: скобки внутри строк не считаются. Не закрыт — -1 */
function closingBrace(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function asObject(s: string): Record<string, unknown> | null {
  // Второй заход — без лишних запятых перед } и ]: {"a": 1,}
  for (const candidate of [s, s.replace(/,\s*([}\]])/g, "$1")]) {
    try {
      const v: unknown = JSON.parse(candidate);
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* следующий вариант */
    }
  }
  return null;
}

/** Первый JSON-объект в ответе модели — где бы он ни стоял; не нашёлся — null */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  let from = 0;
  for (let tries = 0; tries < 20; tries++) {
    const start = text.indexOf("{", from);
    if (start === -1) return null;
    const end = closingBrace(text, start);
    if (end !== -1) {
      const obj = asObject(text.slice(start, end + 1));
      if (obj) return obj;
    }
    from = start + 1;
  }
  return null;
}

/** Строковое поле из оборванного JSON: «{"summary": "Клиент хочет записат…» → «Клиент хочет записат». Нет поля — null */
export function salvageString(text: string, field: string): string | null {
  const m = text.match(new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`));
  if (!m) return null;
  // Обрыв посреди «\u04…» — неполный знак отбрасываем (одинокая «\» в конце в захват не попадает)
  const raw = (m[1] ?? "").replace(/\\u[0-9a-fA-F]{0,3}$/, "");
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

/** Значение из списка: точное, другим регистром, другим словом (synonyms: «medium» → «normal») или запасное */
export function pickEnum<T extends string>(v: unknown, allowed: readonly T[], synonyms: Readonly<Record<string, T>>, fallback: T): T {
  if (typeof v !== "string") return fallback;
  const s = v.trim().toLowerCase();
  if ((allowed as readonly string[]).includes(s)) return s as T;
  return synonyms[s] ?? fallback;
}
