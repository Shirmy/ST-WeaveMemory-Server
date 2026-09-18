"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PerChatQueue = void 0;
class PerChatQueue {
    #tails = new Map();
    run(chatId, task) {
        const previous = this.#tails.get(chatId) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(task);
        this.#tails.set(chatId, next.finally(() => {
            if (this.#tails.get(chatId) === next)
                this.#tails.delete(chatId);
        }));
        return next;
    }
}
exports.PerChatQueue = PerChatQueue;
