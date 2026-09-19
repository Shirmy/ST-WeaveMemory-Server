import assert from 'node:assert/strict';
import { parseLongMemoryOutput, renderLongMemoryMessages, type LongMemoryBatchInput } from '../src/memory/long-memory';

const input: LongMemoryBatchInput = { chatId: 'chat', branchId: 'branch', batchStartFloor: 1, batchEndFloor: 30, floors: [{ floorId: 'floor-1', content: '事件发生' }], stateDeltas: [{ path: '/story/now' }], endStateDigest: { stateNodeId: 'node-30', stateFingerprint: 'sha256:end' } };
const messages = renderLongMemoryMessages(input, { system: '只总结已发生事件。', task: '输出 JSON。' });
assert.equal(messages.length, 2);
const output = parseLongMemoryOutput(JSON.stringify({ slices: [{ startFloor: 1, endFloor: 30, title: '调查', summary: '调查已经发生。', tags: ['调查', '调查'], characterIds: ['alice'], plotlineIds: ['plot'], narrativeTime: '当天' }] }), input);
assert.equal(output.slices.length, 1);
assert.deepEqual(output.slices[0].tags, ['调查']);
assert.throws(() => parseLongMemoryOutput(JSON.stringify({ slices: [{ startFloor: 0, endFloor: 30, summary: '越界', tags: [], characterIds: [], plotlineIds: [] }] }), input));
console.log('long memory acceptance passed');
