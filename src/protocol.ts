export const BACKEND_VERSION = '0.1.0';
export const API_VERSION = 1;
export const SCHEMA_VERSION = 1;

export type GenerationPrepareRequest = {
  chatId: string;
  generationType: string;
  contextSize: number;
  latestUserIndex: number | null;
  latestUserText: string;
};

export type FloorFinalizeRequest = {
  chatId: string;
  messageIndex: number;
  swipeId: number | null;
  content: string;
};
