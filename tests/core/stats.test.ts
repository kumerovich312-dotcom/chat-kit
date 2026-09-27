import { describe, expect, it } from "vitest";
import type { AuthorType, Delivery, MessageKind } from "../../src/core/model.js";
import {
  countMessages, durationText, episodesFromRows, episodesOf, lastClientAt, responseStats, statsPeriod, type Episode, type EpisodeMessage,
} from "../../src/core/stats.js";
import { waitSince } from "../../src/core/waiting.js";

// Статистика ответов: обращения одного диалога, итоги за период, сообщения за период — без базы.

const T0 = Date.parse("2026-09-27T08:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

type Extra = {
  kind?: MessageKind; delivery?: Delivery; handoff?: boolean; shadow?: boolean; missed?: boolean; manager?: string;
  id?: string; name?: string; channel?: string;
};
const m = (sec: number, author: AuthorType, extra: Extra = {}): EpisodeMessage => ({
  at: at(sec),
  kind: extra.kind ?? "message",
  author: { type: author, ...(extra.id ? { id: extra.id } : {}), ...(extra.name ? { name: extra.name } : {}) },
  channel: extra.channel ?? "whatsapp",
  ...(extra.delivery ? { delivery: extra.delivery } : {}),
  ...(extra.handoff ? { handoff: true } : {}),
  ...(extra.shadow ? { shadow: true } : {}),
  ...(extra.missed !== undefined ? { call: { missed: extra.missed, ...(extra.manager ? { manager: extra.manager } : {}) } } : {}),
});

const ep = (start: number, reply: number | null, replier: Episode["replier"] = null, extra: Partial<Episode> = {}): Episode => ({
  contactId: "15", channel: "whatsapp", startedAt: at(start), repliedAt: reply === null ? null : at(reply), replier,
  byBot: replier?.type === "bot", dismissedAt: null, ...extra,
});

const aigerim = { type: "operator_crm" as const, id: "7", name: "Айгерим" };
const bot = { type: "bot" as const, id: null, name: null };

describe("episodesOf", () => {
  it("клиент написал, менеджер ответил через 2 минуты — одно обращение", () => {
    expect(episodesOf([m(0, "client"), m(120, "operator_crm", { id: "7", name: "Айгерим" })], 15)).toEqual([ep(0, 120, aigerim)]);
  });

  it("клиент дописал, пока ждёт, — то же обращение; после ответа написал снова — новое", () => {
    const list = [m(0, "client"), m(30, "client"), m(60, "bot"), m(100, "client"), m(200, "operator_crm", { id: "7", name: "Айгерим" })];
    expect(episodesOf(list, "15")).toEqual([ep(0, 60, bot), ep(100, 200, aigerim)]);
  });

  it("наши сообщения без клиента — не обращения", () => {
    expect(episodesOf([m(0, "operator_crm"), m(5, "bot")], 15)).toEqual([]);
    expect(episodesOf([], 15)).toEqual([]);
  });

  it("заметка, служебная строка, недоставленное и черновик — не ответ; отправляющееся — ответ", () => {
    const list = [
      m(0, "client"), m(10, "operator_crm", { kind: "note" }), m(20, "system", { kind: "system" }),
      m(30, "operator_crm", { delivery: "failed" }), m(40, "bot", { shadow: true }),
    ];
    expect(episodesOf(list, 15)).toEqual([ep(0, null)]);
    expect(episodesOf([...list, m(50, "operator_crm", { delivery: "pending" })], 15)).toEqual([ep(0, 50, { type: "operator_crm", id: null, name: null })]);
  });

  it("бот передал человеку, пока клиент ждёт, — обращение продолжается до ответа человека", () => {
    const list = [m(0, "client"), m(5, "bot", { handoff: true }), m(300, "operator_phone", { name: "Бакыт" })];
    expect(episodesOf(list, 15)).toEqual([ep(0, 300, { type: "operator_phone", id: null, name: "Бакыт" })]);
  });

  it("бот ответил, потом передал человеку — с передачи новое обращение (ждёт человека)", () => {
    const list = [
      m(0, "client"), m(5, "bot"), m(6, "bot", { handoff: true, channel: "telegram" }), m(10, "client"),
      m(100, "operator_crm", { id: "7", name: "Айгерим" }),
    ];
    expect(episodesOf(list, 15)).toEqual([ep(0, 5, bot), ep(6, 100, aigerim, { channel: "telegram" })]);
  });

  it("передача без ответа — клиент ждёт; бот сам ответил после передачи — ответ бота", () => {
    expect(episodesOf([m(0, "bot", { handoff: true })], 15)).toEqual([ep(0, null)]);
    expect(episodesOf([m(0, "client"), m(1, "bot", { handoff: true }), m(40, "bot")], 15)).toEqual([ep(0, 40, bot)]);
  });

  it("звонки: пропущенный входящий — начало; состоявшийся — ответ менеджера с телефона; пропущенный исходящий и звонок без сведений — ничего", () => {
    const list = [
      m(0, "client", { kind: "call", missed: true, channel: "call" }),
      m(10, "operator_phone", { kind: "call", missed: true, channel: "call" }),
      m(20, "operator_crm", { kind: "call", channel: "call" }),
      m(60, "client", { kind: "call", missed: false, manager: "Бакыт", channel: "call" }),
    ];
    expect(episodesOf(list, 15)).toEqual([ep(0, 60, { type: "operator_phone", id: null, name: "Бакыт" }, { channel: "call" })]);
    const out = [m(0, "client"), m(30, "operator_phone", { kind: "call", missed: false, name: "Чолпон", channel: "call" })];
    expect(episodesOf(out, 15)).toEqual([ep(0, 30, { type: "operator_phone", id: null, name: "Чолпон" })]);
  });

  it("«Ответ не нужен» закрывает обращение без ответа; клиент написал снова — новое", () => {
    const list = [m(0, "operator_crm"), m(10, "client")];
    expect(episodesOf(list, 15, { dismissedAt: at(30) })).toEqual([ep(10, null, null, { dismissedAt: at(30) })]);
    expect(episodesOf([...list, m(100, "client")], 15, { dismissedAt: at(30) })).toEqual([ep(10, null, null, { dismissedAt: at(30) }), ep(100, null)]);
    // Отметка в ту же секунду, что и сообщение клиента, снимает ожидание (как waitSince)
    expect(episodesOf([m(10, "client")], 15, { dismissedAt: new Date(T0 + 10_000) })).toEqual([ep(10, null, null, { dismissedAt: at(10) })]);
    // Отметка раньше сообщения — ничего не меняет
    expect(episodesOf([m(10, "client")], 15, { dismissedAt: at(5) })).toEqual([ep(10, null)]);
  });

  it("ответ в ту же секунду — ответ за 0 с, в каком бы порядке ни пришли записи", () => {
    expect(episodesOf([m(10, "client"), m(10, "bot")], 15)).toEqual([ep(10, 10, bot)]);
    expect(episodesOf([m(10, "bot"), m(10, "client")], 15)).toEqual([ep(10, 10, bot)]);
  });

  it("несколько ответов в одну секунду: человек раньше бота, дальше — по номеру сотрудника", () => {
    expect(episodesOf([m(0, "client"), m(9, "bot"), m(9, "operator_admin", { name: "Админ" })], 15)[0]?.replier)
      .toEqual({ type: "operator_admin", id: null, name: "Админ" });
    const two = [m(0, "client"), m(9, "operator_crm", { id: "7", name: "Айгерим" }), m(9, "operator_crm", { id: "12", name: "Бакыт" })];
    expect(episodesOf(two, 15)[0]?.replier).toEqual({ type: "operator_crm", id: "12", name: "Бакыт" });
    expect(episodesOf([...two].reverse(), 15)[0]?.replier).toEqual({ type: "operator_crm", id: "12", name: "Бакыт" });
  });

  it("канал обращения — где клиент начал ждать", () => {
    const list = [m(0, "client", { channel: "telegram" }), m(5, "client", { channel: "whatsapp" }), m(9, "bot")];
    expect(episodesOf(list, 15)[0]?.channel).toBe("telegram");
    expect(episodesOf([m(0, "client", { channel: "whatsapp" }), m(0, "client", { channel: "instagram" })], 15)[0]?.channel).toBe("instagram");
  });

  it("на случайных диалогах: последнее обращение ждёт ответа тогда и только тогда, когда waitSince не null", () => {
    let s = 20260927;
    const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32);
    const authors: AuthorType[] = ["client", "client", "client", "bot", "operator_crm", "operator_phone", "system"];
    const kinds: MessageKind[] = ["message", "message", "message", "note", "call"];
    const deliveries: (Delivery | undefined)[] = [undefined, "sent", "pending", "failed"];
    for (let n = 0; n < 500; n++) {
      const list: EpisodeMessage[] = [];
      let t = 0;
      const withHandoff = rand() < 0.5;
      for (let i = Math.floor(rand() * 10); i > 0; i--) {
        t += Math.floor(rand() * 3);
        const author = authors[Math.floor(rand() * authors.length)]!;
        const kind = author === "system" ? "system" : kinds[Math.floor(rand() * kinds.length)]!;
        const r = rand();
        const delivery = author === "client" ? undefined : deliveries[Math.floor(rand() * deliveries.length)];
        list.push(m(t, author, {
          kind, ...(delivery ? { delivery } : {}), handoff: withHandoff && author === "bot" && rand() < 0.4, shadow: author === "bot" && rand() < 0.1,
          ...(kind === "call" && r < 0.66 ? { missed: r < 0.33 } : {}),
        }));
      }
      const dismissed = rand() < 0.2 ? at(Math.floor(rand() * (t + 1))) : null;
      const eps = episodesOf(list, 1, { dismissedAt: dismissed });
      const last = eps[eps.length - 1];
      const open = !!last && last.repliedAt === null && last.dismissedAt === null;
      const since = waitSince(list, dismissed);
      expect(open, JSON.stringify({ list, dismissed })).toBe(since !== null);
      if (!withHandoff && open) expect(last.startedAt).toBe(new Date(since!).toISOString());
      // Обращения идут подряд и не пересекаются
      for (let i = 1; i < eps.length; i++) {
        const prevEnd = eps[i - 1]!.repliedAt ?? eps[i - 1]!.dismissedAt!;
        expect(Date.parse(eps[i]!.startedAt)).toBeGreaterThan(Date.parse(prevEnd));
      }
    }
  });
});

