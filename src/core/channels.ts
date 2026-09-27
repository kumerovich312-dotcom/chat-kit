/* Каналы переписки: коды, подписи, узнавание канала по названию от провайдера. Без базы и импортов. */

export const CHAT_CHANNELS = ["whatsapp", "telegram", "instagram", "vk", "max", "avito", "site", "email", "sms", "nextbot", "test"] as const;
export type ChatChannel = (typeof CHAT_CHANNELS)[number];

export const CHANNEL_LABEL: Readonly<Record<string, string>> = {
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  instagram: "Instagram",
  vk: "ВКонтакте",
  max: "MAX",
  avito: "Авито",
  site: "Чат на сайте",
  email: "Почта",
  sms: "SMS",
  nextbot: "Мессенджер",
  test: "Тестовый чат",
  call: "Звонок",
  note: "Заметка",
  system: "Система",
};

export function isChatChannel(v: string | null | undefined): v is ChatChannel {
  return !!v && (CHAT_CHANNELS as readonly string[]).includes(v);
}

export function channelLabel(v: string | null | undefined): string {
  return (v && CHANNEL_LABEL[v]) || "Мессенджер";
}

/** Название мессенджера от провайдера («WhatsApp», «Instagram Direct», «telegram_bot», «whatsapp_gateway»…) → код канала.
 *  Незнакомое — «nextbot» (просто «мессенджер»). */
export function normalizeChannel(raw: unknown): ChatChannel {
  const s = String(raw ?? "").toLowerCase();
  if (!s) return "nextbot";
  if (s.includes("whats") || s.includes("waba") || s.includes("ватс") || s.includes("вотс")) return "whatsapp";
  if (s.includes("insta") || s.includes("инста")) return "instagram";
  if (s.includes("tele") || s.includes("телег") || s === "tg") return "telegram";
  if (s.includes("vk") || s.includes("вконт") || /(^|[^а-яё])вк([^а-яё]|$)/.test(s)) return "vk";
  if (s.includes("max") || s.includes("макс")) return "max";
  if (s.includes("avito") || s.includes("авито")) return "avito";
  if (s.includes("mail") || s.includes("почт")) return "email";
  if (s === "sms" || s.includes("смс")) return "sms";
  if (s.includes("site") || s.includes("сайт") || s.includes("widget") || s.includes("webchat") || s.includes("web") || s.includes("jivo")) return "site";
  return "nextbot";
}

/** Как размечать текст для канала: WhatsApp понимает *жирный*, Telegram — HTML, остальные — чистый текст */
export function channelMarkup(channel: string | null | undefined): "whatsapp" | "telegram" | "plain" {
  if (channel === "whatsapp") return "whatsapp";
  if (channel === "telegram") return "telegram";
  return "plain";
}
