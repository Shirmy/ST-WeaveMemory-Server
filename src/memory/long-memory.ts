import { randomUUID } from 'node:crypto';
import type { AiConfigStore } from '../storage/ai-config-store';
import type { LongMemoryStore } from '../storage/long-memory-store';
import type { OpenAiCompatibleClient } from '../ai/openai-compatible-client';
import type { ChatMessage } from '../ai/prompts/state-prompt';
import type { PromptContent } from '../ai/types';
import { fingerprint } from '../core/fingerprint';

export type LongMemoryBatchInput = {
  chatId: string;
  branchId: string;
  batchStartFloor: number;
  batchEndFloor: number;
  floors: Array<{ floorId: string; content: string; extractedRecentSummary?: string }>;
  stateDeltas: unknown[];
  endStateDigest: { stateNodeId: string; stateFingerprint: string };
};

export type LongMemorySliceDraft = {
  startFloor: number;
  endFloor: number;
  title?: string;
  summary: string;
  tags: string[];
  characterIds: string[];
  plotlineIds: string[];
  narrativeTime?: string;
};

export type LongMemoryBatchOutput = { slices: LongMemorySliceDraft[] };

export type LongMemoryRecord = LongMemorySliceDraft & {
  memoryId: string;
  chatId: string;
  branchId: string;
  batchId: string;
  sliceId: string;
  endStateNodeId: string;
  endStateFingerprint: string;
  bm25Indexed: boolean;
  embeddingIndexed: boolean;
  stale: boolean;
  createdAt: string;
  updatedAt: string;
  sourceFloorIds: string[];
  batchDependencyFingerprint: string;
};

export const DEFAULT_LONG_MEMORY_PROMPT: PromptContent = {
  system: '你是织忆的长期记忆总结模型。只总结已经发生的正文事实，按事件切片，保留人物、因果和时间；不要把当前状态或未来计划改写成新事实，不要抄写角色卡设定。',
  task: '请根据输入的楼层正文和状态变化输出 JSON：{"slices":[{"startFloor":number,"endFloor":number,"title":string,"summary":string,"tags":string[],"characterIds":string[],"plotlineIds":string[],"narrativeTime":string}]}。每个 summary 必须能独立理解。'
};

export function renderLongMemoryMessages(input: LongMemoryBatchInput, content: PromptContent): ChatMessage[] {
  const payload = { batchStartFloor: input.batchStartFloor, batchEndFloor: input.batchEndFloor, floors: input.floors, stateDeltas: input.stateDeltas, endStateDigest: input.endStateDigest };
  return [
    { role: 'system', content: content.system.trim() },
    { role: 'user', content: `${content.task.trim()}\n\n[LongMemoryBatchInput]\n${JSON.stringify(payload)}` }
  ];
}

export function parseLongMemoryOutput(raw: string, input: LongMemoryBatchInput): LongMemoryBatchOutput {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('long-memory model output is not JSON'); }
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (!Array.isArray(record.slices)) throw new Error('long-memory output must contain slices[]');
  const slices = record.slices.map((item, index) => {
    const row = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const startFloor = Number(row.startFloor); const endFloor = Number(row.endFloor); const summary = typeof row.summary === 'string' ? row.summary.trim() : '';
    if (!Number.isSafeInteger(startFloor) || !Number.isSafeInteger(endFloor) || startFloor < input.batchStartFloor || endFloor > input.batchEndFloor || startFloor > endFloor || !summary) throw new Error(`invalid long-memory slice at index ${index}`);
    const strings = (key: string): string[] => Array.isArray(row[key]) ? row[key].filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
    return { startFloor, endFloor, summary, ...(typeof row.title === 'string' && row.title.trim() ? { title: row.title.trim() } : {}), tags: [...new Set(strings('tags'))], characterIds: [...new Set(strings('characterIds'))], plotlineIds: [...new Set(strings('plotlineIds'))], ...(typeof row.narrativeTime === 'string' && row.narrativeTime.trim() ? { narrativeTime: row.narrativeTime.trim() } : {}) };
  });
  return { slices };
}

export type LongMemoryGeneratorDeps = { aiConfig: AiConfigStore; client: OpenAiCompatibleClient; store: LongMemoryStore };

export class LongMemoryGenerator {
  constructor(private readonly deps: LongMemoryGeneratorDeps) {}

  async generate(input: LongMemoryBatchInput): Promise<LongMemoryRecord[]> {
    const binding = (await this.deps.aiConfig.getBindings()).summary;
    if (!binding) throw new Error('summary model is not configured');
    const channel = await this.deps.aiConfig.getChannel(binding.channelId);
    if (!channel) throw new Error('summary channel is not configured');
    let prompt: { preset: { content: PromptContent } };
    try { prompt = await this.deps.aiConfig.getActivePrompt('summary'); }
    catch { prompt = { preset: { content: DEFAULT_LONG_MEMORY_PROMPT } }; }
    const completion = await this.deps.client.chatCompletion(channel, { model: binding.model, messages: renderLongMemoryMessages(input, prompt.preset.content), temperature: 0.2, maxTokens: 4096, timeoutMs: (channel.timeout ?? 120) * 1000 });
    const output = parseLongMemoryOutput(completion.text, input);
    const dependency = fingerprint(JSON.stringify({ floors: input.floors.map(floor => ({ id: floor.floorId, content: fingerprint(floor.content) })), stateDeltas: input.stateDeltas, endState: input.endStateDigest, prompt: prompt.preset.content }));
    const reusable = await this.deps.store.findByDependency(input.chatId, input.branchId, dependency);
    if (reusable.length) return reusable;
    const batchId = `batch_${randomUUID()}`; const now = new Date().toISOString();
    const records = output.slices.map((slice, index) => ({ ...slice, memoryId: `memory_${randomUUID()}`, chatId: input.chatId, branchId: input.branchId, batchId, sliceId: `${batchId}:slice:${index + 1}`, sourceFloorIds: input.floors.slice(slice.startFloor - input.batchStartFloor, slice.endFloor - input.batchStartFloor + 1).map(floor => floor.floorId), batchDependencyFingerprint: dependency, endStateNodeId: input.endStateDigest.stateNodeId, endStateFingerprint: input.endStateDigest.stateFingerprint, bm25Indexed: false, embeddingIndexed: false, stale: false, createdAt: now, updatedAt: now }));
    await this.deps.store.markStaleByFloorIds(input.chatId, input.branchId, input.floors.map(floor => floor.floorId));
    await this.deps.store.insertBatch(records);
    return records;
  }
}
