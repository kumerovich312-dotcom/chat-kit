import { fileExt, fmtSize } from "../core/files.js";
import { callService, type ServiceNames } from "./http.js";
import { aiFail, aiOk, guardAi, type AiFile, type AiResult, type AiUsage, type ChatAi, type TranscribeOptions, type Transcript } from "./port.js";

/* Расшифровка речи (голосовые, записи звонков) — сервисом с API как у OpenAI: POST {baseUrl}/audio/transcriptions,
   форма multipart: file, model, response_format, language (если язык точно известен), prompt (подсказка: имена,
   названия). Так умеют OpenAI (gpt-4o-transcribe, gpt-4o-mini-transcribe, whisper-1), Groq (адрес
   https://api.groq.com/openai/v1, модели whisper-large-v3 и whisper-large-v3-turbo) и свои серверы Whisper с тем же API.

   Язык речи называют модели whisper в ответе verbose_json («russian» или «ru» — приводим к коду «ru»); gpt-4o-transcribe
   умеет только json и язык не называет.

   Файл уходит поставщику целиком: скрыть в голосе телефон нельзя — об этом сказано в docs/AI.md. Имя файла не отправляем
   (в нём бывает имя или номер клиента) — только «audio.ogg»: сервисы узнают формат по расширению. */

export type TranscriberOptions = {
  /** Ключ сервиса расшифровки — из окружения проекта */
  apiKey: string;
  /** Адрес API: по умолчанию https://api.openai.com/v1; Groq — https://api.groq.com/openai/v1 */
  baseUrl?: string | undefined;
  /** Модель: по умолчанию gpt-4o-transcribe; у Groq — whisper-large-v3 или whisper-large-v3-turbo */
  model?: string | undefined;
  fetch?: typeof fetch | undefined;
  /** Файл больше — не отправляем (по умолчанию 25 МБ: предел OpenAI и Groq) */
  maxBytes?: number | undefined;
  /** Сколько ждать ответа, мс (по умолчанию 60 секунд) */
  timeoutMs?: number | undefined;
  /** json — только текст; verbose_json — ещё и язык. По умолчанию: модели whisper — verbose_json, остальные — json */
  responseFormat?: "json" | "verbose_json" | undefined;
  /** Расход каждой расшифровки — для журнала затрат проекта */
  onUsage?: ((u: AiUsage) => void) | undefined;
};

export type Transcriber = Required<Pick<ChatAi, "transcribe">>;

export const TRANSCRIBE_MAX_BYTES = 25 * 1024 * 1024;

const NAMES: ServiceNames = { who: "Сервис расшифровки", of: "сервиса расшифровки", with: "сервисом расшифровки" };

/** Расширение по типу файла: сервисы узнают формат по имени и принимают mp3, mp4, m4a, ogg, wav, webm, flac */
const AUDIO_EXT: Readonly<Record<string, string>> = {
  "audio/ogg": "ogg", "audio/opus": "ogg", "application/ogg": "ogg", "video/ogg": "ogg",
  "audio/mpeg": "mp3", "audio/mp3": "mp3",
  "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/m4a": "m4a", "audio/aac": "m4a", "audio/x-aac": "m4a",
  "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/vnd.wave": "wav",
  "audio/webm": "webm", "video/webm": "webm",
  "audio/flac": "flac", "audio/x-flac": "flac",
  "video/mp4": "mp4", "video/mpeg": "mpeg",
};

function audioExt(mime: string, name: string): string {
  const byMime = AUDIO_EXT[mime];
  if (byMime) return byMime;
  const ext = fileExt(name);
  // Голосовые Telegram приходят как .oga, некоторые — как .opus: это тот же ogg
  if (ext === "oga" || ext === "opus") return "ogg";
  return ext || "bin";
}

/** Названия языков, которые отдают модели whisper, → код языка */
const LANG_CODES: Readonly<Record<string, string>> = {
  russian: "ru", english: "en", kyrgyz: "ky", kirghiz: "ky", kazakh: "kk", uzbek: "uz", tajik: "tg", turkmen: "tk", turkish: "tr",
  ukrainian: "uk", belarusian: "be", armenian: "hy", georgian: "ka", azerbaijani: "az", german: "de", polish: "pl", czech: "cs",
  serbian: "sr", french: "fr", spanish: "es", italian: "it", arabic: "ar", persian: "fa", chinese: "zh", korean: "ko",
  japanese: "ja", hindi: "hi", tatar: "tt",
};

