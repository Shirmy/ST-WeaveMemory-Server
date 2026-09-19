import type { ChainPosition } from './chain-engine';
import type { CalendarEntry, CharacterProfile, CharacterTrace, PlotPlan, Plotline, StateSnapshot } from './schema';

export type CurrentStateInput = {
  snapshot: StateSnapshot;
  userText: string;
  recentFloorTexts: string[];
  recentPositions: ChainPosition[];
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
  for (const item of [...story.now.ongoing, ...story.now.upcoming]) {
    if (item.relatedCharacterIds?.some(id => relatedCharacters.has(id))) item.relatedPlotlineIds?.forEach(id => relatedPlotlines.add(id));
  }
  for (const plotline of story.plotlines) {
    if (plotline.pinned || (!plotline.stalled && plotline.stage !== '淡出' && plotline.relatedCharacterIds?.some(id => relatedCharacters.has(id)))) relatedPlotlines.add(plotline.id);
  }

  const selectedProfiles = profiles.filter(profile => relatedCharacters.has(profile.characterId));
  const selectedTraces = selectedProfiles.map(profile => traces[profile.characterId]).filter((trace): trace is CharacterTrace => Boolean(trace));
  const selectedPlotlines = story.plotlines.filter(plotline => relatedPlotlines.has(plotline.id) && plotline.stage !== '淡出');
  const selectedPlans = story.plotPlans.filter(plan => plan.status === 'planned' || plan.status === 'triggered')
    .filter(plan => plan.pinned || plan.relatedCharacterIds?.some(id => relatedCharacters.has(id)) || plan.relatedPlotlineIds?.some(id => relatedPlotlines.has(id)));
  const calendar = selectCalendar(story.calendar, story.now.currentTime, relatedCharacters);

  const sections: string[] = [
    '[织忆·当前状态]',
    '以下是当前剧情的结构化状态，只读参考。若与最新正文冲突，以最新正文为准。',
    renderProfiles(selectedProfiles),
    renderTraces(selectedTraces),
    renderNow(story.now),
    renderCalendar(calendar),
    renderPlotlines(selectedPlotlines),
    renderPlans(selectedPlans)
  ];
  const text = sections.filter(Boolean).join('\n\n');
  return { text, characterIds: [...relatedCharacters], plotlineIds: [...relatedPlotlines], tokens: estimateTokens(text) };
}

export function estimateTokens(text: string): number {
  return text ? Math.max(1, Math.ceil(text.length / 4)) : 0;
}

function renderProfiles(profiles: CharacterProfile[]): string {
  if (!profiles.length) return '[谱]\n暂无与当前输入或近期剧情相关的人物。';
  return `[谱]\n${profiles.map(profile => {
    const value: Record<string, unknown> = {};
    for (const field of PROFILE_FIELDS) value[field] = profile[field];
    return `- ${JSON.stringify(value)}`;
  }).join('\n')}`;
}

function renderTraces(traces: CharacterTrace[]): string {
  if (!traces.length) return '[迹]\n暂无相关人物当前状态。';
  return `[迹]\n${traces.map(trace => `- ${JSON.stringify({ characterId: trace.characterId, longTermTendencies: trace.longTermTendencies, currentSituations: trace.currentSituations, visibility: trace.visibility, affinity: trace.affinity })}`).join('\n')}`;
}

function renderNow(now: StateSnapshot['story']['now']): string {
  return `[事·现在]\n${JSON.stringify({ currentTime: now.currentTime, ongoing: now.ongoing, upcoming: now.upcoming })}`;
}

function renderCalendar(entries: CalendarEntry[]): string {
  return `[事·日历]\n${entries.length ? entries.map(entry => `- ${JSON.stringify(entry)}`).join('\n') : '当前日期附近暂无已确认事项。'}`;
}

function renderPlotlines(plotlines: Plotline[]): string {
  return `[事·剧情线]\n${plotlines.length ? plotlines.map(plotline => `- ${JSON.stringify(plotline)}`).join('\n') : '暂无当前相关剧情线。'}`;
}

function renderPlans(plans: PlotPlan[]): string {
  return `[事·剧情安排]\n以下为未来规划，不代表已经发生。\n${plans.length ? plans.map(plan => `- ${JSON.stringify(plan)}`).join('\n') : '暂无当前相关剧情安排。'}`;
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
