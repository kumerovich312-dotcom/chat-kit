import { defineConfig } from "vitest/config";

// Тесты набора: ядро и подключения — в Node, окно переписки — в jsdom (у таких файлов первой строкой
// `// @vitest-environment jsdom`). Внешняя сеть в тестах запрещена (tests/setup.ts): подключения проверяются
// на поддельных ответах.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environment: "node",
    setupFiles: ["tests/setup.ts"],
    testTimeout: 20_000,
  },
});
