/** Ask AI: chat with the user's own AI account to write and edit documents. */

export const AI_PROVIDERS = ['openrouter', 'openai', 'anthropic', 'xai', 'gemini'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

/** GET /api/ai/settings; PUT /api/ai/settings { provider?, model? } */
export interface AiSettingsDTO {
  /** active provider, null until an account is connected */
  provider: AiProvider | null;
  model: string | null;
  /** providers with a stored key */
  connected: AiProvider[];
}

/** GET /api/ai/models?provider= */
export interface AiModelsResponse {
  models: { id: string; name: string }[];
}

export interface AiChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** POST /api/ai/chat; the response is a stream of `data: <AiStreamEvent>` lines (SSE). */
export interface AiChatBody {
  messages: AiChatMessage[];
  /** the document open next to the chat, if any */
  documentId?: string;
}

export type AiStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; id: string; name: string; title: string }
  | {
      type: 'tool_result';
      id: string;
      ok: boolean;
      summary: string;
      /** content edit, so the user can undo it: Markdown before and after */
      edit?: { documentId: string; title: string; before: string; after: string };
      /** a document the tool created */
      created?: { documentId: string; title: string };
    }
  | { type: 'error'; message: string }
  | { type: 'done' };
