import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DialogStatus, Presence } from "../../src/core/conversation.js";
import {
  activePresence, companyTime, effectiveStatus, effectiveStatusSql, normalizeTagCodes, pickAssignee, presenceText, snoozeChoices, sortTags,
  tagOf, untilLabel, type AssignCandidate, type TagDef,
} from "../../src/core/team.js";
import { createPresenceHub } from "../../src/server/presence.js";

// Команда: статус и «отложить до», раздача новых диалогов, метки, «коллега уже отвечает».

const T0 = Date.parse("2026-09-27T08:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

/** Простой повторяемый генератор случайных чисел — один и тот же набор случаев при каждом запуске */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("effectiveStatus", () => {
  it("открытый и без статуса — открыт", () => {
    expect(effectiveStatus({}, { now: at(0) })).toBe("open");
    expect(effectiveStatus({ status: "open", statusAt: at(0) }, { now: at(9), lastClientAt: at(5) })).toBe("open");
    expect(effectiveStatus({ status: null }, { now: at(0) })).toBe("open");
  });

  it("отложенный: ждёт своего времени; пришло время — открыт (ровно в срок — тоже)", () => {
    const s = { status: "snoozed" as const, statusAt: at(0), snoozedUntil: at(100) };
    expect(effectiveStatus(s, { now: at(99) })).toBe("snoozed");
    expect(effectiveStatus(s, { now: at(100) })).toBe("open");
    expect(effectiveStatus(s, { now: at(500) })).toBe("open");
  });

  it("отложенный: клиент написал после того, как отложили, — открыт; раньше или в ту же секунду — нет", () => {
    const s = { status: "snoozed" as const, statusAt: at(10), snoozedUntil: at(100) };
    expect(effectiveStatus(s, { now: at(20), lastClientAt: at(11) })).toBe("open");
    expect(effectiveStatus(s, { now: at(20), lastClientAt: at(10) })).toBe("snoozed");
    expect(effectiveStatus(s, { now: at(20), lastClientAt: at(5) })).toBe("snoozed");
  });

  it("отложенный без срока — пока клиент не напишет", () => {
    const s = { status: "snoozed" as const, statusAt: at(10) };
    expect(effectiveStatus(s, { now: at(999_999) })).toBe("snoozed");
    expect(effectiveStatus(s, { now: at(20), lastClientAt: at(15) })).toBe("open");
  });

  it("закрытый: открывается сообщением клиента после закрытия, не временем", () => {
    const s = { status: "closed" as const, statusAt: at(10), snoozedUntil: at(0) };
    expect(effectiveStatus(s, { now: at(999_999), lastClientAt: at(9) })).toBe("closed");
    expect(effectiveStatus(s, { now: at(20), lastClientAt: at(10.001) })).toBe("open");
  });

  it("время статуса не известно — по сообщениям клиента не открываем", () => {
    expect(effectiveStatus({ status: "closed" }, { now: at(20), lastClientAt: at(15) })).toBe("closed");
    expect(effectiveStatus({ status: "snoozed", snoozedUntil: at(100) }, { now: at(20), lastClientAt: at(15) })).toBe("snoozed");
  });

  it("принимает Date и числа", () => {
    const s = { status: "snoozed" as const, statusAt: new Date(T0), snoozedUntil: T0 + 5000 };
    expect(effectiveStatus(s, { now: new Date(T0 + 5000) })).toBe("open");
  });
});

describe("effectiveStatusSql (Postgres)", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`CREATE TABLE dialogs (
      id int PRIMARY KEY, status text, status_at timestamptz, snoozed_until timestamptz, last_client_at timestamptz, now_at timestamptz NOT NULL
    );`);
  });
  afterAll(async () => {
    await db.close();
  });

  it("совпадает с effectiveStatus на 500 случайных диалогах (в том числе равные времена и пустые значения)", async () => {
    const rand = rng(7091);
    const time = () => (rand() < 0.2 ? null : at(Math.floor(rand() * 5)));
    const statuses: (DialogStatus | null)[] = [null, "open", "snoozed", "closed", "snoozed", "closed"];
    const expected = new Map<number, DialogStatus>();
    const params: unknown[] = [];
    const values: string[] = [];
    for (let id = 1; id <= 500; id++) {
      const status = statuses[Math.floor(rand() * statuses.length)]!;
      const statusAt = time();
      const snoozedUntil = time();
      const lastClientAt = time();
      const now = at(Math.floor(rand() * 5));
      expected.set(id, effectiveStatus({ status, statusAt, snoozedUntil }, { now, lastClientAt }));
      const row = [id, status, statusAt, snoozedUntil, lastClientAt, now];
      values.push(`(${row.map((v) => (params.push(v), `$${params.length}`)).join(", ")})`);
    }
    await db.query(`INSERT INTO dialogs (id, status, status_at, snoozed_until, last_client_at, now_at) VALUES ${values.join(", ")}`, params);
    const sql = effectiveStatusSql({ status: "d.status", statusAt: "d.status_at", snoozedUntil: "d.snoozed_until", lastClientAt: "d.last_client_at", now: "d.now_at" });
    const res = await db.query<{ id: number; s: string }>(`SELECT d.id, ${sql} AS s FROM dialogs d ORDER BY d.id`);
    const diff = res.rows.filter((r) => r.s !== expected.get(r.id)).slice(0, 5);
    expect(diff).toEqual([]);
    expect(res.rows).toHaveLength(500);
    // Все три исхода встретились
    expect(new Set(res.rows.map((r) => r.s))).toEqual(new Set(["open", "snoozed", "closed"]));
  });

  it("фильтр «Отложенные» и «сейчас» по умолчанию — now()", async () => {
    await db.exec(`CREATE TABLE d2 (id int, status text, status_at timestamptz, snoozed_until timestamptz, last_client_at timestamptz);
      INSERT INTO d2 VALUES (1, 'snoozed', now() - interval '1 hour', now() + interval '1 hour', NULL),
                            (2, 'snoozed', now() - interval '2 hour', now() - interval '1 hour', NULL),
                            (3, 'snoozed', now() - interval '1 hour', now() + interval '1 hour', now());`);
    const sql = effectiveStatusSql({ status: "d.status", statusAt: "d.status_at", snoozedUntil: "d.snoozed_until", lastClientAt: "d.last_client_at" });
    const res = await db.query<{ id: number }>(`SELECT d.id FROM d2 d WHERE ${sql} = 'snoozed'`);
    expect(res.rows.map((r) => r.id)).toEqual([1]);
  });
});

