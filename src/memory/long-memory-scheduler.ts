import type { LongMemoryGenerator } from './long-memory';
import type { LongMemoryStore } from '../storage/long-memory-store';
import type { MemoryStore } from '../storage/types';
import type { StateChainStore } from '../storage/state-chain-store';

export type LongMemoryCommit = { chatId: string; branchId: string };

export class LongMemoryScheduler {
  constructor(private readonly deps: { store: MemoryStore; chain: StateChainStore; memories: LongMemoryStore; generator: LongMemoryGenerator; getSummaryIntervalFloors?: () => Promise<number> }) {}

  async onStateCommitted(input: LongMemoryCommit): Promise<void> {
    const configured = this.deps.getSummaryIntervalFloors ? await this.deps.getSummaryIntervalFloors() : 30;
    const interval = Number.isSafeInteger(configured) && configured > 0 ? configured : 30;
    const nodes = (await this.deps.chain.listNodes(input.branchId)).filter(node => node.status === 'synced').sort((left, right) => left.messageIndex - right.messageIndex);
    if (!nodes.length) return;
    const existing = (await this.deps.memories.list(input.chatId, input.branchId, false)).filter(memory => !memory.stale);
    let nextStart = existing.reduce((max, memory) => Math.max(max, memory.endFloor + 1), 1);
    while (nodes.length >= nextStart + interval - 1) {
      const endOrdinal = nextStart + interval - 1;
      const selected = nodes.slice(nextStart - 1, endOrdinal);
      const floors = (await Promise.all(selected.map(node => this.deps.store.getFloor(node.floorId)))).filter((floor): floor is NonNullable<typeof floor> => Boolean(floor)).map(floor => ({ floorId: floor.floorKey, content: floor.content }));
      if (floors.length !== selected.length) return;
      const deltas = [...(await this.deps.chain.getDeltasByNodeIds(selected.map(node => node.stateNodeId))).values()];
      const endNode = selected.at(-1)!;
      await this.deps.generator.generate({ chatId: input.chatId, branchId: input.branchId, batchStartFloor: nextStart, batchEndFloor: endOrdinal, floors, stateDeltas: deltas, endStateDigest: { stateNodeId: endNode.stateNodeId, stateFingerprint: endNode.stateFingerprint ?? '' } });
      nextStart = endOrdinal + 1;
    }
  }
}
