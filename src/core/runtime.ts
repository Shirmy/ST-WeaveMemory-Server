import { fingerprint } from './fingerprint';
import type { FloorFinalizeRequest, GenerationPrepareRequest } from '../protocol';
import type { MemoryStore } from '../storage/types';
import { PerChatQueue } from '../queue/per-chat-queue';

export class MemoryRuntime {
  constructor(private readonly store: MemoryStore, private readonly queue: PerChatQueue) {}

  async finalizeFloor(input: FloorFinalizeRequest): Promise<{ accepted: boolean; floorKey: string }> {
    return this.queue.run(input.chatId, async () => {
      const contentFingerprint = fingerprint(input.content);
      const floorKey = `${input.chatId}:${input.messageIndex}:${input.swipeId ?? 0}:${contentFingerprint}`;
      const now = new Date().toISOString();
      await this.store.upsertFloor({
        floorKey,
        chatId: input.chatId,
        messageIndex: input.messageIndex,
        swipeId: input.swipeId,
        contentFingerprint,
        content: input.content,
        status: 'pending',
        createdAt: now,
        updatedAt: now
      });
      // v0.2: enqueue unified 谱 / 迹 / 事 state analysis here.
      return { accepted: true, floorKey };
    });
  }

  async prepareGeneration(_input: GenerationPrepareRequest) {
    // v0.2: state backlog gate -> recall -> token packing -> current-state projection.
    return {
      ready: true,
      longMemory: '',
      currentState: '',
      diagnostics: { memoryCount: 0, memoryTokens: 0, stateTokens: 0 }
    };
  }
}
