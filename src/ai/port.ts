import type { Assessment } from "../core/conversation.js";
import type { ChatMessage } from "../core/model.js";

/* «Розетка ИИ» (ChatAi) — общий вид помощника ИИ в окне переписки. Четыре дела:
   - transcribe — расшифровать голосовое или запись звонка (кнопка «Расшифровать»);
   - summarize — кратко пересказать длинную переписку (кнопка «Кратко»);
   - improve — поправить черновик менеджера: грамотнее, короче, теплее, только ошибки (кнопка «Улучшить»);
   - assess — настроение и срочность клиента (пометка в списке диалогов).

   Поставщики меняются настройкой проекта, а не переписыванием: текст — Claude (createClaudeAi), голос — сервис
   расшифровки с API как у OpenAI (createOpenAiCompatibleTranscriber), позже — своя студия. Проект собирает их в один
   ChatAi (combineAi); ключи — в окружении проекта, набор их не хранит. Чего поставщик не умеет — того метода нет, и окно
   не показывает кнопку (aiCaps).

   Методы не бросают исключений: ответ — AiResult. Ошибка — короткая фраза по-русски для сотрудника; retryable — стоит
   повторить (сбой связи, ИИ перегружен), окно покажет «Повторить». */

export type AiFailure = { ok: false; error: string; retryable?: boolean | undefined };

/** Итог обращения к ИИ: готовый результат или причина словами */
export type AiResult<T> = { ok: true; value: T } | AiFailure;

export const aiOk = <T>(value: T): AiResult<T> => ({ ok: true, value });

export const aiFail = (error: string, retryable = false): AiFailure => (retryable ? { ok: false, error, retryable: true } : { ok: false, error });

/** Файл для расшифровки: голосовое, запись звонка, видео с речью */
export type AiFile = { data: Uint8Array; mime: string; name: string };

export type TranscribeOptions = {
  /** Язык записи, если он точно известен («ru», «en») — точнее и быстрее. Не задан — сервис определит сам */
  lang?: string | null | undefined;
  /** Подсказка сервису: имена, названия, слова компании, которые он должен расслышать правильно */
  prompt?: string | null | undefined;
};

export type Transcript = {
  text: string;
  /** Язык речи кодом («ru»), если сервис его назвал */
  lang?: string | null | undefined;
};

export type SummarizeOptions = {
  /** Пояс компании («Asia/Bishkek») — время сообщений в тексте для ИИ такое же, как видят сотрудники */
  timeZone?: string | undefined;
  /** Сколько последних сообщений взять (по умолчанию 80) */
  lastMessages?: number | undefined;
  /** На что обратить особое внимание — словами проекта: «запись и оплата», «документы» */
  focus?: string | null | undefined;
};

export type Summary = {
  /** 1–3 предложения: кто обратился и чего хочет, что сделано, на чём остановились */
  summary: string;
  /** До 5 пунктов: факты, договорённости, открытые вопросы, что сделать дальше */
  points: string[];
};

/** Как улучшить черновик: polish — грамотно и вежливо, shorter — короче, friendlier — теплее, fix — только ошибки */
export type ImproveMode = "polish" | "shorter" | "friendlier" | "fix";

export const IMPROVE_MODES: readonly ImproveMode[] = ["polish", "shorter", "friendlier", "fix"];

/** Подписи режимов для кнопок окна */
export const IMPROVE_LABEL: Readonly<Record<ImproveMode, string>> = {
  polish: "Улучшить",
  shorter: "Короче",
  friendlier: "Теплее",
  fix: "Исправить ошибки",
};

export type ImproveOptions = {
  mode?: ImproveMode | undefined;
  /** Канал ответа (whatsapp, telegram, email…): в мессенджер — коротко и без разметки, в письмо — можно абзацы */
  channel?: string | null | undefined;
};

export type AssessOptions = {
  /** Пояс компании — по времени сообщений ИИ видит, сколько клиент уже ждёт */
  timeZone?: string | undefined;
  /** Сколько последних сообщений взять (по умолчанию 20: оценка идёт часто, чем короче — тем дешевле) */
  lastMessages?: number | undefined;
};

export type AiTask = "transcribe" | "summarize" | "improve" | "assess";

/** Расход на одно обращение — проекту для журнала затрат (onUsage) */
export type AiUsage = {
  task: AiTask;
  model: string;
  /** Токены запроса и ответа (текст) */
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  /** Длина записи в секундах (расшифровка), если сервис её назвал */
  seconds?: number | null | undefined;
};

export interface ChatAi {
  /** Голосовое или запись звонка → текст */
  transcribe?(file: AiFile, opts?: TranscribeOptions): Promise<AiResult<Transcript>>;
  /** Длинная переписка → краткое содержание и пункты */
  summarize?(messages: readonly ChatMessage[], opts?: SummarizeOptions): Promise<AiResult<Summary>>;
  /** Черновик менеджера → поправленный текст (отправляет менеджер сам, после проверки) */
  improve?(text: string, opts?: ImproveOptions): Promise<AiResult<{ text: string }>>;
  /** Последние сообщения → настроение и срочность клиента (проект хранит оценку у диалога) */
  assess?(messages: readonly ChatMessage[], opts?: AssessOptions): Promise<AiResult<Assessment>>;
}

/** Какие кнопки ИИ показать — простые да/нет: их можно передать в клиентскую часть окна (функции туда передать нельзя) */
export type AiCaps = { transcribe: boolean; summarize: boolean; improve: boolean; assess: boolean };

export function aiCaps(ai: ChatAi | null | undefined): AiCaps {
  return {
    transcribe: typeof ai?.transcribe === "function",
    summarize: typeof ai?.summarize === "function",
    improve: typeof ai?.improve === "function",
    assess: typeof ai?.assess === "function",
  };
}

/** Метод поставщика без исключений: неожиданный сбой (ошибка в коде поставщика проекта) → «Сбой помощника ИИ»,
 *  подробности — в журнал сервера */
export function guardAi<A extends unknown[], T>(fn: (...args: A) => Promise<AiResult<T>>): (...args: A) => Promise<AiResult<T>> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (e) {
      console.error("[chat-kit ai] сбой помощника ИИ:", e);
      return aiFail("Сбой помощника ИИ — повторите чуть позже", true);
    }
  };
}

/** Один ChatAi из нескольких поставщиков: каждое дело берёт первый, кто его умеет. Пустые места (null, false) пропускаются —
 *  так проект выключает поставщика без ключа: combineAi(key ? createClaudeAi({ apiKey: key }) : null, transcriber) */
export function combineAi(...parts: readonly (Partial<ChatAi> | null | undefined | false)[]): ChatAi {
  const list = parts.filter((p): p is Partial<ChatAi> => !!p);
  const first = (k: keyof ChatAi) => list.find((p) => typeof p[k] === "function");
  const out: ChatAi = {};
  const t = first("transcribe");
  if (t?.transcribe) out.transcribe = guardAi(t.transcribe.bind(t));
  const s = first("summarize");
  if (s?.summarize) out.summarize = guardAi(s.summarize.bind(s));
  const i = first("improve");
  if (i?.improve) out.improve = guardAi(i.improve.bind(i));
  const a = first("assess");
  if (a?.assess) out.assess = guardAi(a.assess.bind(a));
  return out;
}
