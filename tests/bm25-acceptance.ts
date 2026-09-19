import assert from 'node:assert/strict';
import { Bm25Index, tokenize } from '../src/memory/bm25';
import type { LongMemoryRecord } from '../src/memory/long-memory';

function memory(memoryId: string, summary: string, overrides: Partial<LongMemoryRecord> = {}): LongMemoryRecord {
  return { memoryId, chatId: 'chat', branchId: 'branch', batchId: 'batch', sliceId: memoryId, startFloor: 1, endFloor: 2, batchStartFloor: 1, batchEndFloor: 2, summary, tags: [], characterIds: [], plotlineIds: [], sourceFloorIds: [], batchDependencyFingerprint: 'dep', endStateNodeId: 'node', endStateFingerprint: 'state', bm25Indexed: false, embeddingIndexed: false, stale: false, createdAt: '2026-01-01', updatedAt: '2026-01-01', ...overrides };
}

assert.deepEqual(tokenize('艾丽丝 Alice XML<hidden>'), ['艾', '丽', '丝', '艾丽', '丽丝', 'alice', 'xml', 'hidden']);
const index = new Bm25Index();
index.upsert(memory('a', 'Alice opened the ancient gate', { title: 'The Gate', tags: ['ruins'] }));
index.upsert(memory('b', 'Bob cooked dinner', { title: 'Dinner' }));
index.upsert(memory('c', '艾丽丝在古老的门前停下', { title: '古老的门' }));
assert.equal(index.search('ancient gate', 1)[0].memory.memoryId, 'a');
assert.equal(index.search('艾丽丝 古老的门', 1)[0].memory.memoryId, 'c');
assert.equal(index.search('dinner', 10).length, 1);
index.upsert(memory('a', 'unrelated replacement'));
assert.equal(index.search('ancient gate', 10).length, 0);
index.upsert(memory('b', 'Bob cooked dinner', { stale: true }));
assert.equal(index.search('dinner', 10).length, 0);
assert.equal(index.search('replacement', 10)[0].memory.memoryId, 'a');

const benchmark = new Bm25Index();
for (let n = 0; n < 10_000; n += 1) benchmark.upsert(memory(`bench-${n}`, `ancient gate character ${n}`, { tags: ['ruins'] }));
const started = Date.now();
for (let n = 0; n < 10; n += 1) benchmark.search('ancient gate', 10);
const averageMs = (Date.now() - started) / 10;
assert.ok(averageMs < 50, `BM25 10k search averaged ${averageMs}ms`);
console.log(`bm25 10k average: ${averageMs}ms`);
console.log('bm25 acceptance passed');
