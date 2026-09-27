import { describe, expect, it } from "vitest";
import { isOgg, isWebm, opusPacketSamples, voiceForChannel, webmOpusToOgg } from "../../src/server/audio.js";
import {
  blockGroup, bytesEqual, cat, chromeWebm, ebmlHeader, el, expectedSamples, FRAME_MS, hex, ID, info, oggCrc, oggPackets, open,
  opusHead, opusPacket, readOgg, simpleBlock, text, trackEntry, uintEl, videoTrack,
} from "./audio-fixtures.js";

// Перекладка голосовых WebM (Opus) → Ogg (Opus). Запись «как из Chrome» собирается в тесте, результат разбирается
// обратно независимым читателем Ogg: страницы, контрольные суммы, пакеты байт в байт, отметки времени. Устройство
// записи сверено с настоящей записью Chrome 152 (MediaRecorder): её Ogg Chrome раскодировал в тот же звук, что и WebM.

/** Проверки Ogg Opus (RFC 7845), общие для всех тестов; input — пакеты звука, которые были в WebM */
function checkOgg(ogg: Uint8Array | null, input: readonly Uint8Array[]) {
  expect(ogg).not.toBeNull();
  const out = ogg!;
  expect(isOgg(out)).toBe(true);
  const pages = readOgg(out);
  // Каждая страница: версия 0, верная контрольная сумма, один номер потока, номера страниц по порядку, до 255 кусочков
  expect(pages.filter((p) => !p.crcOk)).toEqual([]);
  expect(pages.every((p) => p.version === 0 && p.lacing.length >= 1 && p.lacing.length <= 255)).toBe(true);
  expect(new Set(pages.map((p) => p.serial)).size).toBe(1);
  expect(pages.map((p) => p.seq)).toEqual(pages.map((_, i) => i));
  // «Начало потока» — только у первой страницы, «конец потока» — только у последней
  expect(pages.map((p) => p.flags & 2)).toEqual(pages.map((_, i) => (i === 0 ? 2 : 0)));
  expect(pages.map((p) => p.flags & 4)).toEqual(pages.map((_, i) => (i === pages.length - 1 ? 4 : 0)));

  const packets = oggPackets(pages);
  // Заголовки: OpusHead — один на первой странице, OpusTags — один на второй; отметка времени у обеих 0
  expect(packets.filter((p) => p.page === 0)).toHaveLength(1);
  expect(packets.filter((p) => p.page === 1)).toHaveLength(1);
  expect(pages[0]!.granule).toBe(0n);
  expect(pages[1]!.granule).toBe(0n);
  const head = packets[0]!.data;
  expect(text(head.subarray(0, 8))).toBe("OpusHead");
  const tags = packets[1]!.data;
  const tv = new DataView(tags.buffer, tags.byteOffset, tags.length);
  expect(text(tags.subarray(0, 8))).toBe("OpusTags");
  expect(tv.getUint32(8, true)).toBe(8);
  expect(text(tags.subarray(12, 20))).toBe("chat-kit");
  expect(tv.getUint32(20, true)).toBe(0);
  expect(tags.length).toBe(24);

  // Звук: те же пакеты байт в байт и в том же порядке, с третьей страницы
  const audio = packets.slice(2);
  expect(audio).toHaveLength(input.length);
  expect(audio.findIndex((p, i) => !bytesEqual(p.data, input[i]!))).toBe(-1);
  expect(audio.every((p) => p.page >= 2)).toBe(true);

  // Отметка страницы — сколько отсчётов 48 кГц закончилось к её концу; страница, где ни один пакет не закончился, — -1
  const granule = new Map<number, bigint>();
  const perPage = new Map<number, number>();
  let total = 0;
  audio.forEach((p, i) => {
    const n = expectedSamples(input[i]!);
    total += n;
    granule.set(p.page, BigInt(total));
    perPage.set(p.page, (perPage.get(p.page) ?? 0) + n);
  });
  for (let i = 2; i < pages.length; i++) expect(pages[i]!.granule, `отметка страницы ${i}`).toBe(granule.get(i) ?? -1n);
  const marks = pages.map((p) => p.granule).filter((g) => g >= 0n);
  expect(marks.every((g, i) => i === 0 || g >= marks[i - 1]!)).toBe(true);
  expect(pages.at(-1)!.granule).toBe(BigInt(total));
  // На странице — не больше секунды звука
  expect(Math.max(...perPage.values())).toBeLessThanOrEqual(48_000);
  return { pages, head, audio, total };
}

