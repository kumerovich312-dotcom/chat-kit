// Поддельный Bot API Telegram для проверок: записывает вызовы методов, отдаёт файлы по getFile, умеет отвечать ошибкой.
// Настоящая сеть в тестах запрещена (tests/setup.ts). Ключи — тестовые, номера чатов и имена — вымышленные.

export const TOKEN = "000000000:test-secret-not-real-telegram-bot";
export const SECRET = "test-secret-not-real-telegram";
export const API = "https://api.telegram.org";

export type TgCall = {
  method: string;
  /** Поля запроса: JSON или текстовые поля формы загрузки */
  body: Record<string, unknown>;
  /** Форма загрузки файла (multipart) — если файл загружали */
  form: FormData | null;
};

type Answer = Response | Record<string, unknown>;

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Ответ Telegram с ошибкой: { ok: false, error_code, description, parameters } */
export const tgError = (code: number, description: string, parameters?: Record<string, unknown>) =>
  json({ ok: false, error_code: code, description, ...(parameters ? { parameters } : {}) }, code);

export function fakeTelegram(o: { token?: string } = {}) {
  const token = o.token ?? TOKEN;
  const calls: TgCall[] = [];
  /** Файлы клиента у Telegram: file_id → путь и содержимое (size — если Telegram должен назвать другой размер) */
  const files = new Map<string, { path: string; data: Uint8Array; size?: number }>();
  /** Скачанные пути файлов (адрес /file/bot…/<путь>) */
  const downloads: string[] = [];
  /** Файлы проекта по ссылкам (signFileLink): адрес → содержимое */
  const web = new Map<string, Uint8Array>();
  const webGets: string[] = [];
  /** Свой ответ метода: по очереди (первый вызов — первый ответ), потом — обычный */
  const queued = new Map<string, ((c: TgCall) => Answer | Promise<Answer>)[]>();
  let nextId = 500;

  const answer = (method: string, fn: (c: TgCall) => Answer | Promise<Answer>) => {
    queued.set(method, [...(queued.get(method) ?? []), fn]);
  };

  const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const filePrefix = `${API}/file/bot${token}/`;
    if (url.startsWith(filePrefix)) {
      const path = decodeURIComponent(url.slice(filePrefix.length));
      downloads.push(url.slice(filePrefix.length));
      const f = [...files.values()].find((x) => x.path === path);
      if (!f) return new Response("not found", { status: 404 });
      return new Response(new Blob([new Uint8Array(f.data)]), { status: 200, headers: { "content-length": String(f.data.byteLength) } });
    }
    const m = url.match(/^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/);
    if (!m) {
      webGets.push(url);
      const data = web.get(url);
      return data ? new Response(new Blob([new Uint8Array(data)]), { status: 200 }) : new Response("not found", { status: 404 });
    }
    const method = m[2] ?? "";
    const form = init?.body instanceof FormData ? init.body : null;
    const body: Record<string, unknown> = form
      ? Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === "string"))
      : (JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    const call: TgCall = { method, body, form };
    calls.push(call);
    if (m[1] !== token) return tgError(401, "Unauthorized");
    const own = queued.get(method)?.shift();
    if (own) {
      const r = await own(call);
      return r instanceof Response ? r : json(r);
    }
    if (method === "getFile") {
      const id = String(body.file_id);
      const f = files.get(id);
      return f
        ? json({ ok: true, result: { file_id: id, file_unique_id: `u-${id}`, file_size: f.size ?? f.data.byteLength, file_path: f.path } })
        : tgError(400, "Bad Request: invalid file_id");
    }
    if (method.startsWith("send")) {
      return json({ ok: true, result: { message_id: nextId++, date: 1790000000, chat: { id: Number(body.chat_id), type: "private" } } });
    }
    return json({ ok: true, result: true });
  }) as typeof fetch;

  return { fetch: fetchFn, calls, files, downloads, web, webGets, answer };
}