describe("snoozeChoices и untilLabel", () => {
  const TZ = "Asia/Bishkek"; // UTC+6, без перехода на летнее время

  it("среда 10:15 — все варианты с точным временем по поясу компании", () => {
    const list = snoozeChoices("2026-09-30T04:15:00Z", TZ);
    expect(list).toEqual([
      { key: "1h", label: "На 1 час", until: "2026-09-30T05:15:00.000Z", hint: "до 11:15" },
      { key: "3h", label: "На 3 часа", until: "2026-09-30T07:15:00.000Z", hint: "до 13:15" },
      { key: "evening", label: "До вечера (18:00)", until: "2026-09-30T12:00:00.000Z", hint: "до 18:00" },
      { key: "tomorrow", label: "Завтра утром (9:00)", until: "2026-10-01T03:00:00.000Z", hint: "до завтра 9:00" },
      { key: "monday", label: "В понедельник (9:00)", until: "2026-10-05T03:00:00.000Z", hint: "до 5 окт 9:00" },
      { key: "week", label: "Через неделю", until: "2026-10-07T04:15:00.000Z", hint: "до 7 окт 10:15" },
    ]);
  });

  it("после 18:00 «До вечера» нет; поздно вечером «на 3 часа» — уже завтра", () => {
    const list = snoozeChoices("2026-09-30T12:00:00Z", TZ); // ровно 18:00
    expect(list.map((c) => c.key)).toEqual(["1h", "3h", "tomorrow", "monday", "week"]);
    const late = snoozeChoices("2026-09-30T17:30:00Z", TZ); // 23:30
    expect(late.find((c) => c.key === "3h")?.hint).toBe("до завтра 2:30");
  });

  it("день — по календарю компании, а не UTC: в 00:30 по Бишкеку «завтра» — следующий день", () => {
    const list = snoozeChoices("2026-09-30T18:30:00Z", TZ); // 1 октября, 00:30, четверг
    expect(list.find((c) => c.key === "evening")?.until).toBe("2026-10-01T12:00:00.000Z");
    expect(list.find((c) => c.key === "tomorrow")?.until).toBe("2026-10-02T03:00:00.000Z");
    expect(list.find((c) => c.key === "monday")?.until).toBe("2026-10-05T03:00:00.000Z");
  });

  it("в воскресенье «В понедельник» не показываем (это «завтра утром»), в понедельник — следующий понедельник", () => {
    expect(snoozeChoices("2026-09-27T06:00:00Z", TZ).map((c) => c.key)).toEqual(["1h", "3h", "evening", "tomorrow", "week"]);
    const monday = snoozeChoices("2026-09-28T03:00:00Z", TZ).find((c) => c.key === "monday");
    expect(monday?.until).toBe("2026-10-05T03:00:00.000Z");
    const saturday = snoozeChoices("2026-10-03T08:00:00Z", TZ).find((c) => c.key === "monday");
    expect(saturday?.until).toBe("2026-10-05T03:00:00.000Z");
  });

  it("переход на зимнее время учтён (Европа, 25 октября 2026)", () => {
    const list = snoozeChoices("2026-10-23T10:00:00Z", "Europe/Berlin"); // пятница 12:00 летнего времени
    expect(list.find((c) => c.key === "evening")?.until).toBe("2026-10-23T16:00:00.000Z");
    expect(list.find((c) => c.key === "tomorrow")?.until).toBe("2026-10-24T07:00:00.000Z");
    expect(list.find((c) => c.key === "monday")?.until).toBe("2026-10-26T08:00:00.000Z");
    // Через неделю — в те же 12:00 по часам, уже зимнего времени
    expect(list.find((c) => c.key === "week")?.until).toBe("2026-10-30T11:00:00.000Z");
  });

  it("свои часы утра и вечера; неверное время — пусто", () => {
    const list = snoozeChoices("2026-09-30T04:15:00Z", TZ, { morningHour: 8, eveningHour: 19 });
    expect(list.find((c) => c.key === "evening")).toMatchObject({ label: "До вечера (19:00)", until: "2026-09-30T13:00:00.000Z" });
    expect(list.find((c) => c.key === "tomorrow")).toMatchObject({ label: "Завтра утром (8:00)", until: "2026-10-01T02:00:00.000Z" });
    expect(snoozeChoices("не время", TZ)).toEqual([]);
  });

  it("companyTime: время по часам компании → точное время; день и месяц могут выходить за край", () => {
    expect(companyTime({ year: 2026, month: 10, day: 12, hour: 15 }, TZ)).toBe("2026-10-12T09:00:00.000Z");
    expect(companyTime({ year: 2026, month: 13, day: 0 }, TZ)).toBe("2026-12-30T18:00:00.000Z");
    expect(companyTime({ year: 2026, month: 10, day: 23, hour: 12 }, "Europe/Berlin")).toBe("2026-10-23T10:00:00.000Z");
    expect(companyTime({ year: 2026, month: 10, day: 26, hour: 9 }, "Europe/Berlin")).toBe("2026-10-26T08:00:00.000Z");
    expect(companyTime({ year: 2026, month: 9, day: 30, hour: 23, minute: 59, second: 59 }, "UTC")).toBe("2026-09-30T23:59:59.000Z");
  });

  it("untilLabel: сегодня, завтра, другой день, другой год", () => {
    const now = "2026-09-30T04:15:00Z";
    expect(untilLabel("2026-09-30T12:00:00Z", now, TZ)).toBe("до 18:00");
    expect(untilLabel("2026-10-01T03:00:00Z", now, TZ)).toBe("до завтра 9:00");
    expect(untilLabel("2026-10-03T03:05:00Z", now, TZ)).toBe("до 3 окт 9:05");
    expect(untilLabel("2027-01-03T03:00:00Z", now, TZ)).toBe("до 3 янв 2027 9:00");
    expect(untilLabel("2026-09-30T18:00:00Z", now, TZ)).toBe("до завтра 0:00");
    expect(untilLabel("не время", now, TZ)).toBe("");
  });
});

