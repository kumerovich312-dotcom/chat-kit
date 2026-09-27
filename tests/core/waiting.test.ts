import { describe, expect, it } from "vitest";
import type { AuthorType, Delivery, MessageKind } from "../../src/core/model.js";
import { waitKey, waitSince, waitText, type WaitMessage } from "../../src/core/waiting.js";

// Правило «ждут ответа» — сценарии без базы.

const T0 = Date.parse("2026-09-27T08:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const m = (min: number, author: AuthorType, extra: { kind?: MessageKind; delivery?: Delivery; handoff?: boolean; shadow?: boolean; missed?: boolean } = {}): WaitMessage => ({
  at: at(min),
  kind: extra.kind ?? "message",
  author: { type: author },
  ...(extra.delivery ? { delivery: extra.delivery } : {}),
  ...(extra.handoff ? { handoff: true } : {}),
  ...(extra.shadow ? { shadow: true } : {}),
  ...(extra.missed !== undefined ? { call: { missed: extra.missed } } : {}),
});

describe("waitSince", () => {
  it("клиент написал — ждёт с первого своего сообщения; дописал ещё — время то же", () => {
    expect(waitSince([m(0, "client")])).toBe(at(0));
    expect(waitSince([m(0, "client"), m(2, "client")])).toBe(at(0));
  });

  it("ответили (менеджер, бот, с телефона, внесённая копия) — не ждёт", () => {
    for (const who of ["operator_crm", "bot", "operator_phone", "operator_admin"] as const) {
      expect(waitSince([m(0, "client"), m(1, who)])).toBeNull();
    }
  });

  it("после ответа клиент написал снова — ждёт с этого сообщения", () => {
    expect(waitSince([m(0, "client"), m(1, "operator_crm"), m(5, "client"), m(6, "client")])).toBe(at(5));
  });

  it("заметка, служебная строка и звонок без сведений — не ответ", () => {
    expect(waitSince([m(0, "client"), m(1, "operator_crm", { kind: "note" })])).toBe(at(0));
    expect(waitSince([m(0, "client"), m(1, "system", { kind: "system" })])).toBe(at(0));
    expect(waitSince([m(0, "client"), m(1, "operator_crm", { kind: "call" })])).toBe(at(0));
  });

  it("звонки: разговор — ответ; пропущенный входящий — клиент ждёт; пропущенный исходящий — ничего не меняет", () => {
    expect(waitSince([m(0, "client"), m(1, "operator_phone", { kind: "call", missed: false })])).toBeNull();
    expect(waitSince([m(0, "client"), m(1, "client", { kind: "call", missed: false })])).toBeNull();
    expect(waitSince([m(0, "operator_crm"), m(1, "client", { kind: "call", missed: true })])).toBe(at(1));
    expect(waitSince([m(0, "client"), m(1, "operator_phone", { kind: "call", missed: true })])).toBe(at(0));
    expect(waitSince([m(0, "operator_crm"), m(1, "operator_phone", { kind: "call", missed: true })])).toBeNull();
  });

  it("недоставленное и черновик теневого режима — не ответ; отправляющееся — ответ", () => {
    expect(waitSince([m(0, "client"), m(1, "operator_crm", { delivery: "failed" })])).toBe(at(0));
    expect(waitSince([m(0, "client"), m(1, "bot", { shadow: true })])).toBe(at(0));
    expect(waitSince([m(0, "client"), m(1, "operator_crm", { delivery: "pending" })])).toBeNull();
  });

  it("«Ответ не нужен» снимает ожидание до следующего сообщения клиента", () => {
    const list = [m(0, "client"), m(1, "operator_crm"), m(3, "client")];
    expect(waitSince(list, at(4))).toBeNull();
    expect(waitSince([...list, m(9, "client")], at(4))).toBe(at(9));
  });

  it("бот «передаю менеджеру» — не ответ: клиент ждёт с первого сообщения после настоящего ответа", () => {
    expect(waitSince([m(0, "client"), m(1, "bot", { handoff: true })])).toBe(at(0));
    expect(waitSince([m(0, "client"), m(1, "bot"), m(2, "client"), m(3, "bot", { handoff: true })])).toBe(at(2));
  });

  it("бот ответил, потом отдельным сообщением передал человеку — ждёт с передачи", () => {
    expect(waitSince([m(0, "client"), m(1, "bot"), m(2, "bot", { handoff: true })])).toBe(at(2));
  });

  it("клиент написал в ту же минуту, что ответил бот, но позже по секундам — ждёт (порядок по точному времени)", () => {
    const bot = { at: new Date(T0 + 5_000).toISOString(), kind: "message" as const, author: { type: "bot" as const } };
    const client = { at: new Date(T0 + 7_000).toISOString(), kind: "message" as const, author: { type: "client" as const } };
    expect(waitSince([bot, client])).toBe(client.at);
  });

  it("сообщения без переписки — не ждёт", () => {
    expect(waitSince([])).toBeNull();
  });
});

describe("waitText и waitKey", () => {
  it("ждёт N мин / ч / дн", () => {
    expect(waitText(30_000)).toBe("ждёт 1 мин");
    expect(waitText(25 * 60_000)).toBe("ждёт 25 мин");
    expect(waitText(3 * 3_600_000 + 5)).toBe("ждёт 3 ч");
    expect(waitText(50 * 3_600_000)).toBe("ждёт 2 дн");
  });
  it("ключ ожидания: клиент и время начала — одно ожидание, один звонок", () => {
    expect(waitKey(15, at(0))).toBe(`15:${T0}`);
    expect(waitKey("15", new Date(T0))).toBe(waitKey(15, T0));
  });
});
