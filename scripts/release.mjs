// Выпуск новой версии набора: проверки → сборка → архив .tgz → проба установки → метка vX.Y.Z → выпуск на GitHub
// с архивом. Выпуск виден всем — запускать только по «да» пользователя: npm run release
// Пробный прогон (всё, кроме метки и выпуска): npm run release -- --dry-run
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "kumerovich312-dotcom/chat-kit";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dry = process.argv.includes("--dry-run");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = String(pkg.version);
const tag = `v${version}`;
const fileName = `muras-chat-kit-${version}.tgz`;
const downloadUrl = `https://github.com/${REPO}/releases/download/${tag}/${fileName}`;

function stop(msg) {
  console.error(`\nВыпуск остановлен: ${msg}`);
  process.exit(1);
}
function step(msg) {
  console.log(`\n— ${msg}`);
}
function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts }).trim();
}
function show(cmd, args, opts = {}) {
  execFileSync(cmd, args, { cwd: root, stdio: "inherit", ...opts });
}
/** Путь к исполняемому файлу пакета из node_modules (по полю bin его package.json) */
function bin(name, cmd) {
  const dir = join(root, "node_modules", name);
  const p = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const rel = typeof p.bin === "string" ? p.bin : p.bin?.[cmd];
  if (!rel) stop(`у пакета ${name} нет команды ${cmd}`);
  return join(dir, rel);
}
/** npm: из npm run — npm_execpath; иначе рядом с node */
function npmCli() {
  const env = process.env.npm_execpath;
  if (env && env.endsWith("npm-cli.js") && existsSync(env)) return env;
  const dir = dirname(process.execPath);
  for (const p of [join(dir, "node_modules", "npm", "bin", "npm-cli.js"), join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")]) {
    if (existsSync(p)) return p;
  }
  return stop("не найден npm");
}

console.log(`Выпуск ${tag}${dry ? " — пробный прогон, без метки и выпуска" : ""}`);
if (!/^\d+\.\d+\.\d+$/.test(version)) stop(`номер версии в package.json «${version}» — нужен вида 1.2.3`);

// 1. Запись о версии в CHANGELOG.md — из неё же текст выпуска на GitHub
const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
const head = changelog.split("\n").findIndex((l) => l.startsWith(`## ${version} `) || l.trim() === `## ${version}`);
if (head < 0) stop(`в CHANGELOG.md нет раздела «## ${version} — …»`);
const rest = changelog.split("\n").slice(head + 1);
const end = rest.findIndex((l) => l.startsWith("## "));
const notes = (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
if (!notes) stop(`раздел ${version} в CHANGELOG.md пустой`);

// 2. Всё сохранено и отправлено в main; такой метки ещё нет
step("Git: всё сохранено и отправлено в main");
const problems = [];
if (run("git", ["status", "--porcelain"])) problems.push("есть несохранённые изменения (git status)");
run("git", ["fetch", "origin", "main", "--tags", "--quiet"]);
if (run("git", ["rev-parse", "HEAD"]) !== run("git", ["rev-parse", "origin/main"])) {
  problems.push("текущая версия кода не совпадает с main на GitHub — сначала git push origin HEAD:main");
}
if (run("git", ["tag", "-l", tag]) || run("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`])) {
  problems.push(`метка ${tag} уже есть — поднимите номер версии в package.json и CHANGELOG.md`);
}
if (problems.length && !dry) stop(problems.join("; "));
for (const p of problems) console.log(`  (пробный прогон) ${p}`);

// 3. Проверки и сборка
step("Типы (tsc)");
show(process.execPath, [bin("typescript", "tsc"), "--noEmit", "-p", "tsconfig.json"]);
step("Тесты (vitest)");
show(process.execPath, [bin("vitest", "vitest"), "run"]);
step("Сборка dist/");
show(process.execPath, [join(root, "scripts", "build.mjs")]);

// 4. Архив: только собранный код, README и CHANGELOG
step("Архив .tgz");
const out = join(tmpdir(), "chat-kit-release", tag);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const npm = npmCli();
const packed = JSON.parse(run(process.execPath, [npm, "pack", "--json", "--ignore-scripts", "--pack-destination", out]))[0];
if (!packed || packed.filename !== fileName) stop(`npm pack дал «${packed?.filename}», ждали «${fileName}»`);
const files = packed.files.map((f) => f.path.replace(/\\/g, "/"));
const need = ["package.json", "README.md", "CHANGELOG.md", "dist/ui/styles.css"];
for (const part of ["core", "ui", "server", "nextbot", "wa-gateway", "studio"]) need.push(`dist/${part}/index.js`, `dist/${part}/index.d.ts`);
const missing = need.filter((f) => !files.includes(f));
if (missing.length) stop(`в архиве нет: ${missing.join(", ")}`);
const extra = files.filter((f) => !need.includes(f) && !f.startsWith("dist/"));
if (extra.length) stop(`в архив попало лишнее: ${extra.join(", ")}`);
const tgz = join(out, fileName);
console.log(`  ${fileName}: ${files.length} файлов, ${(packed.size / 1024).toFixed(0)} КБ`);

// 5. Проба: поставить архив в пустую папку, как его поставит проект, и открыть части набора
step("Проба установки");
const trial = join(out, "trial");
mkdirSync(trial, { recursive: true });
writeFileSync(join(trial, "package.json"), JSON.stringify({ name: "chat-kit-trial", private: true, type: "module" }));
run(process.execPath, [npm, "install", tgz, "--no-audit", "--no-fund", "--ignore-scripts", "--no-package-lock"], { cwd: trial });
writeFileSync(
  join(trial, "check.mjs"),
  [
    'const core = await import("@muras/chat-kit");',
    'for (const part of ["server", "nextbot", "wa-gateway", "studio"]) await import(`@muras/chat-kit/${part}`);',
    'if (typeof core.waitSince !== "function") throw new Error("нет waitSince");',
    'console.log("  части набора открываются");',
  ].join("\n"),
);
show(process.execPath, [join(trial, "check.mjs")], { cwd: trial });

if (dry) {
  console.log(`\nПробный прогон прошёл. Архив: ${tgz}\nНастоящий выпуск — npm run release (по «да» пользователя).`);
  process.exit(0);
}

// 6. Метка и выпуск на GitHub
step(`Метка ${tag}`);
show("git", ["tag", "-a", tag, "-m", `chat-kit ${tag}`]);
show("git", ["push", "origin", tag]);
step("Выпуск на GitHub");
const notesFile = join(out, "notes.md");
writeFileSync(notesFile, `${notes}\n\nПоставить в проект:\n\n\`\`\`bash\nnpm install ${downloadUrl}\n\`\`\`\n`);
show("gh", ["release", "create", tag, tgz, "--repo", REPO, "--title", `chat-kit ${tag}`, "--notes-file", notesFile, "--verify-tag"]);

// 7. Ссылка на архив открывается без входа
const res = await fetch(downloadUrl, { method: "HEAD", redirect: "follow" });
if (!res.ok) stop(`ссылка на архив отвечает ${res.status}: ${downloadUrl}`);
console.log(`\nГотово: ${tag}\nПоставить в проект:\n  npm install ${downloadUrl}`);
