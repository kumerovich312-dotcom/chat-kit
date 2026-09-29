# Инструкция для ИИ проекта: как взять chat-kit и докрутить

Ты — ИИ-разработчик в проекте владельца (CRM на Next.js). Тебе дали chat-kit — нейтральную основу переписки с
клиентами. Твоя задача — подключить её и докрутить под отрасль проекта **не правя саму основу**. Эта инструкция —
главная; подробности — в соседних файлах (ссылки ниже).

## Главные правила

1. **Основу не копировать и не править.** Набор ставится пакетом с номером версии. Всё, чем проект отличается, —
   через паспорт проекта (`defineProfile`), свои карточки и кнопки, места для своей разметки (render-функции),
   цвета (`--ck-*`) и свой переходник к базе. Так улучшения основы достаются проекту сменой версии.
2. **Не хватает возможности в основе** — не обходи её копией. Опиши, чего не хватает и зачем, и передай владельцу:
   основу дорабатывают в её собственном чате, потом проект обновляет версию.
3. **Данные — у проекта.** Набор ничего не хранит: клиенты, сообщения, файлы, сотрудники, права и разделение компаний
   (`org_id`) — в базе проекта, за переходником `ChatStore`.
4. **Секреты — в окружении проекта.** Ключи каналов и ИИ, адреса вебхуков, секрет подписи ссылок — только
   переменные окружения; в коде, в описаниях и в переписке с владельцем — никогда.
5. **Владелец — не программист.** Объясняй просто, показывай результат экраном. Для всего, что видно глазами, — сначала
   2–3 варианта на выбор.

## Шаг 0. Что спросить у владельца (одним сообщением, с вариантами ответа)

- Отрасль и **слова**: с кем переписываемся — клиент, пациент, кандидат, покупатель, ученик, гость? Кто отвечает —
  менеджер, администратор, рекрутёр, консультант? Что ведём по клиенту — заявку, запись, заказ, сделку?
- **Каналы**: WhatsApp (через GREEN-API или Nextbot), Telegram-бот, Instagram, почта, звонки (какая АТС), чат на сайте.
- **ИИ**: нужен ли бот (своя ИИ-студия или Nextbot), расшифровка голосовых, «Кратко», «Улучшить текст», оценка
  настроения и срочности (стоят денег — ключи Claude и сервиса расшифровки заводит владелец).
- **Команда**: кто отвечает клиентам, раздавать ли новые диалоги по очереди, какие **метки** нужны (VIP, жалоба…).
- **Свои карточки** в ленте (запись на приём, счёт, вакансия, заказ) и **свои кнопки** в поле ввода («Записать»,
  «Выставить счёт»): какие поля у каждой.
- **Цвета и шрифт** проекта (или взять из его текущего оформления).

## Шаг 1. Поставить набор

```bash
npm install https://github.com/kumerovich312-dotcom/chat-kit/releases/download/v0.1.0/muras-chat-kit-0.1.0.tgz
```

Номер версии — последний из CHANGELOG. В корневой `app/layout.tsx`: `import "@muras/chat-kit/styles.css";`.
Цвета — переменными `--ck-*` в своём CSS или из паспорта (`profileCss`). Тёмная тема — атрибут
`data-ck-theme="dark"` (или `"auto"`) на `<html>`. Подробно — [CONNECT.md](CONNECT.md), шаги 1–2.

## Шаг 2. Паспорт проекта

Один файл, например `src/lib/chat-profile.ts`:

```ts
import { defineProfile, NOUNS } from "@muras/chat-kit";

export const chatProfile = defineProfile({
  company: "Клиника «Пример»", timeZone: "Asia/Bishkek", phoneCode: "+996", currency: "сом",
  words: { client: NOUNS.patient, manager: NOUNS.administrator, order: NOUNS.appointment, botLabel: "ИИ-администратор" },
  features: { voice: true, statuses: true, tags: true, assignee: true, summary: true, improve: true, transcribe: true },
  tags: [{ code: "vip", label: "VIP", tone: "violet" }, { code: "complaint", label: "Жалоба", tone: "red" }],
  cards: {
    appointment: {
      title: "Запись на приём", icon: "calendar", tone: "blue",
      fields: [{ key: "at", label: "Когда", format: "datetime" }, { key: "doctor", label: "Врач" }],
      statusKey: "status", statuses: { planned: { label: "Записан", tone: "blue" }, done: { label: "Был на приёме", tone: "green" } },
    },
  },
  actions: [
    { id: "appointment", label: "Записать на приём", icon: "calendar", kind: "form", submitLabel: "Записать",
      fields: [{ key: "at", label: "Когда", type: "datetime-local", required: true }, { key: "doctor", label: "Врач", type: "select", options: ["Терапевт", "Хирург"] }] },
    { id: "address", label: "Адрес и часы", icon: "pin", kind: "insert", text: "{client}, мы работаем с 9:00 до 19:00, адрес: …" },
  ],
  theme: { "--ck-accent": "#0f8a5f" },
});
```

