import { describe, expect, it } from "vitest";
import { createOpenAiCompatibleTranscriber, langCode, type AiUsage, type TranscriberOptions } from "../../src/ai/index.js";
import { bytes } from "../helpers/fake-net.js";

// Расшифровка — только на поддельной сети: форма multipart (файл, модель, язык, подсказка, формат ответа), разбор
// ответа json и verbose_json, ошибки словами. Ключ — тестовый.

const KEY = "test-secret-not-real-openai";

type Call = { url: string; headers: Headers; form: FormData };

function voiceNet(reply: (n: number) => Response) {
  const calls: Call[] = [];
  const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers), form: init?.body as FormData });
    return reply(calls.length);
  }) as typeof fetch;
  return { fetch: fetchFn, calls };
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

function transcriber(reply: (n: number) => Response, o: Partial<TranscriberOptions> = {}) {
  const net = voiceNet(reply);
  return { t: createOpenAiCompatibleTranscriber({ apiKey: KEY, fetch: net.fetch, ...o }), calls: net.calls };
}

const voice = () => ({ data: bytes.ogg(), mime: "audio/ogg; codecs=opus", name: "Голосовое Айгерим 0555 00-00-01.oga" });

describe("расшифровка: запрос", () => {
  it("OpenAI по умолчанию: адрес, ключ, модель, формат json, язык и подсказка; имя файла — только по типу", async () => {
    const { t, calls } = transcriber(() => json({ text: "  Здравствуйте, когда вы работаете?  " }));
    const r = await t.transcribe(voice(), { lang: "ru-RU", prompt: "Айгерим, запись, оплата" });
    expect(r).toEqual({ ok: true, value: { text: "Здравствуйте, когда вы работаете?", lang: "ru" } });
    const c = calls[0]!;
    expect(c.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(c.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    // Границу частей формы ставит fetch — свой content-type не задаём
    expect(c.headers.get("content-type")).toBeNull();
    expect(c.form.get("model")).toBe("gpt-4o-transcribe");
    expect(c.form.get("response_format")).toBe("json");
    expect(c.form.get("language")).toBe("ru");
    expect(c.form.get("prompt")).toBe("Айгерим, запись, оплата");
    const file = c.form.get("file") as File;
    expect(file.name).toBe("audio.ogg");
    expect(file.type).toBe("audio/ogg");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes.ogg());
  });

  it("Groq: свой адрес и whisper — ответ verbose_json с языком («Russian» → «ru») и длиной для журнала затрат", async () => {
    const usage: AiUsage[] = [];
    const { t, calls } = transcriber(() => json({ task: "transcribe", language: "Russian", duration: 4.2, text: "Добрый день" }), {
      baseUrl: "https://api.groq.com/openai/v1/", model: "whisper-large-v3", onUsage: (u) => usage.push(u),
    });
    expect(await t.transcribe(voice())).toEqual({ ok: true, value: { text: "Добрый день", lang: "ru" } });
    expect(calls[0]?.url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect(calls[0]?.form.get("response_format")).toBe("verbose_json");
    expect(calls[0]?.form.get("language")).toBeNull();
    expect(usage).toEqual([{ task: "transcribe", model: "whisper-large-v3", seconds: 4.2 }]);
  });

  it("расширение файла — по типу: mp3, m4a; .oga и .opus — это ogg", async () => {
    const { t, calls } = transcriber(() => json({ text: "да" }));
    await t.transcribe({ data: bytes.ogg(), mime: "audio/mpeg", name: "звонок" });
    await t.transcribe({ data: bytes.ogg(), mime: "audio/mp4", name: "voice" });
    await t.transcribe({ data: bytes.ogg(), mime: "application/octet-stream", name: "voice.opus" });
    expect(calls.map((c) => (c.form.get("file") as File).name)).toEqual(["audio.mp3", "audio.m4a", "audio.ogg"]);
  });

  it("ответ простым текстом (response_format text) тоже понимаем", async () => {
    const { t } = transcriber(() => new Response("Просто текст\n", { status: 200, headers: { "content-type": "text/plain" } }));
    expect(await t.transcribe(voice())).toEqual({ ok: true, value: { text: "Просто текст", lang: null } });
  });
});

describe("расшифровка: ошибки словами", () => {
  it("пустой и слишком большой файл — без запроса к сервису", async () => {
    const { t, calls } = transcriber(() => json({ text: "x" }), { maxBytes: 1024 * 1024 });
    expect(await t.transcribe({ data: new Uint8Array(0), mime: "audio/ogg", name: "v.ogg" })).toEqual({ ok: false, error: "Файл пустой — расшифровывать нечего" });
    expect(await t.transcribe({ data: new Uint8Array(1.5 * 1024 * 1024), mime: "audio/mpeg", name: "call.mp3" })).toEqual({
      ok: false, error: "Запись слишком большая для расшифровки: 1,5 МБ, можно до 1,0 МБ",
    });
    expect(calls).toHaveLength(0);
  });

  const cases: [string, Response, { error: string; retryable?: boolean }][] = [
    ["401", json({ error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } }, 401),
      { error: "Ключ сервиса расшифровки не подходит — проверьте настройки проекта" }],
    ["429", json({ error: { message: "Rate limit reached for requests", type: "requests", code: "rate_limit_exceeded" } }, 429),
      { error: "Сервис расшифровки перегружен запросами — повторите через минуту", retryable: true }],
    ["429 без денег", json({ error: { message: "You exceeded your current quota, please check your plan and billing details.", type: "insufficient_quota", code: "insufficient_quota" } }, 429),
      { error: "Закончились деньги на счёте сервиса расшифровки — пополните баланс у поставщика" }],
    ["413", json({ error: { message: "Maximum content size limit exceeded" } }, 413), { error: "Слишком большой запрос для сервиса расшифровки — сократите текст или запись" }],
    ["503", new Response("upstream error", { status: 503 }), { error: "Сервис расшифровки сейчас перегружен — повторите чуть позже", retryable: true }],
    ["формат", json({ error: { message: "Invalid file format. Supported formats: ['flac', 'm4a', 'mp3', 'mp4', 'mpeg', 'mpga', 'oga', 'ogg', 'wav', 'webm']" } }, 400),
      { error: "Сервис расшифровки не принял формат записи (amr) — подходят mp3, m4a, ogg, wav, webm" }],
    ["пусто", json({ text: "   " }), { error: "В записи не нашлось речи — расшифровывать нечего" }],
    ["не JSON", new Response("{сломано", { status: 200, headers: { "content-type": "application/json" } }), { error: "Сервис расшифровки ответил непонятно — попробуйте ещё раз", retryable: true }],
  ];
  for (const [name, res, want] of cases) {
    it(`${name} → «${want.error}»`, async () => {
      const { t } = transcriber(() => res);
      expect(await t.transcribe({ data: bytes.ogg(), mime: "audio/amr", name: "call.amr" })).toEqual({ ok: false, ...want });
    });
  }

  it("молчание дольше срока — «не ответил», можно повторить; ключ не задан — без запроса", async () => {
    const hang = ((_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted", "AbortError")));
      })) as typeof fetch;
    const slow = createOpenAiCompatibleTranscriber({ apiKey: KEY, fetch: hang, timeoutMs: 20 });
    expect(await slow.transcribe(voice())).toEqual({ ok: false, error: "Сервис расшифровки не ответил за 1 секунду — попробуйте ещё раз", retryable: true });
    const { t, calls } = transcriber(() => json({ text: "x" }), { apiKey: "" });
    expect(await t.transcribe(voice())).toEqual({ ok: false, error: "Ключ сервиса расшифровки не задан — проверьте настройки проекта" });
    expect(calls).toHaveLength(0);
  });
});

describe("язык кодом", () => {
  it("коды, коды с регионом, названия whisper; пусто — null", () => {
    expect(langCode("ru")).toBe("ru");
    expect(langCode("ru-RU")).toBe("ru");
    expect(langCode("English")).toBe("en");
    expect(langCode("kazakh")).toBe("kk");
    expect(langCode("klingon")).toBe("klingon");
    expect(langCode(" ")).toBeNull();
    expect(langCode(null)).toBeNull();
  });
});
