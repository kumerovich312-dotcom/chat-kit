# Instagram Direct

Подключение `@muras/chat-kit/instagram` — переписка с клиентами в Instagram Direct через официальный API сообщений
Meta (Instagram Messaging API). Клиент пишет в Direct аккаунта компании — сообщение появляется в CRM; менеджер отвечает
из CRM — ответ уходит клиенту в Instagram.

## Что умеет

| | |
|---|---|
| Входящие | текст; фото, видео, голосовые, документы — файлами; упоминание в истории и ответ на историю; публикации и рилсы — ссылкой; нажатая кнопка-подсказка; «пришёл из рекламы»; «изменил» и «удалил сообщение» |
| Исходящие | текст (длинный — частями); файл по ссылке |
| Статусы | «прочитано» (две галочки) |
| Сообщения из приложения Instagram | сотрудник ответил с телефона — в CRM это «менеджер с телефона» |
| Нельзя | написать клиенту первым; пауза бота и «не отвечать» (это не бот-платформа); ответ с цитатой |

## Два способа подключения

Meta даёт два входа — у каждого свой адрес API и свой ключ. Набор работает с обоими, по умолчанию — первый.

| | Вход через Instagram | Вход через Facebook |
|---|---|---|
| Что нужно | профессиональный аккаунт Instagram | профессиональный аккаунт, привязанный к странице Facebook |
| Адрес API (`apiBase`) | `instagramApiBase()` → `https://graph.instagram.com/v23.0` | `instagramApiBase("facebook")` → `https://graph.facebook.com/v23.0` |
| Ключ (`accessToken`) | ключ аккаунта Instagram — живёт 60 дней, его надо продлевать | ключ страницы Facebook — из долгого ключа пользователя не истекает |
| Разрешения | `instagram_business_basic`, `instagram_business_manage_messages` | `instagram_basic`, `instagram_manage_messages`, `pages_manage_metadata`, `pages_show_list` |

Отправка в обоих — `POST /me/messages`: «me» — тот, чей ключ (аккаунт Instagram или страница Facebook). Поэтому номер
аккаунта в адрес не подставляется — при входе через Facebook он бы там не сработал.

## Настройка в кабинете Meta

1. **Аккаунт.** В приложении Instagram: аккаунт — профессиональный («Для бизнеса» или «Автор»). Там же: Настройки →
   Сообщения и ответы на истории → Подключённые инструменты → включить «Разрешить доступ к сообщениям». Без этого API
   сообщений не работает.
2. **Приложение.** developers.facebook.com → «Мои приложения» → создать приложение для бизнеса и добавить продукт
   Instagram; в нём — настройка API со входом через Instagram или через Facebook (названия разделов в кабинете Meta
   иногда меняет).
3. **Ключ.** Вход через Instagram: Instagram → «Настройка API со входом через Instagram» → добавить аккаунт → создать
   ключ. Вход через Facebook: привязать аккаунт к странице, получить ключ страницы с разрешениями из таблицы выше.
4. **Вебхук** (адрес, куда Meta присылает события). Кабинет → Webhooks, объект **Instagram**:
   - адрес обратного вызова: `https://<домен CRM>/api/instagram/webhook` (только https);
   - слово проверки (verify token) — любое, придумайте сами и сохраните в окружении проекта;
   - поля: `messages`, `messaging_seen`, `messaging_postbacks`, `messaging_referral`, `message_edit`
     (`message_reactions` не нужно — реакции набор не показывает).
   - подписать аккаунт на события: при входе через Instagram — переключатель у аккаунта в том же разделе (или
     `POST https://graph.instagram.com/v23.0/me/subscribed_apps?subscribed_fields=messages,messaging_seen,messaging_postbacks,messaging_referral`
     с ключом аккаунта); при входе через Facebook — `POST /<номер страницы>/subscribed_apps` с ключом страницы.
5. **Секрет приложения** — им Meta подписывает каждое уведомление (заголовок `X-Hub-Signature-256`): Настройки
   приложения → Основное → «Секрет приложения». У продукта Instagram (вход через Instagram) есть и свой «секрет
   приложения Instagram». Если в журнале проекта уведомления отклоняются с 401 «подпись неверна» — укажите второй
   секрет или оба сразу: `appSecret: [первый, второй]` (так же — на время смены секрета).
6. **Доступ к настоящим клиентам.** Пока приложение в режиме разработки, Meta присылает сообщения только от людей
   с ролью в приложении (администраторы, тестировщики). Для всех клиентов — проверка приложения Meta (App Review) на
   разрешение сообщений с расширенным доступом и режим «Опубликовано»; Meta может попросить подтвердить компанию.
