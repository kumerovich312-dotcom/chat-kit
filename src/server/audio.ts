import { MAX_FILE_BYTES } from "./download.js";

/* Голосовое из браузера — в формат мессенджеров, без перекодирования звука.

   Chrome записывает голос в WebM, а WhatsApp и Telegram показывают «голосовое» (кнопка и волна) только для Ogg — WebM
   уходит в лучшем случае обычным файлом. Внутри у обоих один и тот же звук Opus, поэтому звук не трогаем: кусочки Opus
   (пакеты) перекладываем из «коробки» WebM в «коробку» Ogg. Быстро (5 минут голоса — десятки миллисекунд) и без потери
   качества. Firefox сразу пишет Ogg, Safari обычно m4a — такие файлы не меняем.

   Где звать: в серверном действии проекта, которое сохраняет голосовое из поля ввода (в форме поле voice=1, в черновике
   readComposerForm — voice: true), до того, как файл ляжет в хранилище: voiceForChannel({ data, mime, name }). Тогда во
   все каналы уходит уже Ogg (audio/ogg), а в ленте играет тот же файл. Файлы с компьютера (без voice=1) не трогаем.

   Не перекладываем (null — файл остаётся как был): не WebM, видео, несколько дорожек, звук не Opus, сжатая или
   зашифрованная дорожка, обрезанный или испорченный файл, файл больше maxBytes. Метку DiscardPadding (сколько тишины
   срезать в конце) не переносим: в конце останется несколько миллисекунд тишины. */

export type WebmToOggOptions = {
  /** Файл больше — не трогаем (null). По умолчанию 10 МБ, как у скачивания файлов */
  maxBytes?: number | undefined;
};

export type VoiceFile = { data: Uint8Array; mime: string; name: string };

/** WebM (и вообще Matroska — это может быть и видео): файл начинается с метки EBML 1A 45 DF A3 */
export function isWebm(data: Uint8Array): boolean {
  return data.length >= 4 && data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3;
}

/** Ogg: файл начинается с «OggS» */
export function isOgg(data: Uint8Array): boolean {
  return data.length >= 4 && data[0] === 0x4f && data[1] === 0x67 && data[2] === 0x67 && data[3] === 0x53;
}

/** Длительность пакета Opus в отсчётах 48 кГц (960 — это 20 мс) — по первому байту (TOC): длина кадра по «настройке»
 *  (config), число кадров по коду (0 — один, 1 и 2 — два, 3 — во втором байте). 0 — не пакет Opus: пустой, код 3 без
 *  числа кадров или с нулём, длиннее 120 мс */
export function opusPacketSamples(packet: Uint8Array): number {
  return samplesAt(packet, 0, packet.length);
}

/** WebM с одной дорожкой Opus → Ogg Opus (те же пакеты, звук не перекодируется). Не подходит — null, без исключений */
export function webmOpusToOgg(data: Uint8Array, opts: WebmToOggOptions = {}): Uint8Array | null {
  if (!isWebm(data) || data.length > (opts.maxBytes ?? MAX_FILE_BYTES)) return null;
  try {
    const voice = readWebm(data);
    // Номер потока — из содержимого: один и тот же файл всегда даёт один и тот же Ogg
    const ogg = new OggWriter(crc32(data, 0, data.length), data.length + 1024);
    // Заголовки: OpusHead — один на первой странице (флаг «начало потока»), OpusTags — на второй; отметка у обеих 0
    ogg.add(voice.head, 0, voice.head.length, 0, 0);
    ogg.flush(BOS);
    const tags = opusTags();
    ogg.add(tags, 0, tags.length, 0, 0);
    ogg.flush(0);
    // Звук. Отметка страницы (granule) — сколько отсчётов 48 кГц закончилось к концу страницы; страница — до секунды
    // звука и не больше 255 кусочков
    let granule = 0;
    for (let i = 0; i < voice.from.length; i++) {
      const from = voice.from[i]!;
      const to = voice.to[i]!;
      const n = samplesAt(data, from, to);
      if (!n) bad();
      if (ogg.segments && (ogg.samples + n > PAGE_SAMPLES || ogg.segments + Math.floor((to - from) / 255) + 1 > 255)) ogg.flush(0);
      granule += n;
      ogg.add(data, from, to, granule, n);
    }
    ogg.flush(EOS);
    return ogg.bytes();
  } catch {
    return null;
  }
}

