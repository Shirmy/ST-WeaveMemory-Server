import type { LongMemoryGenerator, LongMemoryBatchInput } from './long-memory';
import type { LongMemoryStore } from '../storage/long-memory-store';
import type { MemoryStore } from '../storage/types';
import type { StateChainStore } from '../storage/state-chain-store';

export type LongMemoryCommit = { chatId: string; branchId: string };

export class LongMemoryScheduler {
  private readonly pending = new Map<string, Promise<void>>();
  constructor(private readonly deps: { store: MemoryStore; chain: StateChainStore; memories: LongMemoryStore; generator: LongMemoryGenerator; getSummaryIntervalFloors?: () => Promise<number>; synchronize?: (chatId: string, branchId: string) => Promise<void> }) {}

  async buildRange(chatId: string, branchId: string, start: number, end: number): Promise<LongMemoryBatchInput> {
    await this.deps.synchronize?.(chatId, branchId);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) throw new Error('invalid summary range');
    const nodes = (await this.deps.chain.listNodes(branchId)).filter(node => node.status === 'synced' && node.chatId === chatId).sort((a, b) => a.messageIndex - b.messageIndex);
    const selected = nodes.slice(start - 1, end);
    if (selected.length !== end - start + 1) throw new Error('summary range requires synchronized source floors');
    const floors = await Promise.all(selected.map(node => this.deps.store.getFloor(node.floorId)));
    if (floors.some(floor => !floor || !floor.active || floor.chatId !== chatId)) throw new Error('summary source floors unavailable');
    const last = selected.at(-1)!;
    return { chatId, branchId, batchStartFloor: start, batchEndFloor: end, floors: floors.map(floor => ({ floorId: floor!.floorKey, content: floor!.content })), stateDeltas: [...(await this.deps.chain.getDeltasByNodeIds(selected.map(node => node.stateNodeId))).values()], endStateDigest: { stateNodeId: last.stateNodeId, stateFingerprint: last.stateFingerprint ?? '' } };
  }

  async onStateCommitted(input: LongMemoryCommit): Promise<void> {
    const key = JSON.stringify([input.chatId, input.branchId]);
    const previous = this.pending.get(key);
    const work = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() => this.generateCompleted(input));
    this.pending.set(key, work);
    try { await work; } finally { if (this.pending.get(key) === work) this.pending.delete(key); }
  }

  private async generateCompleted(input: LongMemoryCommit): Promise<void> {
    await this.deps.synchronize?.(input.chatId, input.branchId);
    const configured = this.deps.getSummaryIntervalFloors ? await this.deps.getSummaryIntervalFloors() : 30;
    const interval = Number.isSafeInteger(configured) && configured > 0 ? configured : 30;
    const nodes = (await this.deps.chain.listNodes(input.branchId)).filter(node => node.status === 'synced').sort((left, right) => left.messageIndex - right.messageIndex);
    if (!nodes.length) return;
    const completeBatchEnds = Math.floor(nodes.length / interval) * interval;
    if (!completeBatchEnds) return;
    const expected = Array.from({ length: completeBatchEnds / interval }, (_, index) => ({ batchStartFloor: index * interval + 1, batchEndFloor: (index + 1) * interval }));
    const activeBatches = await this.deps.memories.listBatches(input.chatId, input.branchId, false);
    if (activeBatches.some(batch => !expected.some(item => item.batchStartFloor === batch.batchStartFloor && item.batchEndFloor === batch.batchEndFloor))) {
      await this.deps.memories.markAllBatchesStale(input.chatId, input.branchId);
    }
    const historical = await this.deps.memories.listBatches(input.chatId, input.branchId, true);
    for (const range of expected) {
      const active = historical.find(batch => !batch.stale && batch.batchStartFloor === range.batchStartFloor && batch.batchEndFloor === range.batchEndFloor);
      if (active) continue;
      const nextStart = range.batchStartFloor;
      const endOrdinal = range.batchEndFloor;
      const selected = nodes.slice(nextStart - 1, endOrdinal);
      const floors = (await Promise.all(selected.map(node => this.deps.store.getFloor(node.floorId)))).filter((floor): floor is NonNullable<typeof floor> => Boolean(floor)).map(floor => ({ floorId: floor.floorKey, content: floor.content }));
      if (floors.length !== selected.length) return;
      const deltas = [...(await this.deps.chain.getDeltasByNodeIds(selected.map(node => node.stateNodeId))).values()];
      const endNode = selected.at(-1)!;
      await this.deps.generator.generate({ chatId: input.chatId, branchId: input.branchId, batchStartFloor: nextStart, batchEndFloor: endOrdinal, floors, stateDeltas: deltas, endStateDigest: { stateNodeId: endNode.stateNodeId, stateFingerprint: endNode.stateFingerprint ?? '' } });
    }
  }

  async reconcile(input: LongMemoryCommit): Promise<void> {
    await this.onStateCommitted(input);
  }
}
