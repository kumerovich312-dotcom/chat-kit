// Общая подготовка тестов: настоящая сеть запрещена — подключения (Nextbot, шлюз, студия) проверяются только
// на поддельных ответах. Случайно ушедший наружу запрос сразу роняет тест, а не шлёт что-то настоящему сервису.
const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const host = new URL(url, "http://127.0.0.1").hostname;
  if (host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]") return realFetch(input, init);
  throw new Error(`Внешняя сеть в тестах запрещена: ${url} — подставьте поддельный fetch`);
}) as typeof fetch;