const tenPackets = Array.from({ length: 10 }, (_, i) => opusPacket(1, 0, 40 + i));

describe("isWebm / isOgg — по первым байтам", () => {
  it("метка EBML и «OggS»", () => {
    const webm = chromeWebm([tenPackets]);
    expect(isWebm(webm)).toBe(true);
    expect(isOgg(webm)).toBe(false);
    const ogg = webmOpusToOgg(webm)!;
    expect(isOgg(ogg)).toBe(true);
    expect(isWebm(ogg)).toBe(false);
    expect(isWebm(new Uint8Array())).toBe(false);
    expect(isOgg(Uint8Array.of(0x4f, 0x67, 0x67))).toBe(false);
  });
});

describe("opusPacketSamples — длительность пакета Opus по первому байту", () => {
  it("все 32 настройки и коды 0–3: кадр 2,5–60 мс, один, два или сколько сказано во втором байте", () => {
    for (let config = 0; config < 32; config++) {
      const frame = FRAME_MS[config]! * 48;
      expect(opusPacketSamples(opusPacket(config, 0, 10)), `config ${config}`).toBe(frame);
      expect(opusPacketSamples(opusPacket(config, 1, 11))).toBe(frame * 2);
      expect(opusPacketSamples(opusPacket(config, 2, 10))).toBe(frame * 2);
      const most = Math.floor(120 / FRAME_MS[config]!);
      expect(opusPacketSamples(opusPacket(config, 3, 10, { frames: 3 }))).toBe(3 * frame <= 5760 ? 3 * frame : 0);
      expect(opusPacketSamples(opusPacket(config, 3, 10, { frames: most }))).toBe(most * frame);
      // Длиннее 120 мс — не пакет Opus
      expect(opusPacketSamples(opusPacket(config, 3, 10, { frames: most + 1 }))).toBe(0);
    }
    // Стерео (бит s) на длительность не влияет
    expect(opusPacketSamples(Uint8Array.of((1 << 3) | 0b100))).toBe(960);
  });

  it("не пакет Opus — 0: пустой, код 3 без байта с числом кадров, ноль кадров", () => {
    expect(opusPacketSamples(new Uint8Array())).toBe(0);
    expect(opusPacketSamples(Uint8Array.of(0x0b))).toBe(0);
    expect(opusPacketSamples(Uint8Array.of(0x0b, 0x00))).toBe(0);
  });
});

