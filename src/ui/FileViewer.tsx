"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { fileBadge, fileHref, fileKind } from "../core/files.js";
import { CloseIcon, RotateIcon } from "./icons.js";

/* Просмотр файлов прямо в окне переписки — поверх страницы (вариант В пользователя Атласа 27.09.2026 «смотреть и сразу
   в документы»): фото — с лупой (колесо мыши к точке под курсором, кнопки, двойной щелчок; тянуть — двигать) и поворотом,
   который проект сохраняет в самом файле (пришедшее боком ложится в документы ровно); справа — место для кнопок проекта
   (у Атласа «Куда положить»: пункт чек-листа сделки), внизу — остальные файлы переписки. PDF — встроенным просмотрщиком
   браузера, Word и Excel — «Скачать». Листать — стрелками, закрыть — Esc. */

export type ViewFile = {
  id: string;
  name: string;
  mime: string;
  url: string;
  version?: string | null | undefined;
  /** Строка под названием: «сегодня, 14:05:09 · от клиента» */
  meta?: string | undefined;
  /** Можно повернуть (права у сотрудника, фото JPG / PNG / WebP) */
  canRotate?: boolean | undefined;
};

export type RotateResult = { ok: boolean; version?: string | undefined; error?: string | undefined };

export type ViewerActions = {
  /** Повернуть фото в самом файле (по часовой: 90, 180, 270) — новая метка содержимого */
  onRotate?: ((file: ViewFile, degrees: number) => Promise<RotateResult>) | undefined;
  /** Панель справа: действия проекта с файлом («Куда положить») */
  renderPanel?: ((file: ViewFile) => ReactNode) | undefined;
  /** Кнопки проекта в шапке окна */
  renderActions?: ((file: ViewFile) => ReactNode) | undefined;
};

const src = (f: ViewFile, v?: string | null) => fileHref({ url: f.url, version: v ?? f.version ?? null });
const download = (f: ViewFile) => fileHref({ url: f.url, version: null }, { download: "1" });
const rotatable = (f: ViewFile) => !!f.canRotate && /^image\/(jpeg|png|webp)$/.test(f.mime);

/** Окно просмотра для ленты: открывается щелчком по вложению с data-view-file (сама лента может быть серверной).
 *  panels и actions — уже собранная разметка проекта для каждого файла (её можно собрать и на сервере) */
export function FileViewerHost({ files, onRotate, panels, actions, root }: {
  files: ViewFile[];
  onRotate?: ViewerActions["onRotate"];
  panels?: Record<string, ReactNode> | undefined;
  actions?: Record<string, ReactNode> | undefined;
  /** Слушать щелчки только внутри этого блока (по умолчанию — вся страница) */
  root?: RefObject<HTMLElement | null> | undefined;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => {
    const scope: HTMLElement | Document = root?.current ?? document;
    const onClick = (e: Event) => {
      const me = e as MouseEvent;
      if (me.defaultPrevented || me.button !== 0 || me.ctrlKey || me.metaKey || me.shiftKey || me.altKey) return;
      const a = (me.target as Element | null)?.closest?.("a[data-view-file]");
      if (!a) return;
      const id = a.getAttribute("data-view-file");
      if (!id || !files.some((f) => f.id === id)) return;
      me.preventDefault();
      setOpenId(id);
    };
    scope.addEventListener("click", onClick);
    return () => scope.removeEventListener("click", onClick);
  }, [files, root]);
  if (openId === null) return null;
  return (
    <FileViewer
      files={files}
      openId={openId}
      onOpen={setOpenId}
      onRotate={onRotate}
      renderPanel={panels ? (f) => panels[f.id] ?? null : undefined}
      renderActions={actions ? (f) => actions[f.id] ?? null : undefined}
    />
  );
}

