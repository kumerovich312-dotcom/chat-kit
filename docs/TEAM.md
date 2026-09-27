# Команда: статусы, раздача, метки, «коллега уже отвечает», статистика ответов

Набор даёт правила и слова, а данные хранит проект: статус диалога, ответственного, метки, отметки присутствия,
сообщения. Всё ниже — из ядра `@muras/chat-kit` (сервер и браузер), кроме приёмника отметок присутствия — он в
`@muras/chat-kit/server`. Время везде — по поясу компании из паспорта проекта (`profile.timeZone`).

## 1. Статус диалога и «Отложить»

Что проект хранит у диалога (названия колонок — свои):

| Поле | Что значит |
|---|---|
| `status` | `open` — в работе, `snoozed` — отложен, `closed` — закрыт; пусто — открыт |
| `status_at` | когда статус поставили |
| `snoozed_until` | до какого времени отложен; пусто — пока клиент не напишет |

Кнопки окна и что записать:

- «Отложить» → `status = 'snoozed'`, `status_at = сейчас`, `snoozed_until` = выбранное время;
- «Закрыть диалог» → `status = 'closed'`, `status_at = сейчас`;
- «Открыть снова» → `status = 'open'`, `status_at = сейчас`.

**Правило** (`effectiveStatus`): отложенный диалог сам снова открыт, когда пришло его время или клиент написал после
того, как его отложили; закрытый — когда клиент написал после закрытия. «Клиент написал» — его сообщение или
пропущенный звонок от него. Заданий по расписанию не нужно: статус «сейчас» считается при показе.

В списке диалогов — выражение для SQL (то же правило, проверено на Postgres):

```ts
import { effectiveStatusSql, lastClientAtSql } from "@muras/chat-kit";

const STATUS = effectiveStatusSql({
  status: "c.status", statusAt: "c.status_at", snoozedUntil: "c.snoozed_until",
  // Своя колонка «когда клиент писал последний раз» быстрее; нет её — подзапрос по сообщениям
  lastClientAt: lastClientAtSql({
    table: "messages", contactColumn: "client_id", contactRef: "c.id", timeColumn: "created_at",
    scope: "x.org_id = c.org_id",
    // Сообщение клиента или его пропущенный звонок
    clientMessage: "x.direction = 'in' AND (x.kind = 'message' OR x.kind = 'call' AND x.call_missed)",
  }),
});
// Вкладка «Открытые»: SELECT c.id, c.name, ${STATUS} AS status FROM clients c WHERE c.org_id = $1 AND ${STATUS} = 'open'
```

Условия пишутся для строки с псевдонимом `x` (как у `waitSinceSql`); сам запрос списка не должен называть свою
таблицу `x`. Хранит проект статус по-другому (числом) — вместо `c.status` передайте выражение
`CASE c.state WHEN 2 THEN 'closed' … END`.

В окне, когда переписка уже загружена:

```ts
import { effectiveStatus, lastClientAt } from "@muras/chat-kit";
const status = effectiveStatus(dialog, { now: Date.now(), lastClientAt: lastClientAt(messages) });
```

Меню «Отложить» — `snoozeChoices(new Date(), profile.timeZone)`: «На 1 час», «На 3 часа», «До вечера (18:00)» (только
до 18:00), «Завтра утром (9:00)», «В понедельник (9:00)» (не в воскресенье), «Через неделю». У каждого варианта —
точное время `until` (его и записать) и подсказка `hint` («до завтра 9:00»). Часы утра и вечера можно поменять:
`snoozeChoices(now, tz, { morningHour: 8, eveningHour: 19 })`. Подпись у отложенного диалога —
`untilLabel(snoozedUntil, Date.now(), profile.timeZone)`: «до 18:00», «до завтра 9:00», «до 3 окт 9:00».

Своё время по часам компании (например, «12 октября в 15:00») — `companyTime({ year, month, day, hour }, timeZone)`:
учитывает пояс и переход на летнее время.

## 2. Раздача новых диалогов по очереди

`pickAssignee({ candidates, lastId, strategy, channel })` выбирает, кому дать новый диалог:

- `candidates` — сотрудники в постоянном порядке: `{ id, name, active?, load?, max?, channels? }`. Пропускаются те,
  кто не на смене (`active: false`), у кого диалогов уже столько, сколько можно (`load >= max`), и кто не ведёт
  канал нового диалога (`channels` не задан или пуст — ведёт все);
- `strategy: "round"` (по умолчанию) — следующий после `lastId`, по кругу; `lastId` нет в списке — с начала списка;
- `strategy: "least"` — у кого меньше диалогов в работе; при равенстве — чья очередь ближе;
- `null` — некому: диалог остаётся «не назначен» в общей очереди.

Место — крючок `onContact` приёма (`ingest`): он вызывается, когда клиент найден или заведён; `created: true` —
новый диалог.

```ts
import { after } from "next/server";
import { pickAssignee } from "@muras/chat-kit";
import { ingest } from "@muras/chat-kit/server";

const result = await ingest(adapter, store, input, {
  later: after,
  hooks: {
    async onContact({ contactId, created, hint }) {
      if (!created) return; // раздаём только новые диалоги
      await db.transaction(async (tx) => {
        const team = await teamForAssign(tx, orgId); // свои: кто на смене, сколько открытых диалогов, предел, каналы
        const lastId = await lastAssigned(tx, orgId); // строка «кому дали прошлый» — SELECT … FOR UPDATE
        const who = pickAssignee({ candidates: team, lastId, channel: hint.channel });
        if (!who) return;
        await setAssignee(tx, contactId, who.id);
        await saveLastAssigned(tx, orgId, who.id);
      });
    },
  },
});
```

- Блокировка строки (`FOR UPDATE`) нужна, чтобы два клиента, написавшие в одну секунду, не ушли одному человеку.
  Проект без своей таблицы может держать «кому дали прошлый» в `store.state` (ключ → значение) — без блокировки,
  при малом потоке этого достаточно.
- `load` — сколько открытых диалогов у сотрудника: `COUNT(*) … WHERE assignee_id = … AND ${STATUS} = 'open'`.
- Результат зависит только от входа: те же данные — тот же сотрудник (удобно проверять).

## 3. Метки

- Какие метки есть — в паспорте проекта: `tags: [{ code: "vip", label: "VIP", tone: "violet" }]`. У диалога хранятся
  только коды (массив или своя таблица).
- Перед записью — `normalizeTagCodes(codes)`: без пробелов по краям, строчными буквами, без повторов и пустых.
- Показ: `sortTags(dialog.tags, profile.tags)` — в порядке паспорта, неизвестные в конце; `tagOf(code, profile.tags)` —
  надпись и цвет. Метки нет в паспорте (удалили) — `null`: показать код как есть или скрыть.

## 4. «Коллега уже отвечает»

Чтобы двое не ответили клиенту одновременно, окно показывает, кто из коллег открыл диалог и кто пишет ответ.

```
браузер сотрудника ── отметка «смотрит / пишет / ушёл» ──▶ адрес проекта ──▶ createPresenceHub()
        ▲                                                                        │ кто сейчас в диалоге
        └──────────── живой канал проекта (SSE или опрос) ◀──────────────────────┘
```

Когда слать отметку из браузера:

- открыл диалог — «смотрит» сразу и дальше раз в 20–30 с;
- печатает — «пишет», не чаще раза в 3–5 с;
- отправил ответ или стёр текст — снова «смотрит»;
- закрыл диалог или вкладку — «ушёл» (`navigator.sendBeacon` при `pagehide`).

«Пишет» без новых отметок дольше 10 с показывается как «смотрит», отметка старше минуты не показывается совсем.

Адрес проекта (Next.js):