describe("webmOpusToOgg — перекладка без перекодирования", () => {
  it("запись как из Chrome: Segment и кластеры без длины; разные пакеты — SILK, гибрид, CELT, код 3, длинные", () => {
    const mixed = [
      opusPacket(1, 0, 60), // SILK, узкая полоса, 20 мс
      opusPacket(9, 0, 80), // SILK, широкая полоса, 20 мс
      opusPacket(30, 0, 120), // CELT, 10 мс
      opusPacket(16, 3, 50, { frames: 8 }), // CELT 2,5 мс × 8 = 20 мс
      opusPacket(13, 1, 101), // гибрид 20 мс × 2
      opusPacket(3, 2, 90), // SILK 60 мс × 2 = 120 мс
      opusPacket(31, 3, 255, { frames: 6 }), // CELT 20 мс × 6; ровно 255 байт — кусочки 255 и 0
      opusPacket(11, 0, 510), // 60 мс; 510 байт — кусочки 255, 255, 0
      opusPacket(19, 0, 254), // 20 мс; один кусочек 254
      opusPacket(27, 0, 256), // 20 мс; кусочки 255 и 1
      opusPacket(0, 0, 1), // 10 мс, только первый байт (кадр без данных)
    ];
    const steady = Array.from({ length: 150 }, (_, i) => opusPacket(i % 2 ? 1 : 9, 0, 40 + (i % 50), { seed: i + 7 }));
    const input = [...mixed, ...steady];
    const webm = chromeWebm([input.slice(0, 70), input.slice(70)]);
    const r = checkOgg(webmOpusToOgg(webm), input);
    // Заголовок Opus — из дорожки как есть
    expect(bytesEqual(r.head, opusHead())).toBe(true);
    expect(r.total).toBe(22_080 + 150 * 960);
    // Несколько страниц звука (по секунде), и результат всегда один и тот же
    expect(r.pages.length).toBe(2 + 4);
    expect(bytesEqual(webmOpusToOgg(webm)!, webmOpusToOgg(webm)!)).toBe(true);
  });

  it("начало настоящей записи Chrome 152 (MediaRecorder, audio/webm;codecs=opus, start(250)): кластер на каждый кусок записи, пакеты по 60 мс", () => {
    // Байты записи до первого кластера: EBML, Segment без длины, Info («Chrome»), Tracks — A_OPUS, OpusHead (2 канала,
    // пропуск 0, 48 кГц), Audio с частотой (4 байта) и BitDepth. Дальше Chrome пишет кластер без длины на каждые 250 мс
    const chromeHead = hex(`
      1a45dfa3 9f 4286810142f7810142f2810442f381084282847765626d4287810442858102
      18538067 01ffffffffffffff
      1549a966 99 2ad7b1830f4240 4d8086 4368726f6d65 574186 4368726f6d65
      1654ae6b bf ae bd d78101 73c587 3dfde038ee5541 838102 8686 415f4f505553
        63a293 4f707573486561640102000080bb0000000000 e18d b584473b8000 9f8102 62648120`);
    // Пакеты Chrome: настройка 31 (CELT, 20 мс), стерео, код 3 — три кадра, 60 мс; тишина — 8 байт, звук — до ~1000
    const packets = Array.from({ length: 48 }, (_, i) => {
      const p = opusPacket(31, 3, i % 5 ? 300 + i * 13 : 8, { frames: 3, seed: i + 3 });
      p[0] = 0xff;
      return p;
    });
    const clusters = Array.from({ length: 12 }, (_, c) =>
      open(ID.Cluster, uintEl(ID.Timecode, c * 240), ...packets.slice(c * 4, c * 4 + 4).map((p, i) => simpleBlock([p], { time: i * 60 }))));
    const r = checkOgg(webmOpusToOgg(cat([chromeHead, ...clusters])), packets);
    const at = text(chromeHead).indexOf("OpusHead");
    expect(bytesEqual(r.head, chromeHead.subarray(at, at + 19))).toBe(true);
    expect(r.head[9]).toBe(2);
    // 2,88 с: по 16 пакетов (0,96 с) на страницу — так же, как у настоящей записи
    expect(r.pages.map((p) => p.granule)).toEqual([0n, 0n, 46_080n, 92_160n, 138_240n]);
  });

  it("нет заголовка Opus в дорожке — собираем свой: версия 1, каналы дорожки (или 1), пропуск 312, 48 кГц", () => {
    const stereo = checkOgg(webmOpusToOgg(chromeWebm([tenPackets], { head: null, channels: 2 })), tenPackets).head;
    const dv = new DataView(stereo.buffer, stereo.byteOffset, stereo.length);
    expect(stereo.length).toBe(19);
    expect([stereo[8], stereo[9], dv.getUint16(10, true), dv.getUint32(12, true), dv.getInt16(16, true), stereo[18]]).toEqual([1, 2, 312, 48_000, 0, 0]);
    // Без элемента Audio — один канал; пустой CodecPrivate — как нет
    expect(checkOgg(webmOpusToOgg(chromeWebm([tenPackets], { head: null, channels: null })), tenPackets).head[9]).toBe(1);
    expect(checkOgg(webmOpusToOgg(chromeWebm([tenPackets], { head: new Uint8Array(), channels: 1 })), tenPackets).head).toHaveLength(19);
  });

  it("элементы с известной длиной, BlockGroup, дорожки после кластеров, лишние элементы — понимаем", () => {
    const input = [opusPacket(9, 0, 70), opusPacket(9, 0, 71), opusPacket(18, 0, 30), opusPacket(18, 0, 31), opusPacket(9, 0, 72)];
    const withPreSkip = opusHead({ preSkip: 312, channels: 2 });
    const webm = cat([
      ebmlHeader("matroska"),
      el(ID.Segment,
        el(ID.SeekHead, el(ID.Void, [1, 2, 3])),
        info(),
        el(ID.Cluster, uintEl(ID.Timecode, 0), simpleBlock([input[0]!]), blockGroup([input[1]!], { time: 20 }), el(ID.Void, [0])),
        el(ID.Cluster, uintEl(ID.Timecode, 40), blockGroup([input[2]!]), simpleBlock([input[3]!], { time: 10 }), simpleBlock([input[4]!], { time: 20 })),
        el(ID.Tracks, trackEntry({ head: withPreSkip, channels: 2 })),
        el(ID.Cues, el(ID.CuePoint))),
    ]);
    expect(bytesEqual(checkOgg(webmOpusToOgg(webm), input).head, withPreSkip)).toBe(true);
    // Кластер без длины кончается и перед элементом уровня Segment (здесь — Tracks после кластеров)
    const late = cat([ebmlHeader(), open(ID.Segment, info(), open(ID.Cluster, uintEl(ID.Timecode, 0), ...input.map((p) => simpleBlock([p]))), el(ID.Tracks, trackEntry()))]);
    checkOgg(webmOpusToOgg(late), input);
  });

  it("несколько пакетов в одном блоке: шнуровка Xiph, EBML и «поровну»", () => {
    const xiph = [opusPacket(1, 0, 300), opusPacket(1, 0, 20), opusPacket(1, 0, 7), opusPacket(1, 0, 255), opusPacket(1, 0, 90)];
    // Размеры 100 → 90 → 130 → 5 → 900: разницы и в один, и в два байта
    const ebml = [opusPacket(9, 0, 100), opusPacket(9, 0, 90), opusPacket(9, 0, 130), opusPacket(9, 0, 5), opusPacket(9, 0, 900), opusPacket(9, 0, 60)];
    const fixed = [1, 2, 3].map((seed) => opusPacket(17, 0, 40, { seed }));
    const single = [opusPacket(1, 0, 33)];
    const webm = cat([ebmlHeader(), open(ID.Segment, info(), el(ID.Tracks, trackEntry()), open(ID.Cluster, uintEl(ID.Timecode, 0),
      simpleBlock(xiph, { lacing: "xiph" }), simpleBlock(ebml, { lacing: "ebml", time: 100 }),
      blockGroup(fixed, { lacing: "fixed", time: 300 }), simpleBlock(single, { lacing: "xiph", time: 320 })))]);
    checkOgg(webmOpusToOgg(webm), [...xiph, ...ebml, ...fixed, ...single]);
  });

  it("пакет больше страницы продолжается на следующей: флаг «продолжение», у страницы без конца пакета отметка -1", () => {
    const small = (n: number) => opusPacket(1, 0, 60 + n);
    const input = [small(0), small(1), small(2), opusPacket(31, 3, 70_000), small(3), opusPacket(31, 3, 255 * 255), small(4)];
    const r = checkOgg(webmOpusToOgg(chromeWebm([input])), input);
    expect(r.pages.filter((p) => p.flags & 1)).toHaveLength(2);
    expect(r.pages.filter((p) => p.granule === -1n)).toHaveLength(2);
    // Пакет ровно 255 × 255 байт: страница из 255 кусочков по 255, а завершающий кусочек 0 — уже на следующей
    expect(r.pages.some((p) => p.flags & 1 && p.lacing[0] === 0)).toBe(true);
  });
});

