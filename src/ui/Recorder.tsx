"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fmtDuration } from "../core/time.js";
import { PauseIcon, PlayIcon, SendIcon, StopIcon, TrashIcon } from "./icons.js";

/* Запись голосового прямо в поле ввода — как в WhatsApp: микрофон вместо кнопки «отправить», пока поле пустое;
   во время записи — красная точка, время и «волна» громкости; остановили — можно прослушать, удалить или отправить.
   Прослушивание — через Web Audio (без blob:-адресов: их запрещают строгие правила безопасности страницы).
   Файл уходит тем же путём, что файл с компьютера (поле file, voice=1). Какой формат запишет браузер: Chrome — webm,
   Firefox — ogg, Safari — mp4; перевести в ogg для WhatsApp, если канал требует, — дело проекта или подключения. */

export type Recording = { blob: Blob; mime: string; ext: string; durationSec: number; levels: number[] };

type Phase =
  | { kind: "idle" }
  | { kind: "rec"; startedAt: number }
  | { kind: "ready"; rec: Recording }
  | { kind: "error"; message: string };

const MAX_SEC = 300;

function pickMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const m of ["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return "";
}

const extOf = (mime: string) => (mime.includes("ogg") ? "ogg" : mime.includes("mp4") ? "m4a" : "webm");

function micError(e: unknown): string {
  const name = (e as { name?: string } | null)?.name ?? "";
  if (name === "NotAllowedError") return "Нет доступа к микрофону — разрешите его для этого сайта в настройках браузера";
  if (name === "NotFoundError") return "Микрофон не найден — подключите его и попробуйте ещё раз";
  if (name === "SecurityError") return "Запись голоса на этом сайте выключена";
  return "Не получилось включить микрофон";
}

/** Запись голосового: start / stop / cancel, громкость для «волны» и готовая запись */
export function useRecorder() {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [levels, setLevels] = useState<number[]>([]);
  const [sec, setSec] = useState(0);
  const media = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const ctx = useRef<AudioContext | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const discard = useRef(false);

  const cleanup = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    void ctx.current?.close().catch(() => {});
    ctx.current = null;
  }, []);

  useEffect(() => () => { discard.current = true; media.current?.state === "recording" && media.current.stop(); cleanup(); }, [cleanup]);

  const start = useCallback(async () => {
    const mime = pickMime();
    if (!mime || !navigator.mediaDevices?.getUserMedia) { setPhase({ kind: "error", message: "Этот браузер не умеет записывать голос" }); return; }
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.current = s;
      const rec = new MediaRecorder(s, { mimeType: mime });
      const chunks: Blob[] = [];
      const lv: number[] = [];
      discard.current = false;
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      const startedAt = Date.now();
      rec.onstop = () => {
        cleanup();
        if (discard.current) { setPhase({ kind: "idle" }); return; }
        const type = mime.split(";")[0] ?? mime;
        const blob = new Blob(chunks, { type });
        setPhase({ kind: "ready", rec: { blob, mime: type, ext: extOf(mime), durationSec: Math.round((Date.now() - startedAt) / 1000), levels: lv.slice() } });
      };
      // Громкость для «волны»: раз в 100 мс
      const ac = new AudioContext();
      ctx.current = ac;
      const an = ac.createAnalyser();
      an.fftSize = 512;
      ac.createMediaStreamSource(s).connect(an);
      const buf = new Uint8Array(an.fftSize);
      timer.current = setInterval(() => {
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += ((v - 128) / 128) ** 2;
        lv.push(Math.min(1, Math.sqrt(sum / buf.length) * 3));
        setLevels(lv.slice(-48));
        const n = Math.floor((Date.now() - startedAt) / 1000);
        setSec(n);
        if (n >= MAX_SEC && rec.state === "recording") rec.stop();
      }, 100);
      media.current = rec;
      rec.start(250);
      setSec(0);
      setLevels([]);
      setPhase({ kind: "rec", startedAt });
    } catch (e) {
      cleanup();
      setPhase({ kind: "error", message: micError(e) });
    }
  }, [cleanup]);

  const stop = useCallback(() => { if (media.current?.state === "recording") media.current.stop(); }, []);
  const cancel = useCallback(() => {
    discard.current = true;
    if (media.current?.state === "recording") media.current.stop();
    else { cleanup(); setPhase({ kind: "idle" }); }
  }, [cleanup]);
  const reset = useCallback(() => setPhase({ kind: "idle" }), []);

  return { phase, levels, sec, start, stop, cancel, reset };
}

