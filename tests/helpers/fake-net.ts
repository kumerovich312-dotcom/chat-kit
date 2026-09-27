// Поддельная сеть для проверок подключений: вебхук Nextbot записывает, что ему прислали; хранилище отдаёт файлы.
// Настоящая сеть в тестах запрещена (tests/setup.ts).

export const bytes = {
  jpeg: () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, ...new Array(64).fill(7)]),
  png: () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(64).fill(3)]),
  ogg: () => new Uint8Array([0x4f, 0x67, 0x67, 0x53, ...new Array(64).fill(1)]),
  pdf: () => new TextEncoder().encode("%PDF-1.4\n% вымышленный документ\n%%EOF"),
  docx: () => new TextEncoder().encode("PK\u0003\u0004 [Content_Types].xml word/document.xml"),
  zip: () => new TextEncoder().encode("PK\u0003\u0004 archive.bin"),
};

export type Sent = { url: string; body: Record<string, unknown> };

export function fakeNet(opts: { webhook?: string; webhookStatus?: () => number } = {}) {
  const webhook = opts.webhook ?? "https://app.nextbot.ru/api/webhooks/v1/test-hook";
  const files = new Map<string, Uint8Array>();
  const gets = new Map<string, number>();
  const sent: Sent[] = [];
  const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === webhook && init?.method === "POST") {
      sent.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return new Response("{}", { status: opts.webhookStatus?.() ?? 200 });
    }
    gets.set(url, (gets.get(url) ?? 0) + 1);
    const data = files.get(url);
    if (!data) return new Response("not found", { status: 404 });
    return new Response(new Blob([new Uint8Array(data)]), { status: 200, headers: { "content-length": String(data.byteLength) } });
  }) as typeof fetch;
  return { fetch: fetchFn, files, gets, sent, webhook };
}
