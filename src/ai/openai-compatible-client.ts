import { alternateBaseUrl, joinUrl } from './base-url';
import type { ChatMessage } from './prompts/state-prompt';
import type { AiChannelRecord, AiRole } from './types';

export type AiErrorCode =
  | 'WM_AI_CHANNEL_UNAVAILABLE'
  | 'WM_AI_TIMEOUT'
  | 'WM_AI_RATE_LIMITED'
  | 'WM_AI_REQUEST_FAILED'
  | 'WM_AI_OUTPUT_TRUNCATED'
  | 'WM_AI_EMPTY_OUTPUT'
  | 'WM_INVALID_RESPONSE'
  | 'WM_TASK_CANCELLED';

export class AiRequestError extends Error {
  constructor(readonly code: AiErrorCode, message: string, readonly retryable: boolean, readonly status: number | null = null) {
    super(message);
    this.name = 'AiRequestError';
  }
}

export type ChannelEndpoint = Pick<AiChannelRecord, 'baseUrl' | 'apiKey' | 'headers'>;

export type ChatCompletionInput = {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs: number;
  signal?: AbortSignal;
};

export type ChatCompletionResult = {
  text: string;
  finishReason: string | null;
  model: string | null;
  usage: { promptTokens: number | null; completionTokens: number | null } | null;
  durationMs: number;
};

export type EmbeddingResult = { vector: number[]; model: string | null; durationMs: number };

export type ModelTestResult = { ok: true; role: AiRole; model: string; detail: string; durationMs: number };

type RequestInitLite = { method: 'GET' | 'POST'; body?: string };
type RawResponse = { url: string; status: number; ok: boolean; text: string };

const ALTERNATE_URL_STATUSES = new Set([404, 405]);
const TRUNCATED_FINISH_REASONS = new Set(['length', 'max_tokens']);
const MAX_ERROR_SNIPPET = 300;
const PROBE_MAX_TOKENS = 512;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(part => (typeof part === 'string' ? part : typeof asRecord(part).text === 'string' ? String(asRecord(part).text) : ''))
    .join('');
}

function redact(text: string, apiKey: string | null): string {
  let result = text;
  if (apiKey && apiKey.length >= 6) result = result.split(apiKey).join('***');
  return result.replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_SNIPPET);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    const causeMessage = cause instanceof Error ? ` (${cause.message})` : '';
    return `${error.message}${causeMessage}`;
  }
  return String(error);
}

/**
 * Minimal non-streaming client for OpenAI-compatible endpoints. Retries are deliberately
 * not implemented here; the task layer decides whether an error is worth another attempt.
 */
