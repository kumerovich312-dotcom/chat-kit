import type { Assessment, Mood, Urgency } from "../core/conversation.js";
import { fileWords, fmtSize } from "../core/files.js";
import type { ChatMessage } from "../core/model.js";
import { sortMessages } from "../core/order.js";
import { foldYo } from "../core/text.js";
import {
  aiFail, aiOk, IMPROVE_MODES, type AiFile, type AiResult, type AssessOptions, type ChatAi, type ImproveOptions, type SummarizeOptions,
  type Summary, type TranscribeOptions, type Transcript,
} from "./port.js";
import { langCode } from "./transcriber.js";

/* Поддельный ИИ — для демо-страницы и проверок: без сети и ключей, на один и тот же вход — один и тот же ответ.
   Расшифровка — «(пример расшифровки) …», краткое содержание — из последних сообщений клиента, «Улучшить» — заглавная
   буква, пробелы и точка в конце, оценка — по словам «срочно», «жалоба», «спасибо»… Смысла не понимает: это макет. */

export type FakeAiOptions = {
  /** Задержка ответа, мс — чтобы на демо было видно «ИИ думает…» */
  delayMs?: number | undefined;
  now?: (() => number) | undefined;
};

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Что сказано в сообщении: текст, а у голосового без текста — расшифровка или «Голосовое сообщение» */
function said(m: ChatMessage): string {
  const files = m.attachments ?? [];
  const heard = files.map((a) => oneLine(a.transcript ?? "")).filter(Boolean).join(" ");
  return oneLine(m.text) || heard || (files[0] ? fileWords(files[0]) : "");
}

const seen = (m: ChatMessage) => m.kind !== "system" && m.author.type !== "system" && !m.shadow;

const NEGATIVE = ["жалоб", "ужас", "безобраз", "обман", "верните деньги", "недовол", "плохо", "не работает", "сколько можно", "до сих пор", "никто не отвечает", "разочарова"];
const URGENT = ["срочно", "немедленно", "как можно скорее", "сейчас же", "asap", "urgent", "!!"];
const POSITIVE = ["спасибо", "благодар", "отлично", "супер", "рахмат", "thank", "прекрасно"];
const FILLERS = ["просто", "вообще", "как бы", "на самом деле", "в принципе", "короче", "типа"];

/** Пробелы, знаки, заглавная буква, точка в конце */
function tidy(text: string): string {
  let t = text
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").replace(/ +([,.!?:;])/g, "$1").trim())
    .filter(Boolean)
    .join("\n");
  t = t.replace(/!{2,}/g, "!").replace(/\?{2,}/g, "?").replace(/,{2,}/g, ",");
  t = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?…)]$/.test(t) ? t : `${t}.`;
}

function withoutFillers(text: string): string {
  let t = text;
  for (const w of FILLERS) t = t.replace(new RegExp(`(^|[\\s,])${w}(?=[\\s,.!?]|$)`, "giu"), "$1");
  return t.replace(/ {2,}/g, " ").replace(/ ,/g, ",").trim();
}

export function fakeAi(o: FakeAiOptions = {}): Required<ChatAi> {
  const now = o.now ?? Date.now;
  const pause = () => (o.delayMs ? new Promise<void>((r) => setTimeout(r, o.delayMs)) : Promise.resolve());

  return {
    async transcribe(file: AiFile, opts: TranscribeOptions = {}): Promise<AiResult<Transcript>> {
      await pause();
      const size = file.data?.byteLength ?? 0;
      if (!size) return aiFail("Файл пустой — расшифровывать нечего");
      const what = fileWords({ mime: file.mime, name: "" }).toLowerCase();
      return aiOk({
        text: `(пример расшифровки) Здравствуйте! Хотел уточнить по вашему ответу — перезвоните мне, пожалуйста. [${what}, ${fmtSize(size)}]`,
        lang: langCode(opts.lang) ?? "ru",
      });
    },

    async summarize(messages: readonly ChatMessage[], _opts: SummarizeOptions = {}): Promise<AiResult<Summary>> {
      await pause();
      const list = sortMessages(messages).filter(seen);
      if (!list.length) return aiFail("Нет сообщений — пересказывать нечего");
      const client = list.filter((m) => m.author.type === "client");
      const last = client.at(-1);
      const summary = `(пример) Сообщений от клиента: ${client.length}, от команды и бота: ${list.length - client.length}.`
        + (last ? ` Последнее сообщение клиента: «${clip(said(last), 120)}».` : "");
      return aiOk({ summary, points: client.slice(-3).map((m) => clip(said(m), 80)).filter(Boolean) });
    },

    async improve(text: string, opts: ImproveOptions = {}): Promise<AiResult<{ text: string }>> {
      await pause();
      const draft = String(text ?? "").trim();
      if (!draft) return aiFail("Нет текста — сначала напишите черновик");
      const mode = opts.mode && IMPROVE_MODES.includes(opts.mode) ? opts.mode : "polish";
      if (mode === "shorter") return aiOk({ text: tidy(withoutFillers(draft)) });
      if (mode === "friendlier" && !/^(здравств|добр|привет|салам|hello|hi\b)/i.test(draft)) return aiOk({ text: `Здравствуйте! ${tidy(draft)}` });
      return aiOk({ text: tidy(draft) });
    },

    async assess(messages: readonly ChatMessage[], _opts: AssessOptions = {}): Promise<AiResult<Assessment>> {
      await pause();
      const client = sortMessages(messages).filter((m) => seen(m) && m.author.type === "client");
      if (!client.length) return aiFail("В переписке нет сообщений клиента — оценивать нечего");
      const recent = foldYo(client.slice(-3).map(said).join(" ").toLowerCase());
      const find = (words: string[]) => words.find((w) => recent.includes(w));
      const angry = find(NEGATIVE);
      const urgent = find(URGENT);
      const happy = find(POSITIVE);
      const mood: Mood = angry ? "negative" : happy ? "positive" : "neutral";
      const urgency: Urgency = angry || urgent ? "high" : happy ? "low" : "normal";
      const word = angry ?? urgent ?? happy;
      return aiOk({ mood, urgency, reason: word ? `(пример) в сообщении есть «${word}»` : "(пример) обычный вопрос", at: new Date(now()).toISOString() });
    },
  };
}