describe("lastClientAt", () => {
  it("последнее сообщение клиента или его пропущенный звонок; состоявшийся звонок — не «написал»", () => {
    const list = [
      m(0, "client"), m(50, "client", { kind: "call", missed: true }), m(60, "operator_crm"),
      m(70, "client", { kind: "call", missed: false }), m(80, "client", { kind: "note" }),
    ];
    expect(lastClientAt(list)).toBe(at(50));
    expect(lastClientAt([m(0, "bot")])).toBeNull();
  });
});

describe("responseStats", () => {
  const bakyt = { type: "operator_crm" as const, id: "12", name: "Бакыт" };
  const episodes: Episode[] = [
    ep(0, 60, aigerim, { contactId: "1" }), // человек, 1 мин
    ep(1000, 1300, bot, { contactId: "1" }), // бот, 5 мин
    ep(100, 1100, bakyt, { contactId: "2", channel: "telegram" }), // человек, 16 мин 40 с
    ep(2000, null, null, { contactId: "3", channel: "telegram" }), // ждёт 20 мин
    ep(500, null, null, { contactId: "4", dismissedAt: at(600) }), // «ответ не нужен»
    ep(3000, null, null, { contactId: "5" }), // ждёт 200 с — ещё может успеть за 5 минут
    ep(3100, 3500, aigerim, { contactId: "6" }), // ответ позже now — ещё не пришёл
    ep(-100, 50, aigerim, { contactId: "7" }), // начато до периода — не в счёт
    ep(3300, null, null, { contactId: "8" }), // начнётся после now — не в счёт
  ];
  const stats = responseStats(episodes, { from: at(0), to: at(4000), now: at(3200), targetsMin: [5, 15, 60] });

  it("итоги: обращения, с ответом, ждут сейчас, «ответ не нужен», диалоги", () => {
    expect(stats).toMatchObject({ from: at(0), to: at(4000), now: at(3200), episodes: 7, answered: 3, unanswered: 3, dismissed: 1, dialogs: 6, longestWaitSec: 1200 });
  });

  it("время первого ответа: медиана, среднее, 90 % (как percentile_cont)", () => {
    expect(stats).toMatchObject({ medianSec: 300, avgSec: 453, p90Sec: 860 });
  });

  it("доля быстрее цели: из ответов и тех, кто ждёт дольше цели", () => {
    expect(stats.within).toEqual([
      { min: 5, hit: 2, of: 4, share: 0.5 },
      { min: 15, hit: 2, of: 4, share: 0.5 },
      { min: 60, hit: 3, of: 3, share: 1 },
    ]);
  });

  it("люди и бот отдельно", () => {
    expect(stats.humans).toMatchObject({ answered: 2, medianSec: 530, avgSec: 530, p90Sec: 906 });
    expect(stats.humans.within.map((w) => [w.hit, w.of])).toEqual([[1, 2], [1, 2], [2, 2]]);
    expect(stats.bot).toMatchObject({ answered: 1, medianSec: 300, avgSec: 300, p90Sec: 300 });
    expect(stats.bot.within[0]).toEqual({ min: 5, hit: 1, of: 1, share: 1 });
  });

  it("по сотрудникам и по каналам", () => {
    expect(stats.byManager.map((x) => [x.id, x.name, x.answered, x.medianSec])).toEqual([["7", "Айгерим", 1, 60], ["12", "Бакыт", 1, 1000]]);
    expect(stats.byChannel.map((x) => [x.channel, x.episodes, x.answered, x.unanswered, x.dismissed, x.longestWaitSec])).toEqual([
      ["whatsapp", 5, 2, 2, 1, 200],
      ["telegram", 2, 1, 1, 0, 1200],
    ]);
    expect(stats.byChannel[1]?.within[0]).toEqual({ min: 5, hit: 0, of: 2, share: 0 });
  });

  it("сотрудник с одним номером и новым именем — одна строка с последним именем; без номера — по имени", () => {
    const s = responseStats([
      ep(0, 10, { type: "operator_crm", id: "7", name: "Айгерим" }),
      ep(100, 130, { type: "operator_crm", id: "7", name: "Айгерим С." }),
      ep(200, 220, { type: "operator_phone", id: null, name: "Бакыт" }),
      ep(300, 330, { type: "operator_phone", id: null, name: "бакыт " }),
      ep(400, 401, { type: "operator_phone", id: null, name: null }),
    ], { from: at(0), to: at(1000), now: at(1000) });
    expect(s.byManager.map((x) => [x.id, x.name, x.type, x.answered])).toEqual([
      ["7", "Айгерим С.", "operator_crm", 2],
      [null, "бакыт ", "operator_phone", 2],
      [null, null, "operator_phone", 1],
    ]);
    expect(s.within.map((w) => w.min)).toEqual([5, 15, 60]);
  });

  it("пустой период — нули и пустые значения", () => {
    const s = responseStats([], { from: at(0), to: at(10), now: at(10), targetsMin: [5] });
    expect(s).toMatchObject({ episodes: 0, answered: 0, unanswered: 0, dialogs: 0, medianSec: null, avgSec: null, p90Sec: null, longestWaitSec: null });
    expect(s.within).toEqual([{ min: 5, hit: 0, of: 0, share: null }]);
    expect(s.byManager).toEqual([]);
    expect(s.byChannel).toEqual([]);
  });
});