/** Голосовое для каналов: запись браузера в WebM с Opus → Ogg («audio/ogg», имя с .ogg) — тогда WhatsApp и Telegram
 *  покажут голосовое, а не файл. Всё остальное (Ogg, m4a, mp3, видео, испорченный файл) — как есть.
 *  Звать в серверном действии проекта, которое сохраняет голосовое из поля ввода (поле формы voice=1), до того, как
 *  файл ляжет в хранилище: так Ogg уйдёт во все каналы. Например:
 *    const d = readComposerForm(form);
 *    if (d.file && d.voice) {
 *      const v = voiceForChannel({ data: new Uint8Array(await d.file.arrayBuffer()), mime: d.file.type, name: d.file.name });
 *      // дальше сохранить v.data с типом v.mime и именем v.name — как любой файл
 *    } */
export function voiceForChannel(file: VoiceFile, opts?: WebmToOggOptions): VoiceFile {
  const ogg = webmOpusToOgg(file.data, opts);
  return ogg ? { data: ogg, mime: "audio/ogg", name: oggName(file.name) } : file;
}

/** «Голосовое 14-05.webm» → «Голосовое 14-05.ogg». Меняем только расширения звука: в имени может быть дата с точками */
function oggName(name: string): string {
  const base = name.trim().replace(/\.(webm|weba|mka|mkv|ogg|oga|opus)$/i, "");
  return `${base || "Голосовое"}.ogg`;
}

/* ── Opus ───────────────────────────────────────────────────────────────────────────────────────────────────── */

/** Длина кадра SILK по «настройке»: 10, 20, 40, 60 мс */
const SILK_FRAME = [480, 960, 1920, 2880] as const;

function samplesAt(b: Uint8Array, from: number, to: number): number {
  if (from >= to) return 0;
  const toc = b[from]!;
  const config = toc >> 3;
  // Настройки 0–11 — SILK (10–60 мс), 12–15 — гибрид (10 или 20 мс), 16–31 — CELT (2,5, 5, 10 или 20 мс)
  const frame = config < 12 ? SILK_FRAME[config & 3]! : config < 16 ? (config & 1 ? 960 : 480) : 120 << (config & 3);
  const code = toc & 3;
  const frames = code === 0 ? 1 : code < 3 ? 2 : to - from > 1 ? b[from + 1]! & 0x3f : 0;
  const total = frame * frames;
  return total <= 5760 ? total : 0;
}

/* ── Разбор WebM ────────────────────────────────────────────────────────────────────────────────────────────────
   WebM — вложенные элементы EBML: номер (1–4 байта), длина (1–8 байт), содержимое. Нам нужны: заголовок EBML (тип
   файла), Segment → Tracks → TrackEntry (кодек, заголовок Opus, число каналов) и Segment → Cluster → SimpleBlock или
   BlockGroup → Block (пакеты). Запись в браузере не знает заранее своей длины: у Segment и Cluster длина «неизвестна»
   (все биты — единицы), такой элемент кончается там, где начинается следующий элемент его уровня или файл. */

const EBML = 0x1a45dfa3;
const DOC_TYPE = 0x4282;
const SEGMENT = 0x18538067;
const TRACKS = 0x1654ae6b;
const TRACK_ENTRY = 0xae;
const TRACK_NUMBER = 0xd7;
const TRACK_TYPE = 0x83;
const CODEC_ID = 0x86;
const CODEC_PRIVATE = 0x63a2;
const AUDIO = 0xe1;
const CHANNELS = 0x9f;
const CONTENT_ENCODINGS = 0x6d80;
const CLUSTER = 0x1f43b675;
const SIMPLE_BLOCK = 0xa3;
const BLOCK_GROUP = 0xa0;
const BLOCK = 0xa1;

/** Элементы уровня Segment и начало нового файла: встретили такой внутри Cluster без длины — Cluster кончился */
const SEGMENT_LEVEL: ReadonlySet<number> = new Set([
  CLUSTER, TRACKS, 0x1549a966 /* Info */, 0x114d9b74 /* SeekHead */, 0x1c53bb6b /* Cues */, 0x1254c367 /* Tags */,
  0x1043a770 /* Chapters */, 0x1941a469 /* Attachments */, SEGMENT, EBML,
]);