```ts
// src/app/api/inbox/presence/route.ts
import { createPresenceHub } from "@muras/chat-kit/server";

const hub = createPresenceHub(); // один на процесс сервера

export async function POST(req: Request) {
  const me = await currentUser(); // своя проверка входа
  if (!me) return new Response(null, { status: 401 });
  const { contactId, state } = (await req.json()) as { contactId: string; state: "viewing" | "typing" | "leave" };
  if (!(await canSeeDialog(me, contactId))) return new Response(null, { status: 403 });
  const list = state === "leave"
    ? hub.leave(String(contactId), me.id)
    : hub.touch(String(contactId), { userId: me.id, name: me.name, state: state === "typing" ? "typing" : "viewing" });
  broadcast(me.orgId, { type: "presence", contactId, list }); // свой живой канал: вкладки обновят подпись
  return Response.json({ list });
}
```

- Номер и имя сотрудника берутся из входа, а не из запроса: иначе можно «написать» от чужого имени.
- В окне: `presenceText(activePresence(list, { now: Date.now(), meId: me.id }))` → «Айгерим пишет ответ…»,
  «Айгерим и Бакыт смотрят этот диалог». Себя не показываем; кто пишет — важнее тех, кто смотрит. Пересчитывайте
  подпись раз в несколько секунд — устаревшие отметки уйдут и без новых событий.
- Для значков в списке диалогов — `hub.snapshot()`: все диалоги, где кто-то есть.
- `createPresenceHub` держит отметки в памяти **одного** процесса. Если у проекта несколько процессов сервера
  (несколько копий приложения, бессерверный хостинг) — нужно общее хранилище: своя таблица «диалог, сотрудник, имя,
  состояние, время отметки» (запись с заменой, показ `WHERE at > now() - interval '1 minute'`), Redis или
  «присутствие» самого живого канала. Правило показа то же — `activePresence` и `presenceText`.

## 5. Статистика ответов

**Обращение** — клиент начал ждать ответа: написал или не дозвонился, а до этого не ждал. Пока ждёт, его новые
сообщения — то же обращение. Кончается первым настоящим ответом — тем же, что снимает «Ждут ответа»: наше сообщение,
которое ушло или уходит (не заметка, не служебное, не недоставленное, не черновик бота), или состоявшийся разговор
по телефону.

- **Бот передал человеку** («передаю менеджеру»). Клиент уже ждёт — обращение продолжается: время идёт с его первого
  сообщения, передача ответом не считается. Не ждал (бот ответил, а потом передал) — с передачи начинается новое
  обращение: клиент ждёт человека. Кончается первым настоящим ответом — человека или бота.
- **«Ответ не нужен»** (клиент написал «спасибо») закрывает обращение без ответа: оно не в счёт ни в ответах, ни
  в «ждут сейчас».
- **Одно время** (у неточных каналов — до секунды): ответ в ту же секунду, что и сообщение клиента, — ответ за 0 с.
  Если в одну секунду ответили двое, засчитывается человек раньше бота, дальше — по номеру сотрудника.
- **Звонки**: пропущенный входящий — клиент ждёт; состоявшийся разговор — ответ; входящий звонок записан от клиента,
  поэтому в статистике его автор — «менеджер с телефона» (см. `authorType` ниже).

Что считает `responseStats` за период (обращения, **начатые** в периоде):

| Число | Что значит |
|---|---|
| `dialogs`, `episodes` | сколько диалогов и обращений, где клиент ждал ответа |
| `answered`, `unanswered`, `dismissed` | с ответом; ждут ответа сейчас; «ответ не нужен» |
| `medianSec`, `avgSec`, `p90Sec` | время первого ответа в секундах: медиана (половина ответов быстрее), среднее, 90 % ответов быстрее |
| `within` | доля ответов быстрее целей (по умолчанию 5, 15 и 60 минут): из ответов и тех, кто ждёт уже дольше цели; кто ждёт меньше — ещё может успеть и не в счёт |
| `longestWaitSec` | сколько ждёт тот, кто ждёт дольше всех |
| `humans`, `bot` | то же время отдельно для людей и для бота (доля — из их ответов) |
| `byManager`, `byChannel` | по сотрудникам (только ответы людей) и по каналам |

Ответ позже `now` считается ещё не пришедшим — можно посмотреть итоги «на момент». Для показа — `durationText(sec)`:
«45 с», «2 мин 5 с», «1 ч 10 мин», «2 дн 3 ч».