/** Язык кодом: «ru», «ru-RU» → «ru»; «Russian» → «ru»; незнакомое название — как есть, маленькими буквами; пусто — null */
export function langCode(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.trim().toLowerCase();
  const head = s.split(/[-_]/)[0] ?? "";
  if (/^[a-z]{2,3}$/.test(head)) return head;
  return LANG_CODES[s] ?? s;
}

/** Ответ сервиса → текст, язык и длина записи. Ответ-JSON, который не читается, — null */
export function readTranscript(body: string, contentType = ""): { text: string; lang: string | null; seconds: number | null } | null {
  const t = body.trim();
  if (contentType.includes("json") || t.startsWith("{")) {
    try {
      const j = JSON.parse(t) as { text?: unknown; language?: unknown; duration?: unknown };
      return {
        text: typeof j.text === "string" ? j.text.trim() : "",
        lang: langCode(j.language),
        seconds: typeof j.duration === "number" && Number.isFinite(j.duration) ? j.duration : null,
      };
    } catch {
      return null;
    }
  }
  // response_format text — ответ просто текстом
  return { text: t, lang: null, seconds: null };
}

export function createOpenAiCompatibleTranscriber(o: TranscriberOptions): Transcriber {
  const doFetch = o.fetch ?? fetch;
  const base = (o.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = o.model?.trim() || "gpt-4o-transcribe";
  const maxBytes = o.maxBytes ?? TRANSCRIBE_MAX_BYTES;
  const timeoutMs = o.timeoutMs ?? 60_000;
  const format = o.responseFormat ?? (/whisper/i.test(model) ? "verbose_json" : "json");

  async function transcribe(file: AiFile, opts: TranscribeOptions = {}): Promise<AiResult<Transcript>> {
    if (!o.apiKey?.trim()) return aiFail("Ключ сервиса расшифровки не задан — проверьте настройки проекта");
    const size = file.data?.byteLength ?? 0;
    if (!size) return aiFail("Файл пустой — расшифровывать нечего");
    if (size > maxBytes) return aiFail(`Запись слишком большая для расшифровки: ${fmtSize(size)}, можно до ${fmtSize(maxBytes)}`);
    const mime = String(file.mime ?? "").toLowerCase().split(";")[0]!.trim();
    const ext = audioExt(mime, file.name);
    const lang = langCode(opts.lang);

    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(file.data)], { type: mime || "application/octet-stream" }), `audio.${ext}`);
    form.append("model", model);
    form.append("response_format", format);
    if (lang) form.append("language", lang);
    const hint = opts.prompt?.trim();
    if (hint) form.append("prompt", hint.slice(0, 800));

    // Заголовок content-type с границей частей формы fetch ставит сам
    const r = await callService(doFetch, `${base}/audio/transcriptions`, { method: "POST", headers: { authorization: `Bearer ${o.apiKey}` }, body: form }, timeoutMs, NAMES, model);
    if (!r.ok) {
      if (r.status === 400 && /format|decod|unsupported|invalid file|could not process/i.test(r.detail)) {
        return aiFail(`Сервис расшифровки не принял формат записи (${ext}) — подходят mp3, m4a, ogg, wav, webm`);
      }
      return aiFail(r.error, r.retryable);
    }
    const got = readTranscript(r.body, r.type);
    if (!got) return aiFail("Сервис расшифровки ответил непонятно — попробуйте ещё раз", true);
    if (o.onUsage) {
      try {
        o.onUsage({ task: "transcribe", model, seconds: got.seconds });
      } catch {
        /* журнал затрат не мешает ответу */
      }
    }
    if (!got.text) return aiFail("В записи не нашлось речи — расшифровывать нечего");
    return aiOk({ text: got.text, lang: got.lang ?? lang });
  }

  return { transcribe: guardAi(transcribe) };
}