type Track = { number: number; type: number; codec: string; head: Uint8Array | null; channels: number; encoded: boolean };
/** Что нашли в файле: дорожки и все пакеты — где лежат (from…to) и какой дорожки */
type Found = { tracks: Track[]; from: number[]; to: number[]; owner: number[] };
/** Заголовок элемента: номер, где начинается содержимое, длина (-1 — неизвестна) */
type Head = { id: number; data: number; size: number };

/** Файл не подходит — прерываем разбор; наружу это становится null */
function bad(): never {
  throw new RangeError("Не голосовое WebM с Opus");
}

function readWebm(b: Uint8Array): { head: Uint8Array; from: number[]; to: number[] } {
  const end = b.length;
  const top = head(b, 0, end);
  if (top.id !== EBML || top.size < 0) bad();
  each(b, top.data, top.data + top.size, (h) => {
    if (h.id !== DOC_TYPE) return;
    const kind = ascii(b, h.data, h.data + h.size);
    if (kind !== "webm" && kind !== "matroska") bad();
  });
  const found: Found = { tracks: [], from: [], to: [], owner: [] };
  let segments = 0;
  for (let pos = top.data + top.size; pos < end; ) {
    const h = head(b, pos, end);
    if (h.id === SEGMENT) {
      // Второй Segment — склейка двух записей: взять одну значило бы молча потерять часть голоса
      if (++segments > 1) bad();
      pos = segment(b, h.data, h.size < 0 ? end : h.data + h.size, h.size < 0, found);
    } else {
      if (h.size < 0) bad();
      pos = h.data + h.size;
    }
  }
  // Ровно одна дорожка, и это звук Opus без сжатия и шифрования
  if (found.tracks.length !== 1) bad();
  const t = found.tracks[0]!;
  if (t.codec !== "A_OPUS" || (t.type !== 0 && t.type !== 2) || t.encoded || !t.number) bad();
  const from: number[] = [];
  const to: number[] = [];
  for (let i = 0; i < found.owner.length; i++) {
    if (found.owner[i] !== t.number) continue;
    from.push(found.from[i]!);
    to.push(found.to[i]!);
  }
  if (!from.length) bad();
  return { head: opusHead(t), from, to };
}

/** Содержимое Segment. Без длины — до конца файла или до начала следующего файла. Возвращает, где Segment кончился */
function segment(b: Uint8Array, from: number, end: number, open: boolean, found: Found): number {
  let pos = from;
  while (pos < end) {
    const h = head(b, pos, end);
    if (open && (h.id === EBML || h.id === SEGMENT)) return pos;
    if (h.id === CLUSTER) {
      pos = cluster(b, h, end, found);
      continue;
    }
    if (h.size < 0) bad();
    if (h.id === TRACKS) {
      each(b, h.data, h.data + h.size, (e) => {
        if (e.id === TRACK_ENTRY) found.tracks.push(track(b, e.data, e.data + e.size));
      });
    }
    pos = h.data + h.size;
  }
  return pos;
}

/** Кластер — кусок записи с блоками. Без длины — кончается перед следующим элементом уровня Segment */
function cluster(b: Uint8Array, h: Head, parentEnd: number, found: Found): number {
  const open = h.size < 0;
  const end = open ? parentEnd : h.data + h.size;
  let pos = h.data;
  while (pos < end) {
    const c = head(b, pos, end);
    if (open && SEGMENT_LEVEL.has(c.id)) return pos;
    if (c.size < 0) bad();
    const to = c.data + c.size;
    if (c.id === SIMPLE_BLOCK) block(b, c.data, to, found);
    else if (c.id === BLOCK_GROUP) {
      each(b, c.data, to, (g) => {
        if (g.id === BLOCK) block(b, g.data, g.data + g.size, found);
      });
    }
    pos = to;
  }
  return end;
}

