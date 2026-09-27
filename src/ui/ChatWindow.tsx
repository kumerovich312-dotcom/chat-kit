import type { ReactNode } from "react";
import type { AiAnswer, SendResult } from "../core/composer.js";
import type { Assessment, Assignee, BotState, DialogStatus, Presence } from "../core/conversation.js";
import type { ChatMessage } from "../core/model.js";
import { fromHuman } from "../core/model.js";
import { defineProfile, type ChatProfile } from "../core/profile.js";
import { dayLabel, fmtClock } from "../core/time.js";
import { BotControls, BotFeedback, BotMemory, TeachExample, type MemoryFact, type Rating } from "./Bot.js";
import { ChatFind } from "./ChatFind.js";
import { ChatScroller, type OlderMessages } from "./ChatScroller.js";
import { ChatThread, whoWrote, type ThreadProps } from "./ChatThread.js";
import { Composer, type ComposerProps } from "./Composer.js";
import { DialogHeader } from "./DialogHeader.js";
import { DialogList, type DialogListProps, type LinkLike } from "./DialogList.js";
import { ThreadFilter } from "./Filter.js";
import { ClientGallery, type GalleryFile } from "./Gallery.js";
import { PendingBubbles, PendingProvider } from "./Pending.js";
import { DialogStrip, type SnoozeChoice } from "./Strip.js";
import { SummaryBar } from "./Summary.js";
import { WaitBar } from "./Wait.js";

/* Окно переписки целиком — для быстрого подключения: слева диалоги, в центре переписка с полем ввода, справа — память
   бота о клиенте и панель проекта (заявка, запись, заказ). На телефоне — либо список, либо открытый диалог. Годится для
   серверной страницы: всё, что нажимается, — клиентские части внутри, действия — формы (server actions).

   Паспорт проекта (profile) задаёт слова отрасли, что включено, метки, свои карточки и кнопки. Решения пользователя
   27.09.2026:
   - кнопки бота — в шапке, рядом с короткой пометкой о состоянии бота («А + Б»);
   - оценка ответов бота и «как надо было» — у владельца сразу, у менеджеров — когда он даст доступ: проект передаёт
     teach только тем, кому можно;
   - «второй пилот» — бот предлагает ответ на каждое сообщение клиента, когда диалог ведёт человек (бот на паузе или
     «не отвечать»): менеджер сам выбирает — вставить, отправить как есть или скрыть;
   - что бот знает о клиенте — рядом с перепиской; «Сделать примером для бота» — у ответов менеджеров;
   - фильтр сообщений — кнопкой в шапке, строка над лентой; все файлы клиента — галерея поверх окна; статус, метки и
     ответственный — полосой под шапкой; «Кратко» — кнопкой, плашка сверху ленты; свои кнопки проекта — меню «+». */

type FormAction = (form: FormData) => void | Promise<void>;