7. **По желанию — метка HUMAN_AGENT** (ответ человека до 7 дней, см. ниже): разрешение Human Agent — отдельной
   проверкой Meta.

## Что хранить в окружении проекта

Названия переменных — как принято в проекте. В код и в репозиторий — никогда.

- ключ Instagram (или ключ страницы Facebook);
- секрет приложения Meta;
- слово проверки вебхука;
- номер аккаунта Instagram (`igUserId`) — если одно приложение Meta обслуживает несколько компаний (см. ниже).

Ключ входа через Instagram живёт 60 дней. Продлевать его можно, когда ему больше суток: раз в неделю по расписанию
вызвать `refreshInstagramToken(ключ)` и сохранить новый ключ у себя (в базе настроек — переменную окружения на ходу
не поменять).

## Маршрут приёма (Next.js)

Один адрес: GET — проверка адреса при сохранении вебхука в кабинете, POST — события.

```ts
// src/app/api/instagram/webhook/route.ts
import { after } from "next/server";
import { createInstagramAdapter, metaVerifyResponse } from "@muras/chat-kit/instagram";
import { ingest, jsonResponse, readWebhook } from "@muras/chat-kit/server";
import { chatStore } from "@/lib/chat-store";

const env = (name: string) => process.env[name] ?? ""; // названия — любые

// Проверка адреса: Meta ждёт hub.challenge простым текстом — не jsonResponse
export const GET = (req: Request) => metaVerifyResponse(req, env("META_VERIFY_TOKEN"));

export async function POST(req: Request) {
  const input = await readWebhook(req);
  if (!input) return jsonResponse({ status: 413, body: { ok: false, error: "Слишком большой запрос" } });
  const adapter = createInstagramAdapter({
    accessToken: env("INSTAGRAM_TOKEN"),
    appSecret: env("META_APP_SECRET"),
    fetchProfile: true, // имя и ник нового клиента — из Instagram
    // apiBase: instagramApiBase("facebook"), — при входе через Facebook
  });
  try {
    return jsonResponse(await ingest(adapter, chatStore(ORG_ID /* своя компания */), input, { later: after }));
  } catch (e) {
    console.error("[instagram] ошибка приёма:", e);
    return jsonResponse({ status: 500, body: { ok: false } });
  }
}
```

`later: after` обязательно: файлы скачиваются и сообщения из приложения Instagram записываются после ответа Meta.
Без него ответ Meta задержится на время скачивания и на 3 секунды у каждого «эха» (см. ниже).

**Несколько компаний на одном приложении Meta.** В одном уведомлении могут быть события разных аккаунтов. Номера
аккаунтов — `instagramAccounts(input.body)`; для каждого — подключение с ключом этой компании и `igUserId`: оно
разберёт только события своего аккаунта.

```ts
// import { createInstagramAdapter, instagramAccounts } from "@muras/chat-kit/instagram";
for (const account of instagramAccounts(input.body)) {
  const s = await instagramSettings(account); // своя таблица: номер аккаунта → компания и ключ
  if (!s) continue;
  const adapter = createInstagramAdapter({ accessToken: s.token, appSecret: env("META_APP_SECRET"), igUserId: account });
  const r = await ingest(adapter, chatStore(s.orgId), input, { later: after });
  if (r.status === 401) return jsonResponse(r); // подпись неверна — уведомление целиком не наше
}
return jsonResponse({ status: 200, body: { ok: true } });
```

`igUserId` — номер из уведомлений (`entry.id`); при входе через Instagram это `user_id` из
`GET /me?fields=user_id,username`, не поле `id` (у Meta это разные номера).

## Клиент в CRM

`ContactHint`: `source: "instagram"`, `externalId` — номер клиента у Instagram (IGSID, свой у каждого аккаунта
компании), `channel: "instagram"`, `name` и `username` — если включён `fetchProfile`. Телефона нет: по нему Instagram
с другими каналами не склеивается.

## Ответ менеджера

```ts
// 1) Сообщение — в базу до отправки (delivery = 'pending'): по нему набор узнает «эхо» этого сообщения
// 2) Отправка. externalId — IGSID клиента (ContactHint.externalId)
const r = await instagram.send(
  { externalId: client.instagramId, contactId: String(client.id) },
  {
    text,
    author: { type: "operator_crm", name: user.name, id: String(user.id) },
    messageId: String(messageId),
    file: file ? { name: file.name, mime: file.mime, url: signFileLink({ origin, path: `/files/${file.id}`, id: file.id, secret }) } : undefined,
  },
);
// 3) Сразу записать номер: external_id = r.externalId («ig:…»), delivery = 'sent';
//    ошибка — delivery = 'failed' и r.error (короткая причина по-русски), r.retryable — можно повторить позже
```

