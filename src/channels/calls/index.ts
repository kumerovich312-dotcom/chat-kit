/* Подключение телефонии — только для сервера. Звонки в ленте клиента: входящие и исходящие, разговор или пропущенный,
   длительность, кто говорил, запись разговора.
     import { createCallsAdapter, createZadarmaAdapter, zadarmaEchoResponse } from "@muras/chat-kit/calls"
   createCallsAdapter — общий вебхук JSON для любой АТС; createZadarmaAdapter — уведомления Zadarma.
   Как подключить — docs/channels/calls.md. */

export * from "./common.js";
export * from "./generic.js";
export * from "./zadarma.js";
