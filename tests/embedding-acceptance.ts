import assert from 'node:assert/strict';
import { EmbeddingSearchService, cosineSimilarity, embeddingText } from '../src/memory/embedding';
import { AiRequestError } from '../src/ai/openai-compatible-client';
import type { LongMemoryRecord } from '../src/memory/long-memory';
import type { EmbeddingRef } from '../src/storage/long-memory-store';

function memory(memoryId: string, summary: string, overrides: Partial<LongMemoryRecord> = {}): LongMemoryRecord {
  return { memoryId, chatId: 'chat', branchId: 'branch', batchId: 'batch', sliceId: memoryId, startFloor: 1, endFloor: 2, batchStartFloor: 1, batchEndFloor: 2, summary, tags: [], characterIds: [], plotlineIds: [], sourceFloorIds: [], batchDependencyFingerprint: 'dep', endStateNodeId: 'node', endStateFingerprint: 'state', bm25Indexed: false, embeddingIndexed: false, stale: false, createdAt: '2026-01-01', updatedAt: '2026-01-01', ...overrides };
}

/** In-memory stand-in for LongMemoryStore covering the embedding-facing methods. */
class FakeStore {
  records: LongMemoryRecord[] = [];
  refs = new Map<string, EmbeddingRef>();
  indexed = new Map<string, boolean>();
  indexedWrites = 0;
  async list(chatId: string, branchId?: string): Promise<LongMemoryRecord[]> {
    return this.records.filter(record => !record.stale && record.chatId === chatId && (!branchId || record.branchId === branchId)).map(record => ({ ...record }));
  }
  async listEmbeddingRefs(chatId: string, branchId: string): Promise<EmbeddingRef[]> {
    const ids = new Set(this.records.filter(record => record.chatId === chatId && record.branchId === branchId).map(record => record.memoryId));
    return [...this.refs.values()].filter(ref => ids.has(ref.memoryId)).map(ref => ({ ...ref, vector: [...ref.vector] }));
  }
  async saveEmbeddingRef(ref: EmbeddingRef): Promise<void> { this.refs.set(ref.memoryId, { ...ref }); }
  async deleteEmbeddingRefs(ids: string[]): Promise<void> { for (const id of ids) this.refs.delete(id); }
  async setEmbeddingIndexed(ids: string[], value: boolean): Promise<void> { this.indexedWrites += 1; for (const id of ids) this.indexed.set(id, value); }
}

/** Deterministic fake embedding endpoint: the vector encodes which keywords appear in the text. */
class FakeClient {
  calls: string[] = [];
  failing = new Set<string>();
  nonRetryable = new Set<string>();
  outage = false;
  async createEmbedding(_channel: unknown, _model: string, input: string): Promise<{ vector: number[]; model: string | null; durationMs: number }> {
    this.calls.push(input);
    if (this.outage) throw new AiRequestError('WM_AI_REQUEST_FAILED', 'simulated outage', true);
    for (const word of this.nonRetryable) if (input.includes(word)) throw new AiRequestError('WM_AI_CHANNEL_UNAVAILABLE', 'simulated auth failure', false);
    for (const word of this.failing) if (input.includes(word)) throw new Error('simulated item failure');
    return { vector: ['gate', 'castle', 'dinner'].map(word => (input.includes(word) ? 1 : 0)), model: 'embed-v1', durationMs: 1 };
  }
  count(word: string): number { return this.calls.filter(input => input.includes(word)).length; }
}

function build(store: FakeStore, client: FakeClient, options: { model?: string; cooldownMs?: number; bound?: boolean } = {}): EmbeddingSearchService {
  const binding = { channel: { channelId: 'embed-channel', timeout: 1 } as never, model: options.model ?? 'embed-v1' };
  const config = { resolveRole: async () => (options.bound === false ? null : binding) };
  return new EmbeddingSearchService(store, config as never, client, { maxAttempts: 3, backoffMs: () => 0, failureCooldownMs: options.cooldownMs ?? 60_000 });
}

