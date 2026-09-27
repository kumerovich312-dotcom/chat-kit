"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { canView, fileBadge, fileHref, fileKind, fmtSize } from "../core/files.js";
import { DEFAULT_TEXTS, type Texts } from "../core/profile.js";
import { CloseIcon } from "./icons.js";
import { FileViewer, type RotateResult, type ViewFile } from "./FileViewer.js";
import { usePanel } from "./Panels.js";
import { VoicePlayer } from "./VoicePlayer.js";

/* Все файлы клиента — галерея поверх окна (выбор пользователя 27.09.2026): фото и видео плиткой, документы списком,
   голосовые и записи звонков — с проигрывателем. Щелчок по фото или PDF — окно просмотра с лупой и поворотом.
   Открывается кнопкой в шапке (GalleryButton). Файлы собирает окно из ленты; проект может дать полный список
   (за всю историю, а не только показанные сообщения). */

export type GalleryFile = {
  id: string;
  name: string;
  mime: string;
  url: string;
  version?: string | null | undefined;
  size?: number | null | undefined;
  /** Когда и от кого: «сегодня, 14:05 · от клиента» */
  meta?: string | undefined;
};

export function ClientGallery({ files, t = DEFAULT_TEXTS, onRotate, canRotate = false }: {
  files: readonly GalleryFile[];
  t?: Pick<Texts, "files"> | undefined;
  onRotate?: ((file: ViewFile, degrees: number) => Promise<RotateResult>) | undefined;
  canRotate?: boolean | undefined;
}) {
  const [open, setOpen] = usePanel("gallery");
  const [view, setView] = useState<string | null>(null);

  useEffect(() => {
    if (!open || view) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open, view, setOpen]);

  if (!open || typeof document === "undefined") return null;
  const media = files.filter((f) => ["image", "video"].includes(fileKind(f.mime, f.name)));
  const audio = files.filter((f) => fileKind(f.mime, f.name) === "audio");
  const docs = files.filter((f) => !["image", "video", "audio"].includes(fileKind(f.mime, f.name)));
  const viewable: ViewFile[] = files.filter((f) => canView(f)).map((f) => ({
    id: f.id, name: f.name, mime: f.mime, url: f.url, version: f.version ?? null, meta: f.meta, canRotate: canRotate && !!onRotate,
  }));

  // Окно просмотра — рядом с галереей, а не внутри: щелчок мимо фото закрывает только его
  return (
    <>
      {createPortal(
    <div className="ck ck-gallery" onClick={() => setOpen(false)}>
      <div className="ck-gallery__box" role="dialog" aria-modal="true" aria-label={t.files} onClick={(e) => e.stopPropagation()}>
        <div className="ck-gallery__top">
          <strong>{t.files}</strong>
          <span className="ck-gallery__count">{files.length}</span>
          <button type="button" className="ck-iconbtn" style={{ marginLeft: "auto" }} aria-label="Закрыть" onClick={() => setOpen(false)}><CloseIcon /></button>
        </div>
        <div className="ck-gallery__body ck-scroll">
          {files.length === 0 ? <div className="ck-empty"><div className="ck-empty__title">Файлов пока нет</div></div> : null}
          {media.length > 0 && (
            <section>
              <h3 className="ck-gallery__h">Фото и видео · {media.length}</h3>
              <div className="ck-gallery__grid">
                {media.map((f) => fileKind(f.mime, f.name) === "image" ? (
                  <button key={f.id} type="button" className="ck-gallery__tile" title={f.meta ?? f.name} onClick={() => setView(f.id)}>
                    <img src={fileHref(f)} alt={f.name} loading="lazy" />
                  </button>
                ) : (
                  <a key={f.id} href={fileHref(f)} target="_blank" rel="noreferrer" className="ck-gallery__tile ck-gallery__tile--video" title={f.meta ?? f.name}>
                    <video src={fileHref(f)} preload="metadata" muted />
                    <span className="ck-gallery__play" aria-hidden="true">▶</span>
                  </a>
                ))}
              </div>
            </section>
          )}
          {docs.length > 0 && (
            <section>
              <h3 className="ck-gallery__h">Документы · {docs.length}</h3>
              <div className="ck-gallery__list">
                {docs.map((f) => {
                  const kind = fileKind(f.mime, f.name);
                  const inner = (
                    <>
                      <span className={`ck-doc__badge ck-doc__badge--${kind}`}>{fileBadge(kind)}</span>
                      <span style={{ minWidth: 0 }}>
                        <span className="ck-doc__name">{f.name}</span>
                        <span className="ck-doc__size">{[f.size ? fmtSize(f.size) : null, f.meta].filter(Boolean).join(" · ")}</span>
                      </span>
                    </>
                  );
                  return canView(f)
                    ? <button key={f.id} type="button" className="ck-doc" onClick={() => setView(f.id)}>{inner}</button>
                    : <a key={f.id} href={fileHref(f, { download: "1" })} className="ck-doc">{inner}</a>;
                })}
              </div>
            </section>
          )}
          {audio.length > 0 && (
            <section>
              <h3 className="ck-gallery__h">Голосовые и записи · {audio.length}</h3>
              <div className="ck-gallery__list">
                {audio.map((f) => (
                  <div key={f.id} className="ck-gallery__audio">
                    <VoicePlayer id={`g-${f.id}`} src={fileHref(f)} sizeLabel={f.size ? fmtSize(f.size) : null} downloadHref={fileHref(f, { download: "1" })} />
                    {f.meta ? <span className="ck-doc__size">{f.meta}</span> : null}
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>,
    document.body,
      )}
      {view ? <FileViewer files={viewable} openId={view} onOpen={setView} onRotate={onRotate} /> : null}
    </>
  );
}
