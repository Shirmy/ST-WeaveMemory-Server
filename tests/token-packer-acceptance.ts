import assert from 'node:assert/strict';
import { estimateTokens, packMemories, tokenLimit } from '../src/memory/token-packer';
import type { FusedMemory } from '../src/memory/recall';
import type { LongMemoryRecord } from '../src/memory/long-memory';

function record(memoryId: string, startFloor: number, endFloor: number, summary: string): LongMemoryRecord {
  return { memoryId, chatId: 'chat', branchId: 'branch', batchId: 'batch', sliceId: memoryId, startFloor, endFloor, summary, tags: [], characterIds: [], plotlineIds: [], endStateNodeId: 'node', endStateFingerprint: 'fp', bm25Indexed: true, embeddingIndexed: true, stale: false, createdAt: '2026-01-01', updatedAt: '2026-01-01', sourceFloorIds: [], batchDependencyFingerprint: 'dep', batchStartFloor: startFloor, batchEndFloor: endFloor };
}
function fused(memory: LongMemoryRecord): FusedMemory { return { memory, rrfScore: 1, ranks: { bm25: 1 }, scores: { bm25: 1 } }; }
function ids(result: ReturnType<typeof packMemories>): string[] { return result.memories.map(item => item.memory.memoryId); }

assert.equal(tokenLimit(100_000), 3000);
assert.equal(tokenLimit(1), 2000);
assert.equal(estimateTokens('字'.repeat(1000)), 1000);
assert.equal(estimateTokens('a'.repeat(1000)), 250);
assert.equal(estimateTokens('你好 Alice 今天见到了 Bob'), 10);

const oldA = record('old-A', 1, 2, 'old A');
const oldB = record('old-B', 3, 4, 'old B');
const recentA = record('recent-A', 10, 12, 'recent A');
const recentB = record('recent-B', 13, 15, 'recent B');

// A: the packer receives Phase 13 final only; no hidden RRF candidates can enter.
const finalOnly = packMemories({ recallCandidates: [fused(oldA), fused(oldB)], fixedRecentMemories: [] }, { contextWindow: 100_000, maxMemoryCount: 10, fixedRecentCount: 0 });
assert.deepEqual(ids(finalOnly), ['old-A', 'old-B']);
// B: fixed recent comes from the active store set even when Recall did not return it.
const recentFirst = packMemories({ recallCandidates: [fused(oldA)], fixedRecentMemories: [recentB, recentA] }, { contextWindow: 100_000, maxMemoryCount: 6, fixedRecentCount: 2 });
assert.deepEqual(ids(recentFirst), ['recent-B', 'recent-A', 'old-A']);
assert.deepEqual(recentFirst.memories.slice(0, 2).map(item => item.priority), ['fixed_recent', 'fixed_recent']);
// C: fixed recent wins identity and deduplicates a Recall duplicate.
const deduped = packMemories({ recallCandidates: [fused(recentA), fused(oldA)], fixedRecentMemories: [recentA, recentB] }, { contextWindow: 100_000, maxMemoryCount: 6, fixedRecentCount: 2 });
assert.equal(ids(deduped).filter(id => id === 'recent-A').length, 1);
assert.equal(deduped.memories.find(item => item.memory.memoryId === 'recent-A')?.priority, 'fixed_recent');
assert.equal(deduped.diagnostics.deduplicatedCount, 3);
// D: maxMemoryCount applies to the combined total.
const capped = packMemories({ recallCandidates: [fused(oldA), fused(oldB)], fixedRecentMemories: [recentB, recentA] }, { contextWindow: 100_000, maxMemoryCount: 3, fixedRecentCount: 2 });
assert.equal(capped.memories.length, 3);
assert.equal(capped.diagnostics.packedFixedRecentCount, 2);
assert.equal(capped.diagnostics.packedHighRelevanceCount, 1);
assert.ok(capped.diagnostics.skippedByCount > 0);
// E: fixed recent has priority but never breaks the hard Token limit.
const overBudget = packMemories({ recallCandidates: [], fixedRecentMemories: [record('huge', 1, 1, '字'.repeat(3000))] }, { contextWindow: 1, fixedRecentCount: 1, tokenLimit: 30 });
assert.equal(overBudget.memories.length, 0);
assert.equal(overBudget.diagnostics.skippedByTokenBudget, 1);
assert.ok(overBudget.estimatedTokens <= overBudget.tokenLimit);
// H and current-state semantics: both sources are visible, while current state is diagnostics-only.
const priorities = packMemories({ recallCandidates: [fused(oldA)], fixedRecentMemories: [recentA] }, { contextWindow: 1, currentState: String.fromCodePoint(0x5f53, 0x524d, 0x72b6, 0x6001).repeat(1000) });
assert.deepEqual(priorities.memories.map(item => item.priority), ['fixed_recent', 'high_relevance']);
assert.equal(priorities.currentStateTokens, 4000);
assert.ok(priorities.estimatedTokens <= priorities.tokenLimit);
console.log('token packer acceptance passed');
