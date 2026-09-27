import { describe, expect, it } from "vitest";
import { createInstagramAdapter, instagramAccounts, metaSignature, metaVerifyChallenge, metaVerifyResponse, UNSUPPORTED_TEXT, verifyMetaSignature } from "../../../src/channels/instagram/index.js";
import { createMemoryStore, ingest } from "../../../src/server/index.js";
import { bytes } from "../../helpers/fake-net.js";
import { ACCOUNT, CDN, fakeMeta, fromClient, hook, json, mp4, SECRET, T, TOKEN, webhook, type Call } from "./fake-meta.js";

// Приём уведомлений Instagram: проверка адреса, подпись, сообщения клиента, файлы, статусы, истории, служебные строки.
// Номера клиентов (IGSID), имена и ссылки — вымышленные.

function setup(o: { fetchProfile?: boolean; igUserId?: string; reply?: (call: Call, n: number) => Response | null } = {}) {
  const net = fakeMeta(o.reply ? { reply: o.reply } : {});
  const store = createMemoryStore();
  const adapter = createInstagramAdapter({
    accessToken: TOKEN, appSecret: SECRET, fetch: net.fetch, echoDelayMs: 0,
    ...(o.fetchProfile ? { fetchProfile: true } : {}), ...(o.igUserId ? { igUserId: o.igUserId } : {}),
  });
  const post = (payload: unknown, at = T + 5_000) => ingest(adapter, store, hook(payload), { now: () => at });
  return { net, store, adapter, post };
}

describe("проверка адреса вебхука (GET)", () => {
  const url = (q: string) => ({ url: `https://crm.example/api/instagram?${q}` });

  it("слово совпало — отдаём hub.challenge как есть; иначе 403", () => {
    expect(metaVerifyChallenge(url("hub.mode=subscribe&hub.verify_token=slovo-proverki&hub.challenge=1158201444"), "slovo-proverki")).toEqual({ status: 200, body: "1158201444" });
    expect(metaVerifyChallenge(url("hub.mode=subscribe&hub.verify_token=chuzhoe&hub.challenge=1"), "slovo-proverki").status).toBe(403);
    expect(metaVerifyChallenge(url("hub.mode=unsubscribe&hub.verify_token=slovo-proverki&hub.challenge=1"), "slovo-proverki").status).toBe(403);
    expect(metaVerifyChallenge(url("hub.mode=subscribe&hub.verify_token=slovo-proverki"), "slovo-proverki").status).toBe(403);
    // Слово не задано в окружении — не пускаем никого (и пустое слово в запросе тоже)
    expect(metaVerifyChallenge(url("hub.mode=subscribe&hub.verify_token=&hub.challenge=1"), "").status).toBe(403);
    expect(metaVerifyChallenge({}, "slovo-proverki").status).toBe(403);
  });

  it("ответ для маршрута — простым текстом, без кавычек JSON", async () => {
    const res = metaVerifyResponse(new Request("https://crm.example/api/instagram?hub.mode=subscribe&hub.verify_token=slovo-proverki&hub.challenge=42"), "slovo-proverki");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
    expect(await res.text()).toBe("42");
  });
});

describe("подпись уведомлений", () => {
  it("верная — принимаем; чужой секрет, изменённое тело, нет заголовка — 401 и ничего не записано", async () => {
    const { store, adapter } = setup();
    const payload = webhook(fromClient("6100000000000001", { mid: "mid-sig-1", text: "Здравствуйте" }));
    const good = hook(payload);
    const bad = hook(payload, "test-secret-not-real-other");
    const changed = { ...good, body: good.body.replace("Здравствуйте", "Привет") };
    const bare = { ...good, headers: {} };
    for (const input of [bad, changed, bare]) {
      const r = await ingest(adapter, store, input);
      expect(r.status).toBe(401);
    }
    expect(store.contacts.size).toBe(0);
    expect((await ingest(adapter, store, good, { now: () => T + 5_000 })).status).toBe(200);
    expect(store.messages).toHaveLength(1);
  });

  it("несколько секретов (на время смены секрета приложения); заголовок и подпись — в любом регистре", async () => {
    const body = '{"object":"instagram","entry":[]}';
    const sig = metaSignature("test-secret-not-real-new", body);
    expect(verifyMetaSignature(["test-secret-not-real-old", "test-secret-not-real-new"], sig, body)).toBe(true);
    expect(verifyMetaSignature("test-secret-not-real-old", sig, body)).toBe(false);
    expect(verifyMetaSignature([], sig, body)).toBe(false);
    expect(verifyMetaSignature(SECRET, "sha1=abc", body)).toBe(false);
    const a = createInstagramAdapter({ accessToken: TOKEN, appSecret: ["test-secret-not-real-old", "test-secret-not-real-new"] });
    const r = await a.receive({ method: "POST", headers: { "X-Hub-Signature-256": sig.toUpperCase() }, body });
    expect(r).toMatchObject({ ok: true, events: [] });
  });

  it("не JSON — 400; уведомление не Instagram — 200 и пропущено (Meta не повторяет)", async () => {
    const { adapter, store } = setup();
    const notJson = "{не json";
    const r1 = await ingest(adapter, store, { method: "POST", headers: { "x-hub-signature-256": metaSignature(SECRET, notJson) }, body: notJson });
    expect(r1.status).toBe(400);
    const r2 = await ingest(adapter, store, hook({ object: "page", entry: [] }));
    expect(r2.status).toBe(200);
    expect(r2.summary.status).toBe("ignored");
  });
});

