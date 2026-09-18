"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoryRuntime = void 0;
const fingerprint_1 = require("./fingerprint");
class MemoryRuntime {
    store;
    queue;
    constructor(store, queue) {
        this.store = store;
        this.queue = queue;
    }
    async finalizeFloor(input) {
        return this.queue.run(input.chatId, async () => {
            const contentFingerprint = (0, fingerprint_1.fingerprint)(input.content);
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
    async prepareGeneration(_input) {
        // v0.2: state backlog gate -> recall -> token packing -> current-state projection.
        return {
            ready: true,
            longMemory: '',
            currentState: '',
            diagnostics: { memoryCount: 0, memoryTokens: 0, stateTokens: 0 }
        };
    }
}
exports.MemoryRuntime = MemoryRuntime;