describe("episodesFromRows", () => {
  it("строки базы → обращения", () => {
    const rows = [
      { contact_id: 15, channel: "whatsapp", started_at: new Date(T0), replied_at: new Date(T0 + 60_000), dismissed_at: null, replier_type: "operator_crm", replier_id: "7", replier_name: "Айгерим", by_bot: false },
      { contact_id: 16, channel: null, started_at: at(5), replied_at: null, dismissed_at: new Date(T0 + 9000), replier_type: null, replier_id: null, replier_name: null, by_bot: false },
      { contact_id: 17n, channel: "telegram", started_at: at(7), replied_at: at(8), dismissed_at: null, replier_type: "bot", replier_id: null, replier_name: null, by_bot: true },
    ];
    expect(episodesFromRows(rows)).toEqual([
      ep(0, 60, aigerim),
      ep(5, null, null, { contactId: "16", channel: null, dismissedAt: at(9) }),
      ep(7, 8, bot, { contactId: "17", channel: "telegram" }),
    ]);
  });
});

describe("countMessages", () => {
  it("сообщения клиентов и наши за период: без заметок, служебных, черновиков, недоставленных и звонков", () => {
    const list = [
      { ...m(0, "client"), contactId: 1 },
      { ...m(5, "client"), contactId: 1 },
      { ...m(6, "client"), contactId: 2 },
      { ...m(7, "bot"), contactId: 1 },
      { ...m(8, "bot", { handoff: true }), contactId: 1 },
      { ...m(9, "operator_crm", { delivery: "pending" }), contactId: 2 },
      { ...m(10, "operator_phone"), contactId: 2 },
      { ...m(11, "operator_crm", { delivery: "failed" }), contactId: 2 },
      { ...m(12, "bot", { shadow: true }), contactId: 2 },
      { ...m(13, "operator_crm", { kind: "note" }), contactId: 2 },
      { ...m(14, "system", { kind: "system" }), contactId: 2 },
      { ...m(15, "client", { kind: "call", missed: true }), contactId: 3 },
      { ...m(100, "client"), contactId: 4 }, // после периода
    ];
    expect(countMessages(list, { from: at(0), to: at(100) })).toEqual({ dialogs: 2, incoming: 3, outgoing: 4, byBot: 2, byHumans: 2 });
    expect(countMessages(list, { from: at(1), to: at(6) })).toEqual({ dialogs: 1, incoming: 1, outgoing: 0, byBot: 0, byHumans: 0 });
  });
});