Номер `ig:…` нужен дважды: по нему не задвоится «эхо» и по нему встанут две галочки «прочитано».

- Ответ бота (`author.type: "bot"`) набор переводит из Markdown в чистый текст; текст человека уходит как написан.
- Файл — только ссылкой, которая открывается без входа (`signFileLink`): Meta забирает его сама. Загрузить файл
  данными API Instagram не умеет — `send` вернёт понятную ошибку.
- Подписи к файлу в Instagram нет: текст уходит следом отдельным сообщением.
- Длинный текст — несколькими сообщениями по порядку. Если часть ушла, а следующая — нет, `send` вернёт ошибку
  без повтора (иначе начало задвоится).

## 24 часа и метка HUMAN_AGENT

- Написать можно только клиенту, который написал сам, и только в течение **24 часов** после его последнего
  сообщения. Позже `send` вернёт: «Прошло больше 24 часов с последнего сообщения клиента — Instagram не даёт написать
  первым».
- С разрешением Human Agent от Meta и `humanAgentTag: true` человек может ответить **до 7 дней**: набор сначала
  отправляет как обычно, а при отказе «24 часа» повторяет с `messaging_type: "MESSAGE_TAG"`, `tag: "HUMAN_AGENT"`
  (остальные части длинного текста — сразу с меткой). Ответ бота метку не получает — Meta запрещает её для автоматики.
- Больше 7 дней — «Прошло больше 7 дней…»: ответить можно, когда клиент напишет снова.

## Что приходит в переписку

| Событие Instagram | В CRM |
|---|---|
| текст | сообщение клиента, клиент «ждёт ответа» |
| фото, видео, голосовое, документ | файлом (до 10 МБ, больше — настройка `maxFileBytes`); голосовое — аудио |
| упоминание аккаунта в истории | «Упоминание вашего аккаунта в истории: ссылка» и сама история файлом (история исчезнет через сутки) |
| ответ на историю компании | текст клиента и «Ответ на вашу историю: ссылка» |
| публикация, рилс | «Публикация: ссылка», «Рилс «название»: ссылка» |
| ответ на сообщение | цитата |
| кнопка-подсказка в начале диалога | текст кнопки от клиента |
| клиент из рекламы или по ссылке ig.me | служебная строка «Клиент пришёл из рекламы «…»» — один раз на объявление |
| изменил / удалил сообщение | служебная строка (прежний текст остаётся) |
| сообщение, которое Instagram не передаёт | подсказка посмотреть его в приложении Instagram |
| прочитано | две галочки у нашего сообщения |
| сотрудник ответил из приложения Instagram | «менеджер с телефона», клиент больше не ждёт; появляется через ~3 секунды |
| реакции | не показываем |

«Эхо». Instagram присылает копию каждого сообщения компании — и отправленного из приложения, и отправленного через
CRM. Копию сообщения из CRM набор узнаёт по номеру (память сервера, база проекта через `messageExists`), а если номер
ещё не записан — по недавнему сообщению из CRM с тем же текстом или файлом (`findMessages`). Поэтому переходнику
проекта стоит уметь `messageExists` и `findMessages` (образец — `src/server/memory-store.ts`). Ожидание перед записью
эха — `echoDelayMs` (3000 мс).

## Ограничения

- Первым написать нельзя, пауза бота и «не отвечать» — не поддерживаются (`caps`: `start`, `pause`, `mute` — false).
- Ответ с цитатой (`replyTo`) API Instagram не описывает — уходит обычным сообщением.
- Текст одного сообщения — до 1000 байт (около 500 русских букв): длиннее набор делит сам (`maxTextBytes`).
- Файлы, которые Meta примет по ссылке: фото JPG, PNG, GIF (около 8 МБ), видео и аудио (около 25 МБ), PDF.
- «Прочитано» Instagram присылает для последнего сообщения; у текста, разбитого на части, `send` возвращает номер
  последней части.
- Ссылки Instagram на файлы временные — набор скачивает файлы сразу после ответа Meta.
- Сообщения других программ, подключённых к тому же аккаунту (например, чат-бота), тоже придут «эхом» и будут
  подписаны «менеджер с телефона».
- Версия Graph API — `INSTAGRAM_GRAPH_VERSION` (`v23.0`). Другая — `apiBase: instagramApiBase("instagram", "v24.0")`.
- Если в приложении включено «Требовать секрет приложения» — `appSecretProof: true`.