describe("pickAssignee", () => {
  const team = (extra: Partial<Record<string, Partial<AssignCandidate>>> = {}): AssignCandidate[] =>
    [{ id: "a", name: "Айгерим" }, { id: "b", name: "Бакыт" }, { id: "c", name: "Чолпон" }].map((c) => ({ ...c, ...extra[c.id] }));

  it("никого — null", () => {
    expect(pickAssignee({ candidates: [] })).toBeNull();
    expect(pickAssignee({ candidates: [], lastId: "a", strategy: "least" })).toBeNull();
  });

  it("по очереди: следующий после прошлого, по кругу; прошлого нет в списке — с начала", () => {
    expect(pickAssignee({ candidates: team() })?.id).toBe("a");
    expect(pickAssignee({ candidates: team(), lastId: "a" })?.id).toBe("b");
    expect(pickAssignee({ candidates: team(), lastId: "b" })?.id).toBe("c");
    expect(pickAssignee({ candidates: team(), lastId: "c" })?.id).toBe("a");
    expect(pickAssignee({ candidates: team(), lastId: "уволен" })?.id).toBe("a");
    expect(pickAssignee({ candidates: team(), lastId: null })?.id).toBe("a");
  });

  it("очередь на шести новых диалогах: a, b, c, a, b, c", () => {
    let last: string | null = null;
    const got: string[] = [];
    for (let i = 0; i < 6; i++) {
      last = pickAssignee({ candidates: team(), lastId: last })!.id;
      got.push(last);
    }
    expect(got).toEqual(["a", "b", "c", "a", "b", "c"]);
  });

  it("пропускает не на смене, занятых до предела и тех, кто не ведёт канал", () => {
    expect(pickAssignee({ candidates: team({ b: { active: false } }), lastId: "a" })?.id).toBe("c");
    expect(pickAssignee({ candidates: team({ b: { active: null } }), lastId: "a" })?.id).toBe("b");
    expect(pickAssignee({ candidates: team({ b: { load: 3, max: 3 } }), lastId: "a" })?.id).toBe("c");
    expect(pickAssignee({ candidates: team({ b: { load: 2, max: 3 } }), lastId: "a" })?.id).toBe("b");
    expect(pickAssignee({ candidates: team({ b: { load: 50, max: null } }), lastId: "a" })?.id).toBe("b");
    expect(pickAssignee({ candidates: team({ b: { max: 0 } }), lastId: "a" })?.id).toBe("c");
    const byChannel = team({ a: { channels: ["whatsapp"] }, b: { channels: [] }, c: { channels: [" Telegram "] } });
    expect(pickAssignee({ candidates: byChannel, channel: "telegram" })?.id).toBe("b");
    expect(pickAssignee({ candidates: byChannel, channel: "telegram", lastId: "b" })?.id).toBe("c");
    expect(pickAssignee({ candidates: byChannel, channel: "whatsapp", lastId: "a" })?.id).toBe("b");
    expect(pickAssignee({ candidates: byChannel, lastId: "b" })?.id).toBe("c");
  });

  it("все заняты — null; свободен только прошлый — снова он", () => {
    expect(pickAssignee({ candidates: team({ a: { active: false }, b: { load: 1, max: 1 }, c: { channels: ["email"] } }), channel: "whatsapp" })).toBeNull();
    expect(pickAssignee({ candidates: team({ a: { active: false }, c: { active: false } }), lastId: "b" })?.id).toBe("b");
  });

  it("least: у кого меньше диалогов; при равенстве — чья очередь ближе после прошлого", () => {
    const loads = team({ a: { load: 2 }, b: { load: 1 }, c: { load: 1 } });
    expect(pickAssignee({ candidates: loads, strategy: "least" })?.id).toBe("b");
    expect(pickAssignee({ candidates: loads, strategy: "least", lastId: "b" })?.id).toBe("c");
    expect(pickAssignee({ candidates: team({ a: { load: 2 }, b: { load: 1, max: 1 }, c: { load: 1 } }), strategy: "least" })?.id).toBe("c");
    expect(pickAssignee({ candidates: team(), strategy: "least", lastId: "a" })?.id).toBe("b");
    expect(pickAssignee({ candidates: team({ a: { active: false }, b: { active: false }, c: { active: false } }), strategy: "least" })).toBeNull();
  });

  it("возвращает сотрудника со всеми его полями", () => {
    const list = [{ id: "7", name: "Айгерим", phone: "+996 555 00-00-01" }];
    expect(pickAssignee({ candidates: list })?.phone).toBe("+996 555 00-00-01");
  });
});

