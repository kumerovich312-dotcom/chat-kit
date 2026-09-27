import { describe, expect, it } from "vitest";
import {
  appSecretProof, createInstagramAdapter, graphFailure, IG_ERRORS, instagramApiBase, refreshInstagramToken, splitMessageText, utf8Length,
} from "../../../src/channels/instagram/index.js";
import { fakeMeta, GRAPH, json, SECRET, TOKEN, type Call } from "./fake-meta.js";

// Отправка в Instagram: запрос к Graph API, файлы ссылкой, длинный текст частями, правило 24 часов и метка HUMAN_AGENT,
// ошибки словами. Номера клиентов и ключи — вымышленные.

const CLIENT = "6200000000000001";
const WINDOW = { message: "(#10) This message is sent outside of allowed window.", type: "OAuthException", code: 10, error_subcode: 2018278, fbtrace_id: "Atest" };

function setup(o: { reply?: (call: Call, n: number) => Response | null; humanAgentTag?: boolean; apiBase?: string; appSecretProof?: boolean; maxTextBytes?: number } = {}) {
  const net = fakeMeta(o.reply ? { reply: o.reply } : {});
  const adapter = createInstagramAdapter({
    accessToken: TOKEN, appSecret: SECRET, fetch: net.fetch,
    ...(o.humanAgentTag ? { humanAgentTag: true } : {}),
    ...(o.apiBase ? { apiBase: o.apiBase } : {}),
    ...(o.appSecretProof ? { appSecretProof: true } : {}),
    ...(o.maxTextBytes ? { maxTextBytes: o.maxTextBytes } : {}),
  });
  return { net, adapter };
}

describe("отправка текста", () => {
  it("POST /me/messages с ключом в заголовке; ответ — ig:<номер сообщения>", async () => {
    const { adapter, net } = setup();
    const r = await adapter.send({ externalId: CLIENT }, { text: "Добрый день! Чем помочь?", author: { type: "operator_crm", name: "Айгерим", id: "7" } });
    expect(r).toEqual({ ok: true, externalId: "ig:mid-sent-1" });
    const [call] = net.posts();
    expect(call?.url).toBe(`${GRAPH}/me/messages`);
    expect(call?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(call?.headers.get("content-type")).toBe("application/json");
    expect(call?.body).toEqual({ recipient: { id: CLIENT }, message: { text: "Добрый день! Чем помочь?" } });
    expect(call?.url).not.toContain(TOKEN);
  });

  it("вход через Facebook — graph.facebook.com; appsecret_proof, если включён", async () => {
    const { adapter, net } = setup({ apiBase: instagramApiBase("facebook"), appSecretProof: true });
    await adapter.send({ externalId: CLIENT }, { text: "Здравствуйте" });
    expect(instagramApiBase("facebook", "v24.0")).toBe("https://graph.facebook.com/v24.0");
    expect(net.posts()[0]?.url).toBe(`https://graph.facebook.com/v23.0/me/messages?appsecret_proof=${appSecretProof(TOKEN, SECRET)}`);
  });

  it("ответ бота — без разметки Markdown; текст человека — как написан", async () => {
    const { adapter, net } = setup();
    await adapter.send({ externalId: CLIENT }, { text: "**Запись** на [сайте](https://clinic.example/zapis)", author: { type: "bot" } });
    await adapter.send({ externalId: CLIENT }, { text: "**как есть**", author: { type: "operator_crm" } });
    expect(net.posts().map((c) => (c.body?.message as { text?: string }).text)).toEqual(["Запись на сайте (https://clinic.example/zapis)", "**как есть**"]);
  });

  it("длинный текст — частями не больше 1000 байт, по порядку; ответ — номер последней части", async () => {
    const { adapter, net } = setup();
    const para = "Здравствуйте! Подробно расскажу о подготовке к приёму и о том, что взять с собой. ".repeat(6).trim();
    const text = `${para}\n\n${para}\n\n${para}`;
    expect(utf8Length(text)).toBeGreaterThan(2000);
    const r = await adapter.send({ externalId: CLIENT }, { text });
    const sent = net.posts().map((c) => (c.body?.message as { text: string }).text);
    expect(sent.length).toBeGreaterThanOrEqual(3);
    expect(sent.every((t) => utf8Length(t) <= 1000)).toBe(true);
    expect(sent.join(" ").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
    expect(r).toEqual({ ok: true, externalId: `ig:mid-sent-${sent.length}` });
  });

  it("часть ушла, следующая — нет: ошибка без повтора (иначе начало задвоится)", async () => {
    const { adapter } = setup({ maxTextBytes: 100, reply: (c, n) => (c.method === "POST" && n === 1 ? json({ error: { message: "Service temporarily unavailable", code: 2, is_transient: true } }, 503) : null) });
    const r = await adapter.send({ externalId: CLIENT }, { text: "Первая часть длинного сообщения, которую Instagram примет. Вторая часть, которую он не примет." });
    expect(r).toEqual({ ok: false, error: `Ушла только часть сообщения (1 из 2): ${IG_ERRORS.temporary}`, retryable: false });
  });

  it("клиент не писал в Instagram или текст пустой — не отправляем", async () => {
    const { adapter, net } = setup();
    expect(await adapter.send({ externalId: "" }, { text: "Привет" })).toMatchObject({ ok: false, error: expect.stringMatching(/первым/) });
    expect(await adapter.send({ externalId: CLIENT }, { text: "   " })).toMatchObject({ ok: false });
    expect(net.calls).toHaveLength(0);
  });
});

describe("отправка файлов", () => {
  it("фото ссылкой — вложение image; подпись следом отдельным сообщением; ответ — номер подписи", async () => {
    const { adapter, net } = setup();
    const r = await adapter.send({ externalId: CLIENT }, {
      text: "Схема проезда", file: { name: "shema.jpg", mime: "image/jpeg", url: "https://crm.example/files/15?exp=1&sig=test" },
    });
    expect(net.posts().map((c) => c.body?.message)).toEqual([
      { attachment: { type: "image", payload: { url: "https://crm.example/files/15?exp=1&sig=test" } } },
      { text: "Схема проезда" },
    ]);
    expect(r).toEqual({ ok: true, externalId: "ig:mid-sent-2" });
  });

  it("PDF — вложение file, видео — video, голосовое — audio; текст «Файл: имя» не отправляем", async () => {
    const { adapter, net } = setup();
    await adapter.send({ externalId: CLIENT }, { text: "Файл: dogovor.pdf", file: { name: "dogovor.pdf", mime: "application/pdf", url: "https://crm.example/files/16" } });
    await adapter.send({ externalId: CLIENT }, { text: "", file: { name: "video.mp4", mime: "video/mp4", url: "https://crm.example/files/17" } });
    await adapter.send({ externalId: CLIENT }, { text: "", file: { name: "voice.m4a", mime: "audio/mp4", url: "https://crm.example/files/18" } });
    expect(net.posts().map((c) => (c.body?.message as { attachment: { type: string } }).attachment.type)).toEqual(["file", "video", "audio"]);
  });

  it("файл только данными (без ссылки) — понятная ошибка, в Instagram ничего не уходит", async () => {
    const { adapter, net } = setup();
    const r = await adapter.send({ externalId: CLIENT }, { text: "", file: { name: "a.pdf", mime: "application/pdf", data: new Uint8Array([1, 2, 3]) } });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/только ссылкой/) });
    expect(net.calls).toHaveLength(0);
  });
});

