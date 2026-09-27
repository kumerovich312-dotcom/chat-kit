import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthorType, Delivery, MessageKind } from "../../src/core/model.js";
import {
  countMessages, episodesFromRows, episodesOf, lastClientAt, lastClientAtSql, messageCountsSql, responseEpisodesSql, responseStats,
  type Episode, type EpisodeMessage, type EpisodeRow, type EpisodesSqlOptions, type MessageCounts,
} from "../../src/core/stats.js";

// SQL-двойники статистики на настоящем Postgres (PGlite — Postgres в памяти). Для сотен случайных диалогов запрос
// responseEpisodesSql даёт те же обращения, что episodesOf, на разных периодах; messageCountsSql — те же числа, что
// countMessages; lastClientAtSql — то же время, что lastClientAt. В данных есть одинаковые времена, недоставленные,
// заметки, черновики, звонки (пропущенные, состоявшиеся, без сведений), передачи человеку, «ответ не нужен»
// и чужая компания с теми же номерами клиентов.

let db: PGlite;

const T0 = Date.parse("2026-09-27T08:00:00Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();

const CLIENT = "x.kind = 'message' AND x.author = 'client' OR x.kind = 'call' AND x.author = 'client' AND x.call_missed";
const REPLY = "x.kind = 'message' AND x.author NOT IN ('client', 'system') AND x.delivery IS DISTINCT FROM 'failed' AND NOT x.handoff AND NOT x.shadow"
  + " OR x.kind = 'call' AND x.author <> 'system' AND NOT x.call_missed";
const HANDOFF = "x.kind = 'message' AND x.author NOT IN ('client', 'system') AND x.handoff AND x.delivery IS DISTINCT FROM 'failed' AND NOT x.shadow";
// Состоявшийся входящий звонок записан от клиента — в статистике это ответ менеджера с телефона (как в episodesOf)
const ANSWERED_IN = "x.kind = 'call' AND x.author = 'client' AND NOT x.call_missed";

const BASE: EpisodesSqlOptions = {
  table: "messages", contactColumn: "contact_id", timeColumn: "created_at", scope: "x.org_id = $1", from: "$2", to: "$3",
  clientMessage: CLIENT, reply: REPLY, handoff: HANDOFF, channel: "x.channel",
  authorType: `CASE WHEN ${ANSWERED_IN} THEN 'operator_phone' ELSE x.author END`,
  authorId: `CASE WHEN ${ANSWERED_IN} THEN NULL ELSE x.author_id END`,
  authorName: `CASE WHEN ${ANSWERED_IN} THEN x.call_manager ELSE x.author_name END`,
};
const SQL = responseEpisodesSql({ ...BASE, dismissedAt: (id) => `(SELECT c.dismissed_at FROM contacts c WHERE c.id = ${id})` });
const SQL_PLAIN = responseEpisodesSql(BASE);
const SQL_NO_HANDOFF = responseEpisodesSql({ ...BASE, handoff: undefined });

const COUNTS = messageCountsSql({
  table: "messages", contactColumn: "contact_id", timeColumn: "created_at", scope: "x.org_id = $1", from: "$2", to: "$3",
  incoming: "x.kind = 'message' AND x.author = 'client'",
  outgoing: "x.kind = 'message' AND x.author NOT IN ('client', 'system') AND x.delivery IS DISTINCT FROM 'failed' AND NOT x.shadow",
  authorType: "x.author",
});

type Row = {
  org: number; contact: number; t: number; kind: MessageKind; author: AuthorType; authorId: string | null; authorName: string | null;
  channel: string | null; delivery: Delivery | null; handoff: boolean; shadow: boolean; missed: boolean | null; manager: string | null;
};

/** Простой повторяемый генератор случайных чисел — один и тот же набор случаев при каждом запуске */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const rand = rng(20260928);
const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;

const CONTACTS = 300;
const rows: Row[] = [];
const threads = new Map<number, (EpisodeMessage & { contactId: number })[]>();
const dismissed = new Map<number, string | null>();
let tMax = 0;

const toMessage = (r: Row): EpisodeMessage & { contactId: number } => ({
  at: at(r.t), kind: r.kind,
  author: { type: r.author, ...(r.authorId !== null ? { id: r.authorId } : {}), ...(r.authorName !== null ? { name: r.authorName } : {}) },
  channel: r.channel,
  ...(r.delivery ? { delivery: r.delivery } : {}),
  handoff: r.handoff, shadow: r.shadow,
  ...(r.kind === "call" && r.missed !== null ? { call: { missed: r.missed, ...(r.manager !== null ? { manager: r.manager } : {}) } } : {}),
  contactId: r.contact,
});

function generate() {
  const authors: AuthorType[] = ["client", "client", "client", "bot", "bot", "operator_crm", "operator_crm", "operator_phone", "operator_admin", "system"];
  const kinds: MessageKind[] = ["message", "message", "message", "message", "note", "system", "call"];
  const deliveries: (Delivery | null)[] = [null, null, "sent", "pending", "failed", "read"];
  const steps = [0, 0, 1000, 1000, 2000, 60_000];
  for (let id = 1; id <= CONTACTS; id++) {
    const list: Row[] = [];
    let t = 0;
    for (let i = Math.floor(rand() * 14); i > 0; i--) {
      t += pick(steps);
      const author = pick(authors);
      const kind: MessageKind = author === "system" ? "system" : pick(kinds);
      const r = rand();
      list.push({
        org: 1, contact: id, t, kind, author,
        authorId: author === "client" ? null : pick([null, "7", "12", "m-1"]),
        authorName: pick([null, "Айгерим", "айгерим", "Бакыт", "Азамат Б."]),
        channel: kind === "call" ? "call" : pick(["whatsapp", "telegram", "instagram", null]),
        delivery: author === "client" ? null : pick(deliveries),
        handoff: author !== "client" && author !== "system" && rand() < 0.2,
        shadow: author === "bot" && rand() < 0.1,
        missed: kind !== "call" ? null : r < 0.3 ? null : r < 0.65,
        manager: kind === "call" ? pick([null, "Бакыт", "Чолпон"]) : null,
      });
    }
    tMax = Math.max(tMax, t);
    rows.push(...list);
    threads.set(id, list.map(toMessage));
    // «Ответ не нужен»: у каждого четвёртого; часто — ровно во время одного из сообщений
    const d = rand();
    dismissed.set(id, d < 0.25 ? (list.length && d < 0.12 ? at(pick(list).t) : at(Math.floor(rand() * (t + 2000) / 1000) * 1000)) : null);
    // Чужая компания с тем же номером клиента: её сообщения и ответы не должны мешать
    const u = Math.floor(rand() * 20) * 1000;
    rows.push(
      { org: 2, contact: id, t: u, kind: "message", author: "client", authorId: null, authorName: null, channel: "whatsapp", delivery: null, handoff: false, shadow: false, missed: null, manager: null },
      { org: 2, contact: id, t: u + 1000, kind: "message", author: "bot", authorId: null, authorName: null, channel: "whatsapp", delivery: "sent", handoff: false, shadow: false, missed: null, manager: null },
    );
  }
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE contacts (id int PRIMARY KEY, org_id int NOT NULL, dismissed_at timestamptz);
    CREATE TABLE messages (
      id serial PRIMARY KEY, org_id int NOT NULL, contact_id int NOT NULL, created_at timestamptz NOT NULL,
      kind text NOT NULL, author text NOT NULL, author_id text, author_name text, channel text, delivery text,
      handoff boolean NOT NULL DEFAULT false, shadow boolean NOT NULL DEFAULT false, call_missed boolean, call_manager text
    );
    CREATE INDEX ON messages (contact_id, created_at);`);
  generate();
  for (let i = 0; i < rows.length; i += 400) {
    const params: unknown[] = [];
    const values = rows.slice(i, i + 400).map((r) => {
      const cells = [r.org, r.contact, at(r.t), r.kind, r.author, r.authorId, r.authorName, r.channel, r.delivery, r.handoff, r.shadow, r.missed, r.manager];
      return `(${cells.map((v) => (params.push(v), `$${params.length}`)).join(", ")})`;
    });
    await db.query(
      `INSERT INTO messages (org_id, contact_id, created_at, kind, author, author_id, author_name, channel, delivery, handoff, shadow, call_missed, call_manager) VALUES ${values.join(", ")}`,
      params,
    );
  }
  const params: unknown[] = [];
  const values = [...dismissed].map(([id, d]) => `(${[id, 1, d].map((v) => (params.push(v), `$${params.length}`)).join(", ")})`);
  await db.query(`INSERT INTO contacts (id, org_id, dismissed_at) VALUES ${values.join(", ")}`, params);
});

afterAll(async () => {
  await db.close();
});

/** Периоды: всё сразу, пустой, крошечный, границы ровно по времени сообщений и случайные */
function periods(): [number, number][] {
  const times = rows.filter((r) => r.org === 1).map((r) => r.t);
  const list: [number, number][] = [[-1000, tMax + 1000], [0, 0], [0, 1], [1000, 2000]];
  for (let i = 0; i < 8; i++) {
    if (i % 2) {
      // Обе границы — ровно по времени сообщений
      const a = pick(times);
      const b = pick(times);
      list.push(a < b ? [a, b] : [b, a + 1000]);
    } else {
      const a = Math.floor(rand() * tMax);
      list.push([a, a + Math.floor(rand() * tMax / 2) + 1]);
    }
  }
  return list;
}

const byKey = (list: readonly Episode[]) => [...list].sort((a, b) => a.contactId.localeCompare(b.contactId) || a.startedAt.localeCompare(b.startedAt));

/** Несовпадения по клиентам — первые три, с перепиской, чтобы было видно, в чём дело */
function mismatches(got: readonly Episode[], want: readonly Episode[], withDismissal: boolean) {
  const group = (list: readonly Episode[]) => {
    const out = new Map<string, Episode[]>();
    for (const e of list) out.set(e.contactId, [...(out.get(e.contactId) ?? []), e]);
    return out;
  };
  const g = group(got);
  const w = group(want);
  const ids = new Set([...g.keys(), ...w.keys()]);
  return [...ids]
    .filter((id) => JSON.stringify(byKey(g.get(id) ?? [])) !== JSON.stringify(byKey(w.get(id) ?? [])))
    .slice(0, 3)
    .map((id) => ({ id, got: g.get(id), want: w.get(id), dismissed: withDismissal ? dismissed.get(Number(id)) : null, thread: threads.get(Number(id)) }));
}

function expected(from: number, to: number, o: { dismissal: boolean; only?: (id: number) => boolean }): Episode[] {
  const out: Episode[] = [];
  for (const [id, list] of threads) {
    if (o.only && !o.only(id)) continue;
    for (const e of episodesOf(list, id, { dismissedAt: o.dismissal ? dismissed.get(id) : null })) {
      const s = Date.parse(e.startedAt);
      if (s >= T0 + from && s < T0 + to) out.push(e);
    }
  }
  return out;
}

describe("responseEpisodesSql", () => {
  it(`совпадает с episodesOf на ${CONTACTS} случайных диалогах и 12 периодах («ответ не нужен» — из таблицы клиентов)`, async () => {
    let total = 0;
    for (const [from, to] of periods()) {
      const res = await db.query<EpisodeRow>(SQL, [1, at(from), at(to)]);
      const got = episodesFromRows(res.rows);
      const want = expected(from, to, { dismissal: true });
      expect(mismatches(got, want, true), `период ${from}…${to}`).toEqual([]);
      expect(got).toHaveLength(want.length);
      total += got.length;
    }
    expect(total).toBeGreaterThan(300);
  });

  it("в случайных данных есть все случаи: ответ бота и человека, звонок, без ответа, «ответ не нужен», ответ в ту же секунду", async () => {
    const all = expected(-1000, tMax + 1000, { dismissal: true });
    expect(all.some((e) => e.byBot)).toBe(true);
    expect(all.some((e) => e.replier && e.replier.type !== "bot")).toBe(true);
    expect(all.some((e) => e.channel === "call")).toBe(true);
    expect(all.some((e) => e.repliedAt === null && e.dismissedAt === null)).toBe(true);
    expect(all.some((e) => e.dismissedAt !== null)).toBe(true);
    expect(all.some((e) => e.repliedAt === e.startedAt)).toBe(true);
  });

  it("без «ответ не нужен» и без передачи человеку — тоже совпадает", async () => {
    const noHandoff = new Set([...threads].filter(([, list]) => !list.some((m) => m.handoff)).map(([id]) => id));
    expect(noHandoff.size).toBeGreaterThan(50);
    for (const [from, to] of periods().slice(0, 6)) {
      const plain = episodesFromRows((await db.query<EpisodeRow>(SQL_PLAIN, [1, at(from), at(to)])).rows);
      expect(mismatches(plain, expected(from, to, { dismissal: false }), false)).toEqual([]);
      const bare = episodesFromRows((await db.query<EpisodeRow>(SQL_NO_HANDOFF, [1, at(from), at(to)])).rows)
        .filter((e) => noHandoff.has(Number(e.contactId)));
      expect(mismatches(bare, expected(from, to, { dismissal: false, only: (id) => noHandoff.has(id) }), false)).toEqual([]);
    }
  });

  it("проверка не пустая: запрос с другим порядком одновременных записей или ответов даёт другие обращения", async () => {
    const want = expected(-1000, tMax + 1000, { dismissal: true });
    const run = async (sql: string) => episodesFromRows((await db.query<EpisodeRow>(sql, [1, at(-1000), at(tMax + 1000)])).rows);
    // Ответ в ту же секунду считается раньше сообщения клиента
    const clientLast = SQL.replace("ORDER BY ts, kind,", "ORDER BY ts, kind DESC,");
    expect(clientLast).not.toBe(SQL);
    expect((mismatches(await run(clientLast), want, true)).length).toBeGreaterThan(0);
    // Бот раньше человека среди ответов в одну секунду
    const botFirst = SQL.replace("WHEN 'bot' THEN 3", "WHEN 'bot' THEN -1");
    expect(botFirst).not.toBe(SQL);
    expect((mismatches(await run(botFirst), want, true)).length).toBeGreaterThan(0);
  });

  it("итоги из строк базы — те же, что из обращений TypeScript", async () => {
    const [from, to] = [0, tMax + 1];
    const res = await db.query<EpisodeRow>(SQL, [1, at(from), at(to)]);
    const opts = { from: at(from), to: at(to), now: at(tMax + 30 * 60_000), targetsMin: [1, 5] };
    expect(responseStats(episodesFromRows(res.rows), opts)).toEqual(responseStats(expected(from, to, { dismissal: true }), opts));
  });
});

describe("messageCountsSql и lastClientAtSql", () => {
  it("сообщения за период — те же числа, что countMessages", async () => {
    const all = [...threads.values()].flat();
    for (const [from, to] of periods()) {
      const res = await db.query<MessageCounts>(COUNTS, [1, at(from), at(to)]);
      expect(res.rows[0], `период ${from}…${to}`).toEqual(countMessages(all, { from: at(from), to: at(to) }));
    }
  });

  it("последний ход клиента — то же время, что lastClientAt", async () => {
    const sql = lastClientAtSql({ table: "messages", contactColumn: "contact_id", contactRef: "c.id", timeColumn: "created_at", scope: "x.org_id = c.org_id", clientMessage: CLIENT });
    const res = await db.query<{ id: number; last: Date | null }>(`SELECT c.id, ${sql} AS last FROM contacts c ORDER BY c.id`);
    const diff = res.rows
      .map((r) => ({ id: r.id, got: r.last ? r.last.toISOString() : null, want: lastClientAt(threads.get(r.id) ?? []) }))
      .filter((d) => d.got !== d.want);
    expect(diff.slice(0, 5)).toEqual([]);
    expect(res.rows.filter((r) => r.last !== null).length).toBeGreaterThan(100);
  });
});
