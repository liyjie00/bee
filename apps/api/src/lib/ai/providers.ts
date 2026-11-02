import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { AiProvider } from '@bee/shared';

/**
 * Model providers for Ask AI. Every user brings their own account: an OpenRouter key from
 * "Sign in with OpenRouter" (one login for OpenAI, Claude, Grok and Gemini models), or an
 * API key pasted for one provider. Claude goes through the Anthropic SDK; the others speak
 * the OpenAI Chat Completions protocol at their own base URL.
 */

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments */
  schema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** raw JSON text of the arguments (parsed and validated by the caller) */
  args: string;
  /** provider data to send back with the call (Gemini's thought signature) */
  extra?: unknown;
}

export interface ToolOutput {
  id: string;
  content: string;
  isError: boolean;
}

export interface StepResult {
  toolCalls: ToolCall[];
  stop: 'end' | 'tools' | 'length' | 'refusal';
}

/** One conversation with a model; the session keeps the provider-native message history. */
export interface ChatSession {
  /** onChunk fires for every streamed event, text or not (stall detection) */
  step(onText: (delta: string) => void, signal: AbortSignal, onChunk?: () => void): Promise<StepResult>;
  addToolResults(results: ToolOutput[]): void;
}

export interface ChatInput {
  system: string;
  /** earlier turns as plain text, ending with the new user message */
  history: { role: 'user' | 'assistant'; content: string }[];
  tools: ToolSpec[];
  model: string;
}

const OPENAI_COMPAT: Record<Exclude<AiProvider, 'anthropic'>, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1',
  xai: 'https://api.x.ai/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/',
};

/** Preferred default model per provider, matched against the provider's model list. */
const DEFAULT_MODEL: Record<AiProvider, RegExp[]> = {
  openrouter: [/^anthropic\/claude-opus-5[.-]5$/, /^anthropic\/claude-sonnet-5[.-]5$/, /^anthropic\/claude/],
  anthropic: [/^claude-opus-5-5$/, /^claude-sonnet-5-5$/, /^claude-/],
  openai: [/^gpt-\d+(\.\d+)?$/, /^gpt-/],
  xai: [/^grok-\d+(\.\d+)?$/, /^grok-/],
  gemini: [/^gemini-\d+(\.\d+)?-flash$/, /^gemini-flash-latest$/, /^gemini-/],
};

export interface ModelInfo {
  id: string;
  name: string;
}

/** BEE_AI_<PROVIDER>_BASE_URL points a provider at a proxy or a local mock. */
const baseUrl = (provider: AiProvider): string | undefined =>
  process.env[`BEE_AI_${provider.toUpperCase()}_BASE_URL`] ??
  (provider === 'anthropic' ? undefined : OPENAI_COMPAT[provider]);

function anthropicClient(apiKey: string) {
  return new Anthropic({ apiKey, baseURL: baseUrl('anthropic'), maxRetries: 1, timeout: 5 * 60_000 });
}

function openaiClient(provider: Exclude<AiProvider, 'anthropic'>, apiKey: string, publicUrl: string) {
  return new OpenAI({
    apiKey,
    baseURL: baseUrl(provider),
    // One quick retry: an overloaded model should fail fast so the user can switch.
    maxRetries: 1,
    timeout: 5 * 60_000,
    // OpenRouter app attribution.
    defaultHeaders: provider === 'openrouter' ? { 'HTTP-Referer': publicUrl, 'X-Title': 'Bee' } : undefined,
  });
}

