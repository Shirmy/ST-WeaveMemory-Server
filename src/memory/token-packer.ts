import type { FusedMemory } from './recall';
import { estimateTokens as estimateTextTokens } from '../state/current-state';

export const TOKEN_PACKER_DEFAULTS = { maxMemoryCount: 6, fixedRecentCount: 2, minimumTokens: 2000, maximumTokens: 6000, contextRatio: 0.03 } as const;

export type TokenPackOptions = { contextWindow: number; maxMemoryCount?: number; fixedRecentCount?: number; tokenLimit?: number; currentState?: string };
export type PackedMemory = FusedMemory & { priority: 'fixed_recent' | 'high_relevance' | 'other'; estimatedTokens: number };
export type TokenPackResult = {
  memories: PackedMemory[];
  text: string;
  tokenLimit: number;
  estimatedTokens: number;
  currentStateTokens: number;
  diagnostics: { candidateCount: number; packedCount: number; fixedRecentCount: number; skippedByTokenBudget: number; skippedByCount: number };
};

/** Conservative dependency-free estimate; the rendered prompt itself is counted by packMemories. */
export function estimateTokens(text: string): number { return estimateTextTokens(text); }

export function tokenLimit(contextWindow: number, override?: number): number {
  if (override !== undefined && Number.isSafeInteger(override) && override >= 0) return override;
  const context = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 0;
  return Math.max(TOKEN_PACKER_DEFAULTS.minimumTokens, Math.min(context * TOKEN_PACKER_DEFAULTS.contextRatio, TOKEN_PACKER_DEFAULTS.maximumTokens));
}

function memoryText(item: FusedMemory): string {
  const title = item.memory.title?.trim() ? `${item.memory.title.trim()}\n` : '';
  return `[记忆 ${item.memory.startFloor}-${item.memory.endFloor}]\n${title}${item.memory.summary.trim()}`;
}

function promptText(memories: PackedMemory[]): string {
  if (!memories.length) return '';
  return '[织忆·长期记忆]\n\n以下是较早发生过的剧情记忆，只读参考。\n与最近正文冲突时，以最近正文为准。\n\n' + memories.map(memoryText).join('\n\n');
}

/** Fixed recent memories are considered first; every candidate and the wrapper prompt consume the same budget. */
export function packMemories(candidates: FusedMemory[], options: TokenPackOptions): TokenPackResult {
  const maxCount = Number.isSafeInteger(options.maxMemoryCount) && (options.maxMemoryCount as number) >= 0 ? options.maxMemoryCount as number : TOKEN_PACKER_DEFAULTS.maxMemoryCount;
  const fixedCount = Math.min(maxCount, Number.isSafeInteger(options.fixedRecentCount) && (options.fixedRecentCount as number) >= 0 ? options.fixedRecentCount as number : TOKEN_PACKER_DEFAULTS.fixedRecentCount);
  const limit = tokenLimit(options.contextWindow, options.tokenLimit);
  const unique = [...new Map(candidates.map(item => [item.memory.memoryId, item])).values()];
  const recent = [...unique].sort((a, b) => b.memory.endFloor - a.memory.endFloor || b.memory.startFloor - a.memory.startFloor || a.memory.memoryId.localeCompare(b.memory.memoryId)).slice(0, fixedCount);
  const recentIds = new Set(recent.map(item => item.memory.memoryId));
  const ordered = [...recent, ...unique.filter(item => !recentIds.has(item.memory.memoryId))];
  const packed: PackedMemory[] = [];
  let skippedByTokenBudget = 0;
  let skippedByCount = 0;
  for (const item of ordered) {
    if (packed.length >= maxCount) { skippedByCount++; continue; }
    const priority = recentIds.has(item.memory.memoryId) ? 'fixed_recent' : packed.length < fixedCount ? 'high_relevance' : 'other';
    const candidate = { ...item, priority, estimatedTokens: estimateTokens(memoryText(item)) } as PackedMemory;
    if (estimateTokens(promptText([...packed, candidate])) > limit) { skippedByTokenBudget++; continue; }
    packed.push(candidate);
  }
  const text = promptText(packed);
  return {
    memories: packed, text, tokenLimit: limit, estimatedTokens: estimateTokens(text), currentStateTokens: estimateTokens(options.currentState ?? ''),
    diagnostics: { candidateCount: unique.length, packedCount: packed.length, fixedRecentCount: packed.filter(item => item.priority === 'fixed_recent').length, skippedByTokenBudget, skippedByCount }
  };
}
