// Поддельный GREEN-API для проверок: методы инстанса (…/waInstance<номер>/<метод>/<ключ>) записывают, что им прислали,
// и отвечают как GREEN-API; остальные адреса — хранилище файлов. Настоящая сеть в тестах запрещена (tests/setup.ts).
// Номера, ключи и адреса — вымышленные.

export const ID = "1100000001";
export const TOKEN = "test-secret-not-real-green-api-token";
export const HOOK = "test-secret-not-real-green-api-webhook";
export const API = "https://1100.api.greenapi.test";
export const MEDIA = "https://1100.media.greenapi.test";
export const CHAT = "996555000001@c.us";
export const WID = "996555000009@c.us";
/** Время уведомлений GREEN-API — секунды */
export const T0 = Date.parse("2026-09-27T08:00:00Z") / 1000;
export const iso = (sec: number) => new Date(sec * 1000).toISOString();
export const instanceData = { idInstance: Number(ID), wid: WID, typeInstance: "whatsapp" };

export type ApiCall = { url: string; method: string; name: string; json: Record<string, unknown> | null; form: FormData | null };

export function fakeGreenApi() {
  const calls: ApiCall[] = [];
  const files = new Map<string, Uint8Array>();
  const gets: string[] = [];
  let seq = 0;
  const state = {
    /** Следующий ответ метода — вместо обычного (ошибки GREEN-API) */
    next: null as { status: number; body: string } | null,
    /** Свежая ссылка, которую отдаст downloadFile */
    fresh: "",
    stateInstance: "authorized",
    /** Нет связи */
    down: false,
  };
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const m = url.match(/\/waInstance(\d+)\/(\w+)\/([^/?]+)$/);
    if (m) {
      if (state.down) throw new TypeError("fetch failed");
      const body = init?.body;
      calls.push({
        url, method: String(init?.method ?? "GET"), name: m[2] ?? "",
        json: typeof body === "string" ? (JSON.parse(body) as Record<string, unknown>) : null,
        form: body instanceof FormData ? body : null,
      });
      if (state.next) {
        const n = state.next;
        state.next = null;
        return new Response(n.body, { status: n.status });
      }
      switch (m[2]) {
        case "sendMessage":
        case "sendFileByUrl":
          return json({ idMessage: `3EB0${String(++seq).padStart(12, "0")}` });
        case "sendFileByUpload":
          return json({ idMessage: `3EB0${String(++seq).padStart(12, "0")}`, urlFile: "https://media.greenapi.test/out/file-1.jpg" });
        case "downloadFile":
          return json({ downloadUrl: state.fresh });
        case "getStateInstance":
          return json({ stateInstance: state.stateInstance });
        case "setSettings":
          return json({ saveSettings: true });
        default:
          return new Response("{}", { status: 404 });
      }
    }
    gets.push(url);
    const data = files.get(url);
    if (!data) return new Response("not found", { status: 404 });
    return new Response(new Blob([new Uint8Array(data)]), { status: 200, headers: { "content-length": String(data.byteLength) } });
  }) as typeof fetch;
  return { fetch: fetchFn, calls, files, gets, state };
}

/** Уведомление о сообщении: входящее, с телефона или через API */
export function msg(
  messageData: Record<string, unknown>,
  o: { type?: string; id?: string; ts?: number; chatId?: string; sender?: string; senderName?: string; senderContactName?: string; chatName?: string } = {}
) {
  const chatId = o.chatId ?? CHAT;
  return {
    typeWebhook: o.type ?? "incomingMessageReceived",
    instanceData,
    timestamp: o.ts ?? T0,
    idMessage: o.id ?? "A1",
    senderData: {
      chatId, sender: o.sender ?? chatId, chatName: o.chatName ?? "Айгерим", senderName: o.senderName ?? "Айгерим",
      senderContactName: o.senderContactName ?? "",
    },
    messageData,
  };
}

export const text = (t: string) => ({ typeMessage: "textMessage", textMessageData: { textMessage: t } });

/** Стикер WhatsApp — картинка webp */
export const webp = () => new Uint8Array([...new TextEncoder().encode("RIFF"), 0, 0, 0, 0, ...new TextEncoder().encode("WEBP"), ...new Array(32).fill(5)]);
