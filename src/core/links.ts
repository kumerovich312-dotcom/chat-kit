/* Кнопки «Написать в WhatsApp / Telegram» по номеру клиента — без базы. Узнать, есть ли у номера мессенджер, CRM сама не может, поэтому кнопка открывает
   чат с номером (WhatsApp сразу скажет, если номера у него нет), а менеджер отмечает, что написал. */

const digitsOf = (phone: string | null | undefined) => String(phone ?? "").replace(/\D/g, "");

/** Чат WhatsApp с номером и готовым текстом: https://wa.me/996555000001?text=… ; null — номера нет или он короткий */
export function waLink(phone: string | null | undefined, text?: string): string | null {
  const d = digitsOf(phone);
  if (d.length < 9) return null;
  return `https://wa.me/${d}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}

/** Чат Telegram по номеру: https://t.me/+996555000001 — откроется, если человек не скрыл номер. Текст так не подставить */
export function tgLink(phone: string | null | undefined): string | null {
  const d = digitsOf(phone);
  return d.length < 9 ? null : `https://t.me/+${d}`;
}

/** Есть ли у клиента мессенджер — для цвета кнопки: «yes» — зелёная, «no» — серая, null — не проверяли.
 *  Сам писал нам туда (или отмечено в анкете) — «есть», даже если раньше отметили «нет» */
export type MessengerState = "yes" | "no" | null;
export function messengerState(saved: string | null | undefined, known: boolean): MessengerState {
  if (known || saved === "yes") return "yes";
  return saved === "no" ? "no" : null;
}

/** Имя для обращения — первое слово, но не заглушка вместо имени: «Заявка с сайта», «Клиент из WhatsApp», «@ник», номер */
export function callName(name: string): string {
  const n = name.trim();
  if (!n || /^(заявка|клиент из|звонок|обращение|пациент из)(?=\s|$)/i.test(n) || n.startsWith("@") || /^[+\d]/.test(n)) return "";
  return n.split(/\s+/)[0] ?? "";
}

/** Приветствие для кнопок WhatsApp и Telegram: в первом сообщении — кто пишет и почему (заявка с сайта, письмо),
 *  дальше — только «Здравствуйте, Имя!». Менеджер может поправить текст до отправки */
export function messengerGreeting(o: { client: string; manager: string; company: string; source: string | null; first: boolean }): string {
  const who = callName(o.client);
  const hello = who ? `Здравствуйте, ${who}!` : "Здравствуйте!";
  if (!o.first) return `${hello} `;
  const me = o.manager.trim().split(/\s+/)[0] ?? "";
  const company = o.company.trim();
  const from = company ? `, ${/[«"]/.test(company) ? company : `«${company}»`}` : "";
  const why = o.source === "Сайт" ? " Вы оставили заявку на нашем сайте." : o.source === "Почта" ? " Вы писали нам на почту." : "";
  return `${hello} Это ${me}${from}.${why} Когда вам удобно поговорить?`;
}
