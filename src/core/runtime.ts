import { fingerprint } from './fingerprint';
import type { ChatReconcileRequest, CreateBranchRequest, FloorFinalizeRequest, GenerationPrepareRequest } from '../protocol';
import { floorKeyFor, type MemoryStore } from '../storage/types';
import { PerChatQueue } from '../queue/per-chat-queue';

export class MemoryRuntime {
  constructor(private readonly store: MemoryStore, private readonly queue: PerChatQueue) {}

  async finalizeFloor(input: FloorFinalizeRequest): Promise<{ accepted: boolean; floorKey: string }> {
    return this.queue.run(input.chatId, async () => {
      const contentFingerprint = fingerprint(input.content);
      const branchId = await this.store.getOrCreateActiveBranch(input.chatId);
      const floorKey = floorKeyFor(input.chatId, branchId, input.messageIndex, input.swipeId, contentFingerprint);
      const now = new Date().toISOString();
      await this.store.upsertFloor({
        floorKey,
        chatId: input.chatId,
        branchId,
        messageIndex: input.messageIndex,
        swipeId: input.swipeId,
        contentFingerprint,
        content: input.content,
        active: true,
        status: 'pending',
        createdAt: now,
        updatedAt: now
      });
      // v0.2: enqueue unified 谱 / 迹 / 事 state analysis here.
      return { accepted: true, floorKey };
    });
  }

  async reconcileChat(input: ChatReconcileRequest) {
    return this.queue.run(input.chatId, () => this.store.reconcileChat(input));
  }

  async createBranch(input: CreateBranchRequest) {
    return this.queue.run(input.chatId, () => this.store.createBranch(input));
  }

  async activateBranch(chatId: string, branchId: string) {
    return this.queue.run(chatId, () => this.store.activateBranch(chatId, branchId));
  }

  async prepareGeneration(input: GenerationPrepareRequest) {
    void input;
    // v0.2: state backlog gate -> recall -> token packing -> current-state projection.
    return {
      ready: true,
      longMemory: '',
      currentState: '',
      diagnostics: { memoryCount: 0, memoryTokens: 0, stateTokens: 0 }
    };
  }
}
