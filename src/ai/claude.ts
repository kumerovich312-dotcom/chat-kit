import type { Assessment } from "../core/conversation.js";
import type { ChatMessage } from "../core/model.js";
import { plural } from "../core/text.js";
import { renderConversation, timeStamp } from "./dialog.js";
import { callService, type ServiceNames } from "./http.js";
import {
  aiFail, aiOk, guardAi, IMPROVE_MODES, type AiResult, type AiTask, type AiUsage, type AssessOptions, type ChatAi, type ImproveOptions,
  type SummarizeOptions, type Summary,
} from "./port.js";
import { personalDataMask } from "./privacy.js";
import { assessSystem, improveSystem, inTag, readAssessment, readImproved, readSummary, summarizeSystem, type AiWords } from "./prompts.js";

/* Claude (Anthropic) для текста: краткое содержание, «Улучшить», настроение и срочность. Расшифровывать речь Claude не
   умеет — для голоса отдельный сервис (transcriber.ts); проект соединяет их через combineAi.

   Messages API: POST {baseUrl}/v1/messages, заголовки x-api-key (ключ из окружения проекта) и anthropic-version
   2023-06-01, тело { model, max_tokens, system, messages }. Модели по умолчанию: claude-sonnet-5 — краткое содержание
   и «Улучшить» (нажимают руками, важно качество); claude-haiku-4-5 — оценка (идёт на каждое сообщение клиента: дёшево
   и быстро). Сильнее и дороже — claude-opus-5-5: проект ставит её в models, если качества не хватает.

   Сколько модели думать перед ответом — output_config.effort «low»: пересказу и правке текста хватает, ответ быстрее
   и дешевле. Модели, которые effort не знают (Haiku 4.5, Sonnet 4.5 и более ранние), получают запрос без него; если
   модель всё же отказала из-за effort — тот же запрос уходит второй раз без него.

   До отправки телефоны, почта и номера карт заменяются метками (privacy.ts), в ответе — возвращаются на место. */

export const CLAUDE_MODELS = {
  summarize: "claude-sonnet-5",
  improve: "claude-sonnet-5",
  assess: "claude-haiku-4-5-20251001",
} as const;

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type ClaudeAiOptions = {
  /** Ключ API Anthropic — из окружения проекта, не из кода и не из базы */
  apiKey: string;
  /** Свои модели для дел (по умолчанию CLAUDE_MODELS) */
  models?: { summarize?: string | undefined; improve?: string | undefined; assess?: string | undefined } | undefined;
  fetch?: typeof fetch | undefined;
  /** Адрес API (свой шлюз или прокси); по умолчанию https://api.anthropic.com */
  baseUrl?: string | undefined;
  /** Не больше стольких знаков переписки или черновика в одном запросе (по умолчанию 24 000) */
  maxInputChars?: number | undefined;
  /** Скрывать телефоны, почту и номера карт от поставщика (по умолчанию да) */
  maskPersonalData?: boolean | undefined;
  /** Слова проекта: как называть клиента («пациент», «кандидат») и кто такая компания («клиника», «агентство») */
  words?: { client?: string | undefined; company?: string | undefined } | undefined;
  /** Пояс компании для времени сообщений («Asia/Bishkek»); у вызова можно задать свой */
  timeZone?: string | undefined;
  /** Сколько модели думать: по умолчанию «low»; null — не передавать (как решит модель) */
  effort?: ClaudeEffort | null | undefined;
  /** Сколько ждать ответа, мс (по умолчанию 30 секунд) */
  timeoutMs?: number | undefined;
  now?: (() => number) | undefined;
  /** Расход каждого запроса — для журнала затрат проекта */
  onUsage?: ((u: AiUsage) => void) | undefined;
};

export type ClaudeAi = Required<Pick<ChatAi, "summarize" | "improve" | "assess">>;

const NAMES: ServiceNames = { who: "ИИ", of: "ИИ", with: "ИИ" };

/** Понимает ли модель effort: Opus 4.5 и новее, Sonnet 4.6 и новее — да; Haiku, Sonnet 4.5, Opus 4.1 и более ранние — нет */
export function claudeSupportsEffort(model: string): boolean {
  return !/haiku|claude-3|sonnet-4-(?:0|5|2\d{7})(?!\d)|opus-4-(?:0|1|2\d{7})(?!\d)/.test(model);
}

type ClaudeReply = {
  model?: string;
  content?: { type?: string; text?: unknown }[];
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
};

