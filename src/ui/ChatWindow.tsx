import type { ReactNode } from "react";
import type { BotState } from "../core/conversation.js";
import type { ChatMessage } from "../core/model.js";
import { fromHuman } from "../core/model.js";
import type { SendResult } from "../core/composer.js";
import { BotControls, BotFeedback, BotMemory, TeachExample, type MemoryFact, type Rating } from "./Bot.js";
import { ChatFind } from "./ChatFind.js";
import { ChatScroller } from "./ChatScroller.js";
import { ChatThread, type ThreadProps } from "./ChatThread.js";
import { Composer, type ComposerProps } from "./Composer.js";
import { DialogHeader } from "./DialogHeader.js";
import { DialogList, type DialogListProps, type LinkLike } from "./DialogList.js";
import { PendingBubbles, PendingProvider } from "./Pending.js";
import { WaitBar } from "./Wait.js";

/* Окно переписки целиком — для быстрого подключения: слева диалоги, в центре переписка с полем ввода, справа — память
   бота о клиенте и панель проекта (заявка, запись, заказ). На телефоне — либо список, либо открытый диалог. Годится для
   серверной страницы: всё, что нажимается, — клиентские части внутри, действия — формы (server actions).

   Решения пользователя 27.09.2026 по местам для студии:
   - кнопки бота — в шапке, рядом с короткой пометкой о состоянии бота («А + Б»);
   - оценка ответов бота и «как надо было» — у владельца сразу, у менеджеров — когда он даст доступ: проект передаёт
     teach только тем, кому можно;
   - «второй пилот» — бот предлагает ответ на каждое сообщение клиента, когда диалог ведёт человек (бот на паузе или
     «не отвечать»): менеджер сам выбирает — вставить, отправить как есть или скрыть;
   - что бот знает о клиенте — рядом с перепиской; «Сделать примером для бота» — у ответов менеджеров. */

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
  /** Над лентой: свои пометки проекта */
  above?: ReactNode;
  /** В начале ленты: «Показать сообщения раньше» */
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
  /** Диалог выбран явно — на телефоне показываем его, а не список */
  picked?: boolean | undefined;
  timeZone?: string | undefined;
  now?: number | undefined;
  Link?: LinkLike | undefined;
  empty?: ReactNode;
};

export function ChatWindow({ list, dialog, side, picked = false, timeZone, now, Link, empty }: ChatWindowProps) {
  const last = dialog?.messages[dialog.messages.length - 1];
  const teach = dialog?.teach;
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
          ? <BotFeedback messageId={m.id} action={teach.rate} given={teach.rated?.[m.id] ?? null} />
          : answers.has(m.id) && teach.example
            ? <TeachExample messageId={m.id} action={teach.example} sent={teach.examples?.includes(m.id) ?? false} />
            : null;
        return own || mine ? <>{own}{mine}</> : null;
      }
    : ownActions;
  // «Второй пилот» — когда диалог ведёт человек: бот на паузе или ему нельзя отвечать этому клиенту
  const copilot = dialog?.copilot && dialog.bot && dialog.bot.state.mode !== "bot" ? dialog.copilot : null;
  const memory = dialog?.memory ? <BotMemory facts={dialog.memory.facts} action={dialog.memory.action} updatedAt={dialog.memory.updatedAt} /> : null;
  return (
    <div className={`ck ck-window${picked && dialog ? " ck-window--picked" : ""}`}>
      <div className="ck-window__list">
        <DialogList {...list} timeZone={list.timeZone ?? timeZone} now={list.now ?? now} Link={list.Link ?? Link} />
      </div>
      <div className="ck-window__chat">
        {!dialog ? (
          <div className="ck-empty">{empty ?? <div className="ck-empty__title">Выберите диалог слева</div>}</div>
        ) : (
          <>
            <DialogHeader name={dialog.name} channel={dialog.channel} contact={dialog.contact} note={dialog.note}
              cardHref={dialog.cardHref} backHref={dialog.backHref} Link={Link}
              actions={<>{dialog.bot ? <BotControls state={dialog.bot.state} action={dialog.bot.action} timeZone={timeZone} /> : null}{dialog.headerActions}</>} />
            <PendingProvider key={dialog.id}>
              <div className="ck-window__body">
                {dialog.above}
                <ChatFind key={`find-${dialog.id}`} initial={dialog.findInitial} moreHref={dialog.findMoreHref} />
                <ChatScroller className="ck-window__feed" lastKey={last?.id ?? 0} dialogKey={dialog.id}>
                  {dialog.beforeThread}
                  {dialog.messages.length === 0 ? (
                    <div className="ck-empty">{dialog.empty ?? <div className="ck-empty__title">Сообщений пока нет</div>}</div>
                  ) : null}
                  <ChatThread {...dialog.thread} renderActions={renderActions} messages={dialog.messages} timeZone={timeZone} now={now} />
                  <PendingBubbles />
                </ChatScroller>
                {dialog.waitSince ? <WaitBar since={dialog.waitSince} now={now} handoff={dialog.handoff} dismissAction={dialog.dismissAction} /> : null}
                {dialog.composerNode ?? (dialog.composer
                  ? <Composer key={`composer-${dialog.id}`} {...dialog.composer} copilot={copilot} />
                  : dialog.readOnly ?? null)}
              </div>
            </PendingProvider>
          </>
        )}
      </div>
      {side || memory ? <aside className="ck-window__side ck-scroll">{memory}{side}</aside> : null}
    </div>
  );
}