export type ChatWindowDialog = {
  id: string;
  name: string;
  channel?: string | null | undefined;
  contact?: string | null | undefined;
  note?: string | null | undefined;
  cardHref?: string | null | undefined;
  backHref?: string | null | undefined;
  headerActions?: ReactNode;
  messages: readonly ChatMessage[];
  thread?: Omit<ThreadProps, "messages" | "timeZone"> | undefined;
  /** Бот в этом диалоге: пометка и кнопки «Пауза бота / Вернуть боту / Не отвечать этому клиенту» в шапке */
  bot?: { state: BotState; action: FormAction } | null | undefined;
  /** Обучение бота — только тем, кому можно (владелец; менеджеры — с его доступом): оценка ответов бота и примеры */
  teach?: {
    rate?: FormAction | undefined;
    example?: FormAction | undefined;
    /** Уже поставленные оценки по номерам сообщений */
    rated?: Readonly<Record<string, Rating>> | undefined;
    /** Ответы, уже отправленные в студию примером */
    examples?: readonly string[] | undefined;
  } | null | undefined;
  /** «Второй пилот»: ответ, который бот предлагает на последнее сообщение клиента */
  copilot?: { text: string; sendAction?: ((form: FormData) => Promise<SendResult>) | undefined } | null | undefined;
  /** Что бот знает о клиенте */
  memory?: { facts: readonly MemoryFact[]; action?: FormAction | undefined; updatedAt?: string | null | undefined } | null | undefined;
  /** Полоса под шапкой: статус, метки, ответственный, оценка ИИ, кто из коллег в диалоге */
  status?: DialogStatus | undefined;
  snoozedUntil?: string | null | undefined;
  tags?: readonly string[] | undefined;
  assignee?: Assignee | null | undefined;
  /** Кому можно передать диалог */
  managers?: readonly Assignee[] | undefined;
  assessment?: Assessment | null | undefined;
  presence?: readonly Presence[] | undefined;
  /** Варианты «отложить до» (team.ts: snoozeChoices по поясу компании) */
  snoozeChoices?: readonly SnoozeChoice[] | undefined;
  statusAction?: FormAction | undefined;
  tagsAction?: FormAction | undefined;
  assignAction?: FormAction | undefined;
  /** «Я пишу ответ» — раз в 5 секунд, пока сотрудник набирает (форма state=typing) */
  typing?: FormAction | undefined;
  /** ИИ: «Кратко», «Расшифровать», «Улучшить текст» — { text } или { error } */
  summaryAction?: ((form: FormData) => Promise<AiAnswer>) | undefined;
  transcribeAction?: ((form: FormData) => Promise<AiAnswer>) | undefined;
  improveAction?: ((form: FormData) => Promise<AiAnswer>) | undefined;
  /** Свои кнопки проекта (паспорт: actions) — действие для кнопок с формой и подстановки ({client}, {id}) */
  onAction?: ((form: FormData) => Promise<SendResult>) | undefined;
  actionVars?: Readonly<Record<string, string>> | undefined;
  /** Все файлы клиента за всю историю (иначе галерея берёт их из показанных сообщений) */
  files?: readonly GalleryFile[] | undefined;
  /** Есть сообщения раньше показанных */
  older?: OlderMessages | null | undefined;
  /** Над лентой: свои пометки проекта */
  above?: ReactNode;
  /** В начале ленты: своё */
  beforeThread?: ReactNode;
  /** Клиент ждёт ответа с … и почему */
  waitSince?: string | null | undefined;
  handoff?: boolean | undefined;
  dismissAction?: FormAction | undefined;
  /** Поле ввода; null — роль только читает (показывается readOnly) */
  composer?: Omit<ComposerProps, "above" | "copilot"> | null | undefined;
  /** Своё поле ввода вместо стандартного */
  composerNode?: ReactNode;
  readOnly?: ReactNode;
  findInitial?: string | undefined;
  findMoreHref?: string | null | undefined;
  empty?: ReactNode;
};

export type ChatWindowProps = {
  list: DialogListProps;
  dialog?: ChatWindowDialog | null | undefined;
  side?: ReactNode;
  /** Паспорт проекта: слова отрасли, что включено, метки, карточки, кнопки (defineProfile) */
  profile?: ChatProfile | undefined;
  /** Кто смотрит — «вы», «Мои», «Айгерим пишет ответ» не про себя */
  meId?: string | null | undefined;
  /** Диалог выбран явно — на телефоне показываем его, а не список */
  picked?: boolean | undefined;
  timeZone?: string | undefined;
  now?: number | undefined;
  Link?: LinkLike | undefined;
  empty?: ReactNode;
};

