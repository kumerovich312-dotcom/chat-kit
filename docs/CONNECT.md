# Как проект подключает набор — по шагам

Для Next.js 15 / 16 (App Router, server actions). Примеры — образцы: таблицы и поля у каждого проекта свои. С чего
начать и что спросить у владельца — [FOR-AI.md](FOR-AI.md).

## 1. Поставить набор

Набор ставится готовым файлом выпуска с GitHub (открытый репозиторий):

```bash
npm install https://github.com/kumerovich312-dotcom/chat-kit/releases/download/v0.1.0/muras-chat-kit-0.1.0.tgz
```

В `package-lock.json` запишется отпечаток файла — `npm ci` на сервере скачает его по HTTPS без ключей и без git и
проверит, что файл тот же. Код уже собран: `transpilePackages` в next.config не нужен. Нужен React 19.

Части пакета:

| Импорт | Что | Где |
|---|---|---|
| `@muras/chat-kit` | ядро: модель, «ждут ответа», телефоны, файлы, разметка, время, паспорт проекта, команда, статистика | сервер и браузер |
| `@muras/chat-kit/server` | «розетка» каналов, «переходник», приём, скачивание, подписи ссылок, присутствие, голосовые в Ogg | сервер |
| `@muras/chat-kit/ui` | окно переписки (React) | страница |
| `@muras/chat-kit/styles.css` | стили окна | корневой layout |
| `@muras/chat-kit/telegram`, `/instagram`, `/green-api`, `/email`, `/calls`, `/site`, `/nextbot`, `/studio` | каналы | сервер |
| `@muras/chat-kit/ai` | «розетка ИИ» | сервер |

## 2. Стили, цвета, тёмная тема

В корневом `app/layout.tsx` один раз:

```tsx
import "@muras/chat-kit/styles.css";
import { profileCss } from "@muras/chat-kit";
import { chatProfile } from "@/lib/chat-profile";

// в <head>: цвета из паспорта (только переменные --ck-*, без опасных знаков)
<style>{profileCss(chatProfile)}</style>
```

Или своими переменными в `globals.css`: `:root { --ck-accent: #0f8a5f; --ck-font: Inter, sans-serif; }`. Весь список
переменных — в начале `styles.css`. Тёмная тема — `<html data-ck-theme="dark">` (или `"auto"` — как в системе);
если проект задал свои светлые цвета в `:root`, тёмные он задаёт своим правилом для `[data-ck-theme="dark"]`.
Tailwind настраивать не нужно: у окна свои классы `ck-…`.

## 3. Переходник к своей базе

```ts
import type { ChatStore } from "@muras/chat-kit/server";

export function chatStore(orgId: number): ChatStore {
  return {
    // 1. Клиент: по адресу у подключения (chat_identities), потом по подлинному телефону (hint.phoneTrusted), иначе новый
    async findOrCreateContact(hint) { /* SELECT … ; INSERT … RETURNING id */ },
    // 2. Сообщение: ON CONFLICT (org_id, external_id) DO NOTHING — повтор не запишется; duplicate: true, если строки нет.
    //    Цитата: m.replyTo.externalId → найти своё сообщение с этим ключом и записать reply_to_id (или текст)
    async saveMessage(contactId, m) { /* INSERT … RETURNING id */ },
    // 3. Файл: сжать фото, если проект так делает, положить в хранилище, строка в chat_files
    async saveFile(contactId, f) { /* … */ },
    // 4. «Ждёт ответа»: проекту, который считает его подзапросом (waitSinceSql), делать ничего не нужно
    async markWaiting() {},
    // 5. Открытые вкладки: своя шина SSE или отметка для опроса
    notify(e) { /* bus.emit(orgId, e) */ },
    // По желанию — просят Nextbot, звонки, Instagram:
    async messageExists(externalId) { /* … */ return null; },
    async findMessages(contactId, q) { /* … */ return []; },
    async updateMessage(ref, patch) { /* … */ },
    state: { get: async (k) => null, set: async (k, v) => {}, delete: async (k) => {} }, // таблица chat_kv
  };
}
```