/** Дорожка: номер, вид (2 — звук), кодек, заголовок кодека, число каналов, есть ли сжатие или шифрование */
function track(b: Uint8Array, from: number, to: number): Track {
  const t: Track = { number: 0, type: 0, codec: "", head: null, channels: 0, encoded: false };
  each(b, from, to, (h) => {
    const end = h.data + h.size;
    if (h.id === TRACK_NUMBER) t.number = uint(b, h.data, end);
    else if (h.id === TRACK_TYPE) t.type = uint(b, h.data, end);
    else if (h.id === CODEC_ID) t.codec = ascii(b, h.data, end);
    else if (h.id === CODEC_PRIVATE) t.head = b.subarray(h.data, end);
    else if (h.id === CONTENT_ENCODINGS) t.encoded = true;
    else if (h.id === AUDIO) {
      each(b, h.data, end, (a) => {
        if (a.id === CHANNELS) t.channels = uint(b, a.data, a.data + a.size);
      });
    }
  });
  return t;
}

/** Блок: номер дорожки, время (2 байта), флаги и один или несколько пакетов. Несколько пакетов в блоке («шнуровка»,
 *  lacing) запись в Chrome не делает, но другие программы могут: Xiph, EBML и «поровну» — понимаем все три */
function block(b: Uint8Array, from: number, end: number, found: Found): void {
  const [trackNo, len] = vint(b, from, end);
  // Время блока не нужно: пакеты идут подряд, длительность каждого — в нём самом
  let pos = from + len + 2;
  if (pos >= end) bad();
  const lacing = (b[pos++]! >> 1) & 3;
  if (!lacing) {
    packet(found, trackNo, pos, end);
    return;
  }
  if (pos >= end) bad();
  const count = b[pos++]! + 1;
  const sizes: number[] = [];
  if (lacing === 1) {
    // Xiph: размер — сумма байтов, пока байт равен 255
    for (let i = 0; i < count - 1; i++) {
      let size = 0;
      for (;;) {
        if (pos >= end) bad();
        const x = b[pos++]!;
        size += x;
        if (x !== 255) break;
      }
      sizes.push(size);
    }
  } else if (lacing === 3) {
    // EBML: первый размер — как есть, следующие — разница с предыдущим (со знаком)
    let size = 0;
    for (let i = 0; i < count - 1; i++) {
      const [v, n] = vint(b, pos, end);
      pos += n;
      size = i === 0 ? v : size + v - (2 ** (7 * n - 1) - 1);
      if (size < 0) bad();
      sizes.push(size);
    }
  } else {
    // Поровну
    const total = end - pos;
    if (total % count) bad();
    for (let i = 0; i < count - 1; i++) sizes.push(total / count);
  }
  for (const size of sizes) {
    if (pos + size > end) bad();
    packet(found, trackNo, pos, pos + size);
    pos += size;
  }
  packet(found, trackNo, pos, end);
}

function packet(found: Found, track: number, from: number, to: number): void {
  found.from.push(from);
  found.to.push(to);
  found.owner.push(track);
}

/** Заголовок Opus (OpusHead) из дорожки; нет его — собираем сами: версия 1, каналы дорожки (или 1), пропуск в начале
 *  312 отсчётов (разгон кодека), частота 48 кГц */
function opusHead(t: Track): Uint8Array {
  const h = t.head;
  if (h && h.length) {
    if (!validHead(h)) bad();
    return h;
  }
  const channels = t.channels || 1;
  // Больше двух каналов без таблицы раскладки не описать
  if (channels > 2) bad();
  const out = new Uint8Array(19);
  out.set(latin("OpusHead"));
  out[8] = 1;
  out[9] = channels;
  out[10] = 312 & 0xff;
  out[11] = 312 >> 8;
  u32(out, 12, 48_000);
  // Усиление (16–17) — 0, раскладка каналов (18) — 0: моно или стерео
  return out;
}

/** Заголовок из файла похож на OpusHead: метка, версия 0–15, каналы и раскладка (0 — моно или стерео, 1 — до 8 каналов) */
function validHead(h: Uint8Array): boolean {
  if (h.length < 19 || ascii(h, 0, 8) !== "OpusHead" || h[8]! > 15) return false;
  const channels = h[9]!;
  const family = h[18]!;
  if (family === 0) return channels >= 1 && channels <= 2;
  return family === 1 && channels >= 1 && channels <= 8 && h.length >= 21 + channels;
}

