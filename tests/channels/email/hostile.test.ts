import { describe, expect, it } from "vitest";
import { createEmailAdapter, htmlToText, mailHtml, parseAddress, parseAddressList, parseMailDate, splitReply } from "../../../src/channels/email/index.js";
import { createMemoryStore, ingest } from "../../../src/server/index.js";

// Письмо присылает кто угодно: разбор не должен «задумываться» на подобранных строках (тысячи пробелов, незакрытые теги
// и кавычки, тысячи вложенных цитат). Каждый разбор — быстро; раньше строка «Forwarded message» + 4000 пробелов
// разбиралась 50 секунд.

function fast<T>(fn: () => T, ms = 1500): T {
  const t0 = performance.now();
  const r = fn();
  expect(performance.now() - t0).toBeLessThan(ms);
  return r;
}

describe("подобранные письма разбираются быстро", () => {
  it("текст: пробелы после «Forwarded message», тысячи черт и подписей к цитатам", () => {
    fast(() => splitReply(`Привет\n---------- Forwarded message${" ".repeat(50_000)}x`));
    fast(() => splitReply(`Привет\n${"________________\n".repeat(50_000)}`));
    fast(() => splitReply(`Привет\n${"On Fri, Sep 26, 2026 Company <a@company.example> wrote:\n> q\n".repeat(20_000)}конец`));
    fast(() => splitReply(`Привет\n${"26.09.2026 10:00, Компания <".repeat(5_000)}`));
    expect(fast(() => splitReply("x".repeat(1_000_000))).reply.length).toBeLessThanOrEqual(300_000);
  });

  it("HTML: незакрытые кавычки и теги, тысячи ссылок и цитат", () => {
    fast(() => htmlToText('<a x="'.repeat(50_000)));
    fast(() => htmlToText("<a b ".repeat(50_000)));
    fast(() => htmlToText("<!x".repeat(50_000)));
    fast(() => htmlToText("<!--".repeat(50_000)));
    fast(() => htmlToText(`${"<a href=\"https://x.example\">".repeat(50_000)}${"текст ".repeat(50_000)}`));
    const deep = fast(() => htmlToText(`${"<blockquote>".repeat(10_000)}${"строка<br>".repeat(10_000)}`));
    expect(deep.length).toBeLessThan(1_000_000);
    fast(() => htmlToText(`<p>${" ".repeat(1_000_000)}</p>`));
    fast(() => htmlToText(`<pre>${" ".repeat(1_000_000)}x</pre>`));
    fast(() => htmlToText(`<a href="https://x.example${"/".repeat(200_000)}q">текст</a>`));
    fast(() => htmlToText(`<style ${"/".repeat(20_000)}${" ".repeat(200_000)}x>`));
  });

  it("заголовок Date из тысяч скобок", () => {
    expect(fast(() => parseMailDate("(".repeat(200_000)))).toBeNull();
  });

  it("ответ бота и адреса: длинные заголовки, хвосты ссылок, угловые скобки", () => {
    fast(() => mailHtml(`# a${" ".repeat(50_000)}b`, { markdown: true }));
    fast(() => mailHtml(`# ${"#".repeat(50_000)}x`, { markdown: true }));
    fast(() => mailHtml(`http://a.example${".".repeat(50_000)}`));
    fast(() => mailHtml(`http://a.example${")".repeat(50_000)}`));
    expect(fast(() => parseAddress("<".repeat(100_000)))).toBeNull();
    expect(fast(() => parseAddress("a@".repeat(50_000)))).toBeNull();
    expect(fast(() => parseAddressList("a@b.example,".repeat(50_000)))).toHaveLength(100);
  });

  it("целиком через вебхук: письмо в мегабайт подобранного HTML", async () => {
    const store = createMemoryStore();
    const adapter = createEmailAdapter({ inboundToken: "test-secret-not-real-email", from: "hello@company.example" });
    const html = `<p>Здравствуйте</p>${'<a x="'.repeat(20_000)}${"<blockquote>".repeat(5_000)}${"<br>".repeat(20_000)}`;
    const t0 = performance.now();
    const r = await ingest(adapter, store, {
      method: "POST", headers: { authorization: "Bearer test-secret-not-real-email" },
      body: JSON.stringify({ from: "client@example.com", subject: `Forwarded message${" ".repeat(20_000)}x`, html, messageId: "<h1@mail.example.com>" }),
    });
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(r.status).toBe(200);
  });

  it("тысячи пробелов подряд в тексте письма — до 32 (окно переписки размечает текст клиента)", async () => {
    const store = createMemoryStore();
    const adapter = createEmailAdapter({ inboundToken: "test-secret-not-real-email", from: "hello@company.example" });
    await ingest(adapter, store, {
      method: "POST", headers: { authorization: "Bearer test-secret-not-real-email" },
      body: JSON.stringify({ from: "client@example.com", text: `# a${" ".repeat(5_000)}b\nтаблица:  1   2`, messageId: "<h2@mail.example.com>" }),
    });
    expect(store.thread("1")[0]?.text).toBe(`# a${" ".repeat(32)}b\nтаблица:  1   2`);
  });
});
