# Почта

Подключение `@muras/chat-kit/email` (только для сервера): письмо клиента появляется в той же ленте переписки, что и
мессенджеры; менеджер отвечает из CRM — ответ уходит письмом в ту же цепочку писем. Без библиотек: письма принимаются
вебхуком в виде JSON, отправляет их проект — своей SMTP-библиотекой или готовым способом для Postmark. Код —
`src/channels/email`, проверки — `tests/channels/email`.

## Что умеет

| | |
|---|---|
| Входящие | письма из Postmark Inbound и из универсального JSON (его шлёт любой мост: Cloudflare Email Worker, свой опрос ящика); в ленте — только ответ клиента, без прошлой переписки, подписи и «Отправлено с iPhone» (Gmail, Outlook, Яндекс, Mail.ru, Apple Mail, Thunderbird — по-русски и по-английски); письмо только в HTML — читаемым текстом, ссылки — «текст (адрес)»; тема; вложения — файлами; ответ на наше письмо — с цитатой |
| Пропускает | автоответы, отчёты о недоставке, рассылки, спам (по пометке почтового сервиса), письма с наших же адресов |
| Исходящие | ответ письмом в ту же цепочку (тема «Re: …», заголовки In-Reply-To и References); текст и HTML; ответ бота — с разметкой; файл |
| Статусы | «доставлено», «не доставлено» с причиной, «прочитано» (по желанию) — вебхуками Postmark или от своего моста |
| Нельзя | вебхуки multipart (SendGrid Inbound Parse, Mailgun) напрямую — только JSON; копии (Cc) и несколько получателей; пауза бота и «не отвечать» |

```
клиент пишет на hello@company.example
  → Postmark Inbound или свой мост (Cloudflare Email Worker, опрос ящика) — POST JSON с ключом приёма
  → маршрут проекта: readWebhook → ingest(createEmailAdapter(…)) → переходник проекта → лента
менеджер отвечает в CRM
  → adapter.send → набор собирает письмо → отправитель проекта (SMTP-библиотека или postmarkSender) → клиент
```

## 1. Как письма попадают в CRM — выбрать один путь

### Вариант А. Postmark Inbound

Postmark (postmarkapp.com) принимает письма за вас и присылает каждое вебхуком JSON вместе с вложениями.

1. В Postmark: сервер (Server) → поток **Inbound** → у потока свой адрес вида `<хэш>@inbound.postmarkapp.com`.
2. Направить туда письма клиентов — один из способов:
   - **переадресация** с ящика компании (в Gmail, Яндексе, Mail.ru — правило «пересылать все письма на адрес…»);
   - **свой домен**: MX-запись поддомена (например, `reply.company.example`) → `inbound.postmarkapp.com`, домен — в
     настройках потока Inbound (по инструкции Postmark «Inbound domain forwarding»). Тогда письма на
     `hello@reply.company.example` сразу идут в CRM.
3. **Адрес вебхука** потока Inbound — маршрут проекта с ключом приёма паролем Basic-входа:
   `https://postmark:<ключ приёма>@<сайт>/api/email/inbound`. Имя перед двоеточием — любое, пароль — ключ приёма.
   Postmark подписей не ставит — ключ в адресе и есть защита; без него или с чужим подключение отвечает 401.
4. Галочку «Include raw email content» не ставить: исходник письма набору не нужен, запрос стал бы вдвое тяжелее.
5. Кнопка проверки вебхука в кабинете — подключение отвечает 200 и клиента не заводит (узнаёт проверочное письмо
   Postmark).
6. Ответ не 200 — Postmark повторяет письмо до 10 раз с растущими паузами. Повтор не задваивает переписку: ключ
   письма — его номер (Message-ID).

Postmark помечает спам заголовком `X-Spam-Status`: такие письма подключение пропускает (`acceptSpam: true` —
принимать). Postmark сам вырезает ответ из цитаты только у английских писем (`StrippedTextReply`) — его подключение и
берёт; остальные письма режет само (раздел 4).

### Вариант Б. Свой мост — универсальный JSON

Любая программа, которая получает письмо, может прислать его в CRM одним запросом `POST` на маршрут проекта с
заголовком `Authorization: Bearer <ключ приёма>`:

```json
{
  "from": { "email": "client@example.com", "name": "Клиент Тест" },
  "to": ["hello@company.example"],
  "subject": "Вопрос по заказу",
  "text": "Текст письма (text/plain)",
  "html": "<p>HTML письма</p>",
  "messageId": "<abc-0001@mail.example.com>",
  "inReplyTo": "<ck.4f…@company.example>",
  "references": ["<…>", "<ck.4f…@company.example>"],
  "date": "2026-09-27T08:00:00Z",
  "headers": { "auto-submitted": "no", "precedence": "" },
  "attachments": [
    { "name": "Договор.pdf", "mime": "application/pdf", "contentBase64": "JVBERi0xLjQK…" },
    { "name": "Фото.jpg", "mime": "image/jpeg", "url": "https://files.example/photo.jpg" }
  ]
}
```

| Поле | Что это |
|---|---|
| `from` | отправитель — **обязательно**: `{ email, name }`, `{ address, name }` или строкой «Клиент Тест <client@example.com>» |
| `to` | кому (массив или строка через запятую) — для справки |
| `subject`, `text`, `html` | тема, текст, HTML; хотя бы одно из `text` и `html`. Закодированные заголовки (`=?UTF-8?B?…?=`) понимаются |
| `messageId` | номер письма (заголовок Message-ID) — по нему повтор не записывается второй раз; без него — по содержимому |
| `inReplyTo`, `references` | заголовки цепочки: по ним в ленте видно, на какое наше письмо ответили |
| `date` | время отправки: ISO или как в заголовке Date |
| `headers` | заголовки письма (объект или массив `{ name, value }`) — нужны, чтобы узнать автоответ, рассылку, спам |
| `attachments` | файлы: `name`, `mime`, содержимое base64 в `contentBase64` **или** ссылка `url`; `contentId` — картинка внутри письма |

Ссылкой (`url`) принимаются только файлы, которые набор узнаёт по содержимому (фото, PDF, Word и Excel без макросов,
аудио, видео), и только с открытых адресов (не внутренних) — текст, CSV и прочее присылайте base64.

Статус нашего письма (если мост умеет узнавать доставку) — тем же адресом:
`{ "event": "status", "messageId": "<ck.…@company.example>", "status": "delivered", "error": "…" }`, где `status` —
`sent`, `delivered`, `read` или `failed` (с причиной в `error`).

**Cloudflare Email Worker** (Email Routing → правило «Send to a Worker»). Пример — сверьте с документацией Cloudflare и
библиотеки postal-mime (это зависимость воркера, а не набора):

```js
import PostalMime from "postal-mime";

const toBase64 = (data) => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

export default {
  async email(message, env) {
    const mail = await PostalMime.parse(message.raw);
    const res = await fetch(env.CRM_EMAIL_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.CRM_EMAIL_TOKEN}` },
      body: JSON.stringify({
        from: mail.from, to: (mail.to ?? []).map((a) => a.address),
        subject: mail.subject, text: mail.text, html: mail.html,
        messageId: mail.messageId, inReplyTo: mail.inReplyTo, references: mail.references, date: mail.date,
        headers: Object.fromEntries(mail.headers.map((h) => [h.key, h.value])),
        attachments: mail.attachments.map((a) => ({ name: a.filename, mime: a.mimeType, contentId: a.contentId, contentBase64: toBase64(a.content) })),
      }),
    });
    // CRM не приняла письмо из-за сбоя — не теряем: копия в обычный ящик компании
    if (res.status >= 500) await message.forward(env.BACKUP_MAILBOX);
  },
};
```

**Свой опрос ящика по IMAP** — скрипт проекта (его библиотеки, например imapflow и mailparser) забирает новые письма и
шлёт то же JSON. Повторно присланное письмо не задвоится: ключ — `messageId`.

## 2. Что проект хранит в окружении

- **ключ приёма писем** — придумать случайную строку от 32 знаков из латинских букв и цифр (например,
  `openssl rand -hex 32`); другие знаки мешают вставить ключ в адрес вебхука Postmark;
- **адрес отправителя** — «Компания <hello@company.example>» (не секрет, можно в настройках);
- для отправки через Postmark — **ключ сервера Postmark** (Server API token, раздел «API Tokens» сервера);
- для отправки своей SMTP-библиотекой — адрес, порт, логин и пароль почтового сервера.

Названия переменных — на выбор проекта. Несколько компаний — у каждой свой ключ приёма и свой адрес отправителя
(в своей таблице настроек), адрес вебхука — с номером компании.

## 3. Маршрут приёма (Next.js)

```ts
// src/lib/email.ts — подключение одно на приём и на отправку
import { createEmailAdapter, postmarkSender } from "@muras/chat-kit/email";