/** Заголовок элемента: номер (1–4 байта) и длина (1–8 байт; все биты — единицы: длина неизвестна, size = -1).
 *  Элемент не помещается в родителя — файл обрезан или испорчен */
function head(b: Uint8Array, pos: number, end: number): Head {
  if (pos >= end) bad();
  const f = b[pos]!;
  const idLen = f & 0x80 ? 1 : f & 0x40 ? 2 : f & 0x20 ? 3 : f & 0x10 ? 4 : 0;
  if (!idLen || pos + idLen >= end) bad();
  let id = f;
  for (let i = 1; i < idLen; i++) id = id * 256 + b[pos + i]!;
  let p = pos + idLen;
  const s = b[p]!;
  if (!s) bad();
  const len = Math.clz32(s) - 23;
  if (p + len > end) bad();
  const mask = 0xff >> len;
  let size = s & mask;
  let unknown = size === mask;
  for (let i = 1; i < len; i++) {
    const x = b[p + i]!;
    size = size * 256 + x;
    if (x !== 0xff) unknown = false;
  }
  p += len;
  if (unknown) return { id, data: p, size: -1 };
  if (p + size > end) bad();
  return { id, data: p, size };
}

/** Дочерние элементы элемента с известной длиной; длина «неизвестна» бывает только у Segment и Cluster */
function each(b: Uint8Array, from: number, to: number, fn: (h: Head) => void): void {
  for (let pos = from; pos < to; ) {
    const h = head(b, pos, to);
    if (h.size < 0) bad();
    fn(h);
    pos = h.data + h.size;
  }
}

/** Число переменной длины (номер дорожки в блоке, размеры в шнуровке EBML) → [значение, сколько байт] */
function vint(b: Uint8Array, pos: number, end: number): [number, number] {
  if (pos >= end) bad();
  const s = b[pos]!;
  if (!s) bad();
  const len = Math.clz32(s) - 23;
  if (pos + len > end) bad();
  let v = s & (0xff >> len);
  for (let i = 1; i < len; i++) v = v * 256 + b[pos + i]!;
  return [v, len];
}

/** Целое без знака, до 8 байт */
function uint(b: Uint8Array, from: number, to: number): number {
  if (to - from > 8) bad();
  let v = 0;
  for (let i = from; i < to; i++) v = v * 256 + b[i]!;
  return v;
}

/** Строка латиницей (кодек, тип файла): до первого нулевого байта, не длиннее 64 знаков */
function ascii(b: Uint8Array, from: number, to: number): string {
  let s = "";
  for (let i = from; i < to && i - from < 64; i++) {
    const c = b[i]!;
    if (!c) break;
    s += String.fromCharCode(c);
  }
  return s;
}

const latin = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

/* ── Запись Ogg ─────────────────────────────────────────────────────────────────────────────────────────────────
   Ogg — страницы: «OggS», флаги (1 — продолжение пакета с прошлой страницы, 2 — начало потока, 4 — конец), отметка
   времени (granule), номер потока, номер страницы, контрольная сумма, таблица кусочков (lacing: пакет режется на
   кусочки по 255 байт, последний короче — по нему видно, где пакет кончился) и сами байты. */

const CONTINUED = 1;
const BOS = 2;
const EOS = 4;
/** Звука на странице — не больше секунды */
const PAGE_SAMPLES = 48_000;

/** Второй заголовок Ogg Opus (OpusTags): имя программы-упаковщика и пустой список меток */
function opusTags(): Uint8Array {
  const vendor = latin("chat-kit");
  const t = new Uint8Array(8 + 4 + vendor.length + 4);
  t.set(latin("OpusTags"));
  u32(t, 8, vendor.length);
  t.set(vendor, 12);
  // Число меток — 0: последние 4 байта уже нули
  return t;
}

/** Сборщик Ogg: страница копится (кусочки и откуда брать байты), потом пишется сразу в итоговый массив */
class OggWriter {
  /** Звука на открытой странице, отсчётов 48 кГц */
  samples = 0;
  private out: Uint8Array;
  private len = 0;
  private seq = 0;
  private readonly serial: number;
  private lacing: number[] = [];
  private src: Uint8Array[] = [];
  private from: number[] = [];
  private to: number[] = [];
  /** Отметка последнего пакета, закончившегося на открытой странице (-1 — ни один не закончился) */
  private granule = -1;
  private continued = false;

