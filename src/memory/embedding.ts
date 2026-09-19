import { fingerprint } from '../core/fingerprint';
import type { AiConfigStore } from '../storage/ai-config-store';
import type { AiChannelRecord } from '../ai/types';
import { AiRequestError, type OpenAiCompatibleClient } from '../ai/openai-compatible-client';
import type { LongMemoryRecord } from './long-memory';
import type { EmbeddingRef, LongMemoryStore } from '../storage/long-memory-store';

export type EmbeddingResult = { memory: LongMemoryRecord; score: number };
export type EmbeddingSyncResult = { indexed: number; failed: number; removed: number };
export type EmbeddingServiceOptions = {
  /** Attempts per memory before it is marked failed (default 3). */
  maxAttempts?: number;
  /** Delay between attempts; test hook. */
  backoffMs?: (attempt: number) => number;
  /** How long a failed memory waits before the next sync retries it (default 60s). */
  failureCooldownMs?: number;
};

type Binding = { channel: AiChannelRecord; model: string };
type Entry = { contentFingerprint: string; vector: number[] };
type Failure = { contentFingerprint: string; retryAt: number };
type Scope = { loaded: boolean; bindingKey: string | null; entries: Map<string, Entry>; failed: Map<string, Failure>; indexedIds: Set<string> };
type SyncOutcome = EmbeddingSyncResult & { records: LongMemoryRecord[] };

type EmbeddingStore = Pick<LongMemoryStore, 'list' | 'listEmbeddingRefs' | 'saveEmbeddingRef' | 'deleteEmbeddingRefs' | 'setEmbeddingIndexed'>;
type EmbeddingConfig = Pick<AiConfigStore, 'resolveRole'>;
type EmbeddingClient = Pick<OpenAiCompatibleClient, 'createEmbedding'>;

/** Vector text per roadmap §37: title + summary + characters + plotlines + tags. */
export function embeddingText(memory: LongMemoryRecord): string {
  return [memory.title ?? '', memory.summary, ...memory.characterIds, ...memory.plotlineIds, ...memory.tags].join(' ').trim();
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (!left.length || left.length !== right.length) return 0;
  let dot = 0; let leftNorm = 0; let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) { dot += left[index] * right[index]; leftNorm += left[index] ** 2; rightNorm += right[index] ** 2; }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

const sleep = (ms: number): Promise<void> => (ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve());
const SEPARATOR = String.fromCharCode(0);
const scopeKey = (chatId: string, branchId: string): string => `${chatId}${SEPARATOR}${branchId}`;
const bindingKey = (binding: Binding): string => `${binding.channel.channelId}${SEPARATOR}${binding.model}`;

/**
 * Embedding recall over the active long memories of one chat + branch.
 * Vectors are persisted in `embedding_refs` and cached in memory per scope; a memory is re-embedded only
 * when its vector text fingerprint or the bound channel / model changes. A single failing memory is skipped
 * (and retried after a cooldown) without blocking the rest of the scope.
 */
export class EmbeddingSearchService {
  private readonly scopes = new Map<string, Scope>();
  private readonly syncs = new Map<string, Promise<unknown>>();
  private readonly maxAttempts: number;
  private readonly backoffMs: (attempt: number) => number;
  private readonly failureCooldownMs: number;

  constructor(private readonly store: EmbeddingStore, private readonly aiConfig: EmbeddingConfig, private readonly client: EmbeddingClient, options: EmbeddingServiceOptions = {}) {
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
    this.backoffMs = options.backoffMs ?? (attempt => Math.min(5000, 500 * 2 ** (attempt - 1)));
    this.failureCooldownMs = Math.max(0, options.failureCooldownMs ?? 60_000);
  }

  private scope(chatId: string, branchId: string): { key: string; scope: Scope } {
    const key = scopeKey(chatId, branchId);
    let scope = this.scopes.get(key);
    if (!scope) { scope = { loaded: false, bindingKey: null, entries: new Map(), failed: new Map(), indexedIds: new Set() }; this.scopes.set(key, scope); }
    return { key, scope };
  }

  async search(chatId: string, branchId: string, query: string, topK = 10): Promise<EmbeddingResult[]> {
    const binding = await this.requireBinding();
    const target = this.scope(chatId, branchId);
    const outcome = await this.serialized(target.key, () => this.syncScope(chatId, branchId, target.scope, binding));
    const queryVector = await this.embedWithRetry(binding, query);
    const byId = new Map(outcome.records.map(record => [record.memoryId, record]));
    const limit = Number.isSafeInteger(topK) && topK > 0 ? topK : 10;
    return [...target.scope.entries.entries()]
      .map(([memoryId, entry]) => ({ memory: byId.get(memoryId), score: cosineSimilarity(queryVector, entry.vector) }))
      .filter((item): item is EmbeddingResult => Boolean(item.memory) && item.score > 0)
      .sort((left, right) => right.score - left.score || left.memory.startFloor - right.memory.startFloor || left.memory.memoryId.localeCompare(right.memory.memoryId))
      .slice(0, limit);
  }

  /** Incrementally syncs the scope index with the active memories; a single memory failure never throws. */
  async sync(chatId: string, branchId: string): Promise<EmbeddingSyncResult> {
    const binding = await this.requireBinding();
    const target = this.scope(chatId, branchId);
    return summary(await this.serialized(target.key, () => this.syncScope(chatId, branchId, target.scope, binding)));
  }