const env = (name: string) => process.env[name] ?? ""; // названия — любые

export function emailAdapter() {
  return createEmailAdapter({
    inboundToken: env("EMAIL_INBOUND_TOKEN"),
    from: "Компания <hello@company.example>",
    send: postmarkSender({ serverToken: env("POSTMARK_SERVER_TOKEN") }), // или своя SMTP-библиотека (раздел 5)
  });
}
```

```ts
// src/app/api/email/inbound/route.ts (из файла маршрута Next.js экспортируются только GET, POST и настройки)
import { after } from "next/server";
import { EMAIL_WEBHOOK_MAX_BYTES } from "@muras/chat-kit/email";
import { ingest, jsonResponse, readWebhook } from "@muras/chat-kit/server";
import { chatStore } from "@/lib/chat-store";
import { emailAdapter } from "@/lib/email";

export async function POST(req: Request) {
  // Письмо приходит вместе с вложениями — запрос тяжёлый (по умолчанию readWebhook берёт до 1 МБ)
  const input = await readWebhook(req, EMAIL_WEBHOOK_MAX_BYTES);
  if (!input) return jsonResponse({ status: 413, body: { ok: false, error: "Слишком большое письмо" } });
  try {
    return jsonResponse(await ingest(emailAdapter(), chatStore(ORG_ID /* своя компания */), input, { later: after }));
  } catch (e) {
    console.error("[email] ошибка приёма:", e);
    // Postmark повторит письмо позже — второй раз оно не запишется
    return jsonResponse({ status: 500, body: { ok: false } });
  }
}
```

- `later: after` — вложения сохраняются после ответа вебхуку: письмо видно сразу, файлы — через мгновение.
- Автоответы, рассылки, спам и письма с наших адресов подключение принимает ответом 200 «пропущено» — иначе Postmark
  присылал бы их снова.
- Новому клиенту — заявка, сделка: хук `onContact` в `ingest(…, { hooks })`, как у других каналов.
- Вебхуки доставки Postmark (раздел 6) можно направить на этот же адрес — подключение само отличит их от писем.

## 4. Как письмо выглядит в переписке

- **Клиент — адрес отправителя**: `ContactHint` = `{ source: "email", externalId: "<адрес маленькими буквами>",
  channel: "email", email: "<тот же адрес>", name: "<имя из From>" }`. Переходник может привязать письмо к уже
  известному клиенту с этой почтой (например, оставившему заявку на сайте). Помните: адрес отправителя в письме можно
  подделать; ответы всё равно уйдут на настоящий адрес, а проверку подлинности (SPF, DKIM) почтовый сервис пишет в
  заголовки `Received-SPF` и `Authentication-Results`.
- **Текст — только ответ клиента.** Отрезаются прошлая переписка («On … wrote:», «… написал(а):», «пт, 26 сент. 2026 г.
  в 10:00, Компания <…>:», «-----Original Message-----», шапка Outlook «От: … Отправлено: … Кому: … Тема: …»), строки
  цитаты «>», подпись после «-- » и хвосты «Отправлено с iPhone», «Отправлено из мобильной Почты Mail.ru». Ответ снизу
  и вперемешку с цитатой не теряется. Пересланное письмо («Forwarded message», тема «Fwd:» / «Пересл.:») остаётся
  целиком. Если после чистки ничего не осталось — в ленту идёт весь текст письма.
- **Письмо только в HTML** — читаемым текстом: абзацы, списки «- пункт», таблицы строками, ссылки «текст (адрес)».
  Сам HTML в окне не показывается никогда (так безопаснее).
- **Длина** — до 20 000 знаков; дольше — обрезается с «…». Больше 32 пробелов подряд сокращаются до 32.
- **Тема** — у сообщения (`subject`), окно показывает её строкой «✉ тема». Письмо без текста, но с темой — строка
  «(без текста)»; без текста и без темы — только файлы.
- **Время** — из заголовка Date (время из будущего набор заменяет временем приёма).
- **Повтор** — ключ сообщения `mail:<Message-ID без скобок>`: то же письмо второй раз не запишется.
- **Ответ на наше письмо** — у сообщения `replyTo`: ключ нашего письма (из In-Reply-To). Если проект сохранил ключ
  отправленного письма (раздел 5), лента покажет цитату нашего сообщения; если нашего письма в CRM нет — начало цитаты
  из самого письма клиента.
- **Вложения.** base64 из вебхука набор кладёт в ссылку `data:` и сохраняет файл после ответа (`download` подключения);
  тип — по содержимому файла, простой текст и CSV — по словам письма. Архивы, программы, страницы HTML, картинки SVG,
  старые Word и Excel (в них бывают макросы) не сохраняются; файлы больше 10 МБ (`maxFileBytes`) — тоже; из одного
  письма — не больше 20 файлов. Пропущенное не теряется молча: в ленте служебная строка «Не все вложения письма
  сохранены: «архив.zip» — такие файлы не сохраняем …». Маленькие картинки внутри письма (логотипы и значки в
  подписи, меньше 4 КБ — `skipInlineBelow`) и электронная подпись письма (smime.p7s) пропускаются без строки.
- **Не письма клиентов** (ответ 200, «пропущено», клиента не заводим): автоответы (`Auto-Submitted`, `X-Autoreply`,
  тема «Автоматический ответ:», «Out of Office»), отчёты о недоставке (`MAILER-DAEMON`, `postmaster`,
  `X-Failed-Recipients`), рассылки (`Precedence: bulk | list | junk`, `List-Unsubscribe`, `List-Id`), спам
  (`X-Spam-Status: Yes`), письма с наших адресов: `from`, `replyToAddress` и `ownAddresses` (можно доменом:
  `ownAddresses: ["@company.example"]` — письма коллег).
- **Сохранение файла.** У файлов из письма `NewFile.sourceUrl` — сама ссылка `data:` с содержимым (мегабайты):
  в базу её сохранять не нужно — храните `sourceUrl`, только если он начинается с `http`.

## 5. Ответ из CRM

```ts
"use server";
import { readComposerForm } from "@muras/chat-kit";
import { replySubject } from "@muras/chat-kit/email";
import { emailAdapter } from "@/lib/email";