/** Полоса записи и прослушивания вместо поля ввода */
export function RecorderBar({ r, onSend }: { r: ReturnType<typeof useRecorder>; onSend: (rec: Recording) => void }) {
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const play = useRef<{ ctx: AudioContext; src: AudioBufferSourceNode; raf: number } | null>(null);

  const stopPlay = useCallback(() => {
    const p = play.current;
    if (!p) return;
    cancelAnimationFrame(p.raf);
    try { p.src.stop(); } catch { /* уже остановлено */ }
    void p.ctx.close().catch(() => {});
    play.current = null;
    setPlaying(false);
  }, []);
  useEffect(() => stopPlay, [stopPlay]);

  if (r.phase.kind === "rec") {
    return (
      <div className="ck-rec" role="group" aria-label="Запись голосового">
        <button type="button" className="ck-round" aria-label="Удалить запись" onClick={r.cancel}><TrashIcon /></button>
        <span className="ck-rec__dot" aria-hidden="true" />
        <span className="ck-rec__time ck-mono">{fmtDuration(r.sec)}</span>
        <span className="ck-rec__wave" aria-hidden="true">{r.levels.map((v, i) => <i key={i} style={{ height: `${Math.max(8, v * 100)}%` }} />)}</span>
        <button type="button" className="ck-round ck-send ck-send--ready" aria-label="Остановить запись" onClick={r.stop}><StopIcon /></button>
      </div>
    );
  }
  if (r.phase.kind !== "ready") return null;
  const rec = r.phase.rec;
  const toggle = async () => {
    if (playing) { stopPlay(); return; }
    const ctx = new AudioContext();
    const buf = await ctx.decodeAudioData(await rec.blob.arrayBuffer());
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const t0 = ctx.currentTime;
    src.onended = () => { stopPlay(); setPos(0); };
    src.start();
    const loop = () => { setPos(Math.min(1, (ctx.currentTime - t0) / buf.duration)); if (play.current) play.current.raf = requestAnimationFrame(loop); };
    play.current = { ctx, src, raf: requestAnimationFrame(loop) };
    setPlaying(true);
  };
  const bars = rec.levels.length > 48 ? rec.levels.filter((_, i) => i % Math.ceil(rec.levels.length / 48) === 0) : rec.levels;
  return (
    <div className="ck-rec" role="group" aria-label="Голосовое перед отправкой">
      <button type="button" className="ck-round" aria-label="Удалить запись" onClick={() => { stopPlay(); r.reset(); }}><TrashIcon /></button>
      <button type="button" className="ck-round" aria-label={playing ? "Пауза" : "Прослушать"} onClick={() => void toggle()}>{playing ? <PauseIcon /> : <PlayIcon />}</button>
      <span className="ck-rec__time ck-mono">{fmtDuration(rec.durationSec)}</span>
      <span className="ck-rec__wave ck-rec__wave--done" aria-hidden="true">
        {bars.map((v, i) => <i key={i} className={i / bars.length < pos ? "ck-rec__on" : undefined} style={{ height: `${Math.max(8, v * 100)}%` }} />)}
      </span>
      <button type="button" className="ck-round ck-send ck-send--ready" aria-label="Отправить голосовое" onClick={() => { stopPlay(); onSend(rec); r.reset(); }}><SendIcon /></button>
    </div>
  );
}
