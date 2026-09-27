import type { Attachment as Att } from "../core/model.js";
import { fileBadge, fileHref, fileKind, fmtSize } from "../core/files.js";
import { VoicePlayer } from "./VoicePlayer.js";

/* Вложение в переписке: фото — картинкой (щелчок — окно просмотра с лупой), видео — проигрывателем, голосовое — волной
   как в WhatsApp, PDF / Word / Excel — плашкой. Сам файл отдаёт проект по Attachment.url (права проверяет он).
   data-view-file — окно просмотра (FileViewerHost) открывается щелчком; без JavaScript ссылка открывает файл во вкладке. */

export function Attachment({ a }: { a: Att }) {
  const kind = fileKind(a.mime, a.name);
  const href = fileHref(a);
  const label = a.name || "Вложение";
  if (kind === "image") {
    return (
      <a href={href} target="_blank" rel="noreferrer" className="ck-att" data-view-file={a.id}>
        {/* Обычный img: файл отдаётся по адресу с проверкой прав, оптимизаторы картинок сюда не ходят */}
        <img src={href} alt={label} className="ck-att__img" loading="lazy" />
      </a>
    );
  }
  if (kind === "video") {
    return (
      <div className="ck-att">
        <video controls preload="metadata" src={href} className="ck-att__video" />
        <a href={fileHref(a, { download: "1" })} className="ck-link">скачать{a.size ? ` · ${fmtSize(a.size)}` : ""}</a>
      </div>
    );
  }
  if (kind === "audio") return <VoicePlayer id={a.id} src={href} sizeLabel={a.size ? fmtSize(a.size) : null} downloadHref={fileHref(a, { download: "1" })} />;
  const badge = fileBadge(kind);
  return (
    <a href={href} target="_blank" rel="noreferrer" className="ck-doc" data-view-file={kind === "pdf" ? a.id : undefined}>
      <span className={`ck-doc__badge ck-doc__badge--${kind}`}>{badge}</span>
      <span style={{ minWidth: 0 }}>
        <span className="ck-doc__name">{label}</span>
        {a.size ? <span className="ck-doc__size">{fmtSize(a.size)}</span> : null}
      </span>
    </a>
  );
}
