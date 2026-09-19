import assert from 'node:assert/strict';
import { AiRequestError } from '../src/ai/openai-compatible-client';
import type { AiChannelRecord, RecallSettings } from '../src/ai/types';
import { DEFAULT_RECALL_SETTINGS } from '../src/ai/types';
import { AiConfigError } from '../src/storage/ai-config-store';
import type { LongMemoryRecord } from '../src/memory/long-memory';
import { RecallService, reciprocalRankFusion, rerankDocument, type RankedMemory } from '../src/memory/recall';

function memory(memoryId: string, summary: string, startFloor = 1): LongMemoryRecord {
  return { memoryId, chatId: 'chat', branchId: 'branch', batchId: 'batch', sliceId: memoryId, startFloor, endFloor: startFloor + 1, batchStartFloor: startFloor, batchEndFloor: startFloor + 1, summary, tags: [], characterIds: [], plotlineIds: [], sourceFloorIds: [], batchDependencyFingerprint: 'dep', endStateNodeId: 'node', endStateFingerprint: 'state', bm25Indexed: true, embeddingIndexed: true, stale: false, createdAt: '2026-01-01', updatedAt: '2026-01-01' };
}

const ranked = (ids: string[], base = 1): RankedMemory[] => ids.map((id, index) => ({ memory: memory(id, `summary ${id}`, index + base), score: 1 - index * 0.1 }));
const ids = (items: Array<{ memory: LongMemoryRecord }>): string[] => items.map(item => item.memory.memoryId);

const channel: AiChannelRecord = { channelId: 'rerank-channel', name: 'Rerank', apiType: 'openai-compatible', baseUrl: 'https://rerank.example/v1', hasApiKey: true, apiKey: 'key', timeout: 1, headers: {}, createdAt: '2026-01-01', updatedAt: '2026-01-01' };

class FakeSource {
  results: RankedMemory[] = [];
  error: Error | null = null;
  calls: Array<{ query: string; topK: number | undefined }> = [];
  async search(_chatId: string, _branchId: string, query: string, topK?: number): Promise<RankedMemory[]> {
    this.calls.push({ query, topK });
    if (this.error) throw this.error;
    return this.results.slice(0, topK ?? this.results.length);
  }
}

class FakeRerankClient {
  requests: Array<{ query: string; documents: string[]; model: string }> = [];
  error: Error | null = null;
  /** Relevance per document text; unlisted documents get no score. */
  relevance = new Map<string, number>();
  async rerank(_channel: AiChannelRecord, model: string, query: string, documents: string[]): Promise<{ scores: Array<{ index: number; relevanceScore: number }>; model: string | null; durationMs: number }> {
    this.requests.push({ query, documents, model });
    if (this.error) throw this.error;
    const scores = documents.flatMap((document, index) => (this.relevance.has(document) ? [{ index, relevanceScore: this.relevance.get(document) as number }] : []));
    if (!scores.length) throw new AiRequestError('WM_INVALID_RESPONSE', 'rerank response contains no usable scores', false);
    return { scores, model: 'rerank-v1', durationMs: 1 };
  }
}

function build(options: { settings?: Partial<RecallSettings>; rerankBound?: boolean; resolveError?: Error } = {}) {
  const bm25 = new FakeSource();
  const embedding = new FakeSource();
  const client = new FakeRerankClient();
  const settings: RecallSettings = { ...DEFAULT_RECALL_SETTINGS, ...options.settings };
  const aiConfig = {
    getRecallSettings: async () => ({ ...settings }),
    resolveRole: async (role: string) => {
      if (role === 'rerank' && options.resolveError) throw options.resolveError;
      return role === 'rerank' && options.rerankBound !== false ? { channel, model: 'rerank-v1' } : null;
    }
  };
  return { bm25, embedding, client, service: new RecallService(bm25, embedding, aiConfig as never, client) };
}

