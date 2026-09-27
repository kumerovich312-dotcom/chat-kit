# Переезд «Переписки» Атласа на набор

Для чата Атласа. Переезд делается в репозитории Атласа по его правилам: демо-стенд 30004, проверки `scripts/checks`,
«да» пользователя перед выкладкой на сервер. Здесь — что на что меняется и где подводные камни.

## Что даёт переезд

- Одна основа с TishCRM и студией: правка окна один раз — во всех проектах.
- Время сообщений до секунды (просьба пользователя), подписи «менеджер с телефона» / «ИИ-агент» как сейчас.
- Места для студии: кнопки бота в шапке, «второй пилот», обучение бота, память бота — включаются, когда появится студия.
- Исправления: видео из Nextbot сохранялось как голосовое (в `detectType` проверка `ftyp` для m4a стояла раньше
  проверки видео — в наборе `sniffFile` различает их); сравнение телефонов +7 (Казахстан и Россия) — целиком, а не по
  9 цифрам.

## Порядок

1. **Поставить набор** (docs/CONNECT.md, шаг 1) и подключить стили в `src/app/layout.tsx`. Значения по умолчанию —
   палитра Атласа; добавить только шрифт: `:root { --ck-font: "Golos Text", system-ui, sans-serif; }`.
2. **Nextbot** — ядро переезда, делать первым и отдельно от окна.
3. **Окно «Переписки»** и лента карточки клиента.
4. **Проверки** — поправить под новую разметку, прогнать весь набор на стенде 30004, показать пользователю.
5. Выкладка — после «да».

## 2. Nextbot: `src/lib/nextbot.ts` → `@muras/chat-kit/nextbot`

Разбор событий, «Полный диалог», время, автор, файлы и отправка переехали в набор без изменения правил. В Атласе
остаются: настройки (`nextbot_settings`, страница «Настройки → Nextbot», ключ `nb_…`), журнал обмена
(`nextbot_events`), клиенты и сделки, «Возможный дубль», второй диалог после объединения карточек
(`nextbot_dialog_aliases`), заявка и функция «Найти вакансии».

Маршрут `src/app/api/nextbot/events/route.ts` — `handleNextbotRequest(req, account, { later: after })`, где `account(key)`
находит `nextbot_settings` по ключу и собирает подключение и переходник для этой компании (пример — CONNECT.md, шаг 4).

### Переходник Атласа (`src/lib/chat-store.ts`)

| Метод | Как в Атласе сейчас (перенести SQL из `handleIncoming`) |
|---|---|
| `findOrCreateContact(hint)` | клиент по `clients.nextbot_dialog_id`; иначе второй диалог из `nextbot_dialog_aliases` (сделать основным); иначе по телефону — **только** `hint.phoneTrusted` (WhatsApp) и клиент без диалога; иначе новый клиент (`pickManager`, источник — канал, `ensureLeadSource`) и строка «Возможный дубль…», если телефон совпал. Временное имя («Клиент из…», «@ник») заменить на `hint.name`; пустой телефон — заполнить. Вернуть `name` и `channel` (= `clients.messenger`) |
| `saveMessage` | `INSERT INTO messages … ON CONFLICT (org_id, external_id) WHERE external_id IS NOT NULL DO NOTHING`; `direction` = `in` у клиента, иначе `out`; `sender`: client → client, bot → bot, operator_phone → phone, operator_admin → manager без автора («менеджер в Nextbot»), operator_crm → manager; `deal_id` — открытая сделка; `read_at = now()` у исходящих; `handoff`, `file_id`; `created_at = m.at` |
| `saveFile` | `shrinkImage` + `storeFile(org, deal, ext, data)` + `INSERT INTO files … source 'nextbot', pinned FALSE` (в документы — только кнопкой) |
| `markWaiting` | ничего: «Ждут ответа» считает `WAIT_SINCE` (его можно собрать `waitSinceSql` — тот же расчёт) |
| `notify` | `notifyOrg(orgId)` |
| `messageExists` | `SELECT id, client_id FROM messages WHERE org_id = $1 AND external_id = $2` |
| `findMessages` | как сейчас в дампе: по `external_id = ANY(…)` и наши (`direction = 'out'`) по `text = ANY(…)`, плюс последние N наших; вернуть `sender` → автор, `file_id`, `delivery` |
| `updateMessage` | `UPDATE messages SET sender / handoff / file_id / text / delivery …` |

Хранилище подключения (`media` в `createNextbotAdapter`) — поверх таблиц Атласа, чтобы уже забранные файлы не
качались заново:
- `lookup(clientId, urls)` — `nextbot_media` по `url = ANY(…)` (ключи вида `sha1:<клиент>:<отпечаток>` там уже лежат) и
  время первого сообщения клиента с этим `file_id`;
- `remember` — `INSERT … ON CONFLICT (org_id, url) DO UPDATE SET file_id = COALESCE(nextbot_media.file_id, EXCLUDED.file_id)`;
- `folders` / `saveFolders` — `nextbot_settings.media_folders`;
- `botEventsSince(ms)` — есть ли в `nextbot_events` строка `kind = 'bot_message'`, `status = 'ok'` с этого времени
  (так Атлас узнаёт, что сценарий «Новое сообщение агента» настроен); `noteBotEvent` — ничего (журнал пишет `log`).

`canStoreFiles(clientId)` — есть ли у клиента сделка (файл лежит в сделке). `log` — запись в `nextbot_events` и
`nextbot_settings.last_event_at / last_sent_at / last_error`.

