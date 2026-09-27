/* Что отправило поле ввода — одна форма (FormData) для серверных действий Next.js и для обычных функций.
   Поле ввода окна (ui/Composer) собирает форму, проект читает её readComposerForm — на сервере или в браузере. */

/** Вкладки поля: «Клиенту» (уйдёт в мессенджер), «В историю» (копия переписки, клиенту не уходит), «Заметка» (для
 *  команды), «Письмо» (на почту клиента) */
export type ComposerMode = "send" | "copy" | "note" | "email";

export type ComposerDraft = {
  mode: ComposerMode;
  text: string;
  /** Канал диалога (или «email» для письма) */
  channel: string;
  /** «В историю»: мы написали (out) или клиент написал (in) */
  direction: "out" | "in";
  /** Тема письма */
  subject: string | null;
  /** Файл с компьютера */
  file: File | null;
  /** Файл проекта (скан из сделки) — его номер */
  fileId: string | null;
};

export const COMPOSER_MAX_TEXT = 4000;

/** Форма поля ввода → черновик. Лишнее отрезается: текст до 4000 знаков, тема до 200 */
export function readComposerForm(form: FormData): ComposerDraft {
  const mode = String(form.get("mode") ?? "send");
  const file = form.get("file");
  const fileId = String(form.get("file_id") ?? "").trim();
  return {
    mode: mode === "copy" || mode === "note" || mode === "email" ? mode : "send",
    text: String(form.get("text") ?? "").trim().slice(0, COMPOSER_MAX_TEXT),
    channel: String(form.get("channel") ?? ""),
    direction: form.get("direction") === "in" ? "in" : "out",
    subject: form.get("subject") !== null ? String(form.get("subject")).trim().slice(0, 200) : null,
    file: typeof File !== "undefined" && file instanceof File && file.size > 0 ? file : null,
    fileId: fileId || null,
  };
}

/** Ответ проекта полю ввода: ошибка — поле покажет её и вернёт текст, чтобы не набирать заново */
export type SendResult = { ok?: boolean | undefined; error?: string | undefined } | void;

/** Шаблон ответа: название в меню и текст, который подставится в поле. group — раздел меню («По сделке клиента») */
export type Template = { label: string; text: string; group?: string | undefined };
