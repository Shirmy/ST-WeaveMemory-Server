import { fingerprint } from './fingerprint';
import type { EnqueueOutcome, StateTaskRunner } from '../ai/state-task-runner';
import type { ChatReconcileRequest, CreateBranchRequest, FloorFinalizeRequest, GenerationPrepareRequest, HostChatBindingRequest } from '../protocol';
import { floorKeyFor, type MemoryStore } from '../storage/types';
import { PerChatQueue } from '../queue/per-chat-queue';

export type FloorFinalizeResult = {
  accepted: boolean;
  floorKey: string;
  /** Null when no state task runner is attached (unit tests of the floor layer). */
  stateTask: EnqueueOutcome | null;
};

export class MemoryRuntime {
  constructor(
    private readonly store: MemoryStore,
    private readonly queue: PerChatQueue,
    private readonly stateTasks: StateTaskRunner | null = null
  ) {}

  async finalizeFloor(input: FloorFinalizeRequest): Promise<FloorFinalizeResult> {
    const result = await this.queue.run(input.chatId, async () => {
      const contentFingerprint = fingerprint(input.content);
      const branchId = input.branchId ?? await this.store.getOrCreateActiveBranch(input.chatId);
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
      const stateTask = this.stateTasks
        ? await this.stateTasks.enqueueForFloor({
          chatId: input.chatId,
          branchId,
          floorId: floorKey,
          messageIndex: input.messageIndex,
          swipeId: input.swipeId,
          bodyFingerprint: contentFingerprint,
          reason: 'finalize'
        })
        : null;
      return { accepted: true, floorKey, stateTask };
    });
    this.stateTasks?.kick(input.chatId);
    return result;
  }

  async reconcileChat(input: ChatReconcileRequest) {
    return this.queue.run(input.chatId, async () => {
      const result = await this.store.reconcileChat(input);
      await this.stateTasks?.handleReconcile(result);
      return result;
    });
  }

  async createBranch(input: CreateBranchRequest) {
    return this.queue.run(input.chatId, () => this.store.createBranch(input));
  }

  async activateBranch(chatId: string, branchId: string) {
    return this.queue.run(chatId, () => this.store.activateBranch(chatId, branchId));
  }

  async bindHostChat(input: HostChatBindingRequest) {
    return this.queue.run(input.chatId, () => this.store.bindHostChat(input));
  }

  async prepareGeneration(input: GenerationPrepareRequest) {
    void input;
    // Phase 7: state backlog gate -> recall -> token packing -> current-state projection.
    return {
      ready: true,
      longMemory: '',
      currentState: '',
      diagnostics: { memoryCount: 0, memoryTokens: 0, stateTokens: 0 }
    };
  }
}
