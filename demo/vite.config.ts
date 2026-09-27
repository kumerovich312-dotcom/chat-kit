import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { photoSvg } from "./photos";

// Демо-страница окна переписки: http://localhost:30030 (порты ниже 15000 Windows резервирует; 30003, 30004, 30014,
// 30020, 30097, 30099, 35432 заняты другими проектами).

const here = dirname(fileURLToPath(import.meta.url));

// Файлы демо (голосовые, PDF, Word, Excel) — до запуска сервера: Vite запоминает содержимое папки public при старте
execFileSync(process.execPath, [join(here, "..", "scripts", "demo-assets.mjs")], { stdio: "inherit" });

/** «Фото» для демо — рисунки SVG, повёрнутые на угол из метки содержимого (?v=r90): так видно, что поворот сохраняется */
function photos(): Plugin {
  return {
    name: "chat-kit-demo-photos",
    configureServer(server) {
      server.middlewares.use("/photos/", (req, res) => {
        const url = new URL(req.url ?? "/", "http://demo.local");
        const name = url.pathname.replace(/^\//, "").replace(/\.svg$/, "");
        const turn = Number((url.searchParams.get("v") ?? "r0").replace(/^r/, "")) || 0;
        const svg = photoSvg(name, turn);
        if (!svg) { res.statusCode = 404; res.end("нет такого фото"); return; }
        res.setHeader("content-type", "image/svg+xml; charset=utf-8");
        res.setHeader("cache-control", "no-store");
        if (url.searchParams.get("download") === "1") res.setHeader("content-disposition", `attachment; filename="${name}.svg"`);
        res.end(svg);
      });
    },
  };
}

export default defineConfig({
  root: here,
  plugins: [react(), photos()],
  server: { port: 30030, strictPort: true, host: "127.0.0.1" },
  preview: { port: 30030, strictPort: true, host: "127.0.0.1" },
});
