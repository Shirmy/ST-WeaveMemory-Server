import assert from 'node:assert/strict';
import { Bm25Index, Bm25SearchService, tokenize } from '../src/memory/bm25';
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

class DelayedStore {
  readonly indexed = new Map<string, boolean>();
  private readonly activeByScope = new Map<string, number>();
  readonly maxConcurrentByScope = new Map<string, number>();
  activeLists = 0;
  maxConcurrentLists = 0;
  constructor(private readonly records: Map<string, LongMemoryRecord[]>, private readonly delays: Map<string, number>) {}
  async list(chatId: string, branchId: string): Promise<LongMemoryRecord[]> {
    const key = `${chatId}\u0000${branchId}`;
    const active = (this.activeByScope.get(key) ?? 0) + 1;
    this.activeByScope.set(key, active);
    this.maxConcurrentByScope.set(key, Math.max(this.maxConcurrentByScope.get(key) ?? 0, active));
    this.activeLists += 1;
    this.maxConcurrentLists = Math.max(this.maxConcurrentLists, this.activeLists);
    await new Promise(resolve => setTimeout(resolve, this.delays.get(key) ?? 0));
    const result = (this.records.get(key) ?? []).map(item => ({ ...item }));
    this.activeByScope.set(key, active - 1);
    this.activeLists -= 1;
    return result;
  }
  async setBm25Indexed(ids: string[], value: boolean): Promise<void> { for (const id of ids) this.indexed.set(id, value); }
}

const scopedRecords = new Map([
  ['chat-a\u0000branch-a', [memory('a-alice', 'Alice opened the ancient gate', { chatId: 'chat-a', branchId: 'branch-a' })]],
  ['chat-b\u0000branch-b', [memory('b-bob', 'Bob cooked dinner', { chatId: 'chat-b', branchId: 'branch-b' })]],
  ['chat-1\u0000branch-a', [memory('one-queen', 'Alice became queen', { chatId: 'chat-1', branchId: 'branch-a' })]],
  ['chat-1\u0000branch-b', [memory('two-city', 'Alice left the city', { chatId: 'chat-1', branchId: 'branch-b' })]]
]);
const delayedStore = new DelayedStore(scopedRecords, new Map([
  ['chat-a\u0000branch-a', 30], ['chat-b\u0000branch-b', 1], ['chat-1\u0000branch-a', 20], ['chat-1\u0000branch-b', 2]
]));
const service = new Bm25SearchService(delayedStore as unknown as import('../src/storage/long-memory-store').LongMemoryStore);
async function runConcurrencyTests(): Promise<void> {
const [a, b] = await Promise.all([service.search('chat-a', 'branch-a', 'alice'), service.search('chat-b', 'branch-b', 'bob')]);
assert.deepEqual(a.map(item => item.memory.memoryId), ['a-alice']);
assert.equal(a[0].memory.bm25Indexed, true);
assert.deepEqual(b.map(item => item.memory.memoryId), ['b-bob']);
assert.ok(delayedStore.maxConcurrentLists >= 2);
assert.equal((await service.search('chat-a', 'branch-a', 'bob')).length, 0);
assert.equal((await service.search('chat-b', 'branch-b', 'alice')).length, 0);
const [branchA, branchB] = await Promise.all([service.search('chat-1', 'branch-a', 'queen'), service.search('chat-1', 'branch-b', 'queen')]);
assert.deepEqual(branchA.map(item => item.memory.memoryId), ['one-queen']);
assert.equal(branchB.length, 0);
const sameScope = await Promise.all([
  service.search('chat-a', 'branch-a', 'alice'),
  service.search('chat-a', 'branch-a', 'alice'),
  service.search('chat-a', 'branch-a', 'alice')
]);
assert.deepEqual(sameScope.map(items => items.map(item => item.memory.memoryId)), [['a-alice'], ['a-alice'], ['a-alice']]);
assert.equal(delayedStore.maxConcurrentByScope.get('chat-a\u0000branch-a'), 1);
const active = scopedRecords.get('chat-a\u0000branch-a')!;
active[0].stale = true;
assert.equal((await service.search('chat-a', 'branch-a', 'alice')).length, 0);
active[0].stale = false;
assert.equal((await service.search('chat-a', 'branch-a', 'alice')).length, 1);
assert.equal(delayedStore.indexed.get('a-alice'), true);
}

runConcurrencyTests().then(() => console.log('bm25 acceptance passed')).catch(error => { console.error(error); process.exitCode = 1; });
