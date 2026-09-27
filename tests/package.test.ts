import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

// Набор как пакет: собранный код открывается обычным Node (как на сервере проекта), в коде нет того, на что ругается
// поиск секретов студии, и нет настоящих телефонов.

const root = join(import.meta.dirname, "..");

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".") || name === "public") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|tsx|css|mjs|md|json|html)$/.test(name)) out.push(p);
  }
  return out;
}

describe("выпуск", () => {
  beforeAll(() => {
    execFileSync(process.execPath, [join(root, "scripts", "build.mjs")], { cwd: root, stdio: "pipe" });
  }, 120_000);

  it("собранные части открываются обычным Node: ядро, сервер, подключения", async () => {
    const load = (p: string) => import(pathToFileURL(join(root, "dist", p)).href);
    const core = await load("core/index.js");
    expect(core.normalizePhone("0555 00-00-01", "+996")).toBe("+996555000001");
    expect(typeof (await load("server/index.js")).ingest).toBe("function");
    expect(typeof (await load("channels/nextbot/index.js")).createNextbotAdapter).toBe("function");
    expect(typeof (await load("channels/studio/index.js")).createStudioAdapter).toBe("function");
    expect(typeof (await load("channels/telegram/index.js")).createTelegramAdapter).toBe("function");
    expect(typeof (await load("channels/instagram/index.js")).createInstagramAdapter).toBe("function");
    expect(typeof (await load("channels/green-api/index.js")).createGreenApiAdapter).toBe("function");
    expect(typeof (await load("channels/calls/index.js")).createCallsAdapter).toBe("function");
    expect(typeof (await load("ai/index.js")).createClaudeAi).toBe("function");
    expect(typeof (await load("channels/email/index.js")).createEmailAdapter).toBe("function");
    expect(typeof (await load("channels/site/index.js")).handleSiteRequest).toBe("function");
    // Виджет для сайта — один файл без import: его отдают как есть
    expect(readFileSync(join(root, "dist", "widget", "chat-widget.js"), "utf8")).not.toMatch(/^\s*import\s|\bfrom\s+["']/m);
    expect(typeof core.defineProfile).toBe("function");
    expect(existsSync(join(root, "dist", "ui", "styles.css"))).toBe(true);
    expect(readFileSync(join(root, "dist", "ui", "Composer.js"), "utf8").startsWith('"use client"')).toBe(true);
  });

  it("каждый путь из package.json exports существует", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { exports: Record<string, string | { types: string; default: string }> };
    for (const [key, v] of Object.entries(pkg.exports)) {
      const paths = typeof v === "string" ? [v] : [v.types, v.default];
      for (const p of paths) expect(existsSync(join(root, p)), `${key} → ${p}`).toBe(true);
    }
  });
});

describe("чистота кода", () => {
  const all = files(root).filter((p) => !p.endsWith("package-lock.json"));

  it("нет того, что ловит поиск секретов студии (sk-…, gh…_…, закрытые ключи)", () => {
    const bad = all.filter((p) => {
      const t = readFileSync(p, "utf8");
      return /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/.test(t) || /gh[pousr]_[A-Za-z0-9]{20,}/.test(t) || /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/.test(t);
    });
    expect(bad).toEqual([]);
  });

  it("телефоны в коде и примерах — вымышленные (номера из нулей)", () => {
    const real = all.flatMap((p) => {
      const t = readFileSync(p, "utf8");
      return [...t.matchAll(/\+?996[\s-]?\(?5\d\d\)?[\s-]?(\d\d)[\s-]?(\d\d)[\s-]?(\d\d)/g)]
        .filter((m) => !/^0+\d?$/.test(`${m[1]}${m[2]}${m[3]}`.replace(/^0+/, "0")) && !/^000/.test(`${m[1]}${m[2]}${m[3]}`))
        .map((m) => `${p}: ${m[0]}`);
    });
    expect(real).toEqual([]);
  });
});
