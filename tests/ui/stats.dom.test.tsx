// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Episode } from "../../src/core/stats.js";
import { responseStats, slowestEpisodes, statsByDay } from "../../src/core/stats.js";
import { StatsCards, StatsChannels, StatsChart, StatsSlow, StatsWho } from "../../src/ui/Stats.js";

// Страница статистики: главные цифры, кто отвечал, каналы, график по дням, долгие ожидания.

afterEach(cleanup);

const TZ = "Asia/Bishkek";
const at = (d: string) => new Date(d).toISOString();
const ep = (contactId: string, startedAt: string, repliedAt: string | null, extra: Partial<Episode> = {}): Episode => ({
  contactId, channel: "whatsapp", startedAt: at(startedAt), repliedAt: repliedAt ? at(repliedAt) : null,
  replier: repliedAt ? { type: "operator_crm", id: "u1", name: "Айгерим" } : null, byBot: false, dismissedAt: null, ...extra,
});
const EPS: Episode[] = [
  ep("1", "2026-09-25T04:00:00Z", "2026-09-25T04:03:00Z"),
  ep("2", "2026-09-25T05:00:00Z", "2026-09-25T05:40:00Z", { channel: "telegram" }),
  ep("3", "2026-09-26T04:00:00Z", "2026-09-26T04:00:30Z", { byBot: true, replier: { type: "bot", id: null, name: null } }),
  ep("4", "2026-09-27T03:00:00Z", null),
  ep("5", "2026-09-27T03:30:00Z", null, { dismissedAt: at("2026-09-27T03:40:00Z") }),
];
const period = { from: at("2026-09-24T18:00:00Z"), to: at("2026-09-27T18:00:00Z"), now: at("2026-09-27T04:00:00Z") };

describe("статистика: данные по дням и долгие ожидания", () => {
  it("по дням — по поясу компании; медиана первого ответа за день", () => {
    const days = statsByDay(EPS, { ...period, timeZone: TZ });
    expect(days.map((d) => d.day)).toEqual(["2026-09-25", "2026-09-26", "2026-09-27"]);
    expect(days[0]).toMatchObject({ episodes: 2, answered: 2 });
    expect(days[1]).toMatchObject({ episodes: 1, medianSec: 30 });
    expect(days[2]).toMatchObject({ episodes: 2, unanswered: 1 });
  });

  it("долгие ожидания: сначала кто ждёт до сих пор, «ответ не нужен» без ответа — не в списке", () => {
    const slow = slowestEpisodes(EPS, period);
    expect(slow.map((e) => e.contactId)).toEqual(["4", "2", "1", "3"]);
    expect(slow[0]).toMatchObject({ waiting: true, waitedSec: 3600 });
    expect(slow[1]).toMatchObject({ waiting: false, waitedSec: 2400 });
    expect(slowestEpisodes(EPS, { ...period, minSec: 600 }).map((e) => e.contactId)).toEqual(["4", "2"]);
  });
});

describe("страница статистики — части", () => {
  const stats = responseStats(EPS, { ...period, targetsMin: [5, 15, 60] });

  it("главные цифры: обращения, первый ответ, доля за 15 минут, ждут сейчас", () => {
    const { container } = render(<StatsCards stats={stats} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Обращений5");
    expect(text).toContain("Ответили за 15 мин");
    expect(text).toContain("Ждут сейчас1");
    expect(container.querySelector(".ck-stats__card--bad")).toBeTruthy();
  });

  it("кто отвечал и каналы", () => {
    const who = render(<StatsWho stats={stats} />).container.textContent ?? "";
    expect(who).toContain("Люди");
    expect(who).toContain("ИИ-агент");
    expect(who).toContain("Айгерим");
    cleanup();
    const ch = render(<StatsChannels stats={stats} />).container.textContent ?? "";
    expect(ch).toContain("WhatsApp");
    expect(ch).toContain("Telegram");
  });

  it("график: столбик дольше цели — красный; долгие ожидания — со ссылками", () => {
    const { container } = render(<StatsChart days={statsByDay(EPS, { ...period, timeZone: TZ })} target={15} />);
    expect(container.querySelectorAll(".ck-stats__col")).toHaveLength(3);
    expect(container.querySelectorAll(".ck-stats__bar--late")).toHaveLength(1);
    cleanup();
    const slow = render(<StatsSlow items={slowestEpisodes(EPS, period)} nameOf={(id) => `Клиент ${id}`} hrefFor={(id) => `/?dialog=${id}`} timeZone={TZ} />).container;
    expect(slow.querySelector("a")?.getAttribute("href")).toBe("/?dialog=4");
    expect(slow.textContent).toContain("ждёт 1 ч");
  });
});
