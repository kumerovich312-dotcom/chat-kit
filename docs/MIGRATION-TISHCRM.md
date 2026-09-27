# Переезд «Входящих» TishCRM на набор

Для чата TishCRM («Работа над Dental AI CRM»). Переезд делается в репозитории TishCRM по его правилам (после правки —
`npm run build` и перезапуск, логика — в `src/lib`, проверки — `npm test`, выкладка — своим порядком).

## Что даёт переезд

«Входящие» TishCRM сейчас — один клиентский файл на 511 строк без поиска, фильтров, шаблонов и просмотра фото. С набором:
- «Ждут ответа» и «Непрочитанные», поиск по имени и тексту, поиск внутри переписки;
- поле как в мессенджере (многострочное, шаблоны, файлы, заметки команды), сообщение сразу с часиками;
- голосовые с волной и перемоткой, просмотр фото с лупой и поворотом, Word / Excel / PDF плашками;
- уведомления «ждёт ответа» — один звонок на одно ожидание;
- места для студии: кнопки бота в шапке, «второй пилот», обучение бота, память бота.

И исправления того, что нашлось при изучении:
- лента брала 500 **самых старых** сообщений (`ORDER BY created_at LIMIT 500`) — у длинных диалогов пропадали новые:
  брать последние 500 (`ORDER BY created_at DESC, id DESC LIMIT 500`, затем перевернуть), порядок — ещё и по `id`;
- `delivery = ''` у ответов ИИ и напоминаний — «часики» навсегда: в наборе у сообщения без доставки часиков нет, а новым
  записям ставить `'sent'`;
- сбой отправки через QR сотрудник не видел (строка очереди `failed`, а сообщение `pending` навсегда) — шлюзу при сбое
  ставить `messages.delivery = 'failed'` и причину (правка шлюза — в чате TishCRM);
- автор `auto:<имя>` показывался как есть — `authorFromTish` даёт «<имя> · автоматически»;
- телефон в списке и шапке — `fmtPhone` / `maskPhone` из ядра (скрыть номер тем, кому не положено его видеть);
- файлы отдаются без Range — перемотка голосового не работает: адресу `/api/inbox/media/:id` добавить отдачу кусками
  и правильный `Content-Type` для `audio/ogg`, `video/mp4` (сейчас `application/octet-stream`).

## Порядок

1. Поставить набор (docs/CONNECT.md, шаг 1), стили — в корневой layout, цвета — `:root` (пример в CONNECT.md, шаг 2;
   тема «TishCRM» на демо-странице набора).
2. Переходник `src/lib/chat-store.ts` поверх `dialogs` / `messages` (ниже).
3. «Входящие»: `src/app/(crm)/inbox/page.tsx` + клиентская часть на компонентах набора.
4. Шлюз WhatsApp — подключение `@muras/chat-kit/wa-gateway`.
5. Nextbot — по желанию то же подключение, что у Атласа (`@muras/chat-kit/nextbot`), поверх своих таблиц
   `nextbot_settings` / `nextbot_events`; сейчас у TishCRM свой перенос из Атласа (`src/lib/nextbot.ts`).

## Переходник TishCRM

Клиент набора = **диалог** (`dialogs.id`): переписка у TishCRM живёт в диалогах, пациент привязывается к диалогу.

| Метод | TishCRM |
|---|---|
| `findOrCreateContact(hint)` | `dialogs` по `(org_id, wa_jid)`: для шлюза `wa_jid` — адрес WhatsApp, для Nextbot — `nb:<диалог>`; нет — `INSERT … ON CONFLICT (org_id, wa_jid)`; привязка пациента по телефону — `samePhone` (целиком для номеров с кодом страны) |
| `saveMessage` | `INSERT INTO messages (org_id, dialog_id, direction, author, body, wa_message_id, media_*, delivery) … ON CONFLICT DO NOTHING` по `messages_wamid_uq`; `author` — `authorToTish` |
| `saveFile` | `uploads/org_<id>/…` (как сейчас) — вернуть номер, по которому `saveMessage` запишет `media_*` |
| `markWaiting` | `dialogs.status` / `unread` — как сейчас у шлюза (или ничего, если «ждут ответа» считать запросом) |
| `notify` | то же, что сейчас делает `/api/internal/events`: уведомления сотрудникам |

«Ждут ответа» — подзапросом `waitSinceSql` по `messages`:

```ts
const WAIT_SINCE = waitSinceSql({
  table: "messages", contactColumn: "dialog_id", contactRef: "d.id", timeColumn: "created_at", scope: "x.org_id = $1",
  clientMessage: "x.direction = 'in' AND x.author = 'patient'",
  // ответ — ИИ, сотрудник или телефон клиники; напоминания (auto:) и служебные строки — не ответ
  reply: "x.direction = 'out' AND x.author <> 'system' AND x.author NOT LIKE 'auto:%' AND x.delivery IS DISTINCT FROM 'failed'",
});
```

Сообщения TishCRM → `ChatMessage`: автор — `authorFromTish(author)`, вложение — `{ id, name: media_name, mime: media_mime,
url: "/api/inbox/media/<id>" }`, `at` — `created_at`, `delivery` — `''` читать как «нет отметки».

## Шлюз WhatsApp (`apps/wa-gateway`)

Шлюз пишет сообщения в общую базу сам, а кабинету шлёт только «пациент написал». Подключение набора:

```ts
import { createWaGatewayAdapter } from "@muras/chat-kit/wa-gateway";

const wa = createWaGatewayAdapter({
  url: gatewayUrl, token: gatewayToken, orgId, // адрес и токен шлюза — из окружения, как сейчас у кабинета
  enqueue: (row) => q("INSERT INTO wa_outbox (org_id, wa_jid, body, media_path, media_type, media_mime, media_name, message_id) VALUES (…)", […]),
  setMode: (to, mode) => q("UPDATE dialogs SET status = $1 WHERE org_id = $2 AND wa_jid = $3", [mode === "bot" ? "ai" : "operator", orgId, to.externalId]),
});
```

- `/api/internal/events` → `ingest(wa, store, input)`: событие `message_in` превращается в «обновить экраны» (`refresh`).
- Ответ сотрудника: запись `messages` (`author = operator:<имя>`, `delivery = 'pending'`) → `wa.send(...)` кладёт строку в
  `wa_outbox`; доставку шлюз пишет сам. Ответ ИИ из Markdown подключение переводит в звёздочки WhatsApp.
- «Взять оператором» / «Вернуть ИИ» → `BotControls` (`control` → `setMode`): статус `operator` / `ai`.
- Подключение WhatsApp по QR — `wa.connect()` / `wa.disconnect()`; QR, как сейчас, из `wa_sessions`.
- «Не отвечать этому пациенту» шлюз пока не умеет — кнопка не показывается (`caps.mute = false`).

## Живое обновление

Сейчас — опрос каждые 3 с всего списка и 500 сообщений. С набором можно оставить опрос, но брать только новое
(`after_id`), и слить с показанным (`mergeMessages` из ядра). Звонок — `WaitAlerts` (вместо своего `NotifyProvider`
для сообщений). SSE — по желанию (проверить, что сжатие ответов на сервере не задерживает поток).