describe("сообщения клиента", () => {
  it("текст: клиент заведён по IGSID, время — от Instagram, клиент ждёт ответа; повтор — duplicate", async () => {
    const { store, post } = setup();
    const ev = webhook(fromClient("6100000000000002", { mid: "mid-text-1", text: "Сколько стоит консультация?" }, T - 2_000));
    const r = await post(ev);
    expect(r.status).toBe(200);
    expect(store.contacts.get("1")).toMatchObject({ channel: "instagram", identities: ["instagram:6100000000000002"], name: "Клиент" });
    expect(store.thread("1")[0]).toMatchObject({
      text: "Сколько стоит консультация?", author: { type: "client" }, channel: "instagram", at: new Date(T - 2_000).toISOString(), externalId: "ig:mid-text-1",
    });
    expect(store.waitingSince("1")).toBe(new Date(T - 2_000).toISOString());
    const again = await post(ev);
    expect(again.summary.status).toBe("duplicate");
    expect(store.messages).toHaveLength(1);
  });

  it("фото, видео, голосовое и документ — скачаны и записаны файлами; голосовое mp4 — как аудио", async () => {
    const { store, post, net } = setup();
    net.files.set(`${CDN}photo-1`, bytes.jpeg());
    net.files.set(`${CDN}video-1`, mp4());
    net.files.set(`${CDN}voice-1`, mp4(6));
    net.files.set(`${CDN}doc-1`, bytes.pdf());
    await post(webhook(fromClient("6100000000000003", {
      mid: "mid-files-1",
      attachments: [
        { type: "image", payload: { url: `${CDN}photo-1` } },
        { type: "video", payload: { url: `${CDN}video-1` } },
        { type: "audio", payload: { url: `${CDN}voice-1` } },
        { type: "file", payload: { url: `${CDN}doc-1` } },
      ],
    })));
    const thread = store.thread("1");
    expect(thread.map((m) => m.attachments?.[0]?.mime)).toEqual(["image/jpeg", "video/mp4", "audio/mp4", "application/pdf"]);
    expect(thread.map((m) => m.text)).toEqual(["Фото", "Видео", "Голосовое сообщение", "Документ"]);
    expect(thread.map((m) => m.externalId)).toEqual(["ig:mid-files-1:file:0", "ig:mid-files-1:file:1", "ig:mid-files-1:file:2", "ig:mid-files-1:file:3"]);
    expect(thread.every((m) => m.author.type === "client")).toBe(true);
    expect(store.waitingSince("1")).not.toBeNull();
  });

  it("ответ на сообщение — цитата: исходное находится по номеру у Instagram", async () => {
    const { store, post } = setup();
    await post(webhook(fromClient("6100000000000004", { mid: "mid-q-1", text: "Есть запись на субботу?" }, T - 60_000)));
    await store.saveMessage("1", { kind: "message", author: { type: "operator_crm", name: "Айгерим" }, channel: "instagram", text: "Да, на 11:00", at: new Date(T - 30_000).toISOString(), externalId: "ig:mid-q-2", delivery: "sent" });
    await post(webhook(fromClient("6100000000000004", { mid: "mid-q-3", text: "Отлично, записывайте", reply_to: { mid: "mid-q-2" } })));
    const reply = store.thread("1").find((m) => m.externalId === "ig:mid-q-3");
    expect(reply?.replyTo).toMatchObject({ externalId: "ig:mid-q-2", text: "Да, на 11:00", author: { type: "operator_crm" } });
  });

  it("прочитано: статус нашего сообщения — read", async () => {
    const { store, post } = setup();
    await post(webhook(fromClient("6100000000000005", { mid: "mid-r-1", text: "Здравствуйте" }, T - 60_000)));
    await store.saveMessage("1", { kind: "message", author: { type: "operator_crm" }, channel: "instagram", text: "Добрый день!", at: new Date(T - 30_000).toISOString(), externalId: "ig:mid-r-2", delivery: "sent" });
    await post(webhook({ sender: { id: "6100000000000005" }, recipient: { id: ACCOUNT }, timestamp: T, read: { mid: "mid-r-2" } }));
    expect(store.thread("1").find((m) => m.externalId === "ig:mid-r-2")?.delivery).toBe("read");
  });

  it("упоминание в истории — ссылка текстом и сама история файлом; ответ на историю — текст клиента и ссылка", async () => {
    const { store, post, net } = setup();
    net.files.set(`${CDN}story-1`, bytes.jpeg());
    await post(webhook(fromClient("6100000000000006", { mid: "mid-st-1", attachments: [{ type: "story_mention", payload: { url: `${CDN}story-1` } }] }, T - 10_000)));
    await post(webhook(fromClient("6100000000000006", { mid: "mid-st-2", text: "Очень красиво!", reply_to: { story: { url: `${CDN}story-2`, id: "17900000000000001" } } })));
    const [mention, file, reply] = store.thread("1");
    expect(mention?.text).toBe(`Упоминание вашего аккаунта в истории: ${CDN}story-1`);
    expect(file).toMatchObject({ text: "История клиента", externalId: "ig:mid-st-1:file:0" });
    expect(file?.attachments?.[0]?.mime).toBe("image/jpeg");
    expect(reply?.text).toBe(`Очень красиво!\nОтвет на вашу историю: ${CDN}story-2`);
  });

  it("публикация и рилс — текстом со ссылкой; «сердечко» и неизвестное вложение — словами", async () => {
    const { store, post } = setup();
    await post(webhook(fromClient("6100000000000007", {
      mid: "mid-sh-1",
      attachments: [
        { type: "share", payload: { url: `${CDN}post-1` } },
        { type: "ig_reel", payload: { url: `${CDN}reel-1`, title: "Как мы работаем", reel_video_id: "18000000000000001" } },
        { type: "like_heart" },
        { type: "poll" },
      ],
    })));
    expect(store.thread("1")[0]?.text).toBe(
      `Публикация: ${CDN}post-1\nРилс «Как мы работаем»: ${CDN}reel-1\nСтикер «сердечко»\nВложение (poll), которое Instagram не показывает`
    );
  });

  it("удалённое сообщение — служебная строка «Клиент удалил сообщение» (один раз), ожидание не меняется", async () => {
    const { store, post } = setup();
    await post(webhook(fromClient("6100000000000008", { mid: "mid-del-1", text: "Ой, не туда" }, T - 10_000)));
    const del = webhook(fromClient("6100000000000008", { mid: "mid-del-1", is_deleted: true }));
    await post(del);
    await post(del);
    const thread = store.thread("1");
    expect(thread.map((m) => [m.kind, m.text])).toEqual([["message", "Ой, не туда"], ["system", "Клиент удалил сообщение"]]);
    expect(store.waits).toHaveLength(1);
  });

  it("неподдерживаемое сообщение — подсказка открыть Instagram; кнопка-подсказка — сообщением клиента", async () => {
    const { store, post } = setup();
    await post(webhook(fromClient("6100000000000009", { mid: "mid-un-1", is_unsupported: true }, T - 10_000)));
    await post(webhook({ sender: { id: "6100000000000009" }, recipient: { id: ACCOUNT }, timestamp: T, postback: { mid: "mid-pb-1", title: "Какие у вас цены?", payload: "PRICES" } }));
    expect(store.thread("1").map((m) => [m.author.type, m.text])).toEqual([["client", UNSUPPORTED_TEXT], ["client", "Какие у вас цены?"]]);
  });

  it("клиент из рекламы — служебная строка один раз на объявление; изменённое сообщение — новый текст строкой", async () => {
    const { store, post } = setup();
    const referral = { source: "ADS", type: "OPEN_THREAD", ad_id: "120200000000000001", ads_context_data: { ad_title: "Осенняя акция" } };
    await post(webhook(fromClient("6100000000000010", { mid: "mid-ad-1", text: "Хочу по акции", referral }, T - 20_000)), T - 19_000);
    await post(webhook({ sender: { id: "6100000000000010" }, recipient: { id: ACCOUNT }, timestamp: T - 10_000, referral }), T - 9_000);
    await post(webhook({ sender: { id: "6100000000000010" }, recipient: { id: ACCOUNT }, timestamp: T, message_edit: { mid: "mid-ad-1", text: "Хочу по осенней акции", num_edit: 1 } }), T + 1_000);
    // Служебные строки набор ставит на время приёма — сразу за сообщением клиента
    expect(store.thread("1").map((m) => [m.kind, m.text])).toEqual([
      ["message", "Хочу по акции"],
      ["system", "Клиент пришёл из рекламы «Осенняя акция» (объявление 120200000000000001)"],
      ["system", "Клиент изменил сообщение: «Хочу по осенней акции»"],
    ]);
  });

  it("реакции в переписку не пишем", async () => {
    const { store, post } = setup();
    const r = await post(webhook({ sender: { id: "6100000000000011" }, recipient: { id: ACCOUNT }, timestamp: T, reaction: { mid: "mid-x", action: "react", reaction: "love" } }));
    expect(r.status).toBe(200);
    expect(store.messages).toHaveLength(0);
    expect(store.contacts.size).toBe(0);
  });

  it("кнопка «Тест» в кабинете: changes[] и время в секундах строкой; standby — тоже сообщение", async () => {
    const { store, post } = setup();
    await post({
      object: "instagram",
      entry: [{ id: "0", time: T, changes: [{ field: "messages", value: { sender: { id: "12334" }, recipient: { id: "23245" }, timestamp: String(Math.floor(T / 1000) - 60), message: { mid: "random_mid", text: "random_text" } } }] }],
    });
    await post({ object: "instagram", entry: [{ id: ACCOUNT, time: T, standby: [fromClient("6100000000000012", { mid: "mid-sb-1", text: "Пока бот занят" })] }] });
    expect(store.thread("1")[0]).toMatchObject({ text: "random_text", externalId: "ig:random_mid", at: new Date(T - 60_000).toISOString() });
    expect(store.thread("2")[0]?.text).toBe("Пока бот занят");
  });

  it("igUserId задан — записи чужого аккаунта пропускаем; номера аккаунтов в уведомлении — для выбора компании", async () => {
    const { store, post } = setup({ igUserId: ACCOUNT });
    const payload = {
      object: "instagram",
      entry: [
        { id: "17841400000000099", time: T, messaging: [{ sender: { id: "6100000000000013" }, recipient: { id: "17841400000000099" }, timestamp: T, message: { mid: "mid-other-1", text: "Чужой аккаунт" } }] },
        { id: ACCOUNT, time: T, messaging: [fromClient("6100000000000014", { mid: "mid-own-1", text: "Наш аккаунт" })] },
      ],
    };
    expect(instagramAccounts(JSON.stringify(payload))).toEqual(["17841400000000099", ACCOUNT]);
    expect(instagramAccounts("{не json")).toEqual([]);
    await post(payload);
    expect(store.messages.map((m) => m.text)).toEqual(["Наш аккаунт"]);
  });
});