- Слова отрасли расходятся по всем надписям окна в нужных падежах («Пациенту», «Что бот знает о пациенте»). Готовые
  слова — `NOUNS`; своё — объект `{ one, of, to, many, ofMany, about }`. Любую надпись можно заменить в `texts`.
- Паспорт — простые данные: его можно хранить в базе (настройки компании) и отдавать в браузерные части окна.

## Шаг 3. База проекта

Если своей переписки в проекте ещё нет — таблицы по образцу (Postgres; названия — свои):

```sql
create table chat_contacts (
  id bigserial primary key, org_id bigint not null,
  name text not null default '', phone text, email text, channel text not null default '',
  status text not null default 'open', status_at timestamptz not null default now(), snoozed_until timestamptz,
  tags text[] not null default '{}', assignee_id text, reply_dismissed_at timestamptz, assessment jsonb,
  bot_mode text not null default 'bot', bot_paused_until timestamptz, unread int not null default 0,
  created_at timestamptz not null default now()
);
-- Адреса собеседника у подключений: чат Telegram, номер WhatsApp, почта, посетитель сайта
create table chat_identities (
  org_id bigint not null, contact_id bigint not null references chat_contacts(id),
  source text not null, external_id text not null, primary key (org_id, source, external_id)
);
create table chat_files (
  id bigserial primary key, org_id bigint not null, contact_id bigint not null,
  name text not null, mime text not null, size bigint not null, sha256 text not null, storage_key text not null,
  transcript text, version text, created_at timestamptz not null default now()
);
create table chat_messages (
  id bigserial primary key, org_id bigint not null, contact_id bigint not null references chat_contacts(id),
  at timestamptz not null, kind text not null, author_type text not null, author_id text, author_name text,
  channel text not null, text text not null default '', subject text, external_id text,
  delivery text, delivery_error text, handoff boolean not null default false, shadow boolean not null default false,
  reply_to_id bigint, reply_to_external text, reply_to_text text, call jsonb, card jsonb, file_id bigint references chat_files(id)
);
create unique index chat_messages_external on chat_messages (org_id, external_id) where external_id is not null;
create index chat_messages_thread on chat_messages (org_id, contact_id, at);
create table chat_kv (org_id bigint not null, key text not null, value text not null, primary key (org_id, key));
```

Если переписка в проекте уже есть — не меняй таблицы, а переведи их поля в модель набора в переходнике
(`ChatMessage`: автор — `client / bot / operator_crm / operator_phone / operator_admin / system`, время — до
миллисекунды, ключ повтора — `externalId`). Проверь при переезде:
- лента берёт **последние** N сообщений (`order by at desc, id desc limit N`, затем перевернуть), а не первые;
- ключи повтора, которые уже лежат в базе от старого кода канала, совпадают с ключами подключения набора
  (иначе при переезде старые сообщения задвоятся) — форматы ключей описаны в `docs/channels/<канал>.md`;
- адрес файлов отдаёт правильный `Content-Type` и **Range** (иначе не перематываются голосовые).

## Шаг 4. Переходник `ChatStore`

Один файл, например `src/lib/chat-store.ts`, создаётся уже для одной компании. Пять обязательных вещей:
найти или создать клиента (`findOrCreateContact`), записать сообщение без повторов (`saveMessage`, `ON CONFLICT DO
NOTHING` по ключу повтора), сохранить файл (`saveFile`), отметить «ждёт ответа» (`markWaiting` — можно ничего не
делать, если «ждут ответа» считается подзапросом), сообщить открытым вкладкам (`notify`). По желанию — `messageExists`,
`findMessages`, `updateMessage`, `state` (их просят Nextbot, звонки, Instagram). Образец — `src/server/memory-store.ts`,
по шагам — [CONNECT.md](CONNECT.md), шаг 3.