describe("не голосовое WebM с Opus — null, без исключений", () => {
  const input = [opusPacket(1, 0, 50), opusPacket(1, 0, 51)];
  const webm = chromeWebm([input]);

  it("не WebM: пусто, Ogg, m4a, мусор", () => {
    expect(webmOpusToOgg(new Uint8Array())).toBeNull();
    expect(webmOpusToOgg(Uint8Array.of(0x1a, 0x45, 0xdf))).toBeNull();
    expect(webmOpusToOgg(webmOpusToOgg(webm)!)).toBeNull();
    expect(webmOpusToOgg(cat([[0, 0, 0, 0x20], [...new TextEncoder().encode("ftypM4A ")], new Uint8Array(24)]))).toBeNull();
    expect(webmOpusToOgg(Uint8Array.from({ length: 500 }, (_, i) => (i * 37) & 0xff))).toBeNull();
  });

  it("видео, звук не Opus, несколько дорожек, нет дорожек", () => {
    const tracks = (...entries: Uint8Array[]) =>
      cat([ebmlHeader(), open(ID.Segment, info(), el(ID.Tracks, ...entries), open(ID.Cluster, uintEl(ID.Timecode, 0), simpleBlock([input[0]!], { track: 2 }), simpleBlock([input[1]!], { track: 1 })))]);
    expect(webmOpusToOgg(tracks(videoTrack(1), trackEntry({ number: 2 })))).toBeNull();
    expect(webmOpusToOgg(tracks(videoTrack(1)))).toBeNull();
    expect(webmOpusToOgg(tracks(trackEntry({ number: 1 }), trackEntry({ number: 2 })))).toBeNull();
    expect(webmOpusToOgg(tracks())).toBeNull();
    expect(webmOpusToOgg(chromeWebm([input], { codec: "A_VORBIS" }))).toBeNull();
    expect(webmOpusToOgg(chromeWebm([input], { type: 1 }))).toBeNull();
    // Только одна дорожка, но все блоки — чужой дорожки: звука нет
    expect(webmOpusToOgg(tracks(trackEntry({ number: 3 })))).toBeNull();
  });

  it("неверный заголовок Opus, сжатая или зашифрованная дорожка, чужой тип файла, две записи подряд, пустая запись", () => {
    expect(webmOpusToOgg(chromeWebm([input], { head: new TextEncoder().encode("NotOpusHeadAtAll!!!!") }))).toBeNull();
    expect(webmOpusToOgg(chromeWebm([input], { head: opusHead().subarray(0, 18) }))).toBeNull();
    expect(webmOpusToOgg(chromeWebm([input], { head: opusHead({ channels: 3 }) }))).toBeNull();
    expect(webmOpusToOgg(chromeWebm([input], { head: opusHead({ version: 16 }) }))).toBeNull();
    expect(webmOpusToOgg(chromeWebm([input], { head: opusHead({ family: 255 }) }))).toBeNull();
    expect(webmOpusToOgg(chromeWebm([input], { head: null, channels: 3 }))).toBeNull();
    expect(webmOpusToOgg(chromeWebm([input], { extra: [el(ID.ContentEncodings, el(ID.ContentEncoding, uintEl(ID.ContentEncodingOrder, 0)))] }))).toBeNull();
    expect(webmOpusToOgg(cat([ebmlHeader("mp4"), webm.subarray(ebmlHeader().length)]))).toBeNull();
    expect(webmOpusToOgg(cat([webm, webm]))).toBeNull();
    expect(webmOpusToOgg(chromeWebm([]))).toBeNull();
  });

  it("пакеты не Opus: пустой, код 3 без числа кадров или с нулём, длиннее 120 мс", () => {
    for (const wrong of [new Uint8Array(), Uint8Array.of(0x0b), Uint8Array.of(0x0b, 0x00), opusPacket(3, 3, 20, { frames: 3 })]) {
      expect(webmOpusToOgg(chromeWebm([[input[0]!, wrong, input[1]!]]))).toBeNull();
    }
  });

  it("обрезанный файл — null; обрыв ровно между блоками — просто запись короче", () => {
    const long = chromeWebm([tenPackets.slice(0, 5), tenPackets.slice(5)]);
    expect(webmOpusToOgg(long.subarray(0, long.length - 3))).toBeNull();
    expect(webmOpusToOgg(long.subarray(0, 30))).toBeNull();
    // У Segment известной длины файл короче, чем сказано, — тоже null
    const known = cat([ebmlHeader(), el(ID.Segment, info(), el(ID.Tracks, trackEntry()), el(ID.Cluster, uintEl(ID.Timecode, 0), ...tenPackets.map((p) => simpleBlock([p]))))]);
    expect(webmOpusToOgg(known)).not.toBeNull();
    expect(webmOpusToOgg(known.subarray(0, known.length - 1))).toBeNull();
    const lastBlock = simpleBlock([tenPackets[9]!]).length;
    checkOgg(webmOpusToOgg(long.subarray(0, long.length - lastBlock)), tenPackets.slice(0, 9));
    // Любой обрыв: либо null, либо правильный Ogg с началом записи
    for (let n = 0; n <= long.length; n++) {
      const ogg = webmOpusToOgg(long.subarray(0, n));
      if (!ogg) continue;
      const audio = oggPackets(readOgg(ogg)).slice(2);
      expect(audio.length).toBeGreaterThan(0);
      expect(audio.every((p, i) => bytesEqual(p.data, tenPackets[i]!))).toBe(true);
    }
  });

  it("файл больше maxBytes — не трогаем", () => {
    expect(webmOpusToOgg(webm, { maxBytes: webm.length - 1 })).toBeNull();
    expect(webmOpusToOgg(webm, { maxBytes: webm.length })).not.toBeNull();
  });

  it("случайная порча байтов не роняет разбор: null или Ogg с верными контрольными суммами", () => {
    const sample = chromeWebm([tenPackets.slice(0, 4), tenPackets.slice(4)]);
    let seed = 20_260_927;
    const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
    let converted = 0;
    for (let k = 0; k < 600; k++) {
      const b = sample.slice();
      for (let j = 1 + Math.floor(rnd() * 3); j > 0; j--) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
      const ogg = webmOpusToOgg(b);
      if (!ogg) continue;
      converted++;
      const pages = readOgg(ogg);
      expect(pages.every((p) => p.crcOk)).toBe(true);
      expect(oggPackets(pages).length).toBeGreaterThan(2);
    }
    expect(converted).toBeGreaterThan(0);
  });
});

