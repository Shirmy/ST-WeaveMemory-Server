import type { LongMemoryGenerator } from './long-memory';
import type { LongMemoryStore } from '../storage/long-memory-store';
import type { MemoryStore } from '../storage/types';
import type { StateChainStore } from '../storage/state-chain-store';

export type LongMemoryCommit = { chatId: string; branchId: string };

export class LongMemoryScheduler {
  constructor(private readonly deps: { store: MemoryStore; chain: StateChainStore; memories: LongMemoryStore; generator: LongMemoryGenerator; summaryIntervalFloors?: number }) {}

  async onStateCommitted(input: LongMemoryCommit): Promise<void> {
    const interval = this.deps.summaryIntervalFloors ?? 30;
    const nodes = (await this.deps.chain.listNodes(input.branchId)).filter(node => node.status === 'synced').sort((left, right) => left.messageIndex - right.messageIndex);
    if (!nodes.length || nodes.length % interval !== 0) return;
    const existing = await this.deps.memories.list(input.chatId, input.branchId, true);
    const endNode = nodes[nodes.length - 1];
    if (existing.some(memory => memory.endFloor >= nodes.length)) return;
    const start = Math.max(0, nodes.length - interval);
    const selected = nodes.slice(start);
    const floors = (await Promise.all(selected.map(node => this.deps.store.getFloor(node.floorId)))).filter((floor): floor is NonNullable<typeof floor> => Boolean(floor)).map(floor => ({ floorId: floor.floorKey, content: floor.content }));
    if (floors.length !== selected.length) return;
    const deltas = [...(await this.deps.chain.getDeltasByNodeIds(selected.map(node => node.stateNodeId))).values()];
    await this.deps.generator.generate({ chatId: input.chatId, branchId: input.branchId, batchStartFloor: start + 1, batchEndFloor: nodes.length, floors, stateDeltas: deltas, endStateDigest: { stateNodeId: endNode.stateNodeId, stateFingerprint: endNode.stateFingerprint ?? '' } });
  }
}
