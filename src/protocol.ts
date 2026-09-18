export const BACKEND_VERSION = '0.1.0';
export const API_VERSION = 1;
export const SCHEMA_VERSION = 6;
/** Version of the state-analysis request/response protocol (roadmap §8); part of dependency fingerprints. */
export const STATE_PROTOCOL_VERSION = 1;

export type GenerationPrepareRequest = {
  chatId: string;
  generationType: string;
  contextSize: number;
  latestUserIndex: number | null;
  latestUserText: string;
};

export type FloorFinalizeRequest = {
  chatId: string;
  branchId?: string;
  messageIndex: number;
  swipeId: number | null;
  content: string;
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

export type CreateBranchRequest = {
  chatId: string;
  sourceBranchId?: string;
  forkFloorId: string;
};

export type ActivateBranchRequest = {
  chatId: string;
  branchId: string;
};

export type HostChatBindingRequest = {
  chatId: string;
  mainChatId?: string | null;
  forkFloor?: ReconcileFloor | null;
};
