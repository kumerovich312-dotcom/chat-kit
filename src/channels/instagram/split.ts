/* Длинный текст — на части для канала с пределом длины сообщения (у Instagram — 1000 байт).
   Режем по абзацам, строкам, концам предложений, запятым, пробелам — не раньше середины части, чтобы не получались
   обрывки; слово длиннее предела — по буквам (пару UTF-16 у эмодзи не рвём). Считаем байты UTF-8: латинская буква —
   1 байт, русская — 2, эмодзи — 4. */

const bytesOf = (cp: number) => (cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4);

/** Длина строки в байтах UTF-8 */
export function utf8Length(s: string): number {
  let n = 0;
  for (const ch of s) n += bytesOf(ch.codePointAt(0) ?? 0);
  return n;
}

/** Где резать кусок: после последнего абзаца, строки, предложения, запятой или пробела во второй его половине */
function breakAt(head: string, min: number): number {
  for (const re of [/\n[ \t]*\n/g, /\n/g, /[.!?…](?=\s)/g, /[,;:](?=\s)/g, /\s/g]) {
    let best = -1;
    for (const m of head.matchAll(re)) {
      const at = (m.index ?? 0) + m[0].length;
      if (at >= min) best = at;
    }
    if (best > 0) return best;
  }
  return head.length;
}

/** Текст → части не длиннее maxBytes байт UTF-8. Пустой текст — пустой список */
export function splitMessageText(text: string, maxBytes: number): string[] {
  const limit = Math.max(16, Math.floor(maxBytes));
  const out: string[] = [];
  let rest = text.trim();
  while (rest) {
    if (utf8Length(rest) <= limit) {
      out.push(rest);
      break;
    }
    // Самый длинный кусок, который влезает
    let end = 0;
    let size = 0;
    for (const ch of rest) {
      const b = bytesOf(ch.codePointAt(0) ?? 0);
      if (size + b > limit) break;
      size += b;
      end += ch.length;
    }
    const cut = breakAt(rest.slice(0, end), Math.floor(end / 2));
    const piece = rest.slice(0, cut).trimEnd();
    if (piece) out.push(piece);
    rest = rest.slice(cut).trimStart();
  }
  return out;
}