Образец целиком — `src/server/memory-store.ts` (переходник «в памяти»). Разделение компаний — здесь: переходник
создаётся уже для одной компании (по ключу вебхука или по сессии сотрудника).

## 4. Приём уведомлений канала

Каждый канал — свой адрес. Общая схема:

```ts
// src/app/api/telegram/route.ts
import { after } from "next/server";
import { ingest, jsonResponse, readWebhook } from "@muras/chat-kit/server";
import { createTelegramAdapter } from "@muras/chat-kit/telegram";

export async function POST(req: Request) {
  const input = await readWebhook(req);
  if (!input) return jsonResponse({ status: 413, body: { ok: false } });
  const adapter = createTelegramAdapter({ token: process.env.TG_BOT_TOKEN!, secretToken: process.env.TG_WEBHOOK_SECRET! });
  const r = await ingest(adapter, chatStore(ORG_ID), input, {
    later: after, // файлы — после ответа каналу
    hooks: { onContact: async ({ contactId, created }) => { if (created) await assignNew(contactId); } },
  });
  return jsonResponse(r);
}
```

Особенности каждого канала (как проверить подпись, что настроить у провайдера, чего канал не умеет) —
`docs/channels/<канал>.md`. Nextbot принимается одной строкой — `handleNextbotRequest(req, account, { later: after })`:
`account(key)` находит настройки компании по ключу из заголовка и собирает подключение и переходник.

## 5. Ответ сотрудника

Поле ввода отправляет одну форму; серверное действие читает её и отправляет через подключение:

```ts
"use server";
import { readComposerForm } from "@muras/chat-kit";
import { signFileLink, voiceForChannel } from "@muras/chat-kit/server";

export async function sendMessage(contactId: number, form: FormData) {
  const d = readComposerForm(form); // mode: send | copy | note | email, text, subject, file, fileId, replyTo, voice
  // права → файл (голосовое из поля — сперва voiceForChannel: WebM из Chrome станет Ogg) → строка messages
  // (delivery = 'pending', reply_to_id = d.replyTo) → adapter.send(to, { text, file: { url: signFileLink(…), mime, name,
  // voice: d.voice }, replyTo: { externalId: <ключ цитируемого у канала> }, author, messageId, idempotencyKey })
  // → delivery = 'sent' или 'failed' с причиной
  return { ok: true }; // или { error: "причина" } — поле покажет её и вернёт текст
}
```

Файл клиенту уходит ссылкой без входа на сутки — `signFileLink`; проверка на своём адресе файлов — `verifyFileLink`.

## 6. Страница «Переписка»

```tsx
import { ChatWindow } from "@muras/chat-kit/ui";

<ChatWindow profile={chatProfile} meId={user.id}
  list={{ dialogs, hrefFor, link, filter, status, tag, channel, counts, search, hasMore }}
  dialog={{
    id, name, channel, contact, messages, older: hasOlder ? { href: olderHref } : null,
    // полоса под шапкой
    status, snoozedUntil, tags, assignee, managers, assessment, presence,
    statusAction: setStatus.bind(null, id),   // форма: status (open / snoozed / closed), until
    tagsAction: toggleTag.bind(null, id),     // форма: tag, on (1 / 0)
    assignAction: assign.bind(null, id),      // форма: user_id (пусто — снять)
    typing: iAmTyping.bind(null, id),         // форма: state=typing, раз в 5 секунд
    // бот и ИИ
    bot: { state: botState, action: botCommand.bind(null, id) },         // форма: command, hours
    teach: canTeach ? { rate: rateBotAnswer, example: sendExample } : null,
    copilot: draft ? { text: draft } : null,
    memory: { facts, action: canTeach ? saveFact : undefined },
    summaryAction: summarize.bind(null, id),       // → { text, points } или { error }
    transcribeAction: transcribe.bind(null, id),   // форма: message_id, attachment_id → { text } или { error }
    improveAction: improve,                        // форма: text, mode, channel → { text } или { error }
    // свои кнопки проекта (паспорт: actions с kind "form")
    onAction: projectAction.bind(null, id),        // форма: action_id + поля → { ok } или { error }
    // ожидание и поле ввода
    waitSince, dismissAction: dismissWaiting.bind(null, id),
    composer: { action: sendMessage.bind(null, id), channel, live, templates, files: { upload: true } },
  }}
  side={<OrderPanel … />} />
```