Периоды «Сегодня», «Вчера», «7 дней», «30 дней», «Эта неделя», «Этот месяц» — от полуночи по поясу компании:
`statsPeriod("week", new Date(), profile.timeZone)` → `{ from, to, label }` (`to` — не включая).

### Как посчитать в базе

Для одного загруженного диалога — `episodesOf(messages, contactId, { dismissedAt })`. За период по всем клиентам —
запрос `responseEpisodesSql` (Postgres; совпадение с `episodesOf` проверено тестом на сотнях случайных диалогов).
Условия — те же, что проект уже передаёт в `waitSinceSql`, написанные для строки `x`:

```ts
import { durationText, episodesFromRows, responseEpisodesSql, responseStats, statsPeriod } from "@muras/chat-kit";

const EPISODES = responseEpisodesSql({
  table: "messages", contactColumn: "client_id", timeColumn: "created_at",
  scope: "x.org_id = $1", from: "$2", to: "$3",
  clientMessage: "x.direction = 'in' AND x.kind = 'message' OR x.kind = 'call' AND x.direction = 'in' AND x.call_missed",
  reply: "x.direction = 'out' AND x.kind = 'message' AND x.delivery IS DISTINCT FROM 'error' AND NOT x.handoff"
    + " OR x.kind = 'call' AND NOT x.call_missed",
  handoff: "x.direction = 'out' AND x.kind = 'message' AND x.handoff AND x.delivery IS DISTINCT FROM 'error'",
  channel: "x.channel",
  // Вид автора словами набора: client, bot, operator_crm, operator_phone, operator_admin.
  // Состоявшийся входящий звонок — ответ менеджера с телефона
  authorType: `CASE WHEN x.kind = 'call' AND x.direction = 'in' AND NOT x.call_missed THEN 'operator_phone'
    WHEN x.direction = 'in' THEN 'client' WHEN x.sender = 'bot' THEN 'bot'
    WHEN x.sender = 'phone' OR x.kind = 'call' THEN 'operator_phone' ELSE 'operator_crm' END`,
  authorId: "x.manager_id",
  authorName: "COALESCE(x.manager_name, x.call_manager)",
  // «Ответ не нужен» — если проект его ведёт
  dismissedAt: (id) => `(SELECT c.reply_dismissed_at FROM clients c WHERE c.id = ${id})`,
});

const period = statsPeriod("week", new Date(), profile.timeZone);
const { rows } = await db.query(EPISODES, [orgId, period.from, period.to]);
const stats = responseStats(episodesFromRows(rows), { from: period.from, to: period.to, targetsMin: [5, 15, 60] });
// «Среднее время ответа: 2 мин 5 с» — durationText(stats.avgSec)
```

Сколько сообщений пришло и ушло за период (без заметок, служебных, черновиков, недоставленных и звонков) —
`messageCountsSql({ …, incoming, outgoing, authorType })`: одна строка `{ dialogs, incoming, outgoing, byBot,
byHumans }`; для загруженных сообщений — `countMessages(messages, { from, to })`.

- Внутри запросов — только имена из настроек проекта, не данные пользователя; период и компания — параметрами
  запроса (`$1`, `$2`, `$3`). Условие `scope` — только про строку `x` и параметры.
- Скорость: нужны индексы по (клиент, время) и по (компания, время). На пробных данных (100 000 сообщений, 5 000
  клиентов) запрос за месяц идёт 1–2 с даже в PGlite (Postgres внутри теста); настоящий Postgres быстрее. Страницу
  статистики можно кэшировать на несколько минут.

### Что важно знать

- Обращения считаются по времени начала: клиент, который ждёт со вчерашнего дня, не попадёт в «ждут сейчас» за
  сегодня — его видно в общем счётчике «Ждут ответа».
- «Ответ не нужен» хранится одной отметкой (последней, как у `waitSince`): обращение, закрытое более ранней
  отметкой, в статистике «ждёт» до следующего ответа.
- Время ответа в TypeScript — до миллисекунды; если база хранит время точнее (Postgres — до микросекунды), итоги
  по одному и тому же диалогу могут отличаться на доли секунды.