describe("правило 24 часов и метка HUMAN_AGENT", () => {
  const windowUnlessTagged = (c: Call) => (c.method === "POST" && !c.body?.tag ? json({ error: WINDOW }, 400) : null);

  it("без метки: больше 24 часов — понятная причина, без повтора", async () => {
    const { adapter, net } = setup({ reply: windowUnlessTagged });
    const r = await adapter.send({ externalId: CLIENT }, { text: "Добрый день", author: { type: "operator_crm" } });
    expect(r).toEqual({ ok: false, error: "Прошло больше 24 часов с последнего сообщения клиента — Instagram не даёт написать первым", retryable: false });
    expect(net.posts()).toHaveLength(1);
  });

  it("humanAgentTag: ответ человека — ещё раз с MESSAGE_TAG / HUMAN_AGENT; остальные части — сразу с меткой", async () => {
    const { adapter, net } = setup({ humanAgentTag: true, maxTextBytes: 100, reply: windowUnlessTagged });
    const r = await adapter.send({ externalId: CLIENT }, { text: "Первая часть ответа менеджера, довольно длинная. Вторая часть ответа менеджера, тоже длинная.", author: { type: "operator_crm" } });
    expect(r.ok).toBe(true);
    const bodies = net.posts().map((c) => c.body);
    expect(bodies[0]).not.toHaveProperty("tag");
    expect(bodies.slice(1).every((b) => b?.messaging_type === "MESSAGE_TAG" && b?.tag === "HUMAN_AGENT")).toBe(true);
    expect(bodies).toHaveLength(3);
  });

  it("humanAgentTag: ответ бота метку не получает; больше 7 дней — своя причина", async () => {
    const bot = setup({ humanAgentTag: true, reply: windowUnlessTagged });
    expect(await bot.adapter.send({ externalId: CLIENT }, { text: "Напоминаю о записи", author: { type: "bot" } })).toMatchObject({ ok: false, error: IG_ERRORS.window24h });
    expect(bot.net.posts()).toHaveLength(1);
    const late = setup({ humanAgentTag: true, reply: (c) => (c.method === "POST" ? json({ error: WINDOW }, 400) : null) });
    expect(await late.adapter.send({ externalId: CLIENT }, { text: "Добрый день" })).toMatchObject({ ok: false, error: IG_ERRORS.window7d });
    expect(late.net.posts()).toHaveLength(2);
  });

  it("метка не разрешена приложению — объясняем, что это разрешение Human Agent", async () => {
    const { adapter } = setup({
      humanAgentTag: true,
      reply: (c) => (c.method !== "POST" ? null : c.body?.tag
        ? json({ error: { message: "(#100) Param tag[HUMAN_AGENT] is not allowed for this app", code: 100 } }, 400)
        : json({ error: WINDOW }, 400)),
    });
    expect(await adapter.send({ externalId: CLIENT }, { text: "Добрый день" })).toMatchObject({ ok: false, error: IG_ERRORS.tag });
  });
});

