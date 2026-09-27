# Как проект подключает набор

Пошагово для Next.js 15 / 16. Примеры — образцы: таблицы и поля у каждого проекта свои.

## 1. Поставить набор

Набор ставится готовым файлом выпуска с GitHub (решение пользователя 27.09.2026 — открытый репозиторий):

```bash
npm install https://github.com/kumerovich312-dotcom/chat-kit/releases/download/v0.1.0/muras-chat-kit-0.1.0.tgz
```

В `package-lock.json` запишется отпечаток файла — `npm ci` на сервере скачает его по HTTPS без ключей и без git и
проверит, что файл тот же. Код уже собран: `transpilePackages` в next.config не нужен. Нужен React 19.

Обновление — поменять номер версии в ссылке, `npm install`, свои проверки, выкладка по правилам проекта.

## 2. Стили и цвета

В корневом `app/layout.tsx` один раз:

```ts
import "@muras/chat-kit/styles.css";
```

Свои цвета — переменными в своём CSS (`globals.css`), например у TishCRM:

```css
:root {
  --ck-font: Inter, system-ui, sans-serif;
  --ck-accent: #17a674;
  --ck-accent-dark: #0e6f4f;
  --ck-accent-soft: #d6f2e4;
  --ck-accent-line: #b0e6cf;
}
```

Весь список переменных — в начале `styles.css` (цвета, шрифт, размеры текста, скругления, пузыри, значки каналов,
подсветка поиска). Tailwind проекту ничего настраивать не надо: у окна свои классы `ck-…`.

## 3. Переходник к своей базе

Один файл, например `src/lib/chat-store.ts`. Разделение компаний — здесь: переходник создаётся для одной компании.

```ts
import type { ChatStore } from "@muras/chat-kit/server";

export function chatStore(orgId: number): ChatStore {
  return {
    // 1. Клиент: по адресу у подключения, потом по подлинному телефону (только WhatsApp), иначе новый
    async findOrCreateContact(hint) { /* SELECT … WHERE org_id = $1 AND … ; INSERT … */ },
    // 2. Сообщение: ON CONFLICT (org_id, external_id) DO NOTHING — повтор не запишется
    async saveMessage(contactId, m) { /* INSERT … RETURNING id; duplicate: true, если строки не добавилось */ },
    // 3. Файл: свой порядок хранения (сжать фото, положить в сделку)
    async saveFile(contactId, f) { /* … */ },
    // 4. «Ждёт ответа»: проекту, который считает его запросом (waitSinceSql), делать ничего не нужно
    async markWaiting() {},
    // 5. Открытые вкладки: своя шина SSE или отметка для опроса
    notify(e) { /* notifyOrg(orgId) */ },
    // По желанию — нужно Nextbot: messageExists, findMessages, updateMessage, state
  };
}
```

Образец целиком — `src/server/memory-store.ts` (переходник «в памяти»). Перевод авторов в свои поля: у Атласа
`messages.sender` client / bot / manager / phone, у TishCRM — `authorFromTish` / `authorToTish` из
`@muras/chat-kit/wa-gateway`.

## 4. Приём уведомлений канала

Nextbot — одной строкой в маршруте:

```ts
// src/app/api/nextbot/events/route.ts
import { after } from "next/server";
import { createNextbotAdapter, handleNextbotRequest, nextbotHealth } from "@muras/chat-kit/nextbot";

async function account(key: string) {
  const s = await settingsByKey(key); // своя таблица настроек: ключ компании, ссылка вебхука, включено ли
  if (!s) return null;
  const store = chatStore(s.orgId);
  return {
    enabled: s.enabled, store,
    adapter: createNextbotAdapter({ settings: { enabled: s.enabled, webhookUrl: s.webhookUrl, managerNote: s.note, phoneCode: "+996" }, store }),
    hooks: {
      onContact: async ({ contactId, created }) => { /* новое обращение → сделка */ },
      onLead: async ({ contactId, fields }) => { /* заявка бота → поля сделки */ },
      onFunction: async (name, args) => (name === "vacancies" ? findVacancies(args) : null),
    },
  };
}
export const POST = (req: Request) => handleNextbotRequest(req, account, { later: after });
export const GET = (req: Request) => nextbotHealth(req, account);
```

