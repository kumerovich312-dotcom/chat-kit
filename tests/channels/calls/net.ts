// Поддельная сеть для проверок телефонии: файлы записей по ссылкам и API Zadarma (ссылка на запись).
// Настоящая сеть в тестах запрещена (tests/setup.ts). Адреса, номера и ключи — вымышленные.

export const audio = {
  /** mp3 с тегом ID3 */
  mp3: (size = 64) => {
    const b = new Uint8Array(size);
    b.set([0x49, 0x44, 0x33, 0x03, 0x00]);
    return b;
  },
  /** wav: RIFF … WAVE */
  wav: () => {
    const b = new Uint8Array(64);
    b.set(new TextEncoder().encode("RIFF"), 0);
    b.set(new TextEncoder().encode("WAVE"), 8);
    return b;
  },
  /** Не звук — документ */
  pdf: () => new TextEncoder().encode("%PDF-1.4\n% вымышленный документ\n%%EOF"),
};

export type Seen = { url: string; method: string; headers: Headers };

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

export function fakeNet() {
  const files = new Map<string, Uint8Array>();
  const seen: Seen[] = [];
  // API Zadarma по умолчанию: ссылка на запись по её номеру
  let zadarma = (url: URL): Response => {
    const id = url.searchParams.get("call_id") ?? url.searchParams.get("pbx_call_id") ?? "";
    return json({ status: "success", link: `https://records.zadarma.test/rec/${id}.mp3`, lifetime_till: "2026-09-27 15:00:00" });
  };
  const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers) });
    const u = new URL(url);
    if (u.hostname === "api.zadarma.com") return zadarma(u);
    const data = files.get(url);
    if (!data) return new Response("not found", { status: 404 });
    return new Response(new Blob([new Uint8Array(data)]), { status: 200, headers: { "content-length": String(data.byteLength) } });
  }) as typeof fetch;
  return {
    fetch: fetchFn, files, seen, json,
    /** Свой ответ API Zadarma */
    setZadarma(f: (url: URL) => Response) {
      zadarma = f;
    },
  };
}
