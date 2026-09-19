import assert from 'node:assert/strict';
import { MemoryRuntime } from '../src/core/runtime';
import { emptySnapshot } from '../src/state/apply';
import type { LongMemoryRecord } from '../src/memory/long-memory';
import type { FusedMemory } from '../src/memory/recall';

function memory(memoryId: string, startFloor: number, endFloor: number, summary: string): LongMemoryRecord {
  return { memoryId, chatId: 'chat', branchId: 'branch', batchId: 'batch', sliceId: memoryId, startFloor, endFloor, summary, tags: [], characterIds: [], plotlineIds: [], endStateNodeId: 'node', endStateFingerprint: 'fp', bm25Indexed: true, embeddingIndexed: true, stale: false, createdAt: '2026-01-01', updatedAt: '2026-01-01', sourceFloorIds: [], batchDependencyFingerprint: 'dep', batchStartFloor: startFloor, batchEndFloor: endFloor };
}
function fused(item: LongMemoryRecord): FusedMemory { return { memory: item, rrfScore: 1, ranks: { bm25: 1 }, scores: { bm25: 1 } }; }

async function main(): Promise<void> {
  const old = memory('old', 1, 2, 'old event');
  const middle = memory('middle', 9, 10, 'middle event');
  const recent = memory('recent', 19, 20, 'recent event');
  const snapshot = emptySnapshot('branch');
  const baseStore = { getOrCreateActiveBranch: async () => 'branch', getFloor: async () => null };
  const chain = { trustedPrefix: async () => ({ chatId: 'chat', branchId: 'branch', promptVersion: 'p', positions: [], firstInvalidIndex: null, firstLineageBreakIndex: null, head: null, lineageHead: null, nodes: [] }), snapshotAtFloor: async () => null, current: async () => ({ snapshot }) };
  const tasks = { listTasks: async () => [] };
  const recall = { recall: async (chatId: string, branchId: string, query: string) => { assert.equal(chatId, 'chat'); assert.equal(branchId, 'branch'); assert.equal(query, 'hello'); return { final: [fused(old)] }; } };
  const memories = { list: async () => [recent, middle, old] };
  const runtime = new MemoryRuntime(baseStore as never, {} as never, tasks as never, chain as never, recall as never, memories as never);
  const prepared = await runtime.prepareGeneration({ chatId: 'chat', generationType: 'normal', contextSize: 100_000, latestUserIndex: 0, latestUserText: 'hello' });
  assert.equal(prepared.ready, true);
  assert.equal(prepared.longMemory.includes('[织忆·长期记忆]'), true);
  assert.ok(prepared.longMemory.indexOf('old event') < prepared.longMemory.indexOf('recent event'));
  assert.equal(prepared.diagnostics.memoryCount, 3);
  const preparedDiagnostics = prepared.diagnostics as typeof prepared.diagnostics & { packedFixedRecentCount?: number; packedHighRelevanceCount?: number };
  assert.equal(preparedDiagnostics.packedFixedRecentCount, 2);
  assert.equal(preparedDiagnostics.packedHighRelevanceCount, 1);

  const failing = new MemoryRuntime(baseStore as never, {} as never, tasks as never, chain as never, { recall: async () => { throw new Error('database unreadable'); } } as never, memories as never);
  const failed = await failing.prepareGeneration({ chatId: 'chat', generationType: 'normal', contextSize: 100_000, latestUserIndex: 0, latestUserText: 'hello' });
  assert.equal(failed.ready, false);
  assert.equal((failed as { reason?: string }).reason, 'LONG_MEMORY_RECALL_FAILED');
  console.log('long memory injection acceptance passed');
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