describe("метки", () => {
  const defs: TagDef[] = [{ code: "vip", label: "VIP", color: "#7c3aed" }, { code: "new", label: "Новый" }, { code: "Debt", label: "Долг" }];

  it("normalizeTagCodes: без пробелов, строчными, без повторов и пустых, порядок сохраняется", () => {
    expect(normalizeTagCodes([" VIP", "vip", "", null, undefined, "Новый ", "новый", "debt"])).toEqual(["vip", "новый", "debt"]);
    expect(normalizeTagCodes(null)).toEqual([]);
    expect(normalizeTagCodes(new Set(["a", "A"]))).toEqual(["a"]);
  });

  it("tagOf: по коду без учёта регистра; нет в паспорте — null", () => {
    expect(tagOf(" VIP ", defs)).toBe(defs[0]);
    expect(tagOf("debt", defs)?.label).toBe("Долг");
    expect(tagOf("удалена", defs)).toBeNull();
    expect(tagOf("", defs)).toBeNull();
  });

  it("tagOf и sortTags принимают метки паспорта с tone", () => {
    const profileTags: { code: string; label: string; tone?: "violet" | "red" | undefined }[] = [{ code: "urgent", label: "Срочно", tone: "red" }];
    expect(tagOf("URGENT", profileTags)?.tone).toBe("red");
    expect(sortTags(["x", "urgent"], profileTags)).toEqual(["urgent", "x"]);
  });

  it("sortTags: порядок паспорта, неизвестные — в конце по алфавиту (русские буквы раньше латинских)", () => {
    expect(sortTags(["zeta", "debt", "VIP", "альфа", "alpha", "vip", "new"], defs)).toEqual(["vip", "new", "debt", "альфа", "alpha", "zeta"]);
  });
});

