"use client";

import { useEffect, useRef, useState } from "react";
import { beep, claimOnce, enableNotifications, forgetOldNotified, notifyEnabled, NOTIFY_EVENT, popup, primeAudio, setNotifyEnabled } from "./notify.js";
import { ChatIcon } from "./icons.js";

/* «Клиент ждёт ответа» — звук и окошко:
   - один звонок на одно ожидание: ключ — клиент и с какого времени он ждёт (waitKey). Дописал ещё пару сообщений, пока
     ждёт, — второй раз не звоним;
   - если отвечает бот — звоним через delay (~40 с) и только если клиенту по-прежнему нужен человек (recheck): бот не
     ответил или сам позвал человека. Раньше звонило на каждое сообщение, даже отвеченное ботом;
   - окно перед глазами — окошко браузера не показываем, вместо него карточка «Ждёт ответа» в углу;
   - открытый диалог этого клиента не тревожит; ожидания, которые были до открытия вкладки, — тоже;
   - одно уведомление на все вкладки (claimOnce). */

export type WaitEpisode = { key: string; contactId: string; name: string; text: string };

export type WaitAlertsProps = {
  /** Свежие ожидания (самые новые сверху) — проект пересчитывает их при каждом изменении (SSE или опрос) */
  waitList: readonly WaitEpisode[];
  /** Через сколько мс звонить: с ботом — 40 000, без бота — 0 */
  delay?: number | undefined;
  /** С ботом: спросить у сервера свежий список — звоним, только если ожидание ещё есть */
  recheck?: (() => Promise<readonly WaitEpisode[]>) | undefined;
  /** Этот диалог открыт перед глазами — не звонить */
  isOpen?: ((contactId: string) => boolean) | undefined;
  /** Открыть диалог (щелчок по окошку или «Ответить») */
  onOpen: (contactId: string) => void;
};

const CARD_MS = 12_000;

/** Следит за ожиданиями и зовёт: звук, окошко браузера или карточка в углу. Рисует карточку сам */
export function WaitAlerts({ waitList, delay = 0, recheck, isOpen, onOpen }: WaitAlertsProps) {
  const [card, setCard] = useState<WaitEpisode | null>(null);
  const known = useRef(new Set<string>());
  const baseline = useRef(true);
  const timers = useRef<number[]>([]);
  const cardTimer = useRef<number | null>(null);
  const props = useRef({ recheck, isOpen, onOpen, delay });
  props.current = { recheck, isOpen, onOpen, delay };

  useEffect(() => {
    forgetOldNotified();
    // Звук браузер разрешает только после действия человека на странице — «включаем» его первым щелчком или клавишей
    window.addEventListener("pointerdown", primeAudio, { once: true, capture: true });
    window.addEventListener("keydown", primeAudio, { once: true, capture: true });
    const list = timers.current;
    return () => {
      window.removeEventListener("pointerdown", primeAudio, { capture: true });
      window.removeEventListener("keydown", primeAudio, { capture: true });
      list.forEach((t) => window.clearTimeout(t));
      if (cardTimer.current !== null) window.clearTimeout(cardTimer.current);
    };
  }, []);

  useEffect(() => {
    const fresh = waitList.filter((ep) => !known.current.has(ep.key));
    fresh.forEach((ep) => known.current.add(ep.key));
    // Первый список после открытия вкладки — точка отсчёта: о старых ожиданиях не звоним
    if (baseline.current) { baseline.current = false; return; }
    for (const ep of fresh) {
      timers.current.push(window.setTimeout(async () => {
        if (!notifyEnabled()) return;
        const { recheck: again, isOpen: open, onOpen: go, delay: d } = props.current;
        if (d > 0 && again) {
          try {
            const now = await again();
            if (!now.some((x) => x.key === ep.key)) return;
          } catch { return; }
        }
        const focused = document.visibilityState === "visible" && document.hasFocus();
        if ((focused && open?.(ep.contactId)) || !(await claimOnce(`wait:${ep.key}`))) return;
        beep();
        if (focused) {
          if (cardTimer.current !== null) window.clearTimeout(cardTimer.current);
          setCard(ep);
          cardTimer.current = window.setTimeout(() => setCard(null), CARD_MS);
        } else {
          popup(`Ждёт ответа: ${ep.name}`, ep.text || "Клиент написал", () => go(ep.contactId), `chat-kit-wait-${ep.contactId}`);
        }
      }, delay));
    }
  }, [waitList, delay]);

  if (!card) return null;
  const close = () => { setCard(null); if (cardTimer.current !== null) window.clearTimeout(cardTimer.current); };
  return (
    <div role="status" aria-live="polite" className="ck ck-alert">
      <span className="ck-alert__icon" aria-hidden="true"><ChatIcon /></span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="ck-alert__caps">Ждёт ответа</div>
        <div className="ck-alert__name">{card.name}</div>
        {card.text ? <div className="ck-alert__text">{card.text}</div> : null}
        <div className="ck-alert__actions">
          <button type="button" className="ck-btn ck-btn--sm" onClick={() => { close(); onOpen(card.contactId); }}>Ответить</button>
          <button type="button" className="ck-link" onClick={close}>Скрыть</button>
        </div>
      </div>
    </div>
  );
}

/** Кнопка «Уведомления»: включить звук и окошки (браузер спросит разрешение) или выключить */
export function NotifyToggle({ className }: { className?: string | undefined }) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    setOn(notifyEnabled());
    const sync = () => setOn(notifyEnabled());
    window.addEventListener(NOTIFY_EVENT, sync);
    return () => window.removeEventListener(NOTIFY_EVENT, sync);
  }, []);
  return (
    <button type="button" className={`ck-btn ck-btn--sm${on ? " ck-btn--on" : ""}${className ? ` ${className}` : ""}`} aria-pressed={on}
      onClick={() => { if (on) setNotifyEnabled(false); else void enableNotifications(); }}>
      {on ? "🔔 Уведомления включены" : "🔕 Включить уведомления"}
    </button>
  );
}
