import { phoneTail } from "../core/phone.js";

/* Личные данные клиента поставщику ИИ не отправляем: телефоны, почту и номера карт в тексте заменяем метками
   {{PHONE_1}}, {{EMAIL_1}}, {{CARD_1}}, а в ответе ИИ возвращаем на место (restore). Сотрудник видит текст целиком,
   поставщик номеров не видел. Один и тот же номер, как бы его ни записали («+996 555 00-00-01» и «0555 00-00-01»), —
   одна метка: ИИ понимает, что речь об одном телефоне.

   Лучше скрыть лишнее, чем пропустить: длинное число (сумма «1 000 000 000», номер заказа) тоже станет меткой, но в ответе
   вернётся на место. Даты (12.10.2026, 2026-10-12), время, цены до 8 цифр («150 000», «12 500 000») не трогаем.
   Имена, адреса и номера, написанные словами, не узнаём — об этом сказано в docs/AI.md. */

export type HiddenKind = "phone" | "email" | "card";

/** Почта: «имя@домен.зона», буквы любого языка */
const EMAIL = /[\p{L}\p{N}._%+-]+@(?:[\p{L}\p{N}-]+\.)+\p{L}{2,}/gu;

/** Число цифрами с пробелами, скобками и дефисами между цифрами (телефон, карта, счёт). Не с середины слова или числа.
 *  Точка и двоеточие число обрывают — даты и время остаются как есть */
const NUMBER = /(?<![\p{L}\p{N}_])\+?\d(?:[ \t   ()\-‐-—]{0,3}\d)+/gu;

/** Метка в ответе ИИ; пробелы внутри скобок прощаем */
const TOKEN = /\{\{\s*(PHONE|EMAIL|CARD)_(\d+)\s*\}\}/g;

const TAG: Readonly<Record<HiddenKind, string>> = { phone: "PHONE", email: "EMAIL", card: "CARD" };
const KIND_OF_TAG: Readonly<Record<string, HiddenKind>> = { PHONE: "phone", EMAIL: "email", CARD: "card" };

/** Чем заменить метку, которую не узнали (ИИ выдумал номер метки), и номер карты, который не возвращаем */
const PLAIN: Readonly<Record<HiddenKind, string>> = { phone: "(телефон)", email: "(почта)", card: "(номер карты)" };

/** Что это за число: с «+» и от 7 цифр — телефон; от 13 цифр — карта или счёт; 9–12 — телефон; 7–8 — телефон,
 *  только если записан с дефисами («555-00-01», но не дата «2026-10-12»); короче — не личное */
function kindOf(raw: string): HiddenKind | null {
  const n = raw.replace(/\D/g, "").length;
  if (raw.startsWith("+")) return n >= 7 ? "phone" : null;
  if (n >= 13) return "card";
  if (n >= 9) return "phone";
  if (n >= 7) {
    const dashes = raw.match(/[-‐-—]/g)?.length ?? 0;
    const date = /^\d{4}\D\d{2}\D\d{2}$|^\d{2}\D\d{2}\D\d{4}$/.test(raw);
    return dashes >= 2 && !date ? "phone" : null;
  }
  return null;
}

export type PersonalDataMask = {
  /** Текст с метками вместо телефонов, почты и номеров карт */
  hide(text: string): string;
  /** Вернуть скрытое в ответ ИИ. cards: false — номер карты не возвращать (краткое содержание, оценка): «(номер карты)» */
  restore(text: string, opts?: { cards?: boolean | undefined }): string;
  /** Сколько разных значений скрыто */
  readonly size: number;
};

/** Маска на один запрос к ИИ: всё, что скрыто в нём, возвращается в ответе */
export function personalDataMask(): PersonalDataMask {
  const byToken = new Map<string, { kind: HiddenKind; value: string }>();
  const byKey = new Map<string, string>();
  const count: Record<HiddenKind, number> = { phone: 0, email: 0, card: 0 };

  const token = (kind: HiddenKind, value: string, key: string): string => {
    const k = `${kind}:${key}`;
    let t = byKey.get(k);
    if (!t) {
      count[kind] += 1;
      t = `{{${TAG[kind]}_${count[kind]}}}`;
      byKey.set(k, t);
      byToken.set(t, { kind, value });
    }
    return t;
  };

  return {
    hide(text: string): string {
      return text
        .replace(EMAIL, (m) => token("email", m, m.toLowerCase()))
        .replace(NUMBER, (m) => {
          const kind = kindOf(m);
          if (!kind) return m;
          // Телефон узнаём по последним 9 цифрам: «+996 555 00-00-01» и «0555 00-00-01» — один номер
          return token(kind, m, kind === "phone" ? phoneTail(m) : m.replace(/\D/g, ""));
        });
    },
    restore(text: string, opts: { cards?: boolean | undefined } = {}): string {
      return text.replace(TOKEN, (_m, tag: string, n: string) => {
        const kind = KIND_OF_TAG[tag] ?? "phone";
        const hit = byToken.get(`{{${tag}_${Number(n)}}}`);
        if (!hit) return PLAIN[kind];
        if (hit.kind === "card" && opts.cards === false) return PLAIN.card;
        return hit.value;
      });
    },
    get size() {
      return byToken.size;
    },
  };
}

/** Скрыть телефоны, почту и номера карт в тексте насовсем (без возврата) — например, для журнала */
export function hidePersonalData(text: string): string {
  return personalDataMask().hide(text);
}
