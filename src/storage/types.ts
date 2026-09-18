export type FloorRecord = {
  floorKey: string;
  chatId: string;
  branchId: string;
  messageIndex: number;
  swipeId: number | null;
  contentFingerprint: string;
  content: string;
  active: boolean;
  status: 'pending' | 'synced' | 'failed' | 'stale';
  createdAt: string;
  updatedAt: string;
};

export type ReconcileFloor = {
  messageIndex: number;
  swipeId: number | null;
  content: string;
};

export type ChatReconcileRequest = {
  chatId: string;
  floors: ReconcileFloor[];
};

export type ChatReconcileResult = {
  chatId: string;
  branchId: string;
  activeFloorIds: string[];
  reusedFloorIds: string[];
  createdFloorIds: string[];
  staleFloorIds: string[];
};

export function floorKeyFor(chatId: string, messageIndex: number, swipeId: number | null, contentFingerprint: string): string {
  return `${chatId}:${messageIndex}:${swipeId ?? 0}:${contentFingerprint}`;
}

export interface MemoryStore {
  upsertFloor(record: FloorRecord): Promise<void>;
  getFloor(floorKey: string): Promise<FloorRecord | null>;
  getOrCreateActiveBranch(chatId: string): Promise<string>;
  reconcileChat(input: ChatReconcileRequest): Promise<ChatReconcileResult>;
}
