export type FloorRecord = {
  floorKey: string;
  chatId: string;
  messageIndex: number;
  swipeId: number | null;
  contentFingerprint: string;
  content: string;
  status: 'pending' | 'synced' | 'failed';
  createdAt: string;
  updatedAt: string;
};

export interface MemoryStore {
  upsertFloor(record: FloorRecord): Promise<void>;
  getFloor(floorKey: string): Promise<FloorRecord | null>;
}