`later: after` — файлы скачиваются после ответа Nextbot: сообщение видно сразу, фото — через секунду.

## 5. Ответ менеджера

Поле ввода отправляет форму; серверное действие читает её и отправляет через подключение:

```ts
"use server";
import { readComposerForm } from "@muras/chat-kit";

export async function sendMessage(clientId: number, form: FormData) {
  const d = readComposerForm(form); // mode: send | copy | note | email, text, file…
  // права, запись в базу (delivery = 'pending'), затем adapter.send(…) и delivery = 'sent' или 'failed' с причиной
  return { ok: true }; // или { error: "причина" } — поле покажет её и вернёт текст
}
```

Файл клиенту в Nextbot или студию уходит ссылкой без входа на сутки — `signFileLink` (`@muras/chat-kit/server`),
проверка на своём адресе файлов — `verifyFileLink` (подписи совместимы с прежними ссылками Атласа и TishCRM).

## 6. Страница «Переписка»

```tsx
import { ChatWindow } from "@muras/chat-kit/ui";

<ChatWindow timeZone={user.timezone} list={{ dialogs, hrefFor, link, filter, counts, search }}
  dialog={{ id, name, channel, contact, messages,
    composer: { action: sendMessage.bind(null, id), channel, live, templates },
    bot: { state, action: botCommand.bind(null, id) },           // кнопки бота в шапке
    teach: canTeach ? { rate: rateBotAnswer, example: sendExample } : null, // обучение — только кому можно
    copilot: draft ? { text: draft } : null,                       // «второй пилот»
    memory: { facts, action: canTeach ? saveFact : undefined },    // что бот знает о клиенте
    waitSince, dismissAction: dismissWaiting.bind(null, id) }}
  side={<DealPanel … />} />
```

Своя раскладка — части по отдельности: `DialogList`, `DialogHeader`, `ChatScroller` + `ChatThread` + `PendingBubbles`
(внутри `PendingProvider`), `ChatFind`, `WaitBar`, `Composer`.

«Ждут ответа» для списка и счётчика — подзапросом:

```ts
import { waitSinceSql } from "@muras/chat-kit";
const WAIT_SINCE = waitSinceSql({
  table: "messages", contactColumn: "client_id", contactRef: "c.id", timeColumn: "created_at", scope: "x.org_id = $1",
  clientMessage: "x.direction = 'in' AND x.channel IN (…)",
  reply: "x.direction = 'out' AND x.channel IN (…) AND x.delivery IS DISTINCT FROM 'error' AND NOT x.handoff",
  handoff: "x.direction = 'out' AND x.handoff",
  dismissedAt: "c.reply_dismissed_at",
});
```

## 7. Живое обновление и звонок

Набор не навязывает способ: SSE, опрос раз в несколько секунд — как у проекта. `WaitAlerts` получает список ожиданий
(`waitKey(клиент, с какого времени)`) и звонит один раз на одно ожидание; с ботом — `delay` 40 000 и `recheck`
(звонить, только если клиент всё ещё ждёт человека). Кнопка включения — `NotifyToggle`.

## 8. Адрес файлов

Вложения открываются по `Attachment.url` проекта с проверкой прав. Нужно: правильный `Content-Type` (голосовое —
`audio/ogg`, а не «скачать»), отдача кусками (Range) — иначе не работает перемотка голосового, `?download=1` —
скачать. Поворот фото (`onRotate`) проект делает сам (у Атласа — sharp) и отдаёт новую метку содержимого.

## Проверка после подключения

- Enter отправляет, сообщение видно сразу с часиками, потом галочка; ошибка — причина и «повторить».
- Клиент пишет — диалог в «Ждут ответа», один звонок; ответили — ушёл из «Ждут ответа».
- Фото открывается с лупой, голосовое играет и перематывается, PDF открывается, Word и Excel скачиваются.
- Поиск по переписке подсвечивает слова; телефон — по-местному; время — по поясу компании.
