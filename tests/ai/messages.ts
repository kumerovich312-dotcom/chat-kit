import type { ChatMessage } from "../../src/core/model.js";

// Сообщения для проверок «розетки ИИ»: вымышленные клиенты, номера — из нулей. Время — UTC; в поясе Asia/Bishkek (+6)
// «2026-10-12T08:03Z» — это «12.10 14:03».

let seq = 0;

export const TZ = "Asia/Bishkek";

export const at = (hhmm: string): string => `2026-10-12T${hhmm}:00.000Z`;

export function msg(p: Partial<ChatMessage>): ChatMessage {
  seq += 1;
  return { id: String(seq), at: at("08:00"), kind: "message", author: { type: "client" }, channel: "whatsapp", text: "", ...p };
}

/** Обычная переписка: клиент, менеджер, заметка команды, служебная строка, черновик бота, голосовое с расшифровкой */
export function dialog(): ChatMessage[] {
  return [
    msg({ at: at("08:03"), text: "Здравствуйте, можно записаться на завтра? Мой номер +996 555 00-00-01" }),
    msg({ at: at("08:05"), author: { type: "operator_crm", name: "Айгерим", id: "7" }, text: "Да, есть время в 15:00." }),
    msg({ at: at("08:06"), kind: "note", author: { type: "operator_crm", name: "Айгерим" }, text: "перезвонить после обеда" }),
    msg({ at: at("08:07"), kind: "system", author: { type: "system" }, text: "Бот на паузе" }),
    msg({ at: at("08:08"), author: { type: "bot" }, shadow: true, text: "Черновик бота, клиент его не видел" }),
    msg({
      at: at("08:10"), text: "Голосовое сообщение",
      attachments: [{ id: "f1", name: "Голосовое сообщение", mime: "audio/ogg", url: "/files/1", transcript: "Хорошо, тогда в три. Почта client.test@example.com" }],
    }),
  ];
}
