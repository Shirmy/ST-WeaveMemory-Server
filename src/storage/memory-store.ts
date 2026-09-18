import type { ActivateBranchResult, BranchRecord, ChatReconcileRequest, ChatReconcileResult, CreateBranchRequest, FloorRecord, MemoryStore } from './types';

export class InMemoryStore implements MemoryStore {
  #floors = new Map<string, FloorRecord>();

  async upsertFloor(record: FloorRecord): Promise<void> {
    this.#floors.set(record.floorKey, structuredClone(record));
  }

  async getFloor(floorKey: string): Promise<FloorRecord | null> {
    const value = this.#floors.get(floorKey);
    return value ? structuredClone(value) : null;
  }

  async getOrCreateActiveBranch(chatId: string): Promise<string> {
    return `main:${chatId}`;
  }

  async createBranch(input: CreateBranchRequest): Promise<ActivateBranchResult> {
    const branch: BranchRecord = {
      branchId: `branch:${input.chatId}:memory`,
      chatId: input.chatId,
      parentBranchId: input.sourceBranchId ?? `main:${input.chatId}`,
      forkFloorId: input.forkFloorId,
      active: true,
      createdAt: new Date().toISOString()
    };
    return { branch, activeFloorIds: [] };
  }

  async activateBranch(chatId: string, branchId: string): Promise<ActivateBranchResult> {
    return {
      branch: { branchId, chatId, parentBranchId: null, forkFloorId: null, active: true, createdAt: new Date().toISOString() },
      activeFloorIds: []
    };
  }

  async reconcileChat(input: ChatReconcileRequest): Promise<ChatReconcileResult> {
    const branchId = await this.getOrCreateActiveBranch(input.chatId);
    const activeFloorIds: string[] = [];
    const reusedFloorIds: string[] = [];
    const createdFloorIds: string[] = [];
    for (const floor of input.floors) {
      const floorKey = `${input.chatId}:${floor.messageIndex}:${floor.swipeId ?? 0}`;
      activeFloorIds.push(floorKey);
      createdFloorIds.push(floorKey);
    }
    return {
      chatId: input.chatId,
      branchId,
      branch: { branchId, chatId: input.chatId, parentBranchId: null, forkFloorId: null, active: true, createdAt: new Date().toISOString() },
      activeFloorIds,
      reusedFloorIds,
      createdFloorIds,
      staleFloorIds: []
    };
  }
}
