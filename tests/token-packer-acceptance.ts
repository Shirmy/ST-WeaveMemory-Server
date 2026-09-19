import assert from 'node:assert/strict';
import { packMemories, tokenLimit } from '../src/memory/token-packer';
import type { FusedMemory } from '../src/memory/recall';
import type { LongMemoryRecord } from '../src/memory/long-memory';

function memory(memoryId: string, startFloor: number, endFloor: number, summary: string): FusedMemory {
  return {
    memory: {
      memoryId, chatId: 'chat', branchId: 'branch', batchId: 'batch', sliceId: memoryId,
      startFloor, endFloor, summary, tags: [], characterIds: [], plotlineIds: [],
      endStateNodeId: 'node', endStateFingerprint: 'fp', bm25Indexed: true, embeddingIndexed: true,
      stale: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      sourceFloorIds: [], batchDependencyFingerprint: 'dep', batchStartFloor: startFloor, batchEndFloor: endFloor
    } as LongMemoryRecord,
    rrfScore: 1, ranks: { bm25: 1 }, scores: { bm25: 1 }
  };
}

const candidates = [
  memory('old', 1, 2, 'old event'),
  memory('middle', 5, 6, 'middle event'),
  memory('recent', 10, 12, 'recent event')
];
assert.equal(tokenLimit(100_000), 3000);
assert.equal(tokenLimit(1), 2000);
const packed = packMemories(candidates, { contextWindow: 100_000, maxMemoryCount: 2, fixedRecentCount: 1 });
assert.equal(packed.memories.length, 2);
assert.equal(packed.memories[0].memory.memoryId, 'recent');
assert.equal(packed.memories[0].priority, 'fixed_recent');
assert.equal(packed.diagnostics.fixedRecentCount, 1);
assert.ok(packed.estimatedTokens <= packed.tokenLimit);

const budget = packMemories([memory('huge', 1, 1, '字'.repeat(1000)), ...candidates], { contextWindow: 100_000, tokenLimit: 30, fixedRecentCount: 0 });
assert.ok(budget.estimatedTokens <= 30);
assert.ok(budget.diagnostics.skippedByTokenBudget > 0);
console.log('token packer acceptance passed');