describe("voiceForChannel — голосовое для каналов", () => {
  const webm = chromeWebm([tenPackets]);

  it("запись из Chrome → Ogg: audio/ogg, имя с .ogg", () => {
    const v = voiceForChannel({ data: webm, mime: "audio/webm;codecs=opus", name: "Голосовое 14-05.webm" });
    expect(v.mime).toBe("audio/ogg");
    expect(v.name).toBe("Голосовое 14-05.ogg");
    checkOgg(v.data, tenPackets);
    expect(voiceForChannel({ data: webm, mime: "audio/webm", name: "Запись 27.09.2026" }).name).toBe("Запись 27.09.2026.ogg");
    expect(voiceForChannel({ data: webm, mime: "audio/webm", name: "VOICE.WEBM" }).name).toBe("VOICE.ogg");
    expect(voiceForChannel({ data: webm, mime: "", name: "  " }).name).toBe("Голосовое.ogg");
  });

  it("остальное — как есть (тот же объект): m4a, Ogg, видео, испорченный WebM", () => {
    const m4a = { data: cat([[0, 0, 0, 0x20], [...new TextEncoder().encode("ftypM4A ")], new Uint8Array(24)]), mime: "audio/mp4", name: "Голосовое 14-05.m4a" };
    expect(voiceForChannel(m4a)).toBe(m4a);
    const ogg = { data: webmOpusToOgg(webm)!, mime: "audio/ogg", name: "Голосовое 14-05.ogg" };
    expect(voiceForChannel(ogg)).toBe(ogg);
    const video = { data: chromeWebm([tenPackets], { codec: "V_VP8", type: 1 }), mime: "video/webm", name: "Видео.webm" };
    expect(voiceForChannel(video)).toBe(video);
    const broken = { data: webm.subarray(0, webm.length - 2), mime: "audio/webm", name: "Голосовое.webm" };
    expect(voiceForChannel(broken)).toBe(broken);
  });
});

describe("проверки самих помощников теста", () => {
  it("CRC-32 Ogg: контрольное значение для «123456789» — 0x89A1897F (CRC-32/POSIX без XOR в конце)", () => {
    expect(oggCrc(new TextEncoder().encode("123456789"))).toBe(0x89a1897f);
  });
});

describe("скорость", () => {
  it("5 минут голоса (15 000 пакетов по 20 мс) — быстрее 200 мс", () => {
    const packets = Array.from({ length: 15_000 }, (_, i) => opusPacket(i % 3 ? 9 : 1, 0, 60 + (i % 41), { seed: i + 1 }));
    const clusters: Uint8Array[][] = [];
    for (let i = 0; i < packets.length; i += 250) clusters.push(packets.slice(i, i + 250));
    const webm = chromeWebm(clusters);
    const started = performance.now();
    const ogg = webmOpusToOgg(webm);
    const ms = performance.now() - started;
    expect(ms).toBeLessThan(200);
    const r = checkOgg(ogg, packets);
    expect(r.total).toBe(15_000 * 960);
    expect(r.pages).toHaveLength(2 + 300);
  });
});
