/* «Розетка ИИ» — помощник ИИ в окне переписки: расшифровка голосовых и звонков, краткое содержание, «Улучшить» для
   черновика, настроение и срочность клиента. Ключи — в окружении проекта; набор их не хранит. Подробно — docs/AI.md.
   Подключается так (на сервере):
     import { combineAi, createClaudeAi, createOpenAiCompatibleTranscriber } from "@muras/chat-kit/ai" */

export * from "./port.js";
export * from "./claude.js";
export * from "./transcriber.js";
export * from "./fake.js";
export * from "./privacy.js";
export * from "./dialog.js";
export * from "./prompts.js";
export { parseJsonObject, stripFences } from "./json.js";
export { describeHttpError, type ServiceNames } from "./http.js";
