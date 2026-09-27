import { afterEach, describe, expect, it, vi } from "vitest";
import { aiCaps, aiOk, combineAi, fakeAi, type AiResult, type ChatAi, type Transcript } from "../../src/ai/index.js";
import { bytes } from "../helpers/fake-net.js";
import { at, dialog, msg } from "./messages.js";

// «Розетка ИИ»: сборка из нескольких поставщиков, какие кнопки показать, исключения не доходят до окна;
// поддельный ИИ для демо — без сети, всегда один ответ.

afterEach(() => {
  vi.restoreAllMocks();
});

describe("combineAi и aiCaps", () => {
  it("каждое дело — первый поставщик, который его умеет; пустые места пропускаются", async () => {
    const voice: ChatAi = { transcribe: async () => aiOk({ text: "из сервиса расшифровки" }) };
    const text: ChatAi = {
      transcribe: async () => aiOk({ text: "не должен вызываться" }),
      improve: async (t) => aiOk({ text: `${t}!` }),
    };
    const ai = combineAi(null, false, undefined, voice, text);
    expect(await ai.transcribe!({ data: bytes.ogg(), mime: "audio/ogg", name: "v.ogg" })).toEqual({ ok: true, value: { text: "из сервиса расшифровки" } });
    expect(await ai.improve!("да")).toEqual({ ok: true, value: { text: "да!" } });
    expect(ai.summarize).toBeUndefined();
    expect(aiCaps(ai)).toEqual({ transcribe: true, summarize: false, improve: true, assess: false });
    expect(aiCaps(null)).toEqual({ transcribe: false, summarize: false, improve: false, assess: false });
  });

  it("поставщик-класс работает (this на месте); исключение поставщика — ошибка словами, а не падение окна", async () => {
    class Studio {
      prefix = "студия: ";
      async summarize(): Promise<AiResult<{ summary: string; points: string[] }>> {
        return aiOk({ summary: `${this.prefix}пересказ`, points: [] });
      }
      async transcribe(): Promise<AiResult<Transcript>> {
        throw new Error("сломалось");
      }
    }
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const ai = combineAi(new Studio());
    expect(await ai.summarize!([])).toEqual({ ok: true, value: { summary: "студия: пересказ", points: [] } });
    expect(await ai.transcribe!({ data: bytes.ogg(), mime: "audio/ogg", name: "v.ogg" })).toEqual({
      ok: false, error: "Сбой помощника ИИ — повторите чуть позже", retryable: true,
    });
    expect(log).toHaveBeenCalled();
  });
});

describe("поддельный ИИ", () => {
  const ai = fakeAi({ now: () => Date.parse(at("09:30")) });

  it("расшифровка — пример с размером файла; пустой файл — ошибка", async () => {
    const r = await ai.transcribe({ data: bytes.ogg(), mime: "audio/ogg", name: "v.ogg" });
    expect(r).toEqual({ ok: true, value: { text: "(пример расшифровки) Здравствуйте! Хотел уточнить по вашему ответу — перезвоните мне, пожалуйста. [голосовое сообщение, 1 КБ]", lang: "ru" } });
    expect(await ai.transcribe({ data: new Uint8Array(0), mime: "audio/ogg", name: "v.ogg" })).toEqual({ ok: false, error: "Файл пустой — расшифровывать нечего" });
  });

  it("краткое содержание — из последних сообщений клиента, без служебных и черновиков", async () => {
    const r = await ai.summarize(dialog());
    expect(r).toEqual({
      ok: true,
      value: {
        summary: "(пример) Сообщений от клиента: 2, от команды и бота: 2. Последнее сообщение клиента: «Голосовое сообщение».",
        points: ["Здравствуйте, можно записаться на завтра? Мой номер +996 555 00-00-01", "Голосовое сообщение"],
      },
    });
    expect(await ai.summarize([])).toEqual({ ok: false, error: "Нет сообщений — пересказывать нечего" });
  });

  it("«Улучшить»: заглавная буква, пробелы, знаки; короче — без слов-паразитов; теплее — с приветствием", async () => {
    expect(await ai.improve("  да , запись  есть на 15:00!!! ")).toEqual({ ok: true, value: { text: "Да, запись есть на 15:00!" } });
    expect(await ai.improve("ну вообще запись просто есть", { mode: "shorter" })).toEqual({ ok: true, value: { text: "Ну запись есть." } });
    expect(await ai.improve("запись есть", { mode: "friendlier" })).toEqual({ ok: true, value: { text: "Здравствуйте! Запись есть." } });
    expect(await ai.improve("добрый день, запись есть", { mode: "friendlier" })).toEqual({ ok: true, value: { text: "Добрый день, запись есть." } });
    expect(await ai.improve(" ")).toEqual({ ok: false, error: "Нет текста — сначала напишите черновик" });
  });

  it("оценка — по словам клиента: жалоба и «срочно» — high, «спасибо» — low; время оценки — сейчас", async () => {
    const when = new Date(Date.parse(at("09:30"))).toISOString();
    expect(await ai.assess([msg({ text: "Это безобразие, верните деньги!" })])).toEqual({
      ok: true, value: { mood: "negative", urgency: "high", reason: "(пример) в сообщении есть «безобраз»", at: when },
    });
    expect(await ai.assess([msg({ text: "Нужно срочно" })])).toMatchObject({ ok: true, value: { mood: "neutral", urgency: "high" } });
    expect(await ai.assess([msg({ text: "Спасибо большое!" })])).toMatchObject({ ok: true, value: { mood: "positive", urgency: "low" } });
    expect(await ai.assess([msg({ text: "Сколько стоит?" })])).toMatchObject({ ok: true, value: { mood: "neutral", urgency: "normal", reason: "(пример) обычный вопрос" } });
    expect(await ai.assess([msg({ author: { type: "bot" }, text: "Здравствуйте" })])).toEqual({ ok: false, error: "В переписке нет сообщений клиента — оценивать нечего" });
  });

  it("задержка для демо — ответ приходит не сразу", async () => {
    const slow = fakeAi({ delayMs: 30 });
    const t0 = Date.now();
    await slow.improve("да");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
  });
});