Правило привязки по телефону: к уже известному клиенту привязываем только по **подлинному** телефону
(`hint.phoneTrusted` — номер из самого WhatsApp или телефонной сети), иначе посторонний мог бы назвать чужой номер.

## Шаг 5. Каналы

Каждый канал — своё подключение и свой адрес приёма в проекте (`readWebhook` → `ingest(adapter, store, input,
{ later: after })` → `jsonResponse`). Что настроить у провайдера и в проекте:

| Канал | Описание |
|---|---|
| Telegram-бот | [channels/telegram.md](channels/telegram.md) |
| WhatsApp через GREEN-API | [channels/green-api.md](channels/green-api.md) |
| Instagram Direct | [channels/instagram.md](channels/instagram.md) |
| Почта | [channels/email.md](channels/email.md) |
| Звонки (любая АТС, Zadarma) | [channels/calls.md](channels/calls.md) |
| Чат на сайте | [channels/site.md](channels/site.md) |
| Nextbot | [CONNECT.md](CONNECT.md), шаг 4 |
| Своя ИИ-студия | [channels/studio.md](channels/studio.md) |

Ответ сотрудника уходит тем же подключением (`adapter.send`), доставку записывает проект.

## Шаг 6. Страница переписки

`ChatWindow` (или части по отдельности) на серверной странице, действия — server actions:

```tsx
<ChatWindow profile={chatProfile} meId={user.id} list={{ dialogs, hrefFor, link, filter, status, counts, search }}
  dialog={{ id, name, channel, contact, messages,
    status, snoozedUntil, tags, assignee, managers, assessment, presence,
    statusAction, tagsAction, assignAction, typing,
    bot: { state, action: botCommand }, teach: canTeach ? { rate, example } : null, copilot, memory,
    summaryAction, transcribeAction, improveAction, onAction,
    older: hasOlder ? { href: olderHref } : null,
    waitSince, dismissAction,
    composer: { action: sendMessage, channel, live, templates, files: { upload: true } } }}
  side={<OrderPanel … />} />
```

Что приходит в каждое действие (формы) — в комментариях к `ChatWindowDialog` и в [CONNECT.md](CONNECT.md), шаги 5–6.
Голосовое из поля ввода (форма `voice=1`) перед сохранением переведи в Ogg (`voiceForChannel` из
`@muras/chat-kit/server`) — тогда WhatsApp и Telegram покажут его голосовым, а не файлом.

## Шаг 7. Живое обновление, уведомления, «коллега уже отвечает»

- Способ — свой (SSE или опрос раз в несколько секунд): `store.notify` → шина проекта → страница перечитывает данные.
- Звонок «ждёт ответа» — `WaitAlerts` (один звонок на одно ожидание), кнопка включения — `NotifyToggle`.
- Присутствие: поле ввода само шлёт «пишу ответ» (`typing`), сервер держит отметки (`createPresenceHub`), страница
  получает их и отдаёт в `presence`. Подробно — [TEAM.md](TEAM.md).

## Шаг 8. ИИ

Ключи — в окружении; помощник собирается `combineAi(createClaudeAi(…), createOpenAiCompatibleTranscriber(…))`;
кнопки показываются только для того, что подключено (`aiCaps`). Оценку настроения и срочности вызывай после приёма
сообщения клиента и храни у диалога (`assessment`). Подробно — [AI.md](AI.md).

## Шаг 9. Команда и статистика

Статусы и «отложить до», раздача новых диалогов (`pickAssignee` в обработчике `onContact`), метки, статистика скорости
ответов (подзапрос для Postgres + `responseStats`) — [TEAM.md](TEAM.md). «Ждут ответа» для списка — `waitSinceSql`.

## Шаг 10. Проверить и показать владельцу

- Клиент пишет в каждый подключённый канал — сообщение в ленте один раз, в «Ждут ответа», один звонок.
- Ответ уходит, появляются часики, потом галочки; ошибка — причина и «повторить».
- Фото открывается с лупой, голосовое играет и перематывается, «Расшифровать» даёт текст.
- Слова отрасли — во всех надписях; тёмная тема; телефон (узкий экран).
- Свои карточки и кнопки «+» работают; статус, метки и ответственный сохраняются.
- Показать владельцу экраном, что сделано, и спросить про внешний вид — 2–3 варианта, где есть выбор.

## Обновление набора

Новая версия — ссылка с новым номером в package.json, `npm install`, проверки проекта, выкладка по правилам проекта.
Что изменилось — [CHANGELOG.md](../CHANGELOG.md).
