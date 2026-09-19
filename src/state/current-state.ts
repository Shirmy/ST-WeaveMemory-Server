import type { ChainPosition } from './chain-engine';
import type { CalendarEntry, CharacterProfile, CharacterTrace, PlotPlan, Plotline, StateSnapshot } from './schema';
import type { RecentContextItem } from './recent-context';
import type { WeaveSuppression } from './external-mapping';

export type CurrentStateInput = {
  snapshot: StateSnapshot;
  userText: string;
  recentFloorTexts: string[];
  recentPositions: ChainPosition[];
  recentContext?: RecentContextItem[];
  suppressedWeaveFields?: WeaveSuppression[];
};

export type CurrentStateResult = {
  text: string;
  characterIds: string[];
  plotlineIds: string[];
  tokens: number;
};

const PROFILE_FIELDS = ['canonicalName', 'basic', 'identity', 'personality', 'appearance', 'lifeDetails'] as const;

export function renderCurrentState(input: CurrentStateInput): CurrentStateResult {
  const { snapshot } = input;
  const profiles = Object.values(snapshot.profiles);
  const traces = snapshot.traces;
  const corpus = `${input.userText}\n${input.recentFloorTexts.join('\n')}`.toLocaleLowerCase();
  const relatedCharacters = new Set<string>();
  for (const profile of profiles) {
    const names = [profile.characterId, profile.canonicalName, ...profile.aliases].filter(Boolean);
    if (names.some(name => corpus.includes(name.toLocaleLowerCase()))) relatedCharacters.add(profile.characterId);
  }
  const story = snapshot.story;
  const relatedPlotlines = new Set<string>();
  const addCharacters = (ids: string[] | undefined): void => {
    for (const id of ids ?? []) if (snapshot.profiles[id]) relatedCharacters.add(id);
  };
  for (const item of [...story.now.ongoing, ...story.now.upcoming]) {
    addCharacters(item.relatedCharacterIds);
    for (const id of item.relatedPlotlineIds ?? []) if (story.plotlines.some(plotline => plotline.id === id)) relatedPlotlines.add(id);
  }
  for (const plotline of story.plotlines) {
    const active = plotline.pinned === true || (plotline.stalled !== true && plotline.stage !== '淡出');
    if (!active) continue;
    addCharacters(plotline.relatedCharacterIds);
    if (plotline.relatedCharacterIds?.some(id => snapshot.profiles[id])) relatedPlotlines.add(plotline.id);
  }

  const selectedProfiles = profiles.filter(profile => relatedCharacters.has(profile.characterId));
  const selectedTraces = selectedProfiles.map(profile => traces[profile.characterId]).filter((trace): trace is CharacterTrace => Boolean(trace));
  const selectedPlotlines = story.plotlines.filter(plotline => relatedPlotlines.has(plotline.id));
  const selectedPlans = story.plotPlans.filter(plan => plan.status === 'planned' || plan.status === 'triggered')
    .filter(plan => plan.pinned || plan.relatedCharacterIds?.some(id => relatedCharacters.has(id)) || plan.relatedPlotlineIds?.some(id => relatedPlotlines.has(id)));
  const calendar = selectCalendar(story.calendar, story.now.currentTime, relatedCharacters);

  const suppressed = input.suppressedWeaveFields ?? [];
  const sections: string[] = [
    '[织忆·当前状态]',
    '以下是当前剧情的结构化状态，只读参考。若与最新正文冲突，以最新正文为准。',
    renderProfiles(selectedProfiles, suppressed),
    renderTraces(selectedTraces, suppressed),
    renderNow(story.now, suppressed),
    renderRecentContext(input.recentContext ?? []),
    renderCalendar(calendar, suppressed),
    renderPlotlines(selectedPlotlines, suppressed),
    renderPlans(selectedPlans, suppressed)
  ];
  const text = sections.filter(Boolean).join('\n\n');
  return { text, characterIds: [...relatedCharacters], plotlineIds: [...relatedPlotlines], tokens: estimateTokens(text) };
}

// Phase 8 only uses structured now/plotline relationships for scene membership. There is no
// reliable scene-participant field in the current schema, so we deliberately do not infer people
// from prose or add a second model call. A future schema can extend this selector explicitly.

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const char of Array.from(text)) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(char)) cjk += 1;
    else other += 1;
  }
  return Math.max(1, cjk + Math.ceil(other / 4));
}

function renderProfiles(profiles: CharacterProfile[], suppressed: WeaveSuppression[]): string {
  if (!profiles.length) return '[谱]\n暂无与当前输入或近期剧情相关的人物。';
  return `[谱]\n${profiles.map(profile => {
    const value: Record<string, unknown> = {};
    for (const field of PROFILE_FIELDS) { const target = { domain: 'profile' as const, characterId: profile.characterId, field }; if (isSuppressed(suppressed, target)) continue; value[field] = typeof profile[field] === 'object' && profile[field] !== null && !Array.isArray(profile[field]) ? suppressObject(profile[field] as Record<string, unknown>, suppressed, target) : profile[field]; }
    return `- ${JSON.stringify(value)}`;
  }).join('\n')}`;
}

