import type { AiChatBody, AiModelsResponse, AiProvider, AiSettingsDTO, AiStreamEvent, MarkdownEditBody, MarkdownEditResponse } from '@bee/shared';
import { HttpError, req } from './http';

/** Ask AI: the user's AI account, and the streaming chat. */
export const aiApi = {
  settings: () => req<AiSettingsDTO>('GET', '/ai/settings'),
  update: (patch: { provider?: AiProvider; model?: string }) => req<AiSettingsDTO>('PUT', '/ai/settings', patch),
  models: async (provider: AiProvider) => (await req<AiModelsResponse>('GET', `/ai/models?provider=${provider}`)).models,
  setKey: (provider: AiProvider, apiKey: string) => req<AiSettingsDTO>('PUT', `/ai/keys/${provider}`, { apiKey }),
  removeKey: (provider: AiProvider) => req<AiSettingsDTO>('DELETE', `/ai/keys/${provider}`),
  signInUrl: (next: string) => `/api/ai/openrouter/start?next=${encodeURIComponent(next)}`,
  markdown: async (id: string) => (await req<{ markdown: string }>('GET', `/documents/${id}/markdown`)).markdown,
  editMarkdown: (id: string, body: MarkdownEditBody) => req<MarkdownEditResponse>('POST', `/documents/${id}/markdown`, body),

  /** Streams the reply; resolves when the stream ends. */
  async chat(body: AiChatBody, onEvent: (e: AiStreamEvent) => void, signal: AbortSignal): Promise<void> {
    const res = await fetch('/api/ai/chat', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || !res.body) {
      const data = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
      throw new HttpError(res.status, data?.error?.code ?? `http_${res.status}`, data?.error?.message ?? res.statusText);
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of chunk.split('\n')) if (line.startsWith('data: ')) onEvent(JSON.parse(line.slice(6)) as AiStreamEvent);
      }
    }
  },
};
