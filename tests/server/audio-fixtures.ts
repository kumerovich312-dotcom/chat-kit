/* Помощники тестов перекладки голосовых: сборщик WebM (EBML) и читатель Ogg. Написаны отдельно от кода набора, по
   описаниям форматов (Matroska / EBML; Ogg — RFC 3533; Ogg Opus — RFC 7845; Opus — RFC 6716), чтобы проверять его
   независимо. Пакеты Opus поддельные: первый байт (TOC) настоящий, остальное — предсказуемый «шум». */

export type Bytes = Uint8Array | readonly number[];

export function cat(parts: readonly Bytes[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export const text = (b: Uint8Array): string => String.fromCharCode(...b);
const bytesOf = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/** Байты из шестнадцатеричной записи («1a 45 df a3»), пробелы не важны */
export const hex = (s: string): Uint8Array => Uint8Array.from(s.replace(/\s+/g, "").match(/../g) ?? [], (h) => parseInt(h, 16));

/* ── WebM ─────────────────────────────────────────────────────────────────────────────────────────────────────── */

/** Номера элементов WebM */
export const ID = {
  EBML: 0x1a45dfa3, EBMLVersion: 0x4286, EBMLReadVersion: 0x42f7, EBMLMaxIDLength: 0x42f2, EBMLMaxSizeLength: 0x42f3,
  DocType: 0x4282, DocTypeVersion: 0x4287, DocTypeReadVersion: 0x4285,
  Segment: 0x18538067, SeekHead: 0x114d9b74, Void: 0xec, Info: 0x1549a966, TimecodeScale: 0x2ad7b1, MuxingApp: 0x4d80,
  WritingApp: 0x5741, Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackUID: 0x73c5, TrackType: 0x83,
  CodecID: 0x86, CodecPrivate: 0x63a2, Audio: 0xe1, SamplingFrequency: 0xb5, Channels: 0x9f, Video: 0xe0,
  PixelWidth: 0xb0, PixelHeight: 0xba, ContentEncodings: 0x6d80, ContentEncoding: 0x6240, ContentEncodingOrder: 0x5031,
  Cluster: 0x1f43b675, Timecode: 0xe7, SimpleBlock: 0xa3, BlockGroup: 0xa0, Block: 0xa1, BlockDuration: 0x9b,
  Cues: 0x1c53bb6b, CuePoint: 0xbb,
} as const;

/** Номер элемента — байтами, как он записан в файле (1–4 байта) */
function idBytes(id: number): number[] {
  const out: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  return out;
}

/** Число переменной длины (длина элемента, номер дорожки): самая короткая запись или ровно len байт */
export function vintBytes(n: number, len?: number): number[] {
  let l = len ?? 1;
  if (len === undefined) while (n >= 2 ** (7 * l) - 1) l++;
  const out = new Array<number>(l).fill(0);
  let v = n;
  for (let i = l - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0] = out[0]! | (0x80 >> (l - 1));
  return out;
}

/** Разница со знаком для шнуровки EBML: хранится значение + (2^(7·длина−1) − 1) */
function signedVint(d: number): number[] {
  let len = 1;
  while (Math.abs(d) > 2 ** (7 * len - 1) - 1) len++;
  return vintBytes(d + 2 ** (7 * len - 1) - 1, len);
}

/** Элемент известной длины */
export function el(id: number, ...children: Bytes[]): Uint8Array {
  const body = cat(children);
  return cat([idBytes(id), vintBytes(body.length), body]);
}

/** Элемент «длина неизвестна» — так пишет запись в Chrome (8 байт: 01 FF FF FF FF FF FF FF) */
export function open(id: number, ...children: Bytes[]): Uint8Array {
  return cat([idBytes(id), [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], ...children]);
}

export function uintEl(id: number, v: number): Uint8Array {
  const out: number[] = [];
  let x = v;
  do {
    out.unshift(x % 256);
    x = Math.floor(x / 256);
  } while (x > 0);
  return el(id, out);
}

export const strEl = (id: number, s: string): Uint8Array => el(id, bytesOf(s));

export function floatEl(id: number, v: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v);
  return el(id, b);
}

export const ebmlHeader = (docType = "webm"): Uint8Array =>
  el(ID.EBML, uintEl(ID.EBMLVersion, 1), uintEl(ID.EBMLReadVersion, 1), uintEl(ID.EBMLMaxIDLength, 4), uintEl(ID.EBMLMaxSizeLength, 8),
    strEl(ID.DocType, docType), uintEl(ID.DocTypeVersion, 4), uintEl(ID.DocTypeReadVersion, 2));

export const info = (): Uint8Array => el(ID.Info, uintEl(ID.TimecodeScale, 1_000_000), strEl(ID.MuxingApp, "Chrome"), strEl(ID.WritingApp, "Chrome"));

/** Заголовок Opus (OpusHead, 19 байт), как его пишет Chrome: пропуск в начале 0, частота 48 кГц */
export function opusHead(o: { channels?: number; preSkip?: number; version?: number; family?: number } = {}): Uint8Array {
  const h = new Uint8Array(19);
  h.set(bytesOf("OpusHead"));
  const dv = new DataView(h.buffer);
  h[8] = o.version ?? 1;
  h[9] = o.channels ?? 1;
  dv.setUint16(10, o.preSkip ?? 0, true);
  dv.setUint32(12, 48_000, true);
  h[18] = o.family ?? 0;
  return h;
}

export type TrackSpec = {
  number?: number | undefined;
  /** Вид дорожки: 1 — видео, 2 — звук; null — не писать */
  type?: number | null | undefined;
  codec?: string | undefined;
  /** Заголовок кодека (CodecPrivate); null — нет */
  head?: Uint8Array | null | undefined;
  /** Число каналов в элементе Audio; null — нет элемента Audio */
  channels?: number | null | undefined;
  extra?: readonly Bytes[] | undefined;
};

export function trackEntry(t: TrackSpec = {}): Uint8Array {
  const parts: Bytes[] = [uintEl(ID.TrackNumber, t.number ?? 1), uintEl(ID.TrackUID, 424242)];
  if (t.type !== null) parts.push(uintEl(ID.TrackType, t.type ?? 2));
  parts.push(strEl(ID.CodecID, t.codec ?? "A_OPUS"));
  if (t.head !== null) parts.push(el(ID.CodecPrivate, t.head ?? opusHead()));
  if (t.channels !== null) parts.push(el(ID.Audio, floatEl(ID.SamplingFrequency, 48_000), uintEl(ID.Channels, t.channels ?? 1)));
  return el(ID.TrackEntry, ...parts, ...(t.extra ?? []));
}

export const videoTrack = (number = 1): Uint8Array =>
  el(ID.TrackEntry, uintEl(ID.TrackNumber, number), uintEl(ID.TrackUID, 777), uintEl(ID.TrackType, 1), strEl(ID.CodecID, "V_VP8"),
    el(ID.Video, uintEl(ID.PixelWidth, 320), uintEl(ID.PixelHeight, 240)));

export type Lacing = "none" | "xiph" | "fixed" | "ebml";
export type BlockOpts = { track?: number | undefined; time?: number | undefined; lacing?: Lacing | undefined };

/** Содержимое блока: номер дорожки, время (2 байта), флаги, для шнуровки — число пакетов и их размеры, потом пакеты */
function blockBody(frames: readonly Uint8Array[], o: BlockOpts, flags: number): Uint8Array {
  const time = (o.time ?? 0) & 0xffff;
  const head = [...vintBytes(o.track ?? 1), time >> 8, time & 0xff];
  const lacing = o.lacing ?? "none";
  if (lacing === "none") {
    if (frames.length !== 1) throw new Error("без шнуровки — ровно один пакет");
    return cat([head, [flags], frames[0]!]);
  }
  const last = frames.length - 1;
  const sizes: number[] = [];
  if (lacing === "xiph") {
    for (const f of frames.slice(0, last)) {
      let n = f.length;
      for (; n >= 255; n -= 255) sizes.push(255);
      sizes.push(n);
    }
  } else if (lacing === "ebml") {
    frames.slice(0, last).forEach((f, i) => sizes.push(...(i === 0 ? vintBytes(f.length) : signedVint(f.length - frames[i - 1]!.length))));
  } else if (frames.some((f) => f.length !== frames[0]!.length)) {
    throw new Error("шнуровка «поровну» — пакеты одной длины");
  }
  const bits = lacing === "xiph" ? 0x02 : lacing === "fixed" ? 0x04 : 0x06;
  return cat([head, [flags | bits, last], sizes, ...frames]);
}

export const simpleBlock = (frames: readonly Uint8Array[], o: BlockOpts = {}): Uint8Array => el(ID.SimpleBlock, blockBody(frames, o, 0x80));

export const blockGroup = (frames: readonly Uint8Array[], o: BlockOpts = {}): Uint8Array =>
  el(ID.BlockGroup, el(ID.Block, blockBody(frames, o, 0)), uintEl(ID.BlockDuration, 20));

/** Запись «как из Chrome»: заголовок EBML, Segment и кластеры без длины, Info, дорожка Opus, по пакету в блоке */
export function chromeWebm(clusters: readonly (readonly Uint8Array[])[], track: TrackSpec = {}): Uint8Array {
  const parts: Bytes[] = [el(ID.Void, [0, 0, 0]), info(), el(ID.Tracks, trackEntry(track))];
  let time = 0;
  for (const packets of clusters) {
    parts.push(open(ID.Cluster, uintEl(ID.Timecode, time), ...packets.map((p, i) => simpleBlock([p], { time: i * 20 }))));
    time += packets.length * 20;
  }
  return cat([ebmlHeader(), open(ID.Segment, ...parts)]);
}

/* ── Opus ─────────────────────────────────────────────────────────────────────────────────────────────────────── */

/** Поддельный пакет Opus: TOC (настройка config, моно, код), для кода 3 — байт с числом кадров, дальше — «шум» */
export function opusPacket(config: number, code: 0 | 1 | 2 | 3, length: number, o: { frames?: number; seed?: number } = {}): Uint8Array {
  const p = new Uint8Array(length);
  let x = (o.seed ?? length) >>> 0 || 1;
  for (let i = 1; i < length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    p[i] = x >>> 24;
  }
  if (length) p[0] = (config << 3) | code;
  if (code === 3 && length > 1) p[1] = (o.frames ?? 1) & 0x3f;
  return p;
}

/** Длина кадра по «настройке» (config), мс — таблица из RFC 6716 */
export const FRAME_MS: readonly number[] = [
  10, 20, 40, 60, 10, 20, 40, 60, 10, 20, 40, 60, // SILK: узкая, средняя, широкая полоса
  10, 20, 10, 20, // гибрид
  2.5, 5, 10, 20, 2.5, 5, 10, 20, 2.5, 5, 10, 20, 2.5, 5, 10, 20, // CELT
];

/** Длительность пакета в отсчётах 48 кГц — по таблице, независимо от кода набора */
export function expectedSamples(p: Uint8Array): number {
  const toc = p[0]!;
  const code = toc & 3;
  const frames = code === 0 ? 1 : code === 3 ? p[1]! & 0x3f : 2;
  return FRAME_MS[toc >> 3]! * 48 * frames;
}

/* ── Ogg ──────────────────────────────────────────────────────────────────────────────────────────────────────── */

/** CRC-32 Ogg «в лоб», по битам: многочлен 0x04C11DB7, начало 0, без отражения битов и без XOR в конце */
export function oggCrc(bytes: Uint8Array): number {
  let c = 0;
  for (const byte of bytes) {
    c = (c ^ (byte << 24)) >>> 0;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? ((c << 1) ^ 0x04c11db7) >>> 0 : (c << 1) >>> 0;
  }
  return c;
}

export type OggPage = {
  version: number;
  flags: number;
  granule: bigint;
  serial: number;
  seq: number;
  lacing: number[];
  body: Uint8Array;
  crcOk: boolean;
};

/** Страницы Ogg подряд; контрольная сумма каждой считается заново и сравнивается с записанной */
export function readOgg(b: Uint8Array): OggPage[] {
  const pages: OggPage[] = [];
  for (let pos = 0; pos < b.length; ) {
    if (pos + 27 > b.length) throw new Error(`обрезанная страница на ${pos}`);
    if (text(b.subarray(pos, pos + 4)) !== "OggS") throw new Error(`нет «OggS» на ${pos}`);
    const dv = new DataView(b.buffer, b.byteOffset + pos, 27);
    const n = b[pos + 26]!;
    const lacing = [...b.subarray(pos + 27, pos + 27 + n)];
    const end = pos + 27 + n + lacing.reduce((a, x) => a + x, 0);
    if (lacing.length !== n || end > b.length) throw new Error(`обрезанная страница на ${pos}`);
    const copy = b.slice(pos, end);
    copy.fill(0, 22, 26);
    pages.push({
      version: b[pos + 4]!, flags: b[pos + 5]!, granule: dv.getBigInt64(6, true), serial: dv.getUint32(14, true), seq: dv.getUint32(18, true),
      lacing, body: b.subarray(pos + 27 + n, end), crcOk: oggCrc(copy) === dv.getUint32(22, true),
    });
    pos = end;
  }
  return pages;
}

export type OggPacket = { data: Uint8Array; page: number };

/** Пакеты из страниц: кусочки склеиваются, пока кусочек равен 255. Заодно проверяется флаг «продолжение» (1) */
export function oggPackets(pages: readonly OggPage[]): OggPacket[] {
  const out: OggPacket[] = [];
  let pending: Uint8Array[] = [];
  pages.forEach((pg, i) => {
    if (((pg.flags & 1) === 1) !== pending.length > 0) throw new Error(`флаг «продолжение» не сходится на странице ${i}`);
    let at = 0;
    for (const l of pg.lacing) {
      pending.push(pg.body.subarray(at, at + l));
      at += l;
      if (l < 255) {
        out.push({ data: cat(pending), page: i });
        pending = [];
      }
    }
  });
  if (pending.length) throw new Error("последний пакет не закончен");
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