export class OpenAiCompatibleClient {
  constructor(private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init)) {}

  async chatCompletion(channel: ChannelEndpoint, input: ChatCompletionInput): Promise<ChatCompletionResult> {
    const startedAt = Date.now();
    const body: Record<string, unknown> = { model: input.model, messages: input.messages, stream: false };
    if (input.temperature !== undefined) body.temperature = input.temperature;
    if (input.maxTokens !== undefined) body.max_tokens = input.maxTokens;
    const data = asRecord(await this.requestJson(channel, 'chat/completions', { method: 'POST', body: JSON.stringify(body) }, input.timeoutMs, input.signal));
    const choices = Array.isArray(data.choices) ? data.choices : [];
    const first = asRecord(choices[0]);
    const message = asRecord(first.message);
    const text = contentText(message.content ?? first.text);
    const finishReason = typeof first.finish_reason === 'string' ? first.finish_reason : null;
    if (finishReason && TRUNCATED_FINISH_REASONS.has(finishReason)) {
      throw new AiRequestError('WM_AI_OUTPUT_TRUNCATED', `model output was truncated (finish_reason=${finishReason})`, true);
    }
    if (!text.trim()) throw new AiRequestError('WM_AI_EMPTY_OUTPUT', 'model returned no visible content', true);
    const usage = asRecord(data.usage);
    return {
      text,
      finishReason,
      model: typeof data.model === 'string' ? data.model : null,
      usage: data.usage ? { promptTokens: numberOrNull(usage.prompt_tokens), completionTokens: numberOrNull(usage.completion_tokens) } : null,
      durationMs: Date.now() - startedAt
    };
  }

  async listModels(channel: ChannelEndpoint, timeoutMs: number, signal?: AbortSignal): Promise<string[]> {
    const data = asRecord(await this.requestJson(channel, 'models', { method: 'GET' }, timeoutMs, signal));
    const entries = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
    const ids = entries
      .map(item => (typeof item === 'string' ? item : asRecord(item).id))
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      .map(id => id.trim());
    return [...new Set(ids)].sort();
  }

  async createEmbedding(channel: ChannelEndpoint, model: string, input: string, timeoutMs: number, signal?: AbortSignal): Promise<EmbeddingResult> {
    const startedAt = Date.now();
    const data = asRecord(await this.requestJson(channel, 'embeddings', { method: 'POST', body: JSON.stringify({ model, input }) }, timeoutMs, signal));
    const first = asRecord((Array.isArray(data.data) ? data.data : [])[0]);
    const vector = Array.isArray(first.embedding) ? first.embedding.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)) : [];
    if (!vector.length || vector.length !== (Array.isArray(first.embedding) ? first.embedding.length : 0)) {
      throw new AiRequestError('WM_INVALID_RESPONSE', 'embedding response contains an invalid vector', false);
    }
    return { vector, model: typeof data.model === 'string' ? data.model : null, durationMs: Date.now() - startedAt };
  }

  async testModel(channel: ChannelEndpoint, model: string, role: AiRole, timeoutMs: number, signal?: AbortSignal): Promise<ModelTestResult> {
    const startedAt = Date.now();
    if (role === 'embedding') {
      const body = JSON.stringify({ model, input: 'WeaveMemory connectivity check' });
      const data = asRecord(await this.requestJson(channel, 'embeddings', { method: 'POST', body }, timeoutMs, signal));
      const first = asRecord((Array.isArray(data.data) ? data.data : [])[0]);
      if (!Array.isArray(first.embedding) || first.embedding.length === 0) {
        throw new AiRequestError('WM_INVALID_RESPONSE', 'embedding response contains no vector', false);
      }
      return { ok: true, role, model, detail: `dimensions=${first.embedding.length}`, durationMs: Date.now() - startedAt };
    }
    if (role === 'rerank') {
      const body = JSON.stringify({
        model,
        query: 'story state memory',
        documents: ['WeaveMemory keeps the current story state.', 'Unrelated text.'],
        top_n: 1
      });
      const data = asRecord(await this.requestJson(channel, 'rerank', { method: 'POST', body }, timeoutMs, signal));
      if (!Array.isArray(data.results) || data.results.length === 0) {
        throw new AiRequestError('WM_INVALID_RESPONSE', 'rerank response contains no results', false);
      }
      return { ok: true, role, model, detail: `results=${data.results.length}`, durationMs: Date.now() - startedAt };
    }
    try {
      const completion = await this.chatCompletion(channel, {
        model,
        messages: [
          { role: 'system', content: 'You are a connectivity check.' },
          { role: 'user', content: 'Reply with the single word OK.' }
        ],
        temperature: 0,
        maxTokens: PROBE_MAX_TOKENS,
        timeoutMs,
        signal
      });
      return { ok: true, role, model, detail: completion.text.trim().slice(0, 80), durationMs: Date.now() - startedAt };
    } catch (error) {
      if (error instanceof AiRequestError && (error.code === 'WM_AI_OUTPUT_TRUNCATED' || error.code === 'WM_AI_EMPTY_OUTPUT')) {
        return { ok: true, role, model, detail: 'model reachable but returned no visible text within the probe budget (reasoning model?)', durationMs: Date.now() - startedAt };
      }
      throw error;
    }
  }

  private async requestJson(channel: ChannelEndpoint, path: string, init: RequestInitLite, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const response = await this.requestWithFallback(channel, path, init, timeoutMs, signal);
    let data: unknown;
    try {
      data = response.text ? JSON.parse(response.text) : {};
    } catch {
      throw new AiRequestError('WM_INVALID_RESPONSE', `endpoint returned non-JSON content: ${redact(response.text, channel.apiKey)}`, true, response.status);
    }
    const record = asRecord(data);
    if (record.error !== undefined && record.error !== null) {
      const detail = asRecord(record.error);
      const message = typeof detail.message === 'string' ? detail.message : typeof record.error === 'string' ? record.error : JSON.stringify(record.error);
      throw new AiRequestError('WM_AI_REQUEST_FAILED', `endpoint reported an error: ${redact(message, channel.apiKey)}`, false, response.status);
    }
    return data;
  }

  private async requestWithFallback(channel: ChannelEndpoint, path: string, init: RequestInitLite, timeoutMs: number, signal?: AbortSignal): Promise<RawResponse> {
    const first = await this.rawRequest(channel, joinUrl(channel.baseUrl, path), init, timeoutMs, signal);
    if (!ALTERNATE_URL_STATUSES.has(first.status)) return this.ensureOk(first, channel);
    const alternate = alternateBaseUrl(channel.baseUrl);
    if (!alternate) return this.ensureOk(first, channel);
    const second = await this.rawRequest(channel, joinUrl(alternate, path), init, timeoutMs, signal);
    if (second.ok) return second;
    return this.ensureOk(ALTERNATE_URL_STATUSES.has(second.status) ? first : second, channel);
  }

  private ensureOk(response: RawResponse, channel: ChannelEndpoint): RawResponse {
    if (response.ok) return response;
    const snippet = redact(response.text, channel.apiKey);
    const suffix = snippet ? `: ${snippet}` : '';
    if (response.status === 401 || response.status === 403) {
      throw new AiRequestError('WM_AI_CHANNEL_UNAVAILABLE', `authentication failed (HTTP ${response.status})${suffix}`, false, response.status);
    }
    if (response.status === 429) {
      throw new AiRequestError('WM_AI_RATE_LIMITED', `rate limited (HTTP 429)${suffix}`, true, response.status);
    }
    if (response.status >= 500) {
      throw new AiRequestError('WM_AI_REQUEST_FAILED', `endpoint failed (HTTP ${response.status})${suffix}`, true, response.status);
    }
    if (ALTERNATE_URL_STATUSES.has(response.status)) {
      throw new AiRequestError('WM_AI_REQUEST_FAILED', `endpoint not found (HTTP ${response.status}) at ${response.url}${suffix}`, false, response.status);
    }
    throw new AiRequestError('WM_AI_REQUEST_FAILED', `endpoint rejected the request (HTTP ${response.status})${suffix}`, false, response.status);
  }

  private async rawRequest(channel: ChannelEndpoint, url: string, init: RequestInitLite, timeoutMs: number, signal?: AbortSignal): Promise<RawResponse> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = (): void => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (init.body !== undefined) headers['Content-Type'] = 'application/json';
      if (channel.apiKey) headers.Authorization = `Bearer ${channel.apiKey}`;
      Object.assign(headers, channel.headers);
      const response = await this.fetchImpl(url, { method: init.method, headers, body: init.body, signal: controller.signal });
      const text = await response.text();
      return { url, status: response.status, ok: response.ok, text };
    } catch (error) {
      if (timedOut) throw new AiRequestError('WM_AI_TIMEOUT', `request timed out after ${timeoutMs} ms`, true);
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw new AiRequestError('WM_TASK_CANCELLED', 'request was cancelled', false);
      }
      throw new AiRequestError('WM_AI_CHANNEL_UNAVAILABLE', `endpoint could not be reached: ${redact(errorMessage(error), channel.apiKey)}`, true);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
