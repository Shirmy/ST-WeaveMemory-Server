import type { RecallResult } from '../memory/recall';

export type ScopeDiagnostics = {
  generation?: { at: string; longMemory: string; currentState: string; estimatedTokens: number };
  summary?: { at: string; durationMs: number; promptVersion: string; model: string; channelId: string };
  recall?: { at: string; timings: RecallResult['timings']; packMs?: number; errors: RecallResult['errors'] };
};
const cache = new Map<string, ScopeDiagnostics>();
export function recordDiagnostics(chatId: string, branchId: string, patch: ScopeDiagnostics): void {
  const key = JSON.stringify([chatId, branchId]);
  const current = cache.get(key) ?? {};
  cache.delete(key);
  cache.set(key, { ...current, ...patch });
  if (cache.size > 100) cache.delete(cache.keys().next().value!);
}
export function currentDiagnostics(chatId: string, branchId: string): ScopeDiagnostics {
  return cache.get(JSON.stringify([chatId, branchId])) ?? {};
}
