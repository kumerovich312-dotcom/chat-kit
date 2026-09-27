/* Уведомления сотрудника — звук и всплывающее окошко браузера. Только для браузерного кода. Включаются кнопкой (браузер спрашивает разрешение на окошки), выбор хранится в этом браузере.
   Одно уведомление на все открытые вкладки: первая вкладка «забирает» ключ, остальные молчат. */

const KEY = "chat-kit:notify";
export const NOTIFY_EVENT = "chat-kit:notify-changed";
const SEEN = "chat-kit:notified:";

export function notifyEnabled(): boolean {
  try { return localStorage.getItem(KEY) === "on"; } catch { return false; }
}

export function setNotifyEnabled(on: boolean) {
  try { localStorage.setItem(KEY, on ? "on" : "off"); } catch { /* хранилище недоступно */ }
  window.dispatchEvent(new Event(NOTIFY_EVENT));
}

/** Попросить у браузера разрешение на окошки и включить уведомления */
export async function enableNotifications(): Promise<boolean> {
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "default") await Notification.requestPermission();
  } catch { /* браузер без окошек — хватит звука */ }
  primeAudio();
  setNotifyEnabled(true);
  return true;
}

let audio: AudioContext | null = null;

function ctx(): AudioContext | null {
  const Ctx = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  if (!Ctx) return null;
  audio ??= new Ctx();
  if (audio.state === "suspended") void audio.resume();
  return audio;
}

/** «Включить» звук: браузер разрешает его только после действия человека на странице — зовут на первый щелчок */
export function primeAudio() {
  try { ctx(); } catch { /* звук недоступен — не беда */ }
}

/** Короткое «дзынь» из двух нот — без звуковых файлов */
export function beep() {
  try {
    const a = ctx();
    if (!a) return;
    const t0 = a.currentTime + 0.01;
    for (const [freq, at] of [[880, 0], [1320, 0.13]] as const) {
      const osc = a.createOscillator();
      const gain = a.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + at);
      gain.gain.exponentialRampToValueAtTime(0.18, t0 + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.28);
      osc.connect(gain).connect(a.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + 0.3);
    }
  } catch { /* звук недоступен — не беда */ }
}

/** Всплывающее окошко браузера (если разрешено); щелчок по нему — открыть нужный диалог */
export function popup(title: string, body: string, onOpen: () => void, tag?: string) {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const n = new Notification(title, tag ? { body, tag } : { body });
    n.onclick = () => { window.focus(); onOpen(); n.close(); };
  } catch { /* браузер не показывает уведомления */ }
}

/** Уведомить один раз на все открытые вкладки: первая вкладка «забирает» ключ, остальные молчат */
export async function claimOnce(key: string): Promise<boolean> {
  const take = () => {
    try {
      const k = SEEN + key;
      if (localStorage.getItem(k)) return false;
      localStorage.setItem(k, String(Date.now()));
      return true;
    } catch { return true; }
  };
  try {
    const locks = (navigator as { locks?: { request<T>(name: string, cb: () => Promise<T> | T): Promise<T> } }).locks;
    if (locks) return await locks.request("chat-kit-notify", async () => take());
  } catch { /* блокировки недоступны — обойдёмся без них */ }
  return take();
}

/** Забыть отметки «уже уведомили» старше двух дней, чтобы хранилище не росло */
export function forgetOldNotified() {
  try {
    const old = Date.now() - 2 * 86_400_000;
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith(SEEN) && Number(localStorage.getItem(k)) < old) localStorage.removeItem(k);
    }
  } catch { /* хранилище недоступно */ }
}
