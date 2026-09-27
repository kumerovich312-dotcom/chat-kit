// Сборка выпуска: src → dist (JavaScript ESM + описания типов) и стили. Зовётся из npm run build и перед упаковкой
// (npm pack / npm run release). Проекты получают уже собранный код — у себя им собирать набор не нужно.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
execFileSync(process.execPath, [tsc, "-p", join(root, "tsconfig.build.json")], { stdio: "inherit", cwd: root });
mkdirSync(join(dist, "ui"), { recursive: true });
copyFileSync(join(root, "src", "ui", "styles.css"), join(dist, "ui", "styles.css"));
console.log("Собрано в dist/");
