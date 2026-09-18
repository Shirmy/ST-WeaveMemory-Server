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
  branchId?: string;
  floors: ReconcileFloor[];
};

export type ChatReconcileResult = {
  chatId: string;
  branchId: string;
  branch: BranchRecord;
  activeFloorIds: string[];
  reusedFloorIds: string[];
  createdFloorIds: string[];
  staleFloorIds: string[];
};

export type BranchRecord = {
  branchId: string;
  chatId: string;
  parentBranchId: string | null;
  forkFloorId: string | null;
  active: boolean;
  createdAt: string;
};

export type CreateBranchRequest = {
  chatId: string;
  sourceBranchId?: string;
  forkFloorId: string;
};

export type ActivateBranchResult = {
  branch: BranchRecord;
  activeFloorIds: string[];
};

export type HostChatBindingRequest = {
  chatId: string;
  mainChatId?: string | null;
  forkFloor?: ReconcileFloor | null;
};

export function floorKeyFor(chatId: string, branchId: string, messageIndex: number, swipeId: number | null, contentFingerprint: string): string {
  return `${branchId}:${chatId}:${messageIndex}:${swipeId ?? 0}:${contentFingerprint}`;
}

export interface MemoryStore {
  upsertFloor(record: FloorRecord): Promise<void>;
  getFloor(floorKey: string): Promise<FloorRecord | null>;
  updateFloorStatus(floorKey: string, status: FloorRecord['status']): Promise<void>;
  getOrCreateActiveBranch(chatId: string): Promise<string>;
  reconcileChat(input: ChatReconcileRequest): Promise<ChatReconcileResult>;
  createBranch(input: CreateBranchRequest): Promise<ActivateBranchResult>;
  activateBranch(chatId: string, branchId: string): Promise<ActivateBranchResult>;
  bindHostChat(input: HostChatBindingRequest): Promise<ActivateBranchResult>;
}