describe("statsPeriod", () => {
  const TZ = "Asia/Bishkek";
  const now = "2026-09-30T04:15:00Z"; // среда, 10:15 по Бишкеку

  it("от полуночи по поясу компании, конец — не включая", () => {
    expect(statsPeriod("today", now, TZ)).toEqual({ from: "2026-09-29T18:00:00.000Z", to: "2026-09-30T18:00:00.000Z", label: "Сегодня" });
    expect(statsPeriod("yesterday", now, TZ)).toEqual({ from: "2026-09-28T18:00:00.000Z", to: "2026-09-29T18:00:00.000Z", label: "Вчера" });
    expect(statsPeriod("days7", now, TZ)).toEqual({ from: "2026-09-23T18:00:00.000Z", to: "2026-09-30T18:00:00.000Z", label: "7 дней" });
    expect(statsPeriod("days30", now, TZ)).toEqual({ from: "2026-08-31T18:00:00.000Z", to: "2026-09-30T18:00:00.000Z", label: "30 дней" });
    expect(statsPeriod("week", now, TZ)).toEqual({ from: "2026-09-27T18:00:00.000Z", to: "2026-10-04T18:00:00.000Z", label: "Эта неделя" });
    expect(statsPeriod("month", now, TZ)).toEqual({ from: "2026-08-31T18:00:00.000Z", to: "2026-09-30T18:00:00.000Z", label: "Этот месяц" });
  });

  it("воскресенье — ещё эта неделя; неделя с переходом на зимнее время; декабрь → январь", () => {
    expect(statsPeriod("week", "2026-09-27T06:00:00Z", TZ)).toMatchObject({ from: "2026-09-20T18:00:00.000Z", to: "2026-09-27T18:00:00.000Z" });
    expect(statsPeriod("week", "2026-10-23T10:00:00Z", "Europe/Berlin")).toMatchObject({ from: "2026-10-18T22:00:00.000Z", to: "2026-10-25T23:00:00.000Z" });
    expect(statsPeriod("month", "2026-12-15T10:00:00Z", TZ)).toMatchObject({ from: "2026-11-30T18:00:00.000Z", to: "2026-12-31T18:00:00.000Z" });
  });
});

describe("durationText", () => {
  it("секунды, минуты, часы, дни", () => {
    expect(durationText(0)).toBe("0 с");
    expect(durationText(45)).toBe("45 с");
    expect(durationText(59.6)).toBe("1 мин");
    expect(durationText(120)).toBe("2 мин");
    expect(durationText(125)).toBe("2 мин 5 с");
    expect(durationText(3600)).toBe("1 ч");
    expect(durationText(4200)).toBe("1 ч 10 мин");
    expect(durationText(4230)).toBe("1 ч 10 мин");
    expect(durationText(90_000)).toBe("1 дн 1 ч");
    expect(durationText(172_800)).toBe("2 дн");
    expect(durationText(-5)).toBe("0 с");
    expect(durationText(null)).toBe("—");
    expect(durationText(Number.NaN)).toBe("—");
  });
});