/** Chat models the key can use, best default first. Throws when the key is rejected. */
export async function listModels(
  provider: AiProvider,
  apiKey: string,
  publicUrl: string,
): Promise<ModelInfo[]> {
  let models: (ModelInfo & { created: number })[] = [];
  if (provider === 'anthropic') {
    for await (const m of anthropicClient(apiKey).models.list({ limit: 100 }))
      models.push({ id: m.id, name: m.display_name, created: Date.parse(m.created_at) / 1000 });
  } else if (provider === 'openrouter') {
    // Verify the key first: the model list itself is public.
    const key = await fetch(`${baseUrl('openrouter')}/key`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!key.ok) throw Object.assign(new Error('OpenRouter rejected the key'), { status: 401 });
    const res = await fetch(`${baseUrl('openrouter')}/models?supported_parameters=tools`, {
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json()) as { data?: { id: string; name: string; created: number }[] };
    models = (body.data ?? []).map((m) => ({ id: m.id, name: m.name, created: m.created }));
  } else {
    const page = await openaiClient(provider, apiKey, publicUrl).models.list();
    for (const m of page.data) {
      const id = m.id.replace(/^models\//, '');
      models.push({ id, name: id, created: m.created ?? 0 });
    }
    const chat: Record<string, RegExp> = { openai: /^(gpt-|o\d|chatgpt)/, xai: /^grok/, gemini: /^gemini/ };
    const notChat = /(audio|realtime|tts|transcribe|image|embedding|search|moderation|vision|imagen|veo|aqa|live|robotics|banana|computer-use|omni|customtools|nano)/;
    models = models.filter((m) => chat[provider]!.test(m.id) && !notChat.test(m.id));
  }
  models.sort((a, b) => b.created - a.created);
  const rank = (id: string) => {
    const i = DEFAULT_MODEL[provider].findIndex((re) => re.test(id));
    return i < 0 ? 99 : i;
  };
  const best = [...models].sort((a, b) => rank(a.id) - rank(b.id))[0];
  return best ? [best, ...models.filter((m) => m !== best)].map(({ id, name }) => ({ id, name })) : [];
}

/** Claude models that take the server-side refusal fallback. */
const FALLBACK_MODELS = /^claude-(opus-5-5|sonnet-5-5|opus-5|fable-5-1)$/;

class AnthropicSession implements ChatSession {
  private readonly client: Anthropic;
  private readonly messages: Anthropic.Beta.BetaMessageParam[];
  private readonly tools: Anthropic.Beta.BetaTool[];

  constructor(
    apiKey: string,
    private readonly input: ChatInput,
  ) {
    this.client = anthropicClient(apiKey);
    this.messages = input.history.map((m) => ({ role: m.role, content: m.content }));
    this.tools = input.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.schema as Anthropic.Beta.BetaTool.InputSchema,
    }));
  }

  async step(onText: (delta: string) => void, signal: AbortSignal, onChunk?: () => void): Promise<StepResult> {
    const fallback = FALLBACK_MODELS.test(this.input.model);
    const stream = this.client.beta.messages.stream(
      {
        model: this.input.model,
        max_tokens: 32000,
        system: [{ type: 'text', text: this.input.system, cache_control: { type: 'ephemeral' } }],
        tools: this.tools,
        messages: this.messages,
        ...(fallback && { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }),
      } as Anthropic.Beta.MessageCreateParamsStreaming,
      { signal },
    );
    for await (const event of stream) {
      onChunk?.();
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta')
        onText(event.delta.text);
    }
    const msg = await stream.finalMessage();
    this.messages.push({ role: 'assistant', content: msg.content });
    const toolCalls = msg.content
      .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, args: JSON.stringify(b.input ?? {}) }));
    const stop =
      msg.stop_reason === 'refusal'
        ? 'refusal'
        : msg.stop_reason === 'max_tokens'
          ? 'length'
          : toolCalls.length
            ? 'tools'
            : 'end';
    return { toolCalls, stop };
  }

  addToolResults(results: ToolOutput[]) {
    this.messages.push({
      role: 'user',
      content: results.map((r) => ({
        type: 'tool_result' as const,
        tool_use_id: r.id,
        content: r.content,
        is_error: r.isError,
      })),
    });
  }
}

class OpenAICompatSession implements ChatSession {
  private readonly client: OpenAI;
  private readonly messages: OpenAI.ChatCompletionMessageParam[];
  private readonly tools: OpenAI.ChatCompletionTool[];

  constructor(
    provider: Exclude<AiProvider, 'anthropic'>,
    apiKey: string,
    publicUrl: string,
    private readonly input: ChatInput,
  ) {
    this.client = openaiClient(provider, apiKey, publicUrl);
    this.messages = [
      { role: 'system', content: input.system },
      ...input.history.map((m) => ({ role: m.role, content: m.content })),
    ];
    this.tools = input.tools.map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.schema },
    }));
  }

  async step(onText: (delta: string) => void, signal: AbortSignal, onChunk?: () => void): Promise<StepResult> {
    const stream = await this.client.chat.completions.create(
      { model: this.input.model, messages: this.messages, tools: this.tools, stream: true },
      { signal },
    );
    let text = '';
    let finish: string | null = null;
    const calls: ToolCall[] = [];
    for await (const chunk of stream) {
      onChunk?.();
      const choice = chunk.choices[0];
      if (!choice) continue;
      if (choice.delta.content) {
        text += choice.delta.content;
        onText(choice.delta.content);
      }
      for (const tc of choice.delta.tool_calls ?? []) {
        // Gemini sends each call whole and may leave out `index`.
        const i = tc.index ?? (tc.id || !calls.length ? calls.length : calls.length - 1);
        const c = (calls[i] ??= { id: '', name: '', args: '' });
        if (tc.id) c.id = tc.id;
        const extra = (tc as { extra_content?: unknown }).extra_content;
        if (extra) c.extra = extra;
        if (tc.function?.name) c.name += tc.function.name;
        if (tc.function?.arguments) c.args += tc.function.arguments;
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    const toolCalls = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${i}` }));
    this.messages.push({
      role: 'assistant',
      content: text || null,
      ...(toolCalls.length && {
        tool_calls: toolCalls.map((c) => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: c.args || '{}' },
          // Gemini 3 rejects a follow-up turn without the call's thought signature.
          ...(c.extra ? { extra_content: c.extra } : {}),
        })),
      }),
    });
    const stop =
      finish === 'length'
        ? 'length'
        : finish === 'content_filter'
          ? 'refusal'
          : toolCalls.length
            ? 'tools'
            : 'end';
    return { toolCalls, stop };
  }

  addToolResults(results: ToolOutput[]) {
    for (const r of results)
      this.messages.push({
        role: 'tool',
        tool_call_id: r.id,
        content: r.isError ? `Error: ${r.content}` : r.content,
      });
  }
}

export function openSession(
  provider: AiProvider,
  apiKey: string,
  publicUrl: string,
  input: ChatInput,
): ChatSession {
  return provider === 'anthropic'
    ? new AnthropicSession(apiKey, input)
    : new OpenAICompatSession(provider, apiKey, publicUrl, input);
}
