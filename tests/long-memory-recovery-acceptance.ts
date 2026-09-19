import assert from 'node:assert/strict';
import { LongMemoryScheduler } from '../src/memory/long-memory-scheduler';

type Batch = { batchId: string; batchStartFloor: number; batchEndFloor: number; dependency: string; stale: boolean };

function nodes(count: number): Array<{ stateNodeId: string; messageIndex: number; floorId: string; status: 'synced'; stateFingerprint: string }> {
  return Array.from({ length: count }, (_, index) => ({ stateNodeId: `node-${index + 1}`, messageIndex: index + 1, floorId: `floor-${index + 1}`, status: 'synced', stateFingerprint: `state-${index + 1}` }));
}

async function reconcile(input: { count: number; interval: number; currentDependency: string; batches: Batch[] }): Promise<{ calls: number; batches: Batch[] }> {
  let calls = 0;
  const allNodes = nodes(input.count);
  const scheduler = new LongMemoryScheduler({
    getSummaryIntervalFloors: async () => input.interval,
    store: { getFloor: async (floorId: string) => ({ floorKey: floorId, content: input.currentDependency }) } as never,
    chain: { listNodes: async () => allNodes, getDeltasByNodeIds: async () => new Map() } as never,
    memories: {
      listBatches: async (_chatId: string, _branchId: string, includeStale: boolean) => input.batches.filter(batch => includeStale || !batch.stale),
      markAllBatchesStale: async () => { input.batches = input.batches.map(batch => ({ ...batch, stale: true })); }
    } as never,
    generator: { generate: async (batch: { batchStartFloor: number; batchEndFloor: number }) => {
      const reusable = input.batches.find(item => item.batchStartFloor === batch.batchStartFloor && item.batchEndFloor === batch.batchEndFloor && item.dependency === input.currentDependency);
      input.batches = input.batches.map(item => item.batchStartFloor === batch.batchStartFloor && item.batchEndFloor === batch.batchEndFloor ? { ...item, stale: item.batchId !== reusable?.batchId } : item);
      if (!reusable) {
        calls += 1;
        input.batches.push({ batchId: `generated-${batch.batchStartFloor}-${batch.batchEndFloor}`, batchStartFloor: batch.batchStartFloor, batchEndFloor: batch.batchEndFloor, dependency: input.currentDependency, stale: false });
      }
      return [];
    } } as never
  });
  await scheduler.reconcile({ chatId: 'chat', branchId: 'branch' });
  return { calls, batches: input.batches };
}

async function main(): Promise<void> {
  const restored = await reconcile({ count: 30, interval: 30, currentDependency: 'A', batches: [
    { batchId: 'A', batchStartFloor: 1, batchEndFloor: 30, dependency: 'A', stale: true },
    { batchId: 'B', batchStartFloor: 1, batchEndFloor: 30, dependency: 'B', stale: true }
  ] });
  assert.equal(restored.calls, 0);
  assert.equal(restored.batches.find(batch => batch.batchId === 'A')?.stale, false);
  assert.equal(restored.batches.find(batch => batch.batchId === 'B')?.stale, true);

  const staleOnly = await reconcile({ count: 30, interval: 30, currentDependency: 'C', batches: [
    { batchId: 'A', batchStartFloor: 1, batchEndFloor: 30, dependency: 'A', stale: true },
    { batchId: 'B', batchStartFloor: 1, batchEndFloor: 30, dependency: 'B', stale: true }
  ] });
  assert.equal(staleOnly.calls, 1);
  assert.equal(staleOnly.batches.filter(batch => !batch.stale).map(batch => batch.dependency).join(','), 'C');

  const intervalChanged = await reconcile({ count: 60, interval: 20, currentDependency: 'current', batches: [
    { batchId: 'old-1', batchStartFloor: 1, batchEndFloor: 30, dependency: 'old', stale: true },
    { batchId: 'old-2', batchStartFloor: 31, batchEndFloor: 60, dependency: 'old', stale: true }
  ] });
  assert.equal(intervalChanged.calls, 3);
  assert.deepEqual(intervalChanged.batches.filter(batch => !batch.stale).map(batch => `${batch.batchStartFloor}-${batch.batchEndFloor}`), ['1-20', '21-40', '41-60']);
  assert.equal(intervalChanged.batches.find(batch => batch.batchId === 'old-1')?.stale, true);
  assert.equal(intervalChanged.batches.find(batch => batch.batchId === 'old-2')?.stale, true);
  console.log('long memory recovery acceptance passed');
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