  constructor(serial: number, capacity: number) {
    this.serial = serial;
    this.out = new Uint8Array(capacity);
  }

  get segments(): number {
    return this.lacing.length;
  }

  /** Пакет src[from…to) на открытую страницу; не влез в 255 кусочков — остаток на следующей (флаг «продолжение») */
  add(src: Uint8Array, from: number, to: number, granule: number, samples: number): void {
    if (this.lacing.length === 255) this.flush(0);
    let at = from;
    for (;;) {
      const room = 255 - this.lacing.length;
      const full = Math.floor((to - at) / 255);
      if (full < room) {
        for (let i = 0; i < full; i++) this.lacing.push(255);
        this.lacing.push(to - at - full * 255);
        this.piece(src, at, to);
        this.granule = granule;
        this.samples += samples;
        return;
      }
      for (let i = 0; i < room; i++) this.lacing.push(255);
      this.piece(src, at, at + room * 255);
      at += room * 255;
      this.flush(0);
      this.continued = true;
    }
  }

  /** Записать открытую страницу; flags — «начало» или «конец» потока */
  flush(flags: number): void {
    const n = this.lacing.length;
    if (!n) return;
    let body = 0;
    for (let i = 0; i < this.from.length; i++) body += this.to[i]! - this.from[i]!;
    const start = this.reserve(27 + n + body);
    const o = this.out;
    o.set(OGGS, start);
    o[start + 4] = 0;
    o[start + 5] = flags | (this.continued ? CONTINUED : 0);
    if (this.granule < 0) o.fill(0xff, start + 6, start + 14);
    else {
      u32(o, start + 6, this.granule % 2 ** 32);
      u32(o, start + 10, Math.floor(this.granule / 2 ** 32));
    }
    u32(o, start + 14, this.serial);
    u32(o, start + 18, this.seq++);
    u32(o, start + 22, 0);
    o[start + 26] = n;
    o.set(this.lacing, start + 27);
    let at = start + 27 + n;
    for (let i = 0; i < this.src.length; i++) {
      const piece = this.src[i]!.subarray(this.from[i]!, this.to[i]!);
      o.set(piece, at);
      at += piece.length;
    }
    // Контрольная сумма — по всей странице, пока её место заполнено нулями
    u32(o, start + 22, crc32(o, start, at));
    this.lacing = [];
    this.src = [];
    this.from = [];
    this.to = [];
    this.granule = -1;
    this.continued = false;
    this.samples = 0;
  }

  bytes(): Uint8Array {
    return this.len === this.out.length ? this.out : this.out.slice(0, this.len);
  }

  private piece(src: Uint8Array, from: number, to: number): void {
    this.src.push(src);
    this.from.push(from);
    this.to.push(to);
  }

  /** Место под n байт в итоговом массиве (не хватает — массив вдвое больше); возвращает, откуда писать */
  private reserve(n: number): number {
    const start = this.len;
    if (start + n > this.out.length) {
      const bigger = new Uint8Array(Math.max(this.out.length * 2, start + n));
      bigger.set(this.out.subarray(0, start));
      this.out = bigger;
    }
    this.len += n;
    return start;
  }
}

const OGGS = latin("OggS");

/** Четыре байта, младший первый */
function u32(b: Uint8Array, at: number, v: number): void {
  b[at] = v & 0xff;
  b[at + 1] = (v >>> 8) & 0xff;
  b[at + 2] = (v >>> 16) & 0xff;
  b[at + 3] = (v >>> 24) & 0xff;
}

/** Контрольная сумма Ogg: CRC-32 с многочленом 0x04C11DB7, начальное значение 0, без отражения битов */
let crcTable: Uint32Array | null = null;

function crc32(b: Uint8Array, from: number, to: number): number {
  const t = (crcTable ??= makeCrcTable());
  let c = 0;
  for (let i = from; i < to; i++) c = (c << 8) ^ t[((c >>> 24) ^ b[i]!) & 0xff]!;
  return c >>> 0;
}

function makeCrcTable(): Uint32Array {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
}
