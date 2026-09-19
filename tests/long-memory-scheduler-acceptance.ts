import assert from 'node:assert/strict';
import { LongMemoryScheduler } from '../src/memory/long-memory-scheduler';

const nodes = Array.from({ length: 30 }, (_, index) => ({ stateNodeId: `node-${index + 1}`, messageIndex: index + 1, floorId: `floor-${index + 1}`, status: 'synced' as const, stateFingerprint: `fp-${index + 1}` }));
let generated = 0;
const ranges: string[] = [];
const scheduler = new LongMemoryScheduler({
  getSummaryIntervalFloors: async () => 10,
  store: { getFloor: async (floorId: string) => ({ floorKey: floorId, chatId: 'chat', branchId: 'branch', messageIndex: Number(floorId.split('-')[1]), swipeId: 0, contentFingerprint: `body-${floorId}`, content: `content-${floorId}`, active: true, status: 'synced' as const, createdAt: '', updatedAt: '' }) } as never,
  chain: { listNodes: async () => nodes, getDeltasByNodeIds: async () => new Map() } as never,
  memories: { list: async () => [] } as never,
  generator: { generate: async (input: { batchStartFloor: number; batchEndFloor: number; floors: unknown[] }) => { generated += 1; ranges.push(`${input.batchStartFloor}-${input.batchEndFloor}`); assert.equal(input.floors.length, 10); return []; } } as never
});
async function main(): Promise<void> {
  await scheduler.onStateCommitted({ chatId: 'chat', branchId: 'branch' });
  assert.equal(generated, 3);
  assert.deepEqual(ranges, ['1-10', '11-20', '21-30']);
const untouched = new LongMemoryScheduler({ getSummaryIntervalFloors: async () => 50, store: { getFloor: async (floorId: string) => ({ floorKey: floorId, content: floorId }) } as never, chain: { listNodes: async () => nodes, getDeltasByNodeIds: async () => new Map() } as never, memories: { list: async () => [] } as never, generator: { generate: async () => { throw new Error('must not trigger'); } } as never });
  await untouched.onStateCommitted({ chatId: 'chat', branchId: 'branch' });
  let staleRegenerated = 0;
  const staleScheduler = new LongMemoryScheduler({ getSummaryIntervalFloors: async () => 30, store: { getFloor: async (floorId: string) => ({ floorKey: floorId, content: floorId }) } as never, chain: { listNodes: async () => nodes, getDeltasByNodeIds: async () => new Map() } as never, memories: { list: async () => [{ endFloor: 30, stale: true }] } as never, generator: { generate: async () => { staleRegenerated += 1; return []; } } as never });
  await staleScheduler.onStateCommitted({ chatId: 'chat', branchId: 'branch' });
  assert.equal(staleRegenerated, 1);
  console.log('long memory scheduler acceptance passed');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
