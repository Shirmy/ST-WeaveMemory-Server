export class PerChatQueue {
  #tails = new Map<string, Promise<unknown>>();

  run<T>(chatId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(chatId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.#tails.set(chatId, next.finally(() => {
      if (this.#tails.get(chatId) === next) this.#tails.delete(chatId);
    }));
    return next;
  }
}