export function ChatWindow({ list, dialog, side, profile, meId: me, picked = false, timeZone, now, Link, empty }: ChatWindowProps) {
  const pf = profile ?? defineProfile(timeZone ? { timeZone } : {});
  const t = pf.texts;
  const fe = pf.features;
  const tz = timeZone ?? (profile ? pf.timeZone : undefined);
  const meId = me ?? list.meId ?? null;
  const at = now ?? Date.now();
  const last = dialog?.messages[dialog.messages.length - 1];
  const teach = fe.teach ? dialog?.teach : null;
  const ownActions = dialog?.thread?.renderActions;
  // «Сделать примером» — у текстового ответа человека сразу после сообщения клиента: пара «вопрос → ответ»
  const answers = new Set<string>();
  let prev: ChatMessage | null = null;
  for (const m of dialog?.messages ?? []) {
    if (m.kind !== "message") continue;
    if (prev && prev.author.type === "client" && fromHuman(m) && m.text.trim() && !m.attachments?.length) answers.add(m.id);
    prev = m;
  }
  const renderActions = teach
    ? (m: ChatMessage): ReactNode => {
        const own = ownActions?.(m);
        const mine = m.kind === "message" && m.author.type === "bot" && teach.rate
          ? <BotFeedback messageId={m.id} action={teach.rate} given={teach.rated?.[m.id] ?? null} t={t} />
          : answers.has(m.id) && teach.example
            ? <TeachExample messageId={m.id} action={teach.example} sent={teach.examples?.includes(m.id) ?? false} t={t} />
            : null;
        return own || mine ? <>{own}{mine}</> : null;
      }
    : ownActions;
  const bot = fe.bot ? dialog?.bot : null;
  // «Второй пилот» — когда диалог ведёт человек: бот на паузе или ему нельзя отвечать этому клиенту
  const copilot = fe.copilot && dialog?.copilot && bot && bot.state.mode !== "bot" ? dialog.copilot : null;
  const memory = fe.memory && dialog?.memory
    ? <BotMemory facts={dialog.memory.facts} action={dialog.memory.action} updatedAt={dialog.memory.updatedAt} t={t} />
    : null;

  // Все файлы клиента — для галереи
  const files: GalleryFile[] = [];
  if (dialog && fe.gallery) {
    if (dialog.files) files.push(...dialog.files);
    else {
      const seen = new Set<string>();
      for (const m of dialog.messages) {
        for (const a of m.attachments ?? []) {
          if (seen.has(a.id)) continue;
          seen.add(a.id);
          files.push({ id: a.id, name: a.name || "Файл", mime: a.mime, url: a.url, version: a.version ?? null, size: a.size ?? null, meta: `${dayLabel(m.at, tz, at)}, ${fmtClock(m.at, tz, false)} · ${whoWrote(m, t)}` });
        }
      }
    }
  }

  const strip = dialog && (
    (fe.statuses && (dialog.statusAction || (dialog.status && dialog.status !== "open")))
    || (fe.tags && (dialog.tagsAction || (dialog.tags?.length ?? 0) > 0))
    || (fe.assignee && (dialog.assignAction || dialog.assignee))
    || (fe.presence && (dialog.presence?.length ?? 0) > 0)
    || (fe.assessment && (dialog.assessment?.urgency === "high" || dialog.assessment?.mood === "negative"))
  );
  const composer = dialog?.composer;

  return (
    <div className={`ck ck-window${picked && dialog ? " ck-window--picked" : ""}`}>
      <div className="ck-window__list">
        <DialogList {...list} timeZone={list.timeZone ?? tz} now={list.now ?? now} Link={list.Link ?? Link} meId={meId}
          t={list.t ?? t} tags={list.tags ?? (fe.tags ? pf.tags : undefined)} mine={list.mine ?? (fe.assignee && !!meId)} />
      </div>
      <div className="ck-window__chat">
        {!dialog ? (
          <div className="ck-empty">{empty ?? <div className="ck-empty__title">Выберите диалог слева</div>}</div>
        ) : (
          <>
            <DialogHeader name={dialog.name} channel={dialog.channel} contact={dialog.contact} note={dialog.note}
              cardHref={dialog.cardHref} backHref={dialog.backHref} Link={Link} t={t}
              find={fe.find} filter={fe.filter} gallery={fe.gallery} files={files.length} summary={fe.summary && !!dialog.summaryAction}
              actions={<>{bot ? <BotControls state={bot.state} action={bot.action} timeZone={tz} t={t} /> : null}{dialog.headerActions}</>} />
            {strip ? (
              <DialogStrip t={t} timeZone={tz} now={at} meId={meId}
                status={fe.statuses ? dialog.status : undefined} snoozedUntil={dialog.snoozedUntil}
                tags={fe.tags ? dialog.tags : undefined} tagDefs={pf.tags}
                assignee={fe.assignee ? dialog.assignee : null} managers={dialog.managers}
                assessment={fe.assessment ? dialog.assessment : null}
                presence={fe.presence ? dialog.presence : undefined}
                snoozeChoices={dialog.snoozeChoices}
                actions={{
                  status: fe.statuses ? dialog.statusAction : undefined,
                  tags: fe.tags ? dialog.tagsAction : undefined,
                  assign: fe.assignee ? dialog.assignAction : undefined,
                }} />
            ) : null}
            <PendingProvider key={dialog.id}>
              <div className="ck-window__body">
                {dialog.above}
                {fe.summary && dialog.summaryAction ? <SummaryBar key={`sum-${dialog.id}`} action={dialog.summaryAction} t={t} timeZone={tz} /> : null}
                {fe.find ? <ChatFind key={`find-${dialog.id}`} initial={dialog.findInitial} moreHref={dialog.findMoreHref} /> : null}
                {fe.filter ? <ThreadFilter key={`filter-${dialog.id}`} t={t} /> : null}
                <ChatScroller className="ck-window__feed" lastKey={last?.id ?? 0} dialogKey={dialog.id} older={dialog.older}>
                  {dialog.beforeThread}
                  {dialog.messages.length === 0 ? (
                    <div className="ck-empty">{dialog.empty ?? <div className="ck-empty__title">Сообщений пока нет</div>}</div>
                  ) : null}
                  <ChatThread {...dialog.thread} renderActions={renderActions} messages={dialog.messages} timeZone={tz} now={now}
                    t={t} cards={pf.cards} currency={pf.currency} meId={dialog.thread?.meId ?? meId}
                    canReply={dialog.thread?.canReply ?? (!!composer && !composer.noteOnly)}
                    transcribeAction={fe.transcribe ? dialog.transcribeAction ?? dialog.thread?.transcribeAction : undefined} />
                  <PendingBubbles />
                </ChatScroller>
                {dialog.waitSince ? <WaitBar since={dialog.waitSince} now={now} handoff={dialog.handoff} dismissAction={dialog.dismissAction} t={t} /> : null}
                {dialog.composerNode ?? (composer
                  ? <Composer key={`composer-${dialog.id}`} t={t} voice={fe.voice && fe.files} meId={meId}
                      {...composer}
                      modes={composer.modes ?? fe.modes ?? undefined}
                      templates={fe.templates ? composer.templates : undefined}
                      files={fe.files ? composer.files : undefined}
                      improveAction={fe.improve ? dialog.improveAction ?? composer.improveAction : undefined}
                      actions={composer.actions ?? (pf.actions.length ? pf.actions : undefined)}
                      onAction={dialog.onAction ?? composer.onAction}
                      actionVars={{ client: dialog.name, id: dialog.id, ...dialog.actionVars, ...composer.actionVars }}
                      typing={fe.presence ? dialog.typing ?? composer.typing : undefined}
                      presence={fe.presence ? dialog.presence ?? composer.presence : undefined}
                      copilot={copilot} />
                  : dialog.readOnly ?? null)}
              </div>
            </PendingProvider>
            {fe.gallery ? <ClientGallery key={`gal-${dialog.id}`} files={files} t={t} onRotate={dialog.thread?.onRotate} canRotate={!!dialog.thread?.onRotate} /> : null}
          </>
        )}
      </div>
      {side || memory ? <aside className="ck-window__side ck-scroll">{memory}{side}</aside> : null}
    </div>
  );
}
