"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemoryStore = void 0;
class InMemoryStore {
    #floors = new Map();
    async upsertFloor(record) {
        this.#floors.set(record.floorKey, structuredClone(record));
    }
    async getFloor(floorKey) {
        const value = this.#floors.get(floorKey);
        return value ? structuredClone(value) : null;
    }
}
exports.InMemoryStore = InMemoryStore;