  /** Drops every persisted vector of the scope and embeds all active memories again. */
  async rebuild(chatId: string, branchId: string): Promise<EmbeddingSyncResult> {
    const binding = await this.requireBinding();
    const target = this.scope(chatId, branchId);
    return summary(await this.serialized(target.key, async () => {
      const persisted = await this.store.listEmbeddingRefs(chatId, branchId);
      const ids = new Set([...persisted.map(ref => ref.memoryId), ...target.scope.entries.keys(), ...target.scope.failed.keys(), ...target.scope.indexedIds]);
      await this.store.deleteEmbeddingRefs([...ids]);
      await this.store.setEmbeddingIndexed([...ids], false);
      target.scope.entries.clear(); target.scope.failed.clear(); target.scope.indexedIds.clear();
      target.scope.loaded = true; target.scope.bindingKey = bindingKey(binding);
      return this.syncScope(chatId, branchId, target.scope, binding);
    }));
  }

  /** Runs tasks of one scope strictly one after another; different scopes stay parallel. */
  private serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.syncs.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    this.syncs.set(key, current);
    return current.finally(() => { if (this.syncs.get(key) === current) this.syncs.delete(key); });
  }

  private async syncScope(chatId: string, branchId: string, scope: Scope, binding: Binding): Promise<SyncOutcome> {
    const key = bindingKey(binding);
    if (scope.bindingKey !== key) { scope.entries.clear(); scope.failed.clear(); scope.loaded = false; scope.bindingKey = key; }
    const records = await this.store.list(chatId, branchId);
    const activeIds = new Set(records.map(record => record.memoryId));
    const removedIds = new Set<string>();
    if (!scope.loaded) {
      for (const ref of await this.store.listEmbeddingRefs(chatId, branchId)) {
        if (ref.provider === binding.channel.channelId && ref.model === binding.model && ref.vector.length) scope.entries.set(ref.memoryId, { contentFingerprint: ref.contentFingerprint, vector: ref.vector });
        else if (!activeIds.has(ref.memoryId)) removedIds.add(ref.memoryId);
      }
      scope.loaded = true;
    }
    for (const memoryId of [...scope.entries.keys(), ...scope.failed.keys(), ...scope.indexedIds]) if (!activeIds.has(memoryId)) removedIds.add(memoryId);
    for (const memoryId of removedIds) { scope.entries.delete(memoryId); scope.failed.delete(memoryId); scope.indexedIds.delete(memoryId); }
    if (removedIds.size) { await this.store.deleteEmbeddingRefs([...removedIds]); await this.store.setEmbeddingIndexed([...removedIds], false); }

    const now = Date.now();
    const indexedIds: string[] = []; const failedIds: string[] = [];
    for (const record of records) {
      const text = embeddingText(record);
      const contentFingerprint = fingerprint(text);
      const existing = scope.entries.get(record.memoryId);
      if (existing && existing.contentFingerprint === contentFingerprint) { indexedIds.push(record.memoryId); continue; }
      const failure = scope.failed.get(record.memoryId);
      if (failure && failure.contentFingerprint === contentFingerprint && failure.retryAt > now) { failedIds.push(record.memoryId); continue; }
      try {
        const vector = await this.embedWithRetry(binding, text);
        const ref: EmbeddingRef = { memoryId: record.memoryId, provider: binding.channel.channelId, model: binding.model, contentFingerprint, vector, updatedAt: new Date().toISOString() };
        await this.store.saveEmbeddingRef(ref);
        scope.entries.set(record.memoryId, { contentFingerprint, vector }); scope.failed.delete(record.memoryId); indexedIds.push(record.memoryId);
      } catch (error) {
        scope.entries.delete(record.memoryId);
        scope.failed.set(record.memoryId, { contentFingerprint, retryAt: Date.now() + this.failureCooldownMs });
        await this.store.deleteEmbeddingRefs([record.memoryId]);
        failedIds.push(record.memoryId);
        console.warn('[WeaveMemory] embedding failed for memory', record.memoryId, error instanceof Error ? error.message : String(error));
      }
    }
    const newlyIndexed = indexedIds.filter(memoryId => !scope.indexedIds.has(memoryId));
    const newlyFailed = failedIds.filter(memoryId => scope.indexedIds.has(memoryId));
    if (newlyIndexed.length) await this.store.setEmbeddingIndexed(newlyIndexed, true);
    if (newlyFailed.length) await this.store.setEmbeddingIndexed(newlyFailed, false);
    scope.indexedIds = new Set(indexedIds);
    return { records, indexed: indexedIds.length, failed: failedIds.length, removed: removedIds.size };
  }

  private async requireBinding(): Promise<Binding> {
    const binding = await this.aiConfig.resolveRole('embedding');
    if (!binding) throw new AiRequestError('WM_AI_CHANNEL_UNAVAILABLE', 'embedding model is not bound to any channel', false);
    return binding;
  }

  private async embedWithRetry(binding: Binding, input: string): Promise<number[]> {
    const timeoutMs = (binding.channel.timeout ?? 120) * 1000;
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try { return (await this.client.createEmbedding(binding.channel, binding.model, input, timeoutMs)).vector; }
      catch (error) {
        lastError = error;
        if (error instanceof AiRequestError && !error.retryable) break;
        if (attempt < this.maxAttempts) await sleep(this.backoffMs(attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error('embedding request failed');
  }
}

function summary(outcome: SyncOutcome): EmbeddingSyncResult {
  return { indexed: outcome.indexed, failed: outcome.failed, removed: outcome.removed };
}