function renderTraces(traces: CharacterTrace[], suppressed: WeaveSuppression[]): string {
  if (!traces.length) return '[迹]\n暂无相关人物当前状态。';
  return `[迹]\n${traces.map(trace => { const value: Record<string, unknown> = { characterId: trace.characterId }; for (const field of ['longTermTendencies', 'currentSituations', 'visibility', 'affinity'] as const) { const target = { domain: 'trace' as const, characterId: trace.characterId, field }; if (field === 'longTermTendencies' || field === 'currentSituations' || field === 'visibility') { value[field] = trace[field].filter(item => !isSuppressedItem(suppressed, target, item.id, 'text' in item ? item.text : '')); } else if (!isSuppressed(suppressed, target)) value[field] = suppressObject(trace[field], suppressed, target); } return `- ${JSON.stringify(value)}`; }).join('\n')}`;
}

function renderNow(now: StateSnapshot['story']['now'], suppressed: WeaveSuppression[]): string {
  const value: Record<string, unknown> = { currentTime: now.currentTime, ongoing: now.ongoing.filter(item => !isSuppressedItem(suppressed, { domain: 'story', field: 'now.ongoing' }, item.id, `${item.title} ${item.description ?? ''}`)), upcoming: now.upcoming.filter(item => !isSuppressedItem(suppressed, { domain: 'story', field: 'now.upcoming' }, item.id, `${item.title} ${item.description ?? ''}`)) };
  if (isSuppressed(suppressed, { domain: 'story', field: 'now.currentTime' })) delete value.currentTime;
  return `[事·现在]\n${JSON.stringify(value)}`;
}

function renderRecentContext(items: RecentContextItem[]): string {
  if (!items.length) return '[织忆·近期上下文]\n暂无近期正文。';
  return `[织忆·近期上下文]\n${items.map(item => `- AI楼 ${item.messageIndex}（${item.source === 'summary' ? '摘要' : item.source === 'fallback' ? '摘要失败，使用原文' : '原文'}）：${item.text}`).join('\n')}`;
}

function renderCalendar(entries: CalendarEntry[], suppressed: WeaveSuppression[]): string {
  const visible = entries.filter(entry => !isSuppressedItem(suppressed, { domain: 'story', field: 'calendar' }, entry.id, `${entry.title} ${entry.description ?? ''}`));
  return `[事·日历]\n${visible.length ? visible.map(entry => `- ${JSON.stringify(entry)}`).join('\n') : '当前日期附近暂无已确认事项。'}`;
}

function renderPlotlines(plotlines: Plotline[], suppressed: WeaveSuppression[]): string {
  const visible = plotlines.filter(plotline => !isSuppressedItem(suppressed, { domain: 'story', field: 'plotlines' }, plotline.id, `${plotline.name} ${plotline.currentState}`));
  return `[事·剧情线]\n${visible.length ? visible.map(plotline => `- ${JSON.stringify(plotline)}`).join('\n') : '暂无当前相关剧情线。'}`;
}

function renderPlans(plans: PlotPlan[], suppressed: WeaveSuppression[]): string {
  const visible = plans.filter(plan => !isSuppressedItem(suppressed, { domain: 'story', field: 'plotPlans' }, plan.id, `${plan.title} ${plan.description ?? ''}`));
  return `[事·剧情安排]\n以下为未来规划，不代表已经发生。\n${visible.length ? visible.map(plan => `- ${JSON.stringify(plan)}`).join('\n') : '暂无当前相关剧情安排。'}`;
}

function selectCalendar(entries: CalendarEntry[], currentTime: string | undefined, characterIds: Set<string>): CalendarEntry[] {
  const relevant = entries.filter(entry => entry.confirmed && entry.relatedCharacterIds?.some(id => characterIds.has(id)));
  const current = parseDateKey(currentTime);
  if (!current) return [...new Map([...entries.filter(entry => entry.confirmed), ...relevant].map(entry => [entry.id, entry])).values()];
  const selected = entries.filter(entry => {
    if (!entry.confirmed) return false;
    const date = parseDateKey(entry.dateKey);
    if (!date) return false;
    const distance = Math.abs(date.getTime() - current.getTime()) / 86_400_000;
    return distance <= 1 || entry.relatedCharacterIds?.some(id => characterIds.has(id));
  });
  return [...new Map([...selected, ...relevant].map(entry => [entry.id, entry])).values()];
}

function parseDateKey(value: string | undefined): Date | null {
  if (!value) return null;
  const match = value.match(/^\d{4}-\d{2}-\d{2}/);
  if (!match) return null;
  const date = new Date(`${match[0]}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isSuppressed(all: WeaveSuppression[], target: WeaveSuppression): boolean {
  return all.some(item => item.domain === target.domain && (!item.characterId || item.characterId === target.characterId) && item.field === target.field && !item.itemId && !item.semanticKey);
}

function isSuppressedItem(all: WeaveSuppression[], target: WeaveSuppression, itemId: string, text: string): boolean {
  return all.some(item => item.domain === target.domain && (!item.characterId || item.characterId === target.characterId) && item.field === target.field && ((!item.itemId && !item.semanticKey) || item.itemId === itemId || item.semanticKey === itemId || Boolean(item.semanticKey && text.includes(item.semanticKey))));
}

function suppressObject(value: Record<string, unknown>, all: WeaveSuppression[], target: WeaveSuppression): Record<string, unknown> {
  const result = { ...value };
  for (const key of Object.keys(result)) if (isSuppressed(all, { ...target, field: `${target.field}.${key}` })) delete result[key];
  return result;
}