async function main(): Promise<void> {
  assert.equal(embeddingText(memory('m', 'summary', { title: 'title', tags: ['tag'], characterIds: ['char'], plotlineIds: ['plot'] })), 'title summary char plot tag');
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([1, 0], [1]), 0);

  // 1. Single-item failure does not block the scope; the failing item is retried maxAttempts times.
  const store = new FakeStore();
  const client = new FakeClient();
  store.records = [memory('good', 'ancient gate'), memory('broken', 'always fails')];
  client.failing.add('always fails');
  const service = build(store, client);
  const first = await service.search('chat', 'branch', 'ancient gate');
  assert.deepEqual(first.map(item => item.memory.memoryId), ['good']);
  assert.equal(store.indexed.get('good'), true);
  assert.equal(store.indexed.get('broken'), undefined, 'a never-indexed memory needs no indexed=false write');
  assert.equal(client.count('always fails'), 3);
  assert.ok(store.refs.has('good'));
  assert.ok(!store.refs.has('broken'));

  // 2. Unchanged memories reuse the stored vector: a second search only embeds the query, and does not rewrite index state.
  const callsAfterFirst = client.calls.length;
  const writesAfterFirst = store.indexedWrites;
  assert.deepEqual((await service.search('chat', 'branch', 'ancient gate')).map(item => item.memory.memoryId), ['good']);
  assert.equal(client.calls.length, callsAfterFirst + 1);
  assert.equal(store.indexedWrites, writesAfterFirst);
  assert.equal(client.count('always fails'), 3, 'a failed memory is not retried within the cooldown window');

  // 3. Content change re-embeds only that memory.
  store.records[0].summary = 'new castle';
  const sync = await service.sync('chat', 'branch');
  assert.deepEqual(sync, { indexed: 1, failed: 1, removed: 0 });
  assert.equal(client.count('new castle'), 1);
  assert.deepEqual((await service.search('chat', 'branch', 'castle')).map(item => item.memory.memoryId), ['good']);
  assert.equal((await service.search('chat', 'branch', 'gate')).length, 0);

  // 4. Stale memory leaves the index and the database; reactivating it reuses nothing stale.
  store.records[0].stale = true;
  assert.equal((await service.search('chat', 'branch', 'castle')).length, 0);
  assert.ok(!store.refs.has('good'));
  assert.equal(store.indexed.get('good'), false);
  store.records[0].stale = false;
  assert.deepEqual((await service.search('chat', 'branch', 'castle')).map(item => item.memory.memoryId), ['good']);
  assert.equal(store.indexed.get('good'), true);
  assert.equal(client.count('new castle'), 2, 'reactivated memory is embedded again because its stale vector was dropped');

  // 5. Failure cooldown expiry retries the failed memory; success clears the failure.
  const cooldownStore = new FakeStore();
  const cooldownClient = new FakeClient();
  cooldownStore.records = [memory('flaky', 'flaky dinner')];
  cooldownClient.failing.add('flaky');
  const cooldownService = build(cooldownStore, cooldownClient, { cooldownMs: 0 });
  assert.deepEqual(await cooldownService.sync('chat', 'branch'), { indexed: 0, failed: 1, removed: 0 });
  assert.equal(cooldownClient.count('flaky'), 3);
  cooldownClient.failing.clear();
  assert.deepEqual(await cooldownService.sync('chat', 'branch'), { indexed: 1, failed: 0, removed: 0 });
  assert.equal(cooldownClient.count('flaky'), 4);
  assert.deepEqual((await cooldownService.search('chat', 'branch', 'dinner')).map(item => item.memory.memoryId), ['flaky']);

  // 6. Non-retryable errors are not retried; query embedding failure surfaces to the caller.
  const authStore = new FakeStore();
  const authClient = new FakeClient();
  authStore.records = [memory('secret', 'secret gate')];
  authClient.nonRetryable.add('secret');
  const authService = build(authStore, authClient);
  assert.deepEqual(await authService.sync('chat', 'branch'), { indexed: 0, failed: 1, removed: 0 });
  assert.equal(authClient.count('secret'), 1);
  authClient.outage = true;
  await assert.rejects(authService.search('chat', 'branch', 'gate'), /simulated outage/);
  assert.equal(authClient.calls.filter(input => input === 'gate').length, 3, 'retryable query failures are retried before surfacing');

  // 7. Unbound embedding role fails fast without touching the client.
  const unboundClient = new FakeClient();
  await assert.rejects(build(new FakeStore(), unboundClient, { bound: false }).search('chat', 'branch', 'gate'), /not bound/);
  assert.equal(unboundClient.calls.length, 0);

  // 8. Restart: a fresh service loads persisted vectors without re-embedding; a model change re-embeds everything.
  const restarted = build(store, client);
  const callsBeforeRestart = client.calls.length;
  assert.deepEqual((await restarted.search('chat', 'branch', 'castle')).map(item => item.memory.memoryId), ['good']);
  assert.equal(client.count('new castle'), 2, 'persisted vector is reused after restart');
  assert.equal(client.calls.length, callsBeforeRestart + 1 + 3, 'only the query and the still-failing memory hit the client');
  const switched = build(store, client, { model: 'embed-v2' });
  assert.deepEqual((await switched.search('chat', 'branch', 'castle')).map(item => item.memory.memoryId), ['good']);
  assert.equal(client.count('new castle'), 3, 'model change invalidates stored vectors');
  assert.equal(store.refs.get('good')?.model, 'embed-v2');

  // 9. Rebuild drops every stored vector and embeds the active memories again.
  client.failing.clear();
  const rebuilt = await switched.rebuild('chat', 'branch');
  assert.deepEqual(rebuilt, { indexed: 2, failed: 0, removed: 0 });
  assert.equal(client.count('new castle'), 4);
  assert.equal(store.indexed.get('broken'), true);
  assert.equal((await switched.search('chat', 'branch', 'castle')).length, 1);

  // 10. Scopes are isolated per chat + branch and sync concurrently without cross-talk.
  const scopedStore = new FakeStore();
  const scopedClient = new FakeClient();
  scopedStore.records = [
    memory('a-gate', 'ancient gate', { chatId: 'chat-a', branchId: 'main' }),
    memory('b-castle', 'old castle', { chatId: 'chat-b', branchId: 'main' }),
    memory('a-fork-dinner', 'late dinner', { chatId: 'chat-a', branchId: 'fork' })
  ];
  const scoped = build(scopedStore, scopedClient);
  const [aGate, bGate, forkGate] = await Promise.all([
    scoped.search('chat-a', 'main', 'gate'), scoped.search('chat-b', 'main', 'gate'), scoped.search('chat-a', 'fork', 'gate')
  ]);
  assert.deepEqual(aGate.map(item => item.memory.memoryId), ['a-gate']);
  assert.equal(bGate.length, 0);
  assert.equal(forkGate.length, 0);
  assert.deepEqual((await scoped.search('chat-b', 'main', 'castle')).map(item => item.memory.memoryId), ['b-castle']);
  assert.deepEqual((await scoped.search('chat-a', 'fork', 'dinner')).map(item => item.memory.memoryId), ['a-fork-dinner']);
  assert.equal(scopedClient.count('ancient gate'), 1);
  assert.equal(scopedClient.count('old castle'), 1);
  assert.equal(scopedClient.count('late dinner'), 1);

  // 11. Concurrent syncs of one scope serialize: the memory is embedded once.
  const serialStore = new FakeStore();
  const serialClient = new FakeClient();
  serialStore.records = [memory('once', 'ancient gate')];
  const serial = build(serialStore, serialClient);
  await Promise.all([serial.sync('chat', 'branch'), serial.sync('chat', 'branch'), serial.search('chat', 'branch', 'gate')]);
  assert.equal(serialClient.count('ancient gate'), 1);

  console.log('Phase 12 embedding acceptance passed');
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