export function FileViewer({ files, openId, onOpen, onRotate, renderPanel, renderActions }: { files: ViewFile[]; openId: string; onOpen: (id: string | null) => void } & ViewerActions) {
  const index = files.findIndex((x) => x.id === openId);
  const f = index >= 0 ? files[index] : undefined;
  const close = useCallback(() => onOpen(null), [onOpen]);
  const go = useCallback((d: number) => {
    const next = files[index + d];
    if (next) onOpen(next.id);
  }, [files, index, onOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    // Страница под окном не прокручивается
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [close, go]);

  useEffect(() => { if (!f) close(); }, [f, close]);
  if (!f || typeof document === "undefined") return null;
  const kind = fileKind(f.mime, f.name);
  const panel = renderPanel?.(f);

  return createPortal(
    <div className="ck ck-viewer" onClick={close}>
      <div className="ck-viewer__box" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={f.name}>
        <div className="ck-viewer__top">
          <div className="ck-viewer__title">
            <div className="ck-viewer__name">{f.name}</div>
            <div className="ck-viewer__meta">{f.meta ?? ""}{files.length > 1 ? `${f.meta ? " · " : ""}${index + 1} из ${files.length}` : ""}</div>
          </div>
          {files.length > 1 && (
            <>
              <button type="button" className="ck-btn ck-btn--sm" disabled={index === 0} onClick={() => go(-1)} aria-label="Предыдущий файл">←</button>
              <button type="button" className="ck-btn ck-btn--sm" disabled={index === files.length - 1} onClick={() => go(1)} aria-label="Следующий файл">→</button>
            </>
          )}
          {renderActions?.(f)}
          <a href={download(f)} className="ck-btn ck-btn--sm">Скачать</a>
          <a href={src(f)} target="_blank" rel="noopener" className="ck-btn ck-btn--sm">Открыть в новой вкладке</a>
          <button type="button" className="ck-iconbtn" onClick={close} aria-label="Закрыть"><CloseIcon /></button>
        </div>
        <div className="ck-viewer__mid">
          <div className="ck-viewer__stage">
            {kind === "image" ? (
              <PhotoStage key={f.id} f={f} onRotate={rotatable(f) ? onRotate : undefined} />
            ) : kind === "pdf" ? (
              <iframe key={f.id} src={src(f)} title={f.name} className="ck-viewer__frame" />
            ) : (
              <div className="ck-viewer__doc">
                <div className={`ck-doc__badge ck-doc__badge--${kind}`} style={{ width: 48, height: 48, fontSize: 13 }}>{fileBadge(kind)}</div>
                <div style={{ color: "var(--ck-ink)", fontWeight: 600 }}>Документ</div>
                <div>Браузер не показывает такие файлы — скачайте и откройте в Word или Excel.</div>
                <a href={download(f)} className="ck-btn ck-btn--primary">Скачать</a>
              </div>
            )}
          </div>
          {panel ? <div className="ck-viewer__panel">{panel}</div> : null}
        </div>
        {files.length > 1 && (
          <div className="ck-viewer__strip ck-scroll" aria-label="Файлы переписки">
            {files.map((x) => {
              const k = fileKind(x.mime, x.name);
              return (
                <button key={x.id} type="button" className="ck-thumb" aria-current={x.id === f.id ? "true" : undefined} onClick={() => onOpen(x.id)} aria-label={x.name}>
                  {k === "image" ? <img src={src(x)} alt="" loading="lazy" /> : fileBadge(k)}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

/** Фото: вписано в окно; лупа — колесо мыши (к точке под курсором), кнопки и двойной щелчок; тянуть — двигать.
 *  Поворот виден сразу, а в файл сохраняется через полсекунды после последнего нажатия */
function PhotoStage({ f, onRotate }: { f: ViewFile; onRotate?: ViewerActions["onRotate"] }) {
  const box = useRef<HTMLDivElement>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [rot, setRot] = useState(0);
  const [ver, setVer] = useState<string | null>(null);
  const [state, setState] = useState<"" | "saving" | "saved" | "error">("");
  const [error, setError] = useState("");
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  // Поворот уходит на сервер — кнопки ждут ответа: иначе второй поворот лёг бы на старый файл и фото повернулось бы дважды
  const [inflight, setInflight] = useState(false);
  // Повёрнутый файл встаёт на место без анимации — иначе он «открутился» бы обратно на глазах
  const [instant, setInstant] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const side = Math.abs(rot % 180) === 90;
  const fit = nat && size.w ? Math.min((size.w - 32) / (side ? nat.h : nat.w), (size.h - 32) / (side ? nat.w : nat.h)) : 1;
  const scale = Math.max(0.05, fit * zoom);

  const zoomTo = (z: number, at?: { x: number; y: number }) => {
    const next = Math.min(8, Math.max(1, z));
    const p = at ?? { x: 0, y: 0 };
    setPan((o) => (next === 1 ? { x: 0, y: 0 } : { x: p.x - (next / zoom) * (p.x - o.x), y: p.y - (next / zoom) * (p.y - o.y) }));
    setZoom(next);
  };
  const point = (e: { clientX: number; clientY: number }) => {
    const r = box.current!.getBoundingClientRect();
    return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
  };

  // Колесо — обработчик без passive, иначе браузер прокрутит страницу вместо лупы
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => { e.preventDefault(); zoomTo(zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2), point(e)); };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  const turn = (d: number) => {
    const next = rot + d;
    setRot(next);
    setPan({ x: 0, y: 0 });
    setZoom(1);
    if (!onRotate) return;
    setState("saving");
    setError("");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const deg = ((next % 360) + 360) % 360;
      if (!deg) { setState(""); return; }
      setInflight(true);
      const r = await onRotate(f, deg).catch((): RotateResult => ({ ok: false, error: "Нет связи с сервером" }));
      if (!r.ok || !r.version) { setInflight(false); setState("error"); setError(r.error ?? "Не сохранилось"); return; }
      const v = r.version;
      // Повёрнутый файл сначала загружаем, потом показываем — без мигания обратно
      const img = new Image();
      const swap = (w?: number, h?: number) => {
        setInstant(true);
        setVer(v);
        setRot(0);
        if (w && h) setNat({ w, h });
        setState("saved");
        setInflight(false);
        requestAnimationFrame(() => requestAnimationFrame(() => setInstant(false)));
      };
      img.onload = () => swap(img.naturalWidth, img.naturalHeight);
      img.onerror = () => swap();
      img.src = src(f, v);
    }, 600);
  };

  return (
    <div className="ck-photo">
      <div
        ref={box}
        className={`ck-photo__area${zoom > 1 ? (dragging ? " ck-photo__area--grabbing" : " ck-photo__area--grab") : ""}`}
        onDoubleClick={(e) => zoomTo(zoom > 1 ? 1 : 2.5, point(e))}
        onPointerDown={(e) => {
          if (zoom <= 1) return;
          drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
          setDragging(true);
          (e.target as Element).setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => { const d = drag.current; if (d) setPan({ x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y }); }}
        onPointerUp={() => { drag.current = null; setDragging(false); }}
        onPointerCancel={() => { drag.current = null; setDragging(false); }}
      >
        <img
          src={src(f, ver)}
          alt={f.name}
          draggable={false}
          className="ck-photo__img"
          onLoad={(e) => { const i = e.currentTarget; setNat({ w: i.naturalWidth, h: i.naturalHeight }); }}
          style={{
            width: nat?.w, height: nat?.h,
            transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) rotate(${rot}deg) scale(${scale})`,
            transition: dragging || instant ? "none" : "transform .2s ease", visibility: nat ? "visible" : "hidden",
          }}
        />
      </div>
      <div className="ck-photo__tools">
        <button type="button" className="ck-btn ck-btn--sm" onClick={() => zoomTo(zoom / 1.5)} disabled={zoom <= 1} aria-label="Отдалить">−</button>
        <button type="button" className="ck-btn ck-btn--sm ck-mono" style={{ minWidth: 64 }} onClick={() => zoomTo(1)} aria-label="Вписать в окно">{`${Math.round(zoom * 100)}%`}</button>
        <button type="button" className="ck-btn ck-btn--sm" onClick={() => zoomTo(zoom * 1.5)} disabled={zoom >= 8} aria-label="Приблизить">+</button>
        {onRotate && (
          <>
            <span className="ck-photo__sep" aria-hidden="true" />
            <button type="button" className="ck-btn ck-btn--sm" onClick={() => turn(-90)} disabled={inflight}><RotateIcon dir="left" /> Влево</button>
            <button type="button" className="ck-btn ck-btn--sm" onClick={() => turn(90)} disabled={inflight}><RotateIcon dir="right" /> Вправо</button>
            <span className={`ck-photo__state${state === "error" ? " ck-photo__state--error" : state === "saved" ? " ck-photo__state--ok" : ""}`} aria-live="polite">
              {state === "saving" ? "сохраняем поворот…" : state === "saved" ? "✓ поворот сохранён" : state === "error" ? error : "колесо мыши — лупа"}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