describe("«коллега уже отвечает»", () => {
  const p = (userId: string, name: string, state: Presence["state"], sec: number): Presence => ({ userId, name, state, at: at(sec) });

  it("activePresence: без себя и без устаревших, по одному на человека, пишущие первыми", () => {
    const list = [
      p("me", "Я", "typing", 100),
      p("2", "Бакыт", "viewing", 95),
      p("3", "Айгерим", "viewing", 30), // 70 с назад — ушла
      p("4", "Чолпон", "typing", 98),
      p("2", "Бакыт", "typing", 99), // последняя отметка Бакыта — пишет
      p("5", "Азамат", "viewing", 99),
    ];
    expect(activePresence(list, { now: at(100), meId: "me" })).toEqual([
      p("2", "Бакыт", "typing", 99),
      p("4", "Чолпон", "typing", 98),
      p("5", "Азамат", "viewing", 99),
    ]);
  });

  it("«пишет» без новых отметок дольше 10 с — уже «смотрит»; свои сроки", () => {
    expect(activePresence([p("2", "Бакыт", "typing", 80)], { now: at(100) })).toEqual([p("2", "Бакыт", "viewing", 80)]);
    expect(activePresence([p("2", "Бакыт", "typing", 80)], { now: at(100), typingTtlMs: 30_000 })[0]?.state).toBe("typing");
    expect(activePresence([p("2", "Бакыт", "viewing", 80)], { now: at(100), ttlMs: 10_000 })).toEqual([]);
    expect(activePresence([{ ...p("2", "Бакыт", "viewing", 80), at: "вчера" }], { now: at(100) })).toEqual([]);
  });

  it("presenceText: кто пишет — важнее тех, кто смотрит", () => {
    expect(presenceText([])).toBeNull();
    expect(presenceText([p("1", "Айгерим", "typing", 0)])).toBe("Айгерим пишет ответ…");
    expect(presenceText([p("1", "Айгерим", "typing", 0), p("2", "Бакыт", "typing", 0), p("3", "Чолпон", "viewing", 0)])).toBe("Айгерим и Бакыт пишут ответ…");
    expect(presenceText([p("1", "Айгерим", "viewing", 0)])).toBe("Айгерим смотрит этот диалог");
    expect(presenceText([p("1", "Айгерим", "viewing", 0), p("2", "Бакыт", "viewing", 0)])).toBe("Айгерим и Бакыт смотрят этот диалог");
    expect(presenceText([p("1", "Айгерим", "viewing", 0), p("2", "Бакыт", "viewing", 0), p("3", "Чолпон", "viewing", 0)]))
      .toBe("Айгерим, Бакыт и Чолпон смотрят этот диалог");
    expect(presenceText(["Айгерим", "Бакыт", "Чолпон", "Азамат"].map((n, i) => p(String(i), n, "typing", 0)))).toBe("Айгерим, Бакыт и ещё 2 пишут ответ…");
    expect(presenceText([p("1", " ", "viewing", 0)])).toBe("Коллега смотрит этот диалог");
  });
});

