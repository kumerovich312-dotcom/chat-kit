import type { ReactNode } from "react";

/* Значки окна переписки — линиями, без файлов картинок. Цвет — от текста (currentColor). */

type IconProps = { className?: string | undefined; title?: string | undefined };

function Svg({ className, title, children, view = "0 0 24 24" }: IconProps & { children: ReactNode; view?: string }) {
  return (
    <svg viewBox={view} className={className ? `ck-icon ${className}` : "ck-icon"} aria-hidden={title ? undefined : true} role={title ? "img" : undefined}>
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

const line = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

/** Самолётик — «отправить» */
export const SendIcon = (p: IconProps) => (
  <Svg {...p}>
    <path {...line} d="M10 14l11 -11" />
    <path {...line} d="M21 3l-6.5 18a.55 .55 0 0 1 -1 0l-3.5 -7l-7 -3.5a.55 .55 0 0 1 0 -1l18 -6.5" />
  </Svg>
);

/** Скрепка — «прикрепить файл» */
export const ClipIcon = (p: IconProps) => (
  <Svg {...p}>
    <path {...line} d="M15 7l-6.5 6.5a1.5 1.5 0 0 0 3 3l6.5 -6.5a3 3 0 0 0 -6 -6l-6.5 6.5a4.5 4.5 0 0 0 9 9l6.5 -6.5" />
  </Svg>
);

/** Молния — шаблоны ответов */
export const BoltIcon = (p: IconProps) => (
  <Svg {...p}>
    <path {...line} d="M13 3l0 7l6 0l-8 11l0 -7l-6 0l8 -11" />
  </Svg>
);

/** Галочка — ушло */
export const CheckIcon = (p: IconProps) => (
  <Svg {...p}>
    <path {...line} strokeWidth={2.4} d="M5 12l5 5l10 -10" />
  </Svg>
);

/** Две галочки — дошло / прочитано */
export const DoubleCheckIcon = (p: IconProps) => (
  <Svg {...p}>
    <path {...line} strokeWidth={2.2} d="M2.5 12.5l4.5 4.5l10 -10" />
    <path {...line} strokeWidth={2.2} d="M11.5 16l1 1l10 -10" />
  </Svg>
);

/** Часики — отправляется */
export const ClockIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle {...line} cx="12" cy="12" r="9" />
    <path {...line} d="M12 7v5l3 3" />
  </Svg>
);

/** Звёздочка — ответ ИИ-агента */
export const SparkIcon = (p: IconProps) => (
  <Svg {...p}>
    <path {...line} d="M12 3l1.9 5.1l5.1 1.9l-5.1 1.9l-1.9 5.1l-1.9 -5.1l-5.1 -1.9l5.1 -1.9z" />
    <path {...line} d="M19 16l.8 2.2l2.2 .8l-2.2 .8l-.8 2.2l-.8 -2.2l-2.2 -.8l2.2 -.8z" />
  </Svg>
);

export const SearchIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle {...line} cx="10.5" cy="10.5" r="6.5" />
    <path {...line} d="M20 20l-4.8 -4.8" />
  </Svg>
);

export const CloseIcon = (p: IconProps) => (
  <Svg {...p}>
    <path {...line} d="M6 6l12 12M18 6l-12 12" />
  </Svg>
);

export const ChevronIcon = ({ dir = "down", ...p }: IconProps & { dir?: "up" | "down" | "left" | "right" }) => (
  <Svg {...p}>
    <path {...line} d={dir === "down" ? "M6 9l6 6l6 -6" : dir === "up" ? "M6 15l6 -6l6 6" : dir === "left" ? "M15 6l-6 6l6 6" : "M9 6l6 6l-6 6"} />
  </Svg>
);

export const PhoneIcon = (p: IconProps) => (
  <Svg {...p}>
    <path {...line} d="M5 4h4l2 5l-2.5 1.5a11 11 0 0 0 5 5l1.5 -2.5l5 2v4a2 2 0 0 1 -2 2a16 16 0 0 1 -15 -15a2 2 0 0 1 2 -2" />
  </Svg>
);

export const ChatIcon = (p: IconProps) => (
  <Svg {...p}>
    <path {...line} d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1 -2.5 2.5H10l-4 3.5v-3.5A2.5 2.5 0 0 1 4 14.5z" />
  </Svg>
);

export const PauseIcon = (p: IconProps) => (
  <Svg {...p} view="0 0 16 16">
    <rect x="3" y="2" width="3.5" height="12" rx="1" fill="currentColor" />
    <rect x="9.5" y="2" width="3.5" height="12" rx="1" fill="currentColor" />
  </Svg>
);

export const PlayIcon = (p: IconProps) => (
  <Svg {...p} view="0 0 16 16">
    <path d="M4 2.5v11a1 1 0 0 0 1.5.86l9-5.5a1 1 0 0 0 0-1.72l-9-5.5A1 1 0 0 0 4 2.5z" fill="currentColor" />
  </Svg>
);

export const RotateIcon = ({ dir = "right", ...p }: IconProps & { dir?: "left" | "right" }) => (
  <Svg {...p}>
    {dir === "right"
      ? <path {...line} d="M20 11a8 8 0 1 0 -2.3 5.7M20 4v7h-7" />
      : <path {...line} d="M4 11a8 8 0 1 1 2.3 5.7M4 4v7h7" />}
  </Svg>
);

export const MuteIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle {...line} cx="12" cy="12" r="9" />
    <path {...line} d="M5.6 5.6l12.8 12.8" />
  </Svg>
);

export const ThumbIcon = ({ down = false, ...p }: IconProps & { down?: boolean }) => (
  <Svg {...p}>
    <g transform={down ? "rotate(180 12 12)" : undefined}>
      <path {...line} d="M7 11v8a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1v-7a1 1 0 0 1 1 -1h3a4 4 0 0 0 4 -4v-1a2 2 0 0 1 4 0v5h3a2 2 0 0 1 2 2l-1 5a2 3 0 0 1 -2 2h-7a3 3 0 0 1 -3 -3" />
    </g>
  </Svg>
);

export const PencilIcon = (p: IconProps) => (
  <Svg {...p}>
    <path {...line} d="M4 20h4l10.5 -10.5a2.8 2.8 0 0 0 -4 -4l-10.5 10.5v4" />
    <path {...line} d="M13.5 6.5l4 4" />
  </Svg>
);