Своя раскладка — части по отдельности: `DialogList`, `DialogHeader`, `DialogStrip`, `ChatScroller` + `ChatThread` +
`PendingBubbles` (внутри `PendingProvider`), `ChatFind`, `ThreadFilter`, `SummaryBar`, `ClientGallery`, `WaitBar`,
`Composer`.

Список диалогов — своим запросом; «ждут ответа», статус «сейчас» и «последнее от клиента» — подзапросами ядра:

```ts
import { waitSinceSql } from "@muras/chat-kit";
const WAIT_SINCE = waitSinceSql({
  table: "chat_messages", contactColumn: "contact_id", contactRef: "c.id", timeColumn: "at", scope: "x.org_id = $1",
  clientMessage: "x.kind = 'message' AND x.author_type = 'client' OR x.kind = 'call' AND x.author_type = 'client' AND (x.call->>'missed')::boolean",
  reply: "x.kind = 'message' AND x.author_type NOT IN ('client', 'system') AND x.delivery IS DISTINCT FROM 'failed' AND NOT x.handoff AND NOT x.shadow"
    + " OR x.kind = 'call' AND x.call IS NOT NULL AND NOT (x.call->>'missed')::boolean",
  handoff: "x.kind = 'message' AND x.handoff AND x.delivery IS DISTINCT FROM 'failed' AND NOT x.shadow",
  dismissedAt: "c.reply_dismissed_at",
});
```

Статус «сейчас» (`effectiveStatusSql`), время последнего от клиента (`lastClientAtSql`) и статистика ответов
(`responseEpisodesSql`) — в [TEAM.md](TEAM.md).

## 7. Живое обновление и звонок

Способ — свой: SSE или опрос раз в несколько секунд. `WaitAlerts` получает список ожиданий (`waitKey(клиент, с какого
времени)`) и звонит один раз на одно ожидание; с ботом — `delay` 40 000 и `recheck` (звонить, только если клиент всё ещё
ждёт человека). Кнопка включения — `NotifyToggle`. Присутствие коллег — `createPresenceHub` ([TEAM.md](TEAM.md)).

## 8. Адрес файлов

Вложения открываются по `Attachment.url` проекта с проверкой прав. Нужно: правильный `Content-Type` (голосовое —
`audio/ogg`, а не «скачать»), отдача кусками (Range) — иначе не перематывается голосовое, `?download=1` — скачать.
Поворот фото (`onRotate`) проект делает сам (например, библиотекой sharp) и отдаёт новую метку содержимого (`version`).

## Проверка после подключения

- Enter отправляет, сообщение видно сразу с часиками, потом галочки; ошибка — причина и «повторить».
- Клиент пишет — диалог в «Ждут ответа», один звонок; ответили — ушёл из «Ждут ответа».
- «Ответить» у сообщения — цитата уходит клиенту и видна в ленте; щелчок по цитате ведёт к исходному.
- Фото с лупой, голосовое играет и перематывается, «Расшифровать» даёт текст, PDF открывается, Word и Excel скачиваются.
- Фильтр, «все файлы клиента», «Кратко», статус и метки, меню «+» — работают; слова отрасли — во всех надписях.
- Поиск по переписке подсвечивает слова; телефон — по-местному; время — по поясу компании.