describe("createPresenceHub", () => {
  it("отметки, «пишет» → «смотрит» → ушёл, выход, снимок всех диалогов", () => {
    let now = T0;
    const hub = createPresenceHub({ now: () => now });
    expect(hub.touch("15", { userId: "2", name: "Бакыт", state: "typing" })).toEqual([{ userId: "2", name: "Бакыт", state: "typing", at: at(0) }]);
    now += 1000;
    const list = hub.touch("15", { userId: "3", name: "Айгерим", state: "viewing" });
    expect(list.map((x) => `${x.name}:${x.state}`)).toEqual(["Бакыт:typing", "Айгерим:viewing"]);
    expect(presenceText(activePresence(list, { now, meId: "3" }))).toBe("Бакыт пишет ответ…");
    hub.touch("20", { userId: "3", name: "Айгерим", state: "viewing" });
    expect(Object.keys(hub.snapshot()).sort()).toEqual(["15", "20"]);

    now = T0 + 11_000; // Бакыт перестал печатать
    expect(hub.list("15").map((x) => `${x.name}:${x.state}`)).toEqual(["Айгерим:viewing", "Бакыт:viewing"]);
    now = T0 + 61_000; // отметка Бакыта устарела, Айгерим отмечалась позже
    expect(hub.list("15").map((x) => x.name)).toEqual(["Айгерим"]);
    expect(hub.leave("15", "3")).toEqual([]);
    expect(hub.snapshot()).toEqual({ "20": [{ userId: "3", name: "Айгерим", state: "viewing", at: at(1) }] });
    now = T0 + 200_000;
    expect(hub.snapshot()).toEqual({});
  });

  it("время ставит сервер; пустой сотрудник не записывается; странное состояние — «смотрит»; «__proto__» не ломает снимок", () => {
    const hub = createPresenceHub({ now: () => T0 });
    const bad = { userId: "7", name: "Азамат", state: "hacking" } as unknown as Omit<Presence, "at">;
    expect(hub.touch("1", bad)).toEqual([{ userId: "7", name: "Азамат", state: "viewing", at: at(0) }]);
    expect(hub.touch("1", { userId: " ", name: "Никто", state: "typing" })).toHaveLength(1);
    hub.touch("__proto__", { userId: "7", name: "Азамат", state: "viewing" });
    const snap = hub.snapshot();
    expect(Object.keys(snap).sort()).toEqual(["1", "__proto__"]);
    expect(Object.getPrototypeOf(snap)).toBe(Object.prototype);
    expect(hub.list("нет такого")).toEqual([]);
  });
});
