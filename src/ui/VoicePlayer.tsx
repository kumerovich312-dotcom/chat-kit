"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { fmtDuration } from "../core/time.js";
import { PauseIcon, PlayIcon } from "./icons.js";

/* Голосовое — как в WhatsApp: круглая кнопка, «волна» по самой записи
   закрашивается, пока идёт звук, по ней едет кружок; щелчок по волне — перемотка; стрелки — ±5 секунд; скорость
   1× · 1,5× · 2× (помнит браузер). Одновременно играет одно голосовое: новое останавливает прежнее.

   Волна и точная длина — по самому файлу (его скачиваем, когда голосовое показалось на экране): у голосовых WhatsApp (OGG)
   длина записана в конце файла, и проигрыватель браузера её не знает. Играет — прямая ссылка на файл, без blob:-адресов
   (их запрещают правила безопасности студии); чтобы перемотка работала, адрес файла у проекта должен отдавать файл
   кусками (Range). */

const BARS = 36;
const SPEEDS = [1, 1.5, 2];
const SPEED_KEY = "chat-kit.voice.speed";
const EVENT = "chat-kit:voice";

type Wave = { peaks: number[]; duration: number };
const cache = new Map<string, Promise<Wave | null>>();

/** Волна (36 столбиков 0…1) и длина. Не разобрали (Safari и OGG) — пустая волна, длина — от проигрывателя */
function loadWave(src: string): Promise<Wave | null> {
  let p = cache.get(src);
  if (!p) {
    p = (async () => {
      try {
        const res = await fetch(src, { credentials: "same-origin" });
        if (!res.ok) return null;
        const data = await res.arrayBuffer();
        try {
          const Ctx = (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
          if (!Ctx) return { peaks: [], duration: 0 };
          const buf = await new Ctx(1, 44100, 44100).decodeAudioData(data);
          const ch = buf.getChannelData(0);
          const step = Math.max(1, Math.floor(ch.length / BARS));
          let peaks: number[] = [];
          for (let i = 0; i < BARS; i++) {
            let max = 0;
            for (let j = i * step; j < Math.min(ch.length, (i + 1) * step); j += 8) max = Math.max(max, Math.abs(ch[j] ?? 0));
            peaks.push(max);
          }
          const top = Math.max(...peaks, 0.01);
          peaks = peaks.map((x) => Math.max(0.12, x / top));
          return { peaks, duration: buf.duration };
        } catch {
          return { peaks: [], duration: 0 };
        }
      } catch {
        return null;
      }
    })();
    cache.set(src, p);
  }
  return p;
}

/** Волна-заглушка, пока запись не разобрана: одна и та же у одного файла */
function stub(seed: string): number[] {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return Array.from({ length: BARS }, (_, i) => 0.18 + 0.6 * Math.abs(Math.sin(i * 1.7 + h) * Math.cos(i * 0.45 + h * 2)));
}

export type VoicePlayerProps = {
  id: string;
  src: string;
  /** Размер словами («29 КБ») */
  sizeLabel?: string | null | undefined;
  /** Ссылка «скачать» — по умолчанию та же с ?download=1 */
  downloadHref?: string | null | undefined;
};

export function VoicePlayer({ id, src, sizeLabel, downloadHref }: VoicePlayerProps) {
  const box = useRef<HTMLDivElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const raf = useRef(0);
  const seekTo = useRef<number | null>(null);
  const [wave, setWave] = useState<Wave | null>(null);
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState(0);
  const [speed, setSpeed] = useState(1);

  // Волну и длину — когда голосовое показалось на экране (длинная переписка не качает всё сразу)
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let alive = true;
    const start = () => {
      void loadWave(src).then((w) => {
        if (!alive) return;
        if (!w) { setFailed(true); return; }
        setWave(w);
        if (w.duration) setDur(w.duration);
      });
    };
    if (typeof IntersectionObserver === "undefined") { start(); return () => { alive = false; }; }
    const io = new IntersectionObserver((es) => {
      if (!es.some((e) => e.isIntersecting)) return;
      io.disconnect();
      start();
    }, { rootMargin: "200px" });
    io.observe(el);
    return () => { alive = false; io.disconnect(); };
  }, [src]);

  useEffect(() => {
    try {
      const s = Number(localStorage.getItem(SPEED_KEY));
      if (SPEEDS.includes(s)) setSpeed(s);
    } catch { /* браузер не даёт хранить — скорость обычная */ }
    const other = (e: Event) => { if ((e as CustomEvent<string>).detail !== id) audio.current?.pause(); };
    window.addEventListener(EVENT, other);
    return () => { window.removeEventListener(EVENT, other); cancelAnimationFrame(raf.current); };
  }, [id]);

  useEffect(() => { if (audio.current) audio.current.playbackRate = speed; }, [speed]);

  const frame = () => {
    const a = audio.current;
    if (a) setPos(a.currentTime);
    raf.current = requestAnimationFrame(frame);
  };

  const play = async () => {
    const a = audio.current;
    if (!a) return;
    if (!a.getAttribute("src")) a.setAttribute("src", src);
    a.playbackRate = speed;
    window.dispatchEvent(new CustomEvent(EVENT, { detail: id }));
    try { await a.play(); } catch { setFailed(true); }
  };
  const toggle = () => {
    const a = audio.current;
    if (a && !a.paused) a.pause();
    else void play();
  };
  const seek = (f: number) => {
    const a = audio.current;
    const clamped = Math.min(1, Math.max(0, f));
    if (a && a.getAttribute("src") && dur && a.readyState > 0) {
      a.currentTime = clamped * dur;
      setPos(clamped * dur);
      return;
    }
    seekTo.current = clamped;
    void play();
  };
  const onWave = (e: MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    seek((e.clientX - r.left) / r.width);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!dur) return;
    if (e.key === "ArrowRight") { e.preventDefault(); seek((pos + 5) / dur); }
    if (e.key === "ArrowLeft") { e.preventDefault(); seek((pos - 5) / dur); }
  };
  const nextSpeed = () => {
    const s = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length] ?? 1;
    setSpeed(s);
    try { localStorage.setItem(SPEED_KEY, String(s)); } catch { /* не страшно */ }
  };

  const peaks = wave?.peaks.length ? wave.peaks : stub(id);
  const f = dur ? Math.min(1, pos / dur) : 0;
  const started = playing || pos > 0;
  const download = downloadHref ?? `${src}${src.includes("?") ? "&" : "?"}download=1`;

  return (
    <div ref={box} className="ck-voice" data-voice={id}>
      <audio
        ref={audio}
        preload="none"
        onPlay={() => { setPlaying(true); cancelAnimationFrame(raf.current); raf.current = requestAnimationFrame(frame); }}
        onPause={() => { setPlaying(false); cancelAnimationFrame(raf.current); }}
        onEnded={() => { setPlaying(false); cancelAnimationFrame(raf.current); setPos(0); if (audio.current) audio.current.currentTime = 0; }}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0 && !dur) setDur(d);
          if (seekTo.current !== null) {
            const len = Number.isFinite(d) && d > 0 ? d : dur;
            e.currentTarget.currentTime = seekTo.current * len;
            seekTo.current = null;
          }
        }}
        onError={() => setFailed(true)}
      />
      <button type="button" onClick={toggle} aria-label={playing ? "Пауза" : "Слушать голосовое"} className={`ck-voice__play${playing ? " ck-voice__play--on" : ""}`}>
        {playing ? <PauseIcon /> : <PlayIcon />}
      </button>
      <div className="ck-voice__body">
        <div
          role="slider"
          tabIndex={0}
          aria-label="Перемотка"
          aria-valuemin={0}
          aria-valuemax={Math.round(dur)}
          aria-valuenow={Math.round(pos)}
          onClick={onWave}
          onKeyDown={onKey}
          className="ck-wave"
        >
          {peaks.map((p, i) => (
            <i key={i} className={`ck-wave__bar${(i + 0.5) / peaks.length <= f && started ? " ck-wave__bar--done" : ""}`} style={{ height: `${Math.round(4 + p * 22)}px` }} />
          ))}
          {started ? <span className="ck-wave__dot" style={{ left: `${f * 100}%` }} aria-hidden="true" /> : null}
        </div>
        <div className="ck-voice__row">
          <span className="ck-mono">{failed ? "не открывается" : started ? fmtDuration(pos) : dur ? fmtDuration(dur) : "–:––"}</span>
          {sizeLabel ? <span>{sizeLabel}</span> : null}
          <a href={download} className="ck-link">скачать</a>
          <button type="button" onClick={nextSpeed} aria-label="Скорость" className="ck-voice__speed">{`${String(speed).replace(".", ",")}×`}</button>
        </div>
      </div>
    </div>
  );
}
