export class PerChatQueue {
  #tails = new Map<string, Promise<unknown>>();

  run<T>(chatId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(chatId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    // Only the caller-facing promise rejects. The scheduling tail settles so a
    // handled API validation error cannot create an unhandled rejection.
    const cleanup = (): void => {
      if (this.#tails.get(chatId) === tail) this.#tails.delete(chatId);
    };
    const tail = next.then(cleanup, cleanup);
    this.#tails.set(chatId, tail);
    return next;
  }
}
