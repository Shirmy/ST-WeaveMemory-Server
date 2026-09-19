import type { FusedMemory } from './recall';
import type { LongMemoryRecord } from './long-memory';
import { estimateTokens as estimateTextTokens } from '../state/current-state';

export const TOKEN_PACKER_DEFAULTS = { maxMemoryCount: 6, fixedRecentCount: 2, minimumTokens: 2000, maximumTokens: 6000, contextRatio: 0.03 } as const;
export type TokenPackOptions = { contextWindow: number; maxMemoryCount?: number; fixedRecentCount?: number; tokenLimit?: number; currentState?: string };
export type TokenPackInput = { recallCandidates: FusedMemory[]; fixedRecentMemories: LongMemoryRecord[] };
export type PackCandidate = { memory: LongMemoryRecord; source: 'fixed_recent' | 'high_relevance'; fused?: FusedMemory };
export type PackedMemory = PackCandidate & { priority: PackCandidate['source']; estimatedTokens: number };
export type TokenPackResult = {
  memories: PackedMemory[]; text: string; tokenLimit: number; estimatedTokens: number; currentStateTokens: number;
  diagnostics: { recallCandidateCount: number; fixedRecentCandidateCount: number; deduplicatedCount: number; packedCount: number; packedFixedRecentCount: number; packedHighRelevanceCount: number; skippedByTokenBudget: number; skippedByCount: number; candidateCount: number; fixedRecentCount: number };
};

/** Shared conservative estimate: CJK scripts cost one token per code point; other text uses four chars per token. */
export function estimateTokens(text: string): number { return estimateTextTokens(text); }

export function tokenLimit(contextWindow: number, override?: number): number {
  if (override !== undefined && Number.isSafeInteger(override) && override >= 0) return override;
  const context = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 0;
  return Math.max(TOKEN_PACKER_DEFAULTS.minimumTokens, Math.min(context * TOKEN_PACKER_DEFAULTS.contextRatio, TOKEN_PACKER_DEFAULTS.maximumTokens));
}

function memoryText(item: LongMemoryRecord): string {
  const title = item.title?.trim() ? `${item.title.trim()}\n` : '';
  return `[记忆 ${item.startFloor}-${item.endFloor}]\n${title}${item.summary.trim()}`;
}

export function renderLongMemory(memories: PackedMemory[]): string {
  if (!memories.length) return '';
  const chronological = [...memories].sort((left, right) => left.memory.startFloor - right.memory.startFloor || left.memory.endFloor - right.memory.endFloor || left.memory.memoryId.localeCompare(right.memory.memoryId));
  return '[织忆·长期记忆]\n\n以下是较早发生过的剧情记忆，只读参考。\n与最近正文冲突时，以最近正文为准。\n\n' + chronological.map(item => memoryText(item.memory)).join('\n\n');
}

/** Packs the explicit active fixed-recent set before the Phase 13 final-ranked recall set. */
export function packMemories(input: TokenPackInput, options: TokenPackOptions): TokenPackResult {
  const maxCount = Number.isSafeInteger(options.maxMemoryCount) && (options.maxMemoryCount as number) >= 0 ? options.maxMemoryCount as number : TOKEN_PACKER_DEFAULTS.maxMemoryCount;
  const fixedCount = Math.min(maxCount, Number.isSafeInteger(options.fixedRecentCount) && (options.fixedRecentCount as number) >= 0 ? options.fixedRecentCount as number : TOKEN_PACKER_DEFAULTS.fixedRecentCount);
  const limit = tokenLimit(options.contextWindow, options.tokenLimit);
  const fixed = input.fixedRecentMemories.slice(0, fixedCount).map(memory => ({ memory, source: 'fixed_recent' as const }));
  const recall = input.recallCandidates.map(fused => ({ memory: fused.memory, source: 'high_relevance' as const, fused }));
  const ordered: PackCandidate[] = [];
  const seen = new Set<string>();
  for (const item of [...fixed, ...recall]) {
    if (seen.has(item.memory.memoryId)) continue;
    seen.add(item.memory.memoryId);
    ordered.push(item);
  }
  const packed: PackedMemory[] = [];
  let skippedByTokenBudget = 0;
  let skippedByCount = 0;
  for (const item of ordered) {
    if (packed.length >= maxCount) { skippedByCount++; continue; }
    const candidate = { ...item, priority: item.source, estimatedTokens: estimateTokens(memoryText(item.memory)) } as PackedMemory;
    if (estimateTokens(renderLongMemory([...packed, candidate])) > limit) { skippedByTokenBudget++; continue; }
    packed.push(candidate);
  }
  const packedFixedRecentCount = packed.filter(item => item.priority === 'fixed_recent').length;
  const deduplicatedCount = ordered.length;
  return {
    memories: packed, text: renderLongMemory(packed), tokenLimit: limit, estimatedTokens: estimateTokens(renderLongMemory(packed)), currentStateTokens: estimateTokens(options.currentState ?? ''),
    diagnostics: { recallCandidateCount: input.recallCandidates.length, fixedRecentCandidateCount: fixed.length, deduplicatedCount, packedCount: packed.length, packedFixedRecentCount, packedHighRelevanceCount: packed.length - packedFixedRecentCount, skippedByTokenBudget, skippedByCount, candidateCount: deduplicatedCount, fixedRecentCount: packedFixedRecentCount }
  };
}