export function createClaudeAi(o: ClaudeAiOptions): ClaudeAi {
  const doFetch = o.fetch ?? fetch;
  const base = (o.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const models = {
    summarize: o.models?.summarize || CLAUDE_MODELS.summarize,
    improve: o.models?.improve || CLAUDE_MODELS.improve,
    assess: o.models?.assess || CLAUDE_MODELS.assess,
  };
  const maxChars = Math.max(1000, o.maxInputChars ?? 24_000);
  const masking = o.maskPersonalData !== false;
  const words: AiWords = { client: o.words?.client?.trim() || "клиент", company: o.words?.company?.trim() || null };
  const timeoutMs = o.timeoutMs ?? 30_000;
  const now = o.now ?? Date.now;
  const effort = o.effort === undefined ? "low" : o.effort;
  /** Модели, которые отказали из-за effort, — дальше спрашиваем их без него, одним запросом */
  const noEffort = new Set<string>();

  const post = (body: Record<string, unknown>) =>
    callService(doFetch, `${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": o.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body),
    }, timeoutMs, NAMES, String(body.model));

  /** Один вопрос модели: задание (system) и данные (user) → текст ответа и почему он кончился */
  async function ask(task: AiTask, model: string, system: string, user: string, maxTokens: number): Promise<AiResult<{ text: string; stop: string }>> {
    if (!o.apiKey?.trim()) return aiFail("Ключ ИИ не задан — проверьте настройки проекта");
    const body: Record<string, unknown> = { model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] };
    if (effort && claudeSupportsEffort(model) && !noEffort.has(model)) body.output_config = { effort };
    let r = await post(body);
    if (!r.ok && r.status === 400 && body.output_config && /effort|output_config/i.test(r.detail)) {
      // Модель не знает effort — спрашиваем без него
      noEffort.add(model);
      delete body.output_config;
      r = await post(body);
    }
    if (!r.ok) return aiFail(r.error, r.retryable);
    let reply: ClaudeReply | null = null;
    try {
      reply = JSON.parse(r.body) as ClaudeReply | null;
    } catch {
      /* ниже — «непонятно» */
    }
    if (!reply || typeof reply !== "object") return aiFail("ИИ ответил непонятно — попробуйте ещё раз", true);
    if (reply.usage && o.onUsage) {
      try {
        o.onUsage({ task, model: reply.model ?? model, inputTokens: reply.usage.input_tokens ?? 0, outputTokens: reply.usage.output_tokens ?? 0 });
      } catch {
        /* журнал затрат не мешает ответу */
      }
    }
    if (reply.stop_reason === "refusal") return aiFail("ИИ отказался обрабатывать этот текст");
    const text = (Array.isArray(reply.content) ? reply.content : [])
      .map((b) => (b?.type === "text" && typeof b.text === "string" ? b.text : ""))
      .join("")
      .trim();
    if (!text) {
      return reply.stop_reason === "max_tokens"
        ? aiFail("Ответ ИИ оборвался — сократите текст и попробуйте ещё раз")
        : aiFail("ИИ вернул пустой ответ — попробуйте ещё раз", true);
    }
    return aiOk({ text, stop: reply.stop_reason ?? "" });
  }

  const nowLine = (tz: string | undefined) => {
    const t = timeStamp(now(), tz);
    return t ? `\nСейчас: [${t}]` : "";
  };

  async function summarize(messages: readonly ChatMessage[], opts: SummarizeOptions = {}): Promise<AiResult<Summary>> {
    const tz = opts.timeZone ?? o.timeZone;
    const mask = masking ? personalDataMask() : null;
    const conv = renderConversation(messages, { timeZone: tz, lastMessages: opts.lastMessages ?? 80, maxChars, client: words.client, mask });
    if (!conv.count) return aiFail("Нет сообщений — пересказывать нечего");
    const r = await ask("summarize", models.summarize, summarizeSystem(words, opts.focus), inTag("conversation", conv.text) + nowLine(tz), 4096);
    if (!r.ok) return r;
    const s = readSummary(r.value.text);
    if (!s) return aiFail("ИИ ответил не по форме — попробуйте ещё раз", true);
    // Телефон и почту возвращаем (сотрудник их и так видит), номер карты в пересказ не идёт
    const back = (t: string) => (mask ? mask.restore(t, { cards: false }) : t);
    return aiOk({ summary: back(s.summary), points: s.points.map(back) });
  }

  async function improve(text: string, opts: ImproveOptions = {}): Promise<AiResult<{ text: string }>> {
    const draft = String(text ?? "").trim();
    if (!draft) return aiFail("Нет текста — сначала напишите черновик");
    if (draft.length > maxChars) {
      return aiFail(`Текст слишком длинный: ${draft.length.toLocaleString("ru-RU")} ${plural(draft.length, "знак", "знака", "знаков")}, можно до ${maxChars.toLocaleString("ru-RU")}`);
    }
    const mode = opts.mode && IMPROVE_MODES.includes(opts.mode) ? opts.mode : "polish";
    const mask = masking ? personalDataMask() : null;
    const hidden = mask ? mask.hide(draft) : draft;
    // Ответ не длиннее черновика заметно — места с запасом (и на размышления модели)
    const r = await ask("improve", models.improve, improveSystem(words, mode, opts.channel ?? null), inTag("draft", hidden), Math.min(16_000, 2048 + draft.length));
    if (!r.ok) return r;
    if (r.value.stop === "max_tokens") return aiFail("Ответ ИИ оборвался — сократите текст и попробуйте ещё раз");
    const out = readImproved(r.value.text);
    if (!out) return aiFail("ИИ ответил не по форме — попробуйте ещё раз", true);
    // Текст вернётся менеджеру в поле ввода — всё скрытое (и номер карты) ставим обратно
    return aiOk({ text: mask ? mask.restore(out) : out });
  }

  async function assess(messages: readonly ChatMessage[], opts: AssessOptions = {}): Promise<AiResult<Assessment>> {
    const tz = opts.timeZone ?? o.timeZone;
    const mask = masking ? personalDataMask() : null;
    const conv = renderConversation(messages, { timeZone: tz, lastMessages: opts.lastMessages ?? 20, maxChars: Math.min(maxChars, 8000), client: words.client, mask });
    if (!conv.fromClient) return aiFail("В переписке нет сообщений клиента — оценивать нечего");
    const r = await ask("assess", models.assess, assessSystem(words), inTag("conversation", conv.text) + nowLine(tz), 2048);
    if (!r.ok) return r;
    const a = readAssessment(r.value.text);
    if (!a) return aiFail("ИИ ответил не по форме — попробуйте ещё раз", true);
    const reason = a.reason && mask ? mask.restore(a.reason, { cards: false }) : a.reason;
    return aiOk({ mood: a.mood, urgency: a.urgency, reason, at: new Date(now()).toISOString() });
  }

  return { summarize: guardAi(summarize), improve: guardAi(improve), assess: guardAi(assess) };
}
