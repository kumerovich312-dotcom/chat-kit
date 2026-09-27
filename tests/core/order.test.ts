import { describe, expect, it } from "vitest";
import { compareMessages, dedupeMessages, mergeMessages, placeAfter, sortMessages } from "../../src/core/order.js";

const msg = (id: string, at: string, extra: { seq?: number; externalId?: string; channel?: string; text?: string } = {}) => ({ id, at, ...extra });

describe("порядок сообщений", () => {
  it("по времени до миллисекунды", () => {
    const list = [msg("2", "2026-09-27T08:00:00.500Z"), msg("1", "2026-09-27T08:00:00.100Z")];
    expect(sortMessages(list).map((m) => m.id)).toEqual(["1", "2"]);
  });

  it("при одном времени — по номеру записи, числа как числа («93» раньше «100»)", () => {
    const same = "2026-09-27T08:00:00.000Z";
    expect(sortMessages([msg("100", same), msg("93", same), msg("101", same)]).map((m) => m.id)).toEqual(["93", "100", "101"]);
  });

  it("номер по порядку в диалоге (seq) главнее времени", () => {
    const a = msg("a", "2026-09-27T08:00:05Z", { seq: 2 });
    const b = msg("b", "2026-09-27T08:00:09Z", { seq: 1 });
    expect(compareMessages(a, b)).toBeGreaterThan(0);
  });

  it("UUID студии — как строки (UUIDv7 растут со временем)", () => {
    const same = "2026-09-27T08:00:00.000Z";
    expect(sortMessages([msg("0192f0b2-bbbb", same), msg("0192f0b2-aaaa", same)]).map((m) => m.id)).toEqual(["0192f0b2-aaaa", "0192f0b2-bbbb"]);
  });
});

describe("повторы", () => {
  it("тот же номер у канала — одно сообщение", () => {
    const list = [
      msg("1", "2026-09-27T08:00:00Z", { externalId: "wa:ABC", channel: "whatsapp" }),
      msg("2", "2026-09-27T08:00:01Z", { externalId: "wa:ABC", channel: "whatsapp" }),
      msg("3", "2026-09-27T08:00:02Z", { externalId: "wa:ABC", channel: "telegram" }),
    ];
    expect(dedupeMessages(list).map((m) => m.id)).toEqual(["1", "3"]);
  });

  it("пришедшее с тем же номером записи заменяет показанное (новый статус), порядок общий", () => {
    const shown = [msg("1", "2026-09-27T08:00:00Z", { text: "часики" }), msg("2", "2026-09-27T08:00:02Z")];
    const incoming = [msg("1", "2026-09-27T08:00:00Z", { text: "галочка" }), msg("3", "2026-09-27T08:00:01Z")];
    const merged = mergeMessages(shown, incoming);
    expect(merged.map((m) => m.id)).toEqual(["1", "3", "2"]);
    expect(merged[0]?.text).toBe("галочка");
  });
});

describe("placeAfter — время неточного сообщения", () => {
  const now = Date.parse("2026-09-27T08:10:00Z");
  it("строго после предыдущего известного", () => {
    const floor = Date.parse("2026-09-27T08:05:30Z");
    expect(placeAfter(floor, Date.parse("2026-09-27T08:05:00Z"), now)).toBe(floor + 1);
  });
  it("не позже «сейчас»", () => {
    expect(placeAfter(0, now + 60_000, now)).toBe(now);
  });
  it("время неизвестно — «сейчас», но после предыдущего", () => {
    expect(placeAfter(now + 5, null, now)).toBe(now + 6);
  });
});
