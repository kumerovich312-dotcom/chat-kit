import type { ReactNode } from "react";
import type { ChatMessage } from "../core/model.js";
import { ChatFind } from "./ChatFind.js";
import { ChatScroller } from "./ChatScroller.js";
import { ChatThread, type ThreadProps } from "./ChatThread.js";
import { Composer, type ComposerProps } from "./Composer.js";
import { DialogHeader } from "./DialogHeader.js";
import { DialogList, type DialogListProps, type LinkLike } from "./DialogList.js";
import { PendingBubbles, PendingProvider } from "./Pending.js";
import { WaitBar } from "./Wait.js";

/* Окно переписки целиком — для быстрого подключения: слева диалоги, в центре переписка с полем ввода, справа — панель
   проекта (сделка, запись к врачу). На телефоне — либо список, либо открытый диалог. Годится для серверной страницы:
   всё, что нажимается, — клиентские части внутри. Нужна своя раскладка — части доступны по отдельности. */

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
  /** Над лентой: кнопки бота, пометки */
  above?: ReactNode;
  /** В начале ленты: «Показать сообщения раньше» */
  beforeThread?: ReactNode;
  /** Клиент ждёт ответа с … и почему */
  waitSince?: string | null | undefined;
  handoff?: boolean | undefined;
  dismissAction?: ((form: FormData) => void | Promise<void>) | undefined;
  /** Поле ввода; null — роль только читает (показывается readOnly) */
  composer?: Omit<ComposerProps, "above"> | null | undefined;
  /** Своё поле ввода вместо стандартного (с черновиком бота и т. п.) */
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
              cardHref={dialog.cardHref} backHref={dialog.backHref} actions={dialog.headerActions} Link={Link} />
            <PendingProvider key={dialog.id}>
              <div className="ck-window__body">
                {dialog.above}
                <ChatFind key={`find-${dialog.id}`} initial={dialog.findInitial} moreHref={dialog.findMoreHref} />
                <ChatScroller className="ck-window__feed" lastKey={last?.id ?? 0} dialogKey={dialog.id}>
                  {dialog.beforeThread}
                  {dialog.messages.length === 0 ? (
                    <div className="ck-empty">{dialog.empty ?? <div className="ck-empty__title">Сообщений пока нет</div>}</div>
                  ) : null}
                  <ChatThread {...dialog.thread} messages={dialog.messages} timeZone={timeZone} now={now} />
                  <PendingBubbles />
                </ChatScroller>
                {dialog.waitSince ? <WaitBar since={dialog.waitSince} now={now} handoff={dialog.handoff} dismissAction={dialog.dismissAction} /> : null}
                {dialog.composerNode ?? (dialog.composer ? <Composer key={`composer-${dialog.id}`} {...dialog.composer} /> : dialog.readOnly ?? null)}
              </div>
            </PendingProvider>
          </>
        )}
      </div>
      {side ? <aside className="ck-window__side ck-scroll">{side}</aside> : null}
    </div>
  );
}
