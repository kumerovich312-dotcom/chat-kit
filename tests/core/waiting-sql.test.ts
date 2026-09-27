import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthorType, Delivery } from "../../src/core/model.js";
import { waitSince, waitSinceSql, type WaitMessage } from "../../src/core/waiting.js";

// SQL-двойник правила «ждут ответа» на настоящем Postgres (PGlite — Postgres в памяти): для сотен случайных диалогов
// подзапрос waitSinceSql даёт то же время, что waitSince на TypeScript.

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE contacts (id int PRIMARY KEY, org_id int NOT NULL, dismissed_at timestamptz);
    CREATE TABLE messages (
      id serial PRIMARY KEY, org_id int NOT NULL, contact_id int NOT NULL, created_at timestamptz NOT NULL,
      kind text NOT NULL, author text NOT NULL, delivery text, handoff boolean NOT NULL DEFAULT false, shadow boolean NOT NULL DEFAULT false,
      call_missed boolean
    );`);
});

afterAll(async () => {
  await db.close();
});

const SQL = waitSinceSql({
  table: "messages",
  contactColumn: "contact_id",
  contactRef: "c.id",
  timeColumn: "created_at",
  scope: "x.org_id = c.org_id",
  // Условия с «ИЛИ» — набор сам берёт их в скобки
  clientMessage: "x.kind = 'message' AND x.author = 'client' OR x.kind = 'call' AND x.author = 'client' AND x.call_missed",
  reply: "x.kind = 'message' AND x.author NOT IN ('client', 'system') AND x.delivery IS DISTINCT FROM 'failed' AND NOT x.handoff AND NOT x.shadow"
    + " OR x.kind = 'call' AND x.author <> 'system' AND NOT x.call_missed",
  handoff: "x.kind = 'message' AND x.author NOT IN ('client', 'system') AND x.handoff AND x.delivery IS DISTINCT FROM 'failed' AND NOT x.shadow",
  dismissedAt: "c.dismissed_at",
});

/** Простой повторяемый генератор случайных чисел — один и тот же набор случаев при каждом запуске */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("waitSinceSql", () => {
  it("совпадает с waitSince на 300 случайных диалогах", async () => {
    const rand = rng(20260927);
    const T0 = Date.parse("2026-09-27T08:00:00Z");
    const authors: AuthorType[] = ["client", "client", "client", "bot", "operator_crm", "operator_phone", "system"];
    const kinds = ["message", "message", "message", "message", "note", "system", "call"] as const;
    const deliveries: (Delivery | null)[] = [null, null, "sent", "pending", "failed", "read"];
    const expected = new Map<number, string | null>();
    for (let id = 1; id <= 300; id++) {
      const n = Math.floor(rand() * 8);
      const list: WaitMessage[] = [];
      let t = T0;
      for (let i = 0; i < n; i++) {
        t += Math.floor(rand() * 3) * 1000; // бывают одинаковые времена
        const author = authors[Math.floor(rand() * authors.length)]!;
        const kind = author === "system" ? "system" : kinds[Math.floor(rand() * kinds.length)]!;
        const delivery = author === "client" ? null : deliveries[Math.floor(rand() * deliveries.length)]!;
        const handoff = author === "bot" && rand() < 0.3;
        const shadow = author === "bot" && rand() < 0.1;
        // Звонок: без сведений, пропущенный или состоявшийся
        const r = kind === "call" ? rand() : 1;
        const missed = r < 0.33 ? null : r < 0.66;
        const msg: WaitMessage = {
          at: new Date(t).toISOString(), kind, author: { type: author }, ...(delivery ? { delivery } : {}), handoff, shadow,
          ...(kind === "call" && missed !== null ? { call: { missed } } : {}),
        };
        list.push(msg);
        await db.query(
          "INSERT INTO messages (org_id, contact_id, created_at, kind, author, delivery, handoff, shadow, call_missed) VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8)",
          [id, msg.at, kind, author, delivery, handoff, shadow, kind === "call" ? missed : null]
        );
      }
      // Чужая компания с тем же номером клиента — не должна мешать
      await db.query("INSERT INTO messages (org_id, contact_id, created_at, kind, author) VALUES (2, $1, $2, 'message', 'client')", [id, new Date(T0 + 99_000).toISOString()]);
      const dismissed = rand() < 0.2 ? new Date(T0 + Math.floor(rand() * 10) * 1000).toISOString() : null;
      await db.query("INSERT INTO contacts (id, org_id, dismissed_at) VALUES ($1, 1, $2)", [id, dismissed]);
      expected.set(id, waitSince(list, dismissed));
    }
    const rows = await db.query<{ id: number; since: Date | null }>(`SELECT c.id, ${SQL} AS since FROM contacts c ORDER BY c.id`);
    const got = new Map(rows.rows.map((r) => [r.id, r.since ? new Date(r.since).toISOString() : null]));
    const diff = [...expected].filter(([id, want]) => got.get(id) !== want).slice(0, 5);
    expect(diff).toEqual([]);
  });

  it("псевдоним x в условиях меняется, а слова и строки в кавычках — нет", () => {
    const sql = waitSinceSql({
      table: "messages", contactColumn: "client_id", contactRef: "c.id", timeColumn: "created_at",
      clientMessage: "x.direction = 'in' AND x.text <> 'x.y'", reply: "x.direction = 'out' AND xx.flag", scope: "x.org_id = $1",
    });
    expect(sql).toContain("(i.direction = 'in' AND i.text <> 'x.y')");
    expect(sql).toContain("(r.direction = 'out' AND xx.flag)");
    expect(sql).toContain("(r.org_id = $1)");
  });
});
