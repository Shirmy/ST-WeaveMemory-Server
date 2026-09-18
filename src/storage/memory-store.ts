import type { FloorRecord, MemoryStore } from './types';

export class InMemoryStore implements MemoryStore {
  #floors = new Map<string, FloorRecord>();

  async upsertFloor(record: FloorRecord): Promise<void> {
    this.#floors.set(record.floorKey, structuredClone(record));
  }

  async getFloor(floorKey: string): Promise<FloorRecord | null> {
    const value = this.#floors.get(floorKey);
    return value ? structuredClone(value) : null;
  }
}