Обработчики (`hooks`):
- `onContact` — новое обращение → сделка на первом этапе воронки (`create_deals`, `funnel_id`, `applyStageEntry`,
  строка «Новое обращение в …»), только для `lead` и `custom` с именем `nextbot:client_message`; вернуть
  `{ deal_id, created_deal }` — попадут в ответ Nextbot, как сейчас;
- `onLead` — поля сделки и анкеты, заметка «ИИ-агент собрал обращение…» (`sender = 'bot'`);
- `onFunction("vacancies")` — `agentVacancyAnswer`.

Отправка (`sendManagerMessage` / `deliverMessage`): запись `messages` (`sender = 'manager'`, `delivery = 'pending'`,
`external_id = atlas:<uuid>`), затем `adapter.send({ externalId: dialogId, contactId }, { text, author, messageId,
idempotencyKey: external_id, file })` → `delivery = 'sent'` или `'error'` с причиной. Заметку боту «не перебивай» при
первом ответе за 6 часов подключение шлёт само (нужен `store` в настройках подключения и `delivery` в `findMessages`).
Файл — `file.url = signFileLink({ origin, path: "/files/<id>", id, secret, scope: "file" })` — с тем же секретом
подписи, что сейчас: прежние ссылки продолжают работать. Смена этапа — `adapter.notification(dialogId, text)`.

### Совместимость с уже записанными данными — не менять

- Ключи повтора строк дампа `nb:<диалог>:<sha1(время|автор|текст)[0..32]>` и событий `nb:<message_id>` — в наборе те
  же: старые строки не задвоятся.
- Файлы: `nb:file:<клиент>:<sha1>` и ключи `sha1:<клиент>:<sha1>` в `nextbot_media` — те же.
- Служебные строки «Nextbot не доставил…» теперь с ключом `nb:<диалог>:notice:<sha1>`; прежние (без ключа) могут
  один раз повториться — не страшно.
- Первое сообщение, когда «Полный диалог» состоит из одной строки, разбирается как раньше (строкой целиком) — это
  поведение Атласа, в наборе не менялось; проверить на стенде.

## 3. Окно: `src/app/(crm)/inbox/*` → `@muras/chat-kit/ui`

| Атлас | Набор |
|---|---|
| `chat-thread.tsx` | `ChatThread` (серверный, как сейчас): `renderSystem` — «Возможный дубль… Объединить карточки», `renderAttachmentExtra` — `FilePin`, `viewerPanel` — «Куда положить», `onRotate` — `rotateFile`, звонки — `kind: "call"` + `call` + `canListen`, `resendAction` — `resendMessage` |
| `chat-look.tsx` | стили набора (`ck-msg--in/out/bot`, `ck-note`), `waitText` — ядро |
| `chat-composer.tsx`, `pending.tsx` | `Composer` + `PendingProvider` / `PendingBubbles`: вкладки те же, шаблоны — `templateGroups: { deal: "По сделке клиента" }`, скрепка — `files: { upload, project }`; действия читают форму `readComposerForm` (поля те же: mode, channel, direction, text, subject, file, file_id) |
| `chat-find.tsx`, `chat-scroller.tsx` | `ChatFind`, `ChatScroller` (подсветка — `::highlight(ck-find)` в стилях набора; `globals.css` Атласа больше не нужен для этого) |
| `wait-label.tsx`, полоса «Ответ не нужен» | `WaitLabel`, `WaitBar` |
| `components/attachment.tsx`, `voice-player.tsx`, `clients/[id]/file-viewer.tsx` | `Attachment`, `VoicePlayer`, `FileViewer` / `FileViewerHost` (голосовое — без `blob:`, адрес `/files/[id]` уже умеет Range) |
| `page.tsx` (список, фильтры, шапка, сделка справа) | `DialogList` + `DialogHeader` (или `ChatWindow`), сделка — `side`; SQL списка — свой, строки → `DialogSummary` |
| `(crm)/notify.ts`, звук в `live-updates.tsx` | `notify.ts` набора и `WaitAlerts` (поток `/api/live` остаётся Атласа) |
| `lib/messenger-links.ts` | ядро: `waLink`, `tgLink`, `messengerGreeting` (параметр `agency` → `company`), `messengerState` |
| `lib/phone.ts`, `lib/channels.ts`, `lib/waiting.ts`, `lib/search.ts` | ядро (можно оставить файлы Атласа реэкспортом, чтобы не трогать остальной код) |

Сообщение Атласа → `ChatMessage`: `id` строкой, `at` = `created_at`, `kind` — `note` / `system` / `call` / `message`
(по `channel`), автор — по `sender` (и `author` / `author_id` для имени и «вы»), вложение —
`{ id, name, mime, size, url: "/files/<id>", version: file_v }`.

## 4. Проверки

- `test-units.mjs`: проверки телефонов, `nextbot-media`, `messenger-links` — теперь в наборе (там они на вымышленных
  данных); в Атласе можно оставить как есть, если файлы стали реэкспортом.
- `test-chat.mjs`, `test-nextbot.mjs` ищут классы Tailwind в HTML (`self-start`, `self-end`, `bg-warn-soft`,
  `bg-violet-soft`) — заменить на классы набора: `ck-msg--in`, `ck-msg--out`, `ck-note`, `ck-msg--bot`;
  подпись времени теперь с секундами.
- Весь набор проверок — на стенде 30004; перед сервером — «да» пользователя.
