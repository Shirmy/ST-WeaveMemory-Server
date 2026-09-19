import assert from 'node:assert/strict';
import { LongMemoryGenerator, parseLongMemoryOutput, renderLongMemoryMessages, type LongMemoryBatchInput, type LongMemoryRecord } from '../src/memory/long-memory';

const input: LongMemoryBatchInput = { chatId: 'chat', branchId: 'branch', batchStartFloor: 1, batchEndFloor: 30, floors: [{ floorId: 'floor-1', content: '事件发生' }], stateDeltas: [{ path: '/story/now' }], endStateDigest: { stateNodeId: 'node-30', stateFingerprint: 'sha256:end' } };
const messages = renderLongMemoryMessages(input, { system: '只总结已发生事件。', task: '输出 JSON。' });
assert.equal(messages.length, 2);
const output = parseLongMemoryOutput(JSON.stringify({ slices: [{ startFloor: 1, endFloor: 30, title: '调查', summary: '调查已经发生。', tags: ['调查', '调查'], characterIds: ['alice'], plotlineIds: ['plot'], narrativeTime: '当天' }] }), input);
assert.equal(output.slices.length, 1);
assert.deepEqual(output.slices[0].tags, ['调查']);
assert.throws(() => parseLongMemoryOutput(JSON.stringify({ slices: [{ startFloor: 0, endFloor: 30, summary: '越界', tags: [], characterIds: [], plotlineIds: [] }] }), input));

async function main(): Promise<void> {
let calls = 0;
let saved: LongMemoryRecord[] = [];
const generator = new LongMemoryGenerator({
  aiConfig: { getBindings: async () => ({ summary: { channelId: 'summary', model: 'test' } }), getChannel: async () => ({ channelId: 'summary', name: 'summary', baseUrl: 'http://localhost', apiKey: 'key', timeout: 10, headers: {} }), getActivePrompt: async () => ({ preset: { content: { system: 'system', task: 'task' } } }) } as never,
  client: { chatCompletion: async () => { calls += 1; return { text: JSON.stringify({ slices: [{ startFloor: 1, endFloor: 30, summary: '已发生', tags: [], characterIds: [], plotlineIds: [] }] }) }; } } as never,
  store: {
    findByDependency: async (_chatId: string, _branchId: string, dependency: string) => saved.filter(item => item.batchDependencyFingerprint === dependency),
    activateBatch: async (batchId: string) => { const target = saved.find(item => item.batchId === batchId); saved = saved.map(item => item.batchStartFloor === target?.batchStartFloor && item.batchEndFloor === target?.batchEndFloor ? { ...item, stale: item.batchId !== batchId } : item); },
    listByBatch: async (batchId: string) => saved.filter(item => item.batchId === batchId),
    markStaleByFloorIds: async () => 0,
    insertBatch: async (records: LongMemoryRecord[]) => { saved = saved.map(item => item.batchStartFloor === records[0]?.batchStartFloor && item.batchEndFloor === records[0]?.batchEndFloor ? { ...item, stale: true } : item); saved.push(...records); }
  } as never
});
await generator.generate(input);
assert.equal(calls, 1);
saved = saved.map(item => ({ ...item, stale: true }));
const reused = await generator.generate(input);
assert.equal(calls, 1, 'same dependency must be reused before summary model call');
assert.equal(reused[0]?.stale, false, 'stale historical batch is reactivated');
const inputB = { ...input, endStateDigest: { stateNodeId: 'node-30-b', stateFingerprint: 'sha256:b' } };
await generator.generate(inputB);
assert.equal(calls, 2);
await generator.generate(input);
assert.equal(calls, 2, 'A to B to A must reuse historical A');
const active = saved.filter(item => !item.stale);
assert.equal(new Set(active.map(item => item.batchId)).size, 1, 'only one batch version may be active for a range');
assert.equal(active[0]?.batchDependencyFingerprint, saved[0]?.batchDependencyFingerprint);
console.log('long memory acceptance passed');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
