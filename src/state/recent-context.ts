export type RecentContextMode = 'raw' | 'summary';

export type RecentContextConfig = {
  mode: RecentContextMode;
  summaryRegex: string;
  recentFloorCount: number;
};

export type RecentContextItem = {
  floorId: string;
  messageIndex: number;
  text: string;
  source: 'raw' | 'summary' | 'fallback';
};

const DEFAULT_CONFIG: RecentContextConfig = { mode: 'raw', summaryRegex: '', recentFloorCount: 4 };

export function normalizeRecentContextConfig(input?: Partial<RecentContextConfig>): RecentContextConfig {
  const count = Number.isSafeInteger(input?.recentFloorCount) ? Math.min(20, Math.max(1, input!.recentFloorCount as number)) : DEFAULT_CONFIG.recentFloorCount;
  return {
    mode: input?.mode === 'summary' ? 'summary' : DEFAULT_CONFIG.mode,
    summaryRegex: typeof input?.summaryRegex === 'string' ? input.summaryRegex.slice(0, 1000) : DEFAULT_CONFIG.summaryRegex,
    recentFloorCount: count
  };
}

export function buildRecentContext(items: Array<{ floorId: string; messageIndex: number; content: string }>, input?: Partial<RecentContextConfig>): RecentContextItem[] {
  const config = normalizeRecentContextConfig(input);
  return items.slice(-config.recentFloorCount).map(item => {
    if (config.mode !== 'summary') return { floorId: item.floorId, messageIndex: item.messageIndex, text: item.content, source: 'raw' };
    const summary = extractSummary(item.content, config.summaryRegex);
    return { floorId: item.floorId, messageIndex: item.messageIndex, text: summary ?? item.content, source: summary ? 'summary' : 'fallback' };
  });
}

export function extractSummary(content: string, pattern: string): string | null {
  if (!pattern.trim()) return null;
  try {
    const match = new RegExp(pattern, 'ms').exec(content);
    if (!match) return null;
    const captured = match.slice(1).find(value => typeof value === 'string' && value.trim()) ?? match[0];
    const text = captured.trim();
    return text || null;
  } catch {
    return null;
  }
}