export async function sendEmail(clientId: number, form: FormData) {
  const d = readComposerForm(form);
  // Последнее письмо клиента из своей базы: его ключ (externalId) и тема — чтобы ответ лёг в ту же цепочку
  const last = await lastClientEmail(clientId);
  // права, запись в базу с delivery = 'pending', затем:
  const r = await emailAdapter().send({ externalId: client.email /* ContactHint.externalId */ }, {
    text: d.text,
    subject: d.subject || replySubject(last?.subject),               // «Re: <тема>»; нет — «Ответ на ваше письмо»
    replyTo: last ? { externalId: last.externalId } : null,          // In-Reply-To и References
    author: { type: "operator_crm", name: user.name, id: String(user.id) },
    idempotencyKey: `msg:${messageId}`,                              // повтор — с тем же номером письма
    file: d.file ? { name: d.file.name, mime: d.file.type, data: new Uint8Array(await d.file.arrayBuffer()) } : undefined,
  });
  // r.ok — delivery = 'sent' и externalId = r.externalId («mail:<номер письма>»); иначе delivery = 'failed', причина r.error
}
```

- **Сохраните `r.externalId` у сообщения.** По нему придут статусы доставки и найдётся цитата, когда клиент ответит.
- **Тема.** Поле ввода окна показывает вкладку «Письмо» с полем темы, если передать ему `emailTo` (адрес клиента) и
  `replySubject` (тема последнего письма клиента) — тема сразу «Re: …». Без темы подключение ставит «Ответ на ваше
  письмо» (`defaultSubject` — своя).
- **Цепочка.** С `replyTo` письмо уходит с заголовками In-Reply-To и References — почта клиента покажет его в той же
  цепочке. Без `replyTo` — новое письмо (так можно написать и первым: `caps.start: true`).
- **Номер письма** (Message-ID) набор ставит сам: `<ck.…@домен from>` (домен — `domain`). С `idempotencyKey` номер
  всегда один и тот же: письмо, отправленное повторно после сбоя связи, почта клиента может узнать как то же самое.
- **Текст.** Ответ бота (`author.type: "bot"`) написан разметкой Markdown: в текст письма он уходит без разметки,
  в HTML — с жирным, курсивом и ссылками. Текст менеджера — как набран; в HTML адреса становятся ссылками.
- **Reply-To.** Если письма принимает другой адрес, чем тот, с которого они уходят (например, адрес Postmark
  `<хэш>@inbound.postmarkapp.com`), — `replyToAddress`: ответ клиента придёт прямо в CRM.
- **Файл**: данными (`file.data`, лучше всего), файлом на диске сервера (`file.path`) или ссылкой (`file.url` —
  её забирает отправитель). До 10 МБ (`maxFileBytes`); без текста — «Во вложении: <имя файла>».
- `adapter.compose(to, out)` — собрать письмо, не отправляя (посмотреть, что уйдёт).

### Отправка через Postmark

```ts
send: postmarkSender({ serverToken: env("POSTMARK_SERVER_TOKEN"), messageStream: "outbound" })
```

- Адрес отправителя (или весь домен) должен быть подтверждён в Postmark (Sender Signatures / Domains: DKIM и
  Return-Path) — иначе ошибка «Адрес отправителя не подтверждён». Новый аккаунт Postmark, пока его не одобрили, пишет
  только на адреса своего домена.
- Набор передаёт Postmark свой номер письма (заголовок Message-ID) и кладёт его в `Metadata` (`ck-message-id`) —
  по нему вебхуки доставки находят письмо в переписке.
- Файл по ссылке `postmarkSender` сначала забирает сам: только http(s), не внутренние адреса, до 7 МБ
  (`maxFileBytes`; Postmark принимает письмо до 10 МБ вместе с файлами). Свои адреса для файлов — `allowHost`.
- `trackOpens: true` — статус «прочитано» (вебхук Open). В письмо добавляется невидимая картинка; не у всех клиентов
  она загружается, поэтому «прочитано» — не точно.

### Отправка своей SMTP-библиотекой

Отправитель — функция проекта: получает готовое письмо `OutgoingMail` (поля названы как у распространённых
SMTP-библиотек) и возвращает номер, с которым письмо ушло. Например, с nodemailer (зависимость проекта):

```ts
import nodemailer from "nodemailer";

