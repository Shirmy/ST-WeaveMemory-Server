export const AI_ROLES = ['summary', 'state', 'embedding', 'rerank'] as const;
export type AiRole = (typeof AI_ROLES)[number];

export const AI_API_TYPES = ['openai-compatible'] as const;
export type AiApiType = (typeof AI_API_TYPES)[number];

export const PROMPT_TYPES = ['state', 'summary'] as const;
export type PromptType = (typeof PROMPT_TYPES)[number];

export type AiChannelSummary = {
  channelId: string;
  name: string;
  apiType: AiApiType;
  baseUrl: string;
  hasApiKey: boolean;
  timeout: number | null;
  headers: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};

/** Internal representation that carries the decrypted key. Never return it to the frontend. */
export type AiChannelRecord = AiChannelSummary & { apiKey: string | null };

export type AiChannelInput = {
  channelId?: string;
  name: string;
  apiType?: AiApiType;
  baseUrl: string;
  /** undefined = keep the stored key; null or '' = remove it. */
  apiKey?: string | null;
  timeout?: number | null;
  headers?: Record<string, string>;
};

export type AiModelBinding = {
  role: AiRole;
  channelId: string;
  model: string;
  updatedAt: string;
};

export type AiModelBindings = Record<AiRole, AiModelBinding | null>;

export type PromptContent = { system: string; task: string };

export type PromptPresetRecord = {
  presetId: string;
  promptType: PromptType;
  name: string;
  content: PromptContent;
  version: number;
  isBuiltin: boolean;
  createdAt: string;
  updatedAt: string;
};

export type PromptPresetInput = {
  presetId?: string;
  promptType: PromptType;
  name: string;
  content: PromptContent;
};

export type ActivePrompt = {
  preset: PromptPresetRecord;
  /** Content hash of the effective prompt; feeds dependency fingerprints as statePromptVersion. */
  promptVersion: string;
};

export type StateTaskSettings = {
  timeoutSec: number;
  maxAttempts: number;
  /** Roadmap §14.2: a full snapshot checkpoint every N synced state nodes. */
  checkpointInterval: number;
};

export type LongMemorySettings = { summaryIntervalFloors: number };
export const DEFAULT_LONG_MEMORY_SETTINGS: LongMemorySettings = { summaryIntervalFloors: 30 };
export const LONG_MEMORY_SETTING_LIMITS = { summaryIntervalFloors: { min: 1, max: 500 } } as const;

/** Roadmap §61 / §62: long-memory recall pipeline settings (BM25 + Embedding → RRF → optional reranker). */
export type RecallSettings = {
  bm25TopK: number;
  embeddingTopK: number;
  rrfK: number;
  rerankEnabled: boolean;
  rerankCandidateLimit: number;
  finalRecallCount: number;
};
export const DEFAULT_RECALL_SETTINGS: RecallSettings = { bm25TopK: 10, embeddingTopK: 10, rrfK: 60, rerankEnabled: false, rerankCandidateLimit: 20, finalRecallCount: 6 };
export const RECALL_SETTING_LIMITS = {
  bm25TopK: { min: 1, max: 100 },
  embeddingTopK: { min: 1, max: 100 },
  rrfK: { min: 1, max: 1000 },
  rerankCandidateLimit: { min: 1, max: 100 },
  finalRecallCount: { min: 1, max: 50 }
} as const;

export const DEFAULT_STATE_TASK_SETTINGS: StateTaskSettings = { timeoutSec: 45, maxAttempts: 3, checkpointInterval: 20 };

export const STATE_TASK_SETTING_LIMITS = {
  timeoutSec: { min: 15, max: 120 },
  maxAttempts: { min: 1, max: 5 },
  checkpointInterval: { min: 1, max: 200 }
} as const;