describe("ошибки Instagram словами", () => {
  it("ключ недействителен, лимит, сбой Meta, нет связи", async () => {
    const answer = (res: () => Response) => setup({ reply: (c) => (c.method === "POST" ? res() : null) }).adapter.send({ externalId: CLIENT }, { text: "Привет" });
    expect(await answer(() => json({ error: { message: "Error validating access token: Session has expired", type: "OAuthException", code: 190, error_subcode: 463 } }, 400)))
      .toEqual({ ok: false, error: IG_ERRORS.token, retryable: false });
    expect(await answer(() => json({ error: { message: "There have been too many calls to this Instagram account", code: 80002 } }, 400)))
      .toEqual({ ok: false, error: IG_ERRORS.rate, retryable: true });
    expect(await answer(() => json({ error: { message: "Calls to this api have exceeded the rate limit.", code: 613 } }, 400))).toMatchObject({ retryable: true });
    expect(await answer(() => new Response("Bad gateway", { status: 502 }))).toEqual({ ok: false, error: IG_ERRORS.temporary, retryable: true });
    const offline = createInstagramAdapter({ accessToken: TOKEN, appSecret: SECRET, fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch });
    expect(await offline.send({ externalId: CLIENT }, { text: "Привет" })).toEqual({ ok: false, error: "Нет связи с Instagram", retryable: true });
  });

  it("клиент недоступен, нет такого клиента, файл не забрали, прочее — с кодом", () => {
    expect(graphFailure(400, { message: "This person isn't available right now.", code: 551, error_subcode: 1545041 }).error).toBe(IG_ERRORS.unavailable);
    expect(graphFailure(400, { message: "(#100) No matching user found", code: 100, error_subcode: 2018001 }).error).toBe(IG_ERRORS.noUser);
    expect(graphFailure(400, { message: "(#100) Upload attachment failure.", code: 100, error_subcode: 2018047 }).error).toBe(IG_ERRORS.file);
    expect(graphFailure(400, { message: "(#10) Application does not have permission for this action", code: 10 }).error).toBe(IG_ERRORS.permission);
    expect(graphFailure(400, { message: "(#100) Invalid parameter", code: 100 })).toEqual({ error: "Instagram не принял сообщение (код 100): (#100) Invalid parameter", retryable: false, window: false });
    expect(graphFailure(429, null)).toMatchObject({ error: IG_ERRORS.rate, retryable: true });
  });
});

describe("деление текста", () => {
  it("по абзацам и предложениям, не раньше середины части; русские буквы — по 2 байта", () => {
    expect(utf8Length("abc")).toBe(3);
    expect(utf8Length("абв")).toBe(6);
    expect(utf8Length("😀")).toBe(4);
    expect(splitMessageText("Короткий текст", 1000)).toEqual(["Короткий текст"]);
    expect(splitMessageText("  ", 1000)).toEqual([]);
    const parts = splitMessageText("Первый абзац про запись.\n\nВторой абзац про оплату и адрес.", 60);
    expect(parts).toEqual(["Первый абзац про запись.", "Второй абзац про оплату и адрес."]);
  });

  it("слово длиннее предела режется по буквам, эмодзи не рвётся", () => {
    const parts = splitMessageText("😀".repeat(10), 16);
    expect(parts).toEqual(["😀😀😀😀", "😀😀😀😀", "😀😀"]);
    const long = "а".repeat(30);
    expect(splitMessageText(long, 20)).toEqual(["а".repeat(10), "а".repeat(10), "а".repeat(10)]);
  });
});

describe("продление ключа входа через Instagram", () => {
  it("новый ключ и срок; ошибка — словами", async () => {
    const calls: string[] = [];
    const ok = (async (input: Parameters<typeof fetch>[0]) => {
      calls.push(String(input));
      return json({ access_token: "test-secret-not-real-ig-token-2", token_type: "bearer", expires_in: 5183944 });
    }) as typeof fetch;
    expect(await refreshInstagramToken(TOKEN, { fetch: ok })).toEqual({ ok: true, accessToken: "test-secret-not-real-ig-token-2", expiresInSec: 5183944 });
    expect(calls[0]).toBe(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${TOKEN}`);
    const bad = (async () => json({ error: { message: "Invalid OAuth access token.", type: "OAuthException", code: 190 } }, 400)) as typeof fetch;
    expect(await refreshInstagramToken(TOKEN, { fetch: bad })).toMatchObject({ ok: false, error: IG_ERRORS.token });
  });
});