const smtp = nodemailer.createTransport({ host: env("SMTP_HOST"), port: 465, secure: true, auth: { user: env("SMTP_USER"), pass: env("SMTP_PASSWORD") } });

createEmailAdapter({
  inboundToken: env("EMAIL_INBOUND_TOKEN"),
  from: "Компания <hello@company.example>",
  send: async (mail) => {
    const info = await smtp.sendMail({
      from: mail.from, to: mail.to, replyTo: mail.replyTo, subject: mail.subject, text: mail.text, html: mail.html,
      messageId: mail.messageId, inReplyTo: mail.inReplyTo, references: mail.references,
      attachments: mail.attachments?.map((a) => ({ filename: a.name, contentType: a.mime, ...(a.data ? { content: Buffer.from(a.data) } : { path: a.url }) })),
    });
    return { messageId: info.messageId };
  },
});
```

- Ошибки nodemailer и похожих библиотек подключение переводит само: неверный логин (`EAUTH`), нет связи
  (`ECONNECTION`, `ETIMEDOUT` — можно повторить), сервер не принял адрес (`EENVELOPE`, код 550), «повторите позже»
  (коды 4xx). Свои причины — `throw new MailSendError("Лимит писем на сегодня исчерпан", true)`: текст покажется
  менеджеру как есть, второй аргумент — можно ли повторить.
- Postmark через SMTP: добавьте заголовки `X-PM-KeepID: true` (иначе Postmark заменит номер письма своим) и
  `X-PM-Metadata-ck-message-id: <номер письма без скобок>` (для статусов).

Ошибки (`r.error`) — коротко по-русски:

| Когда | Текст | Повторять |
|---|---|---|
| у клиента нет почты | У клиента нет адреса почты — письмо отправить некуда | нет |
| отправка не настроена | Отправка писем не настроена: подключите SMTP или почтовый сервис в настройках проекта | нет |
| файл больше лимита | Файл «…» больше 10 МБ — письмом не отправить | нет |
| неверный ключ Postmark | Postmark не принял ключ сервера — проверьте ключ в окружении проекта | нет |
| отправитель не подтверждён | Адрес отправителя не подтверждён в Postmark — подтвердите его (Sender Signatures) или домен | нет |
| адрес отключён в Postmark | Postmark больше не отправляет писем на этот адрес: раньше письмо не дошло или клиент пожаловался на спам | нет |
| слишком часто (429) | Postmark просит подождать: слишком много писем подряд — повторите позже | да |
| сбой Postmark (5xx), нет связи | Postmark временно недоступен / Нет связи с Postmark — повторите позже | да |
| SMTP: логин | Почтовый сервер не принял логин или пароль — проверьте настройки отправки почты | нет |
| SMTP: нет связи | Нет связи с почтовым сервером — попробуйте ещё раз | да |

## 6. Статусы доставки

Postmark: сервер → поток **outbound** → Webhooks → добавить вебхук на адрес приёма (тот же, с ключом паролем
Basic-входа) и отметить события **Delivery**, **Bounce**, **Spam Complaint** (и **Open**, если включён `trackOpens`).

| Событие Postmark | Статус в переписке |
|---|---|
| Delivery | доставлено |
| Open | прочитано |
| Bounce (HardBounce, SoftBounce, DnsError, Blocked…) | не доставлено: «Письмо не доставлено: адрес не существует или ящик закрыт» и т. п. |
| Spam Complaint | не доставлено: «Клиент пометил письмо как спам — Postmark больше не отправит ему писем» |
| Bounce AutoResponder, Transient; Click, Subscription Change | пропускается (это не недоставка) |

Статус находит сообщение по ключу `mail:<номер письма>` — через `updateMessage` переходника (метод по желанию; без
него статусы не записываются). Порядок событий у почты не гарантирован: чтобы «прочитано» не сменилось на
«доставлено», сравнивайте статусы по `DELIVERY_RANK` из ядра. Другой почтовый сервис — статусы от своего моста в
универсальном JSON (раздел 1).

## 7. Ограничения

`EMAIL_CAPS = { text: true, files: true, pause: false, mute: false, start: true, statuses: true }`:

- **Только JSON.** Вход набора — тело запроса строкой, поэтому вебхуки multipart/form-data (SendGrid Inbound Parse,
  Mailgun) напрямую не подходят: нужен мост, который переложит письмо в универсальный JSON.
- **Размер.** Письмо с вложениями приходит одним запросом (до `EMAIL_WEBHOOK_MAX_BYTES` = 50 МБ). На хостингах с
  лимитом тела запроса (Vercel — 4,5 МБ) письма с большими вложениями не дойдут: нужен свой сервер или мост, который
  кладёт файлы в хранилище и присылает ссылки (`url`).
- **Один получатель** — клиент. Копии (Cc, Bcc) и другие адресаты письма клиента в ответ не попадают.
- **Чистка цитат — по приметам.** Подпись к цитате и шапку прошлого письма узнаём у распространённых почтовых
  программ; у редкой программы кусок прошлой переписки может остаться в тексте.
- **HTML письма не показывается** — только текст; картинки внутри письма приходят отдельными файлами после текста.
- Архивы, программы, старые Word и Excel, файлы календаря (.ics) и winmail.dat не сохраняются — служебная строка.
- **Время** — из заголовка Date, его ставит почтовая программа клиента: если у клиента сбиты часы, письмо встанет не
  на своё место (время из будущего набор заменяет временем приёма).
- Пауза бота и «не отвечать» (`pause`, `mute: false`) — у почты нет бота; если проект отвечает на письма своим ИИ,
  паузу ведёт проект.

## 8. Для особых случаев

- `splitReply(text)` → `{ reply, quote }`, `htmlToText(html)`, `mailHtml(text, { markdown })`, `replySubject(subject)` —
  чистка текста и сборка HTML без сети.
- `parsePostmarkInbound(body)`, `parseJsonMail(body)` → письмо в одном виде (`ParsedMail`); `postmarkStatusEvents`,
  `jsonStatusEvents` — статусы; `emailWebhookAuthorized(input, ключ)` — проверка ключа приёма.

## Проверка после подключения

- Написать с Gmail на адрес компании — в CRM новый клиент с именем из письма, тема «✉ …», текст без подписи; клиент в
  «Ждут ответа».
- Ответить из CRM — письмо пришло в ту же цепочку (Gmail показывает одним разговором), тема «Re: …».
- Клиент отвечает на него — в ленте его ответ без цитаты и отметка, на какое наше письмо он ответил.
- Приложить к письму PDF и фото — файлы в ленте; архив — служебная строка.
- Включить автоответ «я в отпуске» в ящике клиента и написать ему — автоответ в CRM не попадает.
- Postmark: в Activity у вебхуков ответ 200; после отправки — статус «доставлено».