describe("профиль клиента", () => {
  it("fetchProfile: имя и ник из Instagram у нового клиента; профиль спрашиваем один раз", async () => {
    const { store, post, net } = setup({
      fetchProfile: true,
      reply: (c) => (c.method === "GET" && c.url.includes("/6100000000000015?") ? json({ name: "Айгерим Тест", username: "aigerim.test", id: "6100000000000015" }) : null),
    });
    await post(webhook(fromClient("6100000000000015", { mid: "mid-pf-1", text: "Здравствуйте" }, T - 10_000)));
    await post(webhook(fromClient("6100000000000015", { mid: "mid-pf-2", text: "Вы тут?" })));
    expect(store.contacts.get("1")?.name).toBe("Айгерим Тест");
    const gets = net.calls.filter((c) => c.method === "GET");
    expect(gets).toHaveLength(1);
    expect(gets[0]?.url).toBe("https://graph.instagram.com/v23.0/6100000000000015?fields=name%2Cusername");
    expect(gets[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("профиль не отдали — клиент всё равно заведён, сообщение записано", async () => {
    const { store, post } = setup({ fetchProfile: true, reply: (c) => (c.method === "GET" ? json({ error: { message: "Unsupported get request", code: 100 } }, 400) : null) });
    const r = await post(webhook(fromClient("6100000000000016", { mid: "mid-pf-3", text: "Добрый вечер" })));
    expect(r.status).toBe(200);
    expect(store.contacts.get("1")?.name).toBe("Клиент");
    expect(store.messages).toHaveLength(1);
  });
});