async function main(): Promise<void> {
  // 1. RRF math (roadmap §39): 1/(k+rank) per source; a memory in both lists outranks single-source memories.
  const fused = reciprocalRankFusion([{ source: 'bm25', results: ranked(['a', 'b', 'c']) }, { source: 'embedding', results: ranked(['c', 'd', 'a']) }], 60);
  assert.deepEqual(ids(fused), ['a', 'c', 'b', 'd']);
  const a = fused[0];
  assert.deepEqual(a.ranks, { bm25: 1, embedding: 3 });
  assert.ok(Math.abs(a.rrfScore - (1 / 61 + 1 / 63)) < 1e-12);
  assert.deepEqual(fused[2].ranks, { bm25: 2 });
  assert.deepEqual(reciprocalRankFusion([], 60), []);
  // ties break by story order (startFloor), not by insertion order
  const tie = reciprocalRankFusion([{ source: 'bm25', results: ranked(['late'], 9) }, { source: 'embedding', results: ranked(['early'], 2) }], 60);
  assert.deepEqual(ids(tie), ['early', 'late']);

  // 2. Reranker disabled (default): RRF order is final, no rerank request is made.
  {
    const t = build();
    t.bm25.results = ranked(['a', 'b', 'c']);
    t.embedding.results = ranked(['c', 'd']);
    const result = await t.service.recall('chat', 'branch', 'hello');
    assert.deepEqual(ids(result.final), ['c', 'a', 'b', 'd']);
    assert.equal(result.rerank.status, 'disabled');
    assert.equal(t.client.requests.length, 0);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(t.bm25.calls, [{ query: 'hello', topK: 10 }]);
    assert.deepEqual(t.embedding.calls, [{ query: 'hello', topK: 10 }]);
    assert.equal(result.settings.rerankEnabled, false);
  }

  // 3. Reranker enabled but no rerank model bound: still fully usable, RRF order.
  {
    const t = build({ settings: { rerankEnabled: true }, rerankBound: false });
    t.bm25.results = ranked(['a', 'b']);
    const result = await t.service.recall('chat', 'branch', 'q');
    assert.equal(result.rerank.status, 'not_configured');
    assert.deepEqual(ids(result.final), ['a', 'b']);
    assert.equal(t.client.requests.length, 0);
  }

  // 4. Reranker applied: the bound channel + model is used, the candidate limit caps documents, final order follows relevance.
  {
    const t = build({ settings: { rerankEnabled: true, rerankCandidateLimit: 4, finalRecallCount: 2 } });
    t.bm25.results = ranked(['a', 'b', 'c', 'd', 'e']);
    t.embedding.results = ranked(['e', 'f']);
    t.client.relevance.set(rerankDocument(memory('f', 'summary f')), 0.9);
    t.client.relevance.set(rerankDocument(memory('b', 'summary b')), 0.8);
    t.client.relevance.set(rerankDocument(memory('a', 'summary a')), 0.1);
    const result = await t.service.recall('chat', 'branch', 'q');
    assert.equal(result.rerank.status, 'applied');
    assert.equal(result.rerank.documentCount, 4);
    assert.equal(result.rerank.model, 'rerank-v1');
    assert.equal(t.client.requests.length, 1);
    assert.equal(t.client.requests[0].model, 'rerank-v1');
    assert.equal(t.client.requests[0].query, 'q');
    assert.deepEqual(t.client.requests[0].documents, ids(result.rrf).slice(0, 4).map(id => rerankDocument(memory(id, `summary ${id}`))));
    assert.deepEqual(ids(result.rerank.candidates).slice(0, 3), ['f', 'b', 'a']);
    assert.deepEqual(ids(result.final), ['f', 'b']);
    assert.equal(result.rerank.candidates[0].rerankScore, 0.9);
    // unscored documents fall behind every scored one but keep their RRF order among themselves
    assert.deepEqual(ids(result.rerank.candidates).slice(3), ids(result.rrf).slice(0, 4).filter(id => !['f', 'b', 'a'].includes(id)));
  }

  // 5. Reranker request fails: RRF order is used and the failure is reported, not thrown.
  {
    const t = build({ settings: { rerankEnabled: true, finalRecallCount: 2 } });
    t.bm25.results = ranked(['a', 'b', 'c']);
    t.client.error = new AiRequestError('WM_AI_REQUEST_FAILED', 'simulated rerank outage', true);
    const result = await t.service.recall('chat', 'branch', 'q');
    assert.equal(result.rerank.status, 'failed');
    assert.equal(result.rerank.error, 'simulated rerank outage');
    assert.deepEqual(ids(result.final), ['a', 'b']);
    assert.deepEqual(result.errors, [{ source: 'rerank', code: 'WM_AI_REQUEST_FAILED', message: 'simulated rerank outage' }]);
  }

  // 5b. Rerank binding/channel resolution fails: optional enhancement stays degraded to RRF.
  {
    const t = build({ settings: { rerankEnabled: true }, resolveError: new AiConfigError('stored API key cannot be decrypted', 'WM_AI_CHANNEL_UNAVAILABLE') });
    t.bm25.results = ranked(['a', 'b', 'c']);
    const result = await t.service.recall('chat', 'branch', 'q');
    assert.equal(result.rerank.status, 'failed');
    assert.deepEqual(ids(result.final), ids(result.rrf));
    assert.deepEqual(result.errors, [{ source: 'rerank', code: 'WM_AI_CHANNEL_UNAVAILABLE', message: 'stored API key cannot be decrypted' }]);
    assert.equal(t.client.requests.length, 0);
  }

  // 6. Reranker answers without usable scores: treated as failure, RRF order kept.
  {
    const t = build({ settings: { rerankEnabled: true, finalRecallCount: 1 } });
    t.bm25.results = ranked(['a', 'b']);
    const result = await t.service.recall('chat', 'branch', 'q');
    assert.equal(result.rerank.status, 'failed');
    assert.equal(result.errors[0]?.code, 'WM_INVALID_RESPONSE');
    assert.deepEqual(ids(result.final), ['a']);
  }

  // 7. Pool not larger than the final count: rerank cannot change the selection, so no request is sent.
  {
    const t = build({ settings: { rerankEnabled: true, finalRecallCount: 6 } });
    t.bm25.results = ranked(['a', 'b', 'c']);
    const result = await t.service.recall('chat', 'branch', 'q');
    assert.equal(result.rerank.status, 'skipped_within_final');
    assert.equal(t.client.requests.length, 0);
    assert.deepEqual(ids(result.final), ['a', 'b', 'c']);
    const empty = build({ settings: { rerankEnabled: true } });
    assert.equal((await empty.service.recall('chat', 'branch', 'q')).rerank.status, 'no_candidates');
  }

  // 8. Embedding failure (roadmap §45): BM25 continues alone.
  {
    const t = build();
    t.bm25.results = ranked(['a', 'b']);
    t.embedding.error = new AiRequestError('WM_AI_CHANNEL_UNAVAILABLE', 'embedding model is not bound to any channel', false);
    const result = await t.service.recall('chat', 'branch', 'q');
    assert.deepEqual(ids(result.final), ['a', 'b']);
    assert.deepEqual(result.embedding, []);
    assert.deepEqual(result.errors, [{ source: 'embedding', code: 'WM_AI_CHANNEL_UNAVAILABLE', message: 'embedding model is not bound to any channel' }]);
  }

  // 9. BM25 failure: Embedding continues alone.
  {
    const t = build();
    t.bm25.error = new Error('index unavailable');
    t.embedding.results = ranked(['x', 'y']);
    const result = await t.service.recall('chat', 'branch', 'q');
    assert.deepEqual(ids(result.final), ['x', 'y']);
    assert.deepEqual(result.bm25, []);
    assert.equal(result.errors[0]?.source, 'bm25');
    assert.equal(result.errors[0]?.code, 'WM_INTERNAL_ERROR');
  }

  // 10. Both sources failing is a core failure and surfaces to the caller.
  {
    const t = build();
    t.bm25.error = new Error('db unreadable');
    t.embedding.error = new Error('embedding down');
    await assert.rejects(t.service.recall('chat', 'branch', 'q'), /long memory recall failed: db unreadable/);
  }

  // 11. Per-request overrides win over persisted settings; top-K caps reach each source.
  {
    const t = build({ settings: { rerankEnabled: true } });
    t.bm25.results = ranked(['a', 'b', 'c', 'd']);
    t.embedding.results = ranked(['e', 'f', 'g']);
    const result = await t.service.recall('chat', 'branch', 'q', { bm25TopK: 2, embeddingTopK: 1, finalRecallCount: 2, rerankEnabled: false, rrfK: 1 });
    assert.deepEqual(t.bm25.calls, [{ query: 'q', topK: 2 }]);
    assert.deepEqual(t.embedding.calls, [{ query: 'q', topK: 1 }]);
    assert.deepEqual(ids(result.rrf), ['a', 'e', 'b']);
    assert.deepEqual(ids(result.final), ['a', 'e']);
    assert.equal(result.rerank.status, 'disabled');
    assert.equal(result.settings.rrfK, 1);
    assert.equal(result.settings.rerankCandidateLimit, 20);
  }

  console.log('Phase 13 recall acceptance passed');
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
