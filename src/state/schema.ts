export const STATE_SCHEMA_VERSION = 1;

export type StateRecordSource = {
  branchId: string;
  sourceFloorIds: string[];
  sourceHostChatIds: string[];
  sourceType?: 'manual' | 'story' | 'card';
};

export type CharacterProfile = {
  characterId: string;
  canonicalName: string;
  aliases: string[];
  basic: { gender?: string; age?: string; birthday?: string; race?: string; notes?: string };
  appearance: {
    height?: string; build?: string; face?: string; hair?: string; eyes?: string;
    distinctiveFeatures?: string[]; clothingStyle?: string; notes?: string;
  };
  identity: {
    occupation?: string; organizations?: string[]; socialIdentity?: string[];
    background?: string; importantRelations?: string[];
  };
  personality: {
    coreTraits?: string[]; behaviorStyle?: string[]; expressionHabits?: string[];
    likes?: string[]; dislikes?: string[]; principles?: string[];
  };
  lifeDetails: string[];
  nsfw?: Record<string, unknown>;
  lockedPaths: string[];
  sourcePriority: Record<string, 'manual' | 'story' | 'card'>;
  source: StateRecordSource;
  updatedAt: string;
};

export type CharacterTrace = {
  characterId: string;
  longTermTendencies: Array<{ id: string; text: string; targetCharacterId?: string }>;
  currentSituations: Array<{ id: string; text: string; targetCharacterId?: string }>;
  visibility: Array<{ id: string; fact: string; knownBy: string[]; unknownBy?: string[] }>;
  affinity: { inner: -2 | -1 | 0 | 1 | 2 | null; outer: -2 | -1 | 0 | 1 | 2 | null; note?: string };
  source: StateRecordSource;
  updatedAt: string;
};

export type CalendarEntry = {
  id: string;
  dateKey: string;
  type: 'story' | 'festival' | 'birthday' | 'anniversary' | 'custom';
  title: string;
  description?: string;
  relatedCharacterIds?: string[];
  sourceFloorIds?: string[];
  sourceHostChatIds?: string[];
  confirmed: boolean;
};

export type Plotline = {
  id: string;
  name: string;
  stage: '起线' | '延展' | '成形' | '收束' | '淡出';
  timeAnchor?: string;
  currentState: string;
  nextStep?: string;
  drivers?: string[];
  stalled?: boolean;
  pinned?: boolean;
  relatedCharacterIds?: string[];
  sourceFloorIds?: string[];
  sourceHostChatIds?: string[];
  updatedAt: string;
};

export type PlotPlan = {
  id: string;
  type: '明线' | '暗线' | '红线';
  title: string;
  description?: string;
  time: '今天' | '明天' | '后天' | '未来';
  location?: string;
  threadDynamic?: string;
  pinned?: boolean;
  relatedPlotlineIds?: string[];
  relatedCharacterIds?: string[];
  status: 'planned' | 'triggered' | 'cancelled' | 'expired';
  sourceFloorIds?: string[];
  sourceHostChatIds?: string[];
  createdAt: string;
  updatedAt: string;
};

export type StoryState = {
  now: {
    currentTime?: string;
    ongoing: Array<{ id: string; title: string; description?: string; relatedCharacterIds?: string[]; relatedPlotlineIds?: string[] }>;
    upcoming: Array<{ id: string; title: string; description?: string; expectedTime?: string; relatedCharacterIds?: string[]; relatedPlotlineIds?: string[] }>;
  };
  calendar: CalendarEntry[];
  plotlines: Plotline[];
  plotPlans: PlotPlan[];
  source: StateRecordSource;
};

export type StateSnapshot = {
  schemaVersion: number;
  branchId: string;
  profiles: Record<string, CharacterProfile>;
  traces: Record<string, CharacterTrace>;
  story: StoryState;
  updatedAt: string;
};

export type StateAnalysisRequest = {
  protocolVersion: number;
  schemaVersion: number;
  statePromptVersion: number;
  floor: { hostChatId: string; branchId: string; floorId: string; messageIndex: number; swipeId: number | null; content: string };
  previousRelevantState: Pick<StateSnapshot, 'profiles' | 'traces' | 'story'>;
  lockedPaths: string[];
  knownCharacters: Array<{ characterId: string; canonicalName: string; aliases: string[] }>;
};

export type StateAnalysisResponse = {
  profiles?: Record<string, Partial<CharacterProfile>>;
  traces?: Record<string, Partial<CharacterTrace>>;
  story?: Partial<StoryState>;
  touchedCharacterIds?: string[];
  notes?: string[];
};

export type StateSourceContext = {
  branchId: string;
  floorId?: string;
  hostChatId?: string;
  sourceType?: StateRecordSource['sourceType'];
};

export type ManualStateEdit = {
  branchId: string;
  hostChatId?: string;
  target: 'profile' | 'trace' | 'story';
  entityId?: string;
  path: string;
  value: unknown;
  source: StateRecordSource;
  updatedAt: string;
};

export type KnownCharacter = { characterId: string; canonicalName: string; aliases: string[] };

export class StateSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateSchemaError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const clone = <T>(value: T): T => structuredClone(value);

function fail(path: string, message: string): never {
  throw new StateSchemaError(`${path}: ${message}`);
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(path, 'must be a non-empty string');
  return value.trim();
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return stringValue(value, path);
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) fail(path, 'must be an array');
  const result = value.map((item, index) => stringValue(item, `${path}[${index}]`));
  return [...new Set(result)];
}

function optionalStringArray(value: unknown, path: string): string[] | undefined {
  return value === undefined ? undefined : stringArray(value, path);
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') fail(path, 'must be boolean');
  return value;
}

function objectValue(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) fail(path, 'must be an object');
  return value;
}

function knownKeys(item: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(item)) {
    if (!allowedSet.has(key)) fail(`${path}.${key}`, 'is an unknown field');
  }
}

function normalizedPath(path: string): string {
  return path.trim().replace(/\[(\d+)\]/g, '.$1').replace(/^\./, '');
}

function assertUnlocked(path: string, lockedPaths: string[], errorPath = path, includeDescendant = false): void {
  const candidate = normalizedPath(path).replace(/^response\./, '');
  for (const lockedPath of lockedPaths) {
    const locked = normalizedPath(lockedPath);
    if (candidate === locked || candidate.startsWith(`${locked}.`) || includeDescendant && locked.startsWith(`${candidate}.`)) fail(errorPath, 'is locked');
  }
}

function source(value: unknown, path: string, context?: StateSourceContext): StateRecordSource {
  const item = objectValue(value, path);
  knownKeys(item, ['branchId', 'sourceFloorIds', 'sourceHostChatIds', 'sourceType'], path);
  const branchId = stringValue(item.branchId, `${path}.branchId`);
  if (context?.branchId && branchId !== context.branchId) fail(`${path}.branchId`, 'does not match the current branch');
  const sourceType = item.sourceType === undefined ? 'story' : item.sourceType;
  if (sourceType !== 'manual' && sourceType !== 'story' && sourceType !== 'card') fail(`${path}.sourceType`, 'is invalid');
  return {
    branchId,
    sourceFloorIds: stringArray(item.sourceFloorIds, `${path}.sourceFloorIds`),
    sourceHostChatIds: stringArray(item.sourceHostChatIds, `${path}.sourceHostChatIds`),
    sourceType
  };
}

function validateAffinity(value: unknown, path: string): CharacterTrace['affinity'] {
  const item = objectValue(value, path);
  knownKeys(item, ['inner', 'outer', 'note'], path);
  const check = (candidate: unknown, field: string): CharacterTrace['affinity']['inner'] => {
    if (candidate === null) return null;
    if (candidate !== -2 && candidate !== -1 && candidate !== 0 && candidate !== 1 && candidate !== 2) fail(`${path}.${field}`, 'must be an integer from -2 to 2 or null');
    return candidate;
  };
  return { inner: check(item.inner, 'inner'), outer: check(item.outer, 'outer'), note: optionalString(item.note, `${path}.note`) };
}

function validateProfile(value: unknown, path: string, context?: StateSourceContext): CharacterProfile {
  const item = objectValue(value, path);
  knownKeys(item, ['characterId', 'canonicalName', 'aliases', 'basic', 'appearance', 'identity', 'personality', 'lifeDetails', 'nsfw', 'lockedPaths', 'sourcePriority', 'source', 'updatedAt'], path);
  const basic = objectValue(item.basic, `${path}.basic`);
  const appearance = objectValue(item.appearance, `${path}.appearance`);
  const identity = objectValue(item.identity, `${path}.identity`);
  const personality = objectValue(item.personality, `${path}.personality`);
  knownKeys(basic, ['gender', 'age', 'birthday', 'race', 'notes'], `${path}.basic`);
  knownKeys(appearance, ['height', 'build', 'face', 'hair', 'eyes', 'distinctiveFeatures', 'clothingStyle', 'notes'], `${path}.appearance`);
  knownKeys(identity, ['occupation', 'organizations', 'socialIdentity', 'background', 'importantRelations'], `${path}.identity`);
  knownKeys(personality, ['coreTraits', 'behaviorStyle', 'expressionHabits', 'likes', 'dislikes', 'principles'], `${path}.personality`);
  const sourcePriority = objectValue(item.sourcePriority, `${path}.sourcePriority`);
  const priority: Record<string, 'manual' | 'story' | 'card'> = {};
  for (const [key, value] of Object.entries(sourcePriority)) {
    const id = stringValue(key, `${path}.sourcePriority key`);
    if (value !== 'manual' && value !== 'story' && value !== 'card') fail(`${path}.sourcePriority.${id}`, 'is invalid');
    priority[id] = value;
  }
  const listFields = (object: Record<string, unknown>, fields: string[], base: string): Record<string, unknown> => {
    const result: Record<string, unknown> = {};
    for (const field of fields) {
      if (object[field] !== undefined) result[field] = Array.isArray(object[field]) ? stringArray(object[field], `${base}.${field}`) : stringValue(object[field], `${base}.${field}`);
    }
    return result;
  };
  return {
    characterId: stringValue(item.characterId, `${path}.characterId`),
    canonicalName: stringValue(item.canonicalName, `${path}.canonicalName`),
    aliases: stringArray(item.aliases, `${path}.aliases`),
    basic: listFields(basic, ['gender', 'age', 'birthday', 'race', 'notes'], `${path}.basic`) as CharacterProfile['basic'],
    appearance: listFields(appearance, ['height', 'build', 'face', 'hair', 'eyes', 'distinctiveFeatures', 'clothingStyle', 'notes'], `${path}.appearance`) as CharacterProfile['appearance'],
    identity: listFields(identity, ['occupation', 'organizations', 'socialIdentity', 'background', 'importantRelations'], `${path}.identity`) as CharacterProfile['identity'],
    personality: listFields(personality, ['coreTraits', 'behaviorStyle', 'expressionHabits', 'likes', 'dislikes', 'principles'], `${path}.personality`) as CharacterProfile['personality'],
    lifeDetails: stringArray(item.lifeDetails, `${path}.lifeDetails`),
    nsfw: item.nsfw === undefined ? undefined : objectValue(item.nsfw, `${path}.nsfw`),
    lockedPaths: stringArray(item.lockedPaths, `${path}.lockedPaths`),
    sourcePriority: priority,
    source: source(item.source, `${path}.source`, context),
    updatedAt: stringValue(item.updatedAt, `${path}.updatedAt`)
  };
}

function validateTrace(value: unknown, path: string, context?: StateSourceContext): CharacterTrace {
  const item = objectValue(value, path);
  knownKeys(item, ['characterId', 'longTermTendencies', 'currentSituations', 'visibility', 'affinity', 'source', 'updatedAt'], path);
  const list = (field: string): Array<Record<string, unknown>> => {
    const value = item[field];
    if (!Array.isArray(value)) fail(`${path}.${field}`, 'must be an array');
    return value.map((entry, index) => objectValue(entry, `${path}.${field}[${index}]`));
  };
  const tendency = list('longTermTendencies').map((entry, index) => { knownKeys(entry, ['id', 'text', 'targetCharacterId'], `${path}.longTermTendencies[${index}]`); return { id: stringValue(entry.id, `${path}.longTermTendencies[${index}].id`), text: stringValue(entry.text, `${path}.longTermTendencies[${index}].text`), targetCharacterId: optionalString(entry.targetCharacterId, `${path}.longTermTendencies[${index}].targetCharacterId`) }; });
  const situations = list('currentSituations').map((entry, index) => { knownKeys(entry, ['id', 'text', 'targetCharacterId'], `${path}.currentSituations[${index}]`); return { id: stringValue(entry.id, `${path}.currentSituations[${index}].id`), text: stringValue(entry.text, `${path}.currentSituations[${index}].text`), targetCharacterId: optionalString(entry.targetCharacterId, `${path}.currentSituations[${index}].targetCharacterId`) }; });
  const visibility = list('visibility').map((entry, index) => { knownKeys(entry, ['id', 'fact', 'knownBy', 'unknownBy'], `${path}.visibility[${index}]`); return { id: stringValue(entry.id, `${path}.visibility[${index}].id`), fact: stringValue(entry.fact, `${path}.visibility[${index}].fact`), knownBy: stringArray(entry.knownBy, `${path}.visibility[${index}].knownBy`), unknownBy: optionalStringArray(entry.unknownBy, `${path}.visibility[${index}].unknownBy`) }; });
  return { characterId: stringValue(item.characterId, `${path}.characterId`), longTermTendencies: tendency, currentSituations: situations, visibility, affinity: validateAffinity(item.affinity, `${path}.affinity`), source: source(item.source, `${path}.source`, context), updatedAt: stringValue(item.updatedAt, `${path}.updatedAt`) };
}

function validateStory(value: unknown, path: string, context?: StateSourceContext): StoryState {
  const item = objectValue(value, path);
  knownKeys(item, ['now', 'calendar', 'plotlines', 'plotPlans', 'source'], path);
  const now = objectValue(item.now, `${path}.now`);
  knownKeys(now, ['currentTime', 'ongoing', 'upcoming'], `${path}.now`);
  const simpleItems = (value: unknown, itemPath: string, allowExpectedTime: boolean) => {
    if (!Array.isArray(value)) fail(itemPath, 'must be an array');
    return value.map((entry, index) => {
      const current = objectValue(entry, `${itemPath}[${index}]`);
      knownKeys(current, allowExpectedTime ? ['id', 'title', 'description', 'expectedTime', 'relatedCharacterIds', 'relatedPlotlineIds'] : ['id', 'title', 'description', 'relatedCharacterIds', 'relatedPlotlineIds'], `${itemPath}[${index}]`);
      return {
        id: stringValue(current.id, `${itemPath}[${index}].id`),
        title: stringValue(current.title, `${itemPath}[${index}].title`),
        description: optionalString(current.description, `${itemPath}[${index}].description`),
        ...(allowExpectedTime ? { expectedTime: optionalString(current.expectedTime, `${itemPath}[${index}].expectedTime`) } : {}),
        relatedCharacterIds: optionalStringArray(current.relatedCharacterIds, `${itemPath}[${index}].relatedCharacterIds`),
        relatedPlotlineIds: optionalStringArray(current.relatedPlotlineIds, `${itemPath}[${index}].relatedPlotlineIds`)
      };
    });
  };
  const calendar = Array.isArray(item.calendar) ? item.calendar.map((entry, index) => {
    const current = objectValue(entry, `${path}.calendar[${index}]`);
    knownKeys(current, ['id', 'dateKey', 'type', 'title', 'description', 'relatedCharacterIds', 'sourceFloorIds', 'sourceHostChatIds', 'confirmed'], `${path}.calendar[${index}]`);
    const type = current.type;
    if (!['story', 'festival', 'birthday', 'anniversary', 'custom'].includes(String(type))) fail(`${path}.calendar[${index}].type`, 'is invalid');
    if (typeof current.confirmed !== 'boolean') fail(`${path}.calendar[${index}].confirmed`, 'must be boolean');
    return { id: stringValue(current.id, `${path}.calendar[${index}].id`), dateKey: stringValue(current.dateKey, `${path}.calendar[${index}].dateKey`), type: type as CalendarEntry['type'], title: stringValue(current.title, `${path}.calendar[${index}].title`), description: optionalString(current.description, `${path}.calendar[${index}].description`), relatedCharacterIds: optionalStringArray(current.relatedCharacterIds, `${path}.calendar[${index}].relatedCharacterIds`), sourceFloorIds: optionalStringArray(current.sourceFloorIds, `${path}.calendar[${index}].sourceFloorIds`), sourceHostChatIds: optionalStringArray(current.sourceHostChatIds, `${path}.calendar[${index}].sourceHostChatIds`), confirmed: current.confirmed };
  }) : fail(`${path}.calendar`, 'must be an array');
  const plotlines = Array.isArray(item.plotlines) ? item.plotlines.map((entry, index) => {
    const current = objectValue(entry, `${path}.plotlines[${index}]`);
    knownKeys(current, ['id', 'name', 'stage', 'timeAnchor', 'currentState', 'nextStep', 'drivers', 'stalled', 'pinned', 'relatedCharacterIds', 'sourceFloorIds', 'sourceHostChatIds', 'updatedAt'], `${path}.plotlines[${index}]`);
    if (!['起线', '延展', '成形', '收束', '淡出'].includes(String(current.stage))) fail(`${path}.plotlines[${index}].stage`, 'is invalid');
    return {
      id: stringValue(current.id, `${path}.plotlines[${index}].id`), name: stringValue(current.name, `${path}.plotlines[${index}].name`),
      stage: current.stage as Plotline['stage'], timeAnchor: optionalString(current.timeAnchor, `${path}.plotlines[${index}].timeAnchor`),
      currentState: stringValue(current.currentState, `${path}.plotlines[${index}].currentState`), nextStep: optionalString(current.nextStep, `${path}.plotlines[${index}].nextStep`),
      drivers: optionalStringArray(current.drivers, `${path}.plotlines[${index}].drivers`), stalled: optionalBoolean(current.stalled, `${path}.plotlines[${index}].stalled`), pinned: optionalBoolean(current.pinned, `${path}.plotlines[${index}].pinned`),
      relatedCharacterIds: optionalStringArray(current.relatedCharacterIds, `${path}.plotlines[${index}].relatedCharacterIds`), sourceFloorIds: optionalStringArray(current.sourceFloorIds, `${path}.plotlines[${index}].sourceFloorIds`), sourceHostChatIds: optionalStringArray(current.sourceHostChatIds, `${path}.plotlines[${index}].sourceHostChatIds`), updatedAt: stringValue(current.updatedAt, `${path}.plotlines[${index}].updatedAt`)
    };
  }) : fail(`${path}.plotlines`, 'must be an array');
  const plotPlans = Array.isArray(item.plotPlans) ? item.plotPlans.map((entry, index) => {
    const current = objectValue(entry, `${path}.plotPlans[${index}]`);
    knownKeys(current, ['id', 'type', 'title', 'description', 'time', 'location', 'threadDynamic', 'pinned', 'relatedPlotlineIds', 'relatedCharacterIds', 'status', 'sourceFloorIds', 'sourceHostChatIds', 'createdAt', 'updatedAt'], `${path}.plotPlans[${index}]`);
    if (!['明线', '暗线', '红线'].includes(String(current.type))) fail(`${path}.plotPlans[${index}].type`, 'is invalid');
    if (!['今天', '明天', '后天', '未来'].includes(String(current.time))) fail(`${path}.plotPlans[${index}].time`, 'is invalid');
    if (!['planned', 'triggered', 'cancelled', 'expired'].includes(String(current.status))) fail(`${path}.plotPlans[${index}].status`, 'is invalid');
    return {
      id: stringValue(current.id, `${path}.plotPlans[${index}].id`), type: current.type as PlotPlan['type'], title: stringValue(current.title, `${path}.plotPlans[${index}].title`), description: optionalString(current.description, `${path}.plotPlans[${index}].description`), time: current.time as PlotPlan['time'], location: optionalString(current.location, `${path}.plotPlans[${index}].location`), threadDynamic: optionalString(current.threadDynamic, `${path}.plotPlans[${index}].threadDynamic`), pinned: optionalBoolean(current.pinned, `${path}.plotPlans[${index}].pinned`), relatedPlotlineIds: optionalStringArray(current.relatedPlotlineIds, `${path}.plotPlans[${index}].relatedPlotlineIds`), relatedCharacterIds: optionalStringArray(current.relatedCharacterIds, `${path}.plotPlans[${index}].relatedCharacterIds`), status: current.status as PlotPlan['status'], sourceFloorIds: optionalStringArray(current.sourceFloorIds, `${path}.plotPlans[${index}].sourceFloorIds`), sourceHostChatIds: optionalStringArray(current.sourceHostChatIds, `${path}.plotPlans[${index}].sourceHostChatIds`), createdAt: stringValue(current.createdAt, `${path}.plotPlans[${index}].createdAt`), updatedAt: stringValue(current.updatedAt, `${path}.plotPlans[${index}].updatedAt`)
    };
  }) : fail(`${path}.plotPlans`, 'must be an array');
  return {
    now: { currentTime: optionalString(now.currentTime, `${path}.now.currentTime`), ongoing: simpleItems(now.ongoing, `${path}.now.ongoing`, false), upcoming: simpleItems(now.upcoming, `${path}.now.upcoming`, true) },
    calendar,
    plotlines,
    plotPlans,
    source: source(item.source, `${path}.source`, context)
  };
}

export function validateStateSnapshot(value: unknown, context?: StateSourceContext): asserts value is StateSnapshot {
  const item = objectValue(value, 'snapshot');
  knownKeys(item, ['schemaVersion', 'branchId', 'profiles', 'traces', 'story', 'updatedAt'], 'snapshot');
  if (item.schemaVersion !== STATE_SCHEMA_VERSION) fail('snapshot.schemaVersion', `must equal ${STATE_SCHEMA_VERSION}`);
  const branchId = stringValue(item.branchId, 'snapshot.branchId');
  if (context?.branchId && branchId !== context.branchId) fail('snapshot.branchId', 'does not match the current branch');
  if (!isRecord(item.profiles) || !isRecord(item.traces)) fail('snapshot', 'profiles and traces must be objects');
  for (const [id, profile] of Object.entries(item.profiles)) {
    const parsed = validateProfile(profile, `snapshot.profiles.${id}`, context);
    if (parsed.characterId !== id) fail(`snapshot.profiles.${id}.characterId`, 'must match the map key');
  }
  for (const [id, trace] of Object.entries(item.traces)) {
    const parsed = validateTrace(trace, `snapshot.traces.${id}`, context);
    if (parsed.characterId !== id) fail(`snapshot.traces.${id}.characterId`, 'must match the map key');
  }
  validateStory(item.story, 'snapshot.story', context);
  stringValue(item.updatedAt, 'snapshot.updatedAt');
}

export function normalizeStateSnapshot(value: unknown, context?: StateSourceContext): StateSnapshot {
  validateStateSnapshot(value, context);
  const result = clone(value);
  const normalizeSource = (item: StateRecordSource): StateRecordSource => ({
    ...item,
    branchId: item.branchId.trim(),
    sourceFloorIds: [...new Set(item.sourceFloorIds.map(id => id.trim()))],
    sourceHostChatIds: [...new Set(item.sourceHostChatIds.map(id => id.trim()))]
  });
  for (const [key, profile] of Object.entries(result.profiles)) {
    const normalizedKey = key.trim();
    profile.characterId = normalizedKey;
    profile.aliases = [...new Set(profile.aliases.map(alias => alias.trim()).filter(Boolean))];
    profile.lockedPaths = [...new Set(profile.lockedPaths.map(path => path.trim()).filter(Boolean))];
    profile.source = normalizeSource(profile.source);
    if (normalizedKey !== key) {
      delete result.profiles[key];
      result.profiles[normalizedKey] = profile;
    }
  }
  for (const [key, trace] of Object.entries(result.traces)) {
    const normalizedKey = key.trim();
    trace.characterId = normalizedKey;
    trace.source = normalizeSource(trace.source);
    if (normalizedKey !== key) {
      delete result.traces[key];
      result.traces[normalizedKey] = trace;
    }
  }
  result.story.source = normalizeSource(result.story.source);
  result.schemaVersion = STATE_SCHEMA_VERSION;
  result.branchId = context?.branchId ?? result.branchId;
  return result;
}

function validatePartialAffinity(value: unknown, path: string): void {
  const item = objectValue(value, path);
  knownKeys(item, ['inner', 'outer', 'note'], path);
  for (const field of ['inner', 'outer']) {
    if (item[field] !== undefined && item[field] !== null && ![-2, -1, 0, 1, 2].includes(item[field] as number)) fail(`${path}.${field}`, 'must be an integer from -2 to 2 or null');
    if (item[field] !== undefined && item[field] !== null && typeof item[field] !== 'number') fail(`${path}.${field}`, 'must be an integer from -2 to 2 or null');
  }
  optionalString(item.note, `${path}.note`);
}

function validatePartialProfile(value: unknown, path: string): void {
  const item = objectValue(value, path);
  knownKeys(item, ['characterId', 'canonicalName', 'aliases', 'basic', 'appearance', 'identity', 'personality', 'lifeDetails', 'nsfw', 'lockedPaths', 'sourcePriority', 'updatedAt'], path);
  optionalString(item.characterId, `${path}.characterId`);
  optionalString(item.canonicalName, `${path}.canonicalName`);
  optionalStringArray(item.aliases, `${path}.aliases`);
  optionalStringArray(item.lifeDetails, `${path}.lifeDetails`);
  optionalStringArray(item.lockedPaths, `${path}.lockedPaths`);
  optionalString(item.updatedAt, `${path}.updatedAt`);
  const nested: Record<string, string[]> = {
    basic: ['gender', 'age', 'birthday', 'race', 'notes'],
    appearance: ['height', 'build', 'face', 'hair', 'eyes', 'distinctiveFeatures', 'clothingStyle', 'notes'],
    identity: ['occupation', 'organizations', 'socialIdentity', 'background', 'importantRelations'],
    personality: ['coreTraits', 'behaviorStyle', 'expressionHabits', 'likes', 'dislikes', 'principles']
  };
  for (const [field, fields] of Object.entries(nested)) {
    if (item[field] === undefined) continue;
    const child = objectValue(item[field], `${path}.${field}`);
    knownKeys(child, fields, `${path}.${field}`);
    for (const key of fields) {
      if (child[key] !== undefined) {
        if (['distinctiveFeatures', 'organizations', 'socialIdentity', 'importantRelations', 'coreTraits', 'behaviorStyle', 'expressionHabits', 'likes', 'dislikes', 'principles'].includes(key)) stringArray(child[key], `${path}.${field}.${key}`);
        else stringValue(child[key], `${path}.${field}.${key}`);
      }
    }
  }
  if (item.nsfw !== undefined) objectValue(item.nsfw, `${path}.nsfw`);
  if (item.sourcePriority !== undefined) {
    const priority = objectValue(item.sourcePriority, `${path}.sourcePriority`);
    for (const [key, priorityValue] of Object.entries(priority)) {
      if (priorityValue !== 'manual' && priorityValue !== 'story' && priorityValue !== 'card') fail(`${path}.sourcePriority.${key}`, 'is invalid');
    }
  }
}

function validatePartialTrace(value: unknown, path: string): void {
  const item = objectValue(value, path);
  knownKeys(item, ['characterId', 'longTermTendencies', 'currentSituations', 'visibility', 'affinity', 'updatedAt'], path);
  optionalString(item.characterId, `${path}.characterId`);
  optionalString(item.updatedAt, `${path}.updatedAt`);
  if (item.affinity !== undefined) validatePartialAffinity(item.affinity, `${path}.affinity`);
  const arrays: Record<string, string[]> = {
    longTermTendencies: ['id', 'text', 'targetCharacterId'],
    currentSituations: ['id', 'text', 'targetCharacterId'],
    visibility: ['id', 'fact', 'knownBy', 'unknownBy']
  };
  for (const [field, fields] of Object.entries(arrays)) {
    if (item[field] === undefined) continue;
    if (!Array.isArray(item[field])) fail(`${path}.${field}`, 'must be an array');
    (item[field] as unknown[]).forEach((entry, index) => {
      const child = objectValue(entry, `${path}.${field}[${index}]`);
      knownKeys(child, fields, `${path}.${field}[${index}]`);
      stringValue(child.id, `${path}.${field}[${index}].id`);
      stringValue(child[field === 'visibility' ? 'fact' : 'text'], `${path}.${field}[${index}].${field === 'visibility' ? 'fact' : 'text'}`);
      optionalString(child.targetCharacterId, `${path}.${field}[${index}].targetCharacterId`);
      if (field === 'visibility') {
        stringArray(child.knownBy, `${path}.${field}[${index}].knownBy`);
        optionalStringArray(child.unknownBy, `${path}.${field}[${index}].unknownBy`);
      }
    });
  }
}

function validatePartialStory(value: unknown, path: string): void {
  const item = objectValue(value, path);
  knownKeys(item, ['now', 'calendar', 'plotlines', 'plotPlans'], path);
  if (item.now !== undefined) {
    const now = objectValue(item.now, `${path}.now`);
    knownKeys(now, ['currentTime', 'ongoing', 'upcoming'], `${path}.now`);
    optionalString(now.currentTime, `${path}.now.currentTime`);
    if (now.ongoing !== undefined) validateStory({ now: { ongoing: now.ongoing, upcoming: [] }, calendar: [], plotlines: [], plotPlans: [], source: { branchId: '_', sourceFloorIds: [], sourceHostChatIds: [] } }, `${path}.now`);
    if (now.upcoming !== undefined) validateStory({ now: { ongoing: [], upcoming: now.upcoming }, calendar: [], plotlines: [], plotPlans: [], source: { branchId: '_', sourceFloorIds: [], sourceHostChatIds: [] } }, `${path}.now`);
  }
  if (item.calendar !== undefined || item.plotlines !== undefined || item.plotPlans !== undefined) {
    validateStory({ now: { ongoing: [], upcoming: [] }, calendar: item.calendar ?? [], plotlines: item.plotlines ?? [], plotPlans: item.plotPlans ?? [], source: { branchId: '_', sourceFloorIds: [], sourceHostChatIds: [] } }, path);
  }
}

function validatePartialResponseValue(value: unknown, path: string, lockedPaths: string[]): void {
  assertUnlocked(path, lockedPaths, path);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validatePartialResponseValue(entry, `${path}[${index}]`, lockedPaths));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) validatePartialResponseValue(entry, `${path}.${key}`, lockedPaths);
}

export function validateStateAnalysisResponse(value: unknown, lockedPaths: string[] = []): asserts value is StateAnalysisResponse {
  const item = objectValue(value, 'response');
  knownKeys(item, ['profiles', 'traces', 'story', 'touchedCharacterIds', 'notes'], 'response');
  const scanIdentityFields = (candidate: unknown, path: string): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) => scanIdentityFields(entry, `${path}[${index}]`));
      return;
    }
    if (!isRecord(candidate)) return;
    for (const [key, entry] of Object.entries(candidate)) {
      if (['branchId', 'hostChatId', 'floorId', 'source'].includes(key)) fail(`${path}.${key}`, 'identity fields are supplied by the program');
      scanIdentityFields(entry, `${path}.${key}`);
    }
  };
  scanIdentityFields(item, 'response');
  for (const forbidden of ['branchId', 'hostChatId', 'floorId', 'source']) {
    if (forbidden in item) fail(`response.${forbidden}`, 'identity fields are supplied by the program');
  }
  for (const field of ['touchedCharacterIds', 'notes']) {
    if (item[field] !== undefined) stringArray(item[field], `response.${field}`);
  }
  for (const section of ['profiles', 'traces']) {
    if (item[section] !== undefined && !isRecord(item[section])) fail(`response.${section}`, 'must be an object');
  }
  if (item.story !== undefined && !isRecord(item.story)) fail('response.story', 'must be an object');
  if (isRecord(item.profiles)) for (const [characterId, record] of Object.entries(item.profiles)) validatePartialProfile(record, `response.profiles.${characterId}`);
  if (isRecord(item.traces)) for (const [characterId, record] of Object.entries(item.traces)) validatePartialTrace(record, `response.traces.${characterId}`);
  if (item.story !== undefined) validatePartialStory(item.story, 'response.story');
  validatePartialResponseValue(item, 'response', lockedPaths);
}

export function normalizeStateAnalysisResponse(value: unknown, lockedPaths: string[] = []): StateAnalysisResponse {
  validateStateAnalysisResponse(value, lockedPaths);
  return clone(value);
}

export function resolveCharacterIdentity(value: unknown, knownCharacters: KnownCharacter[]): string {
  const candidate = stringValue(value, 'character');
  const normalized = candidate.trim().toLocaleLowerCase();
  const match = knownCharacters.find(character => [character.characterId, character.canonicalName, ...character.aliases]
    .some(alias => alias.trim().toLocaleLowerCase() === normalized));
  return (match?.characterId ?? candidate).trim();
}

function validateManualEditValue(target: ManualStateEdit['target'], path: string, value: unknown): void {
  const normalized = normalizedPath(path);
  if (!normalized) fail('manualEdit.path', 'must be a non-empty schema path');
  const segments = normalized.split('.');
  if (segments.some(segment => !segment || !/^\d+$/.test(segment) && !/^[A-Za-z][A-Za-z0-9_]*$/.test(segment))) fail('manualEdit.path', 'contains an invalid path segment');
  if (target === 'profile') {
    if (segments.includes('source') || segments.includes('branchId') || segments.includes('hostChatId')) fail('manualEdit.path', 'cannot target identity or source fields');
    if (segments.length > 1 && !segments.some(segment => /^\d+$/.test(segment))) {
      validatePartialProfile(segments.length === 2 ? { [segments[0]]: { [segments[1]]: value } } : { [segments[0]]: value }, 'manualEdit.value');
      return;
    }
    if (segments.length === 1) {
      validatePartialProfile({ [segments[0]]: value }, 'manualEdit.value');
      return;
    }
  } else if (target === 'trace') {
    if (segments.length === 2 && segments[0] === 'affinity') {
      validatePartialAffinity({ [segments[1]]: value }, 'manualEdit.value');
      return;
    }
    if (segments.length === 1) {
      validatePartialTrace({ [segments[0]]: value }, 'manualEdit.value');
      return;
    }
    if (segments.length > 1 && !segments.some(segment => /^\d+$/.test(segment))) {
      validatePartialTrace({ [segments[0]]: { [segments[1]]: value } }, 'manualEdit.value');
      return;
    }
  } else {
    if (segments.length === 1) {
      validatePartialStory({ [segments[0]]: value }, 'manualEdit.value');
      return;
    }
    if (segments.length === 2 && segments[0] === 'now') {
      validatePartialStory({ now: { [segments[1]]: value } }, 'manualEdit.value');
      return;
    }
    const numericIndex = segments.findIndex(segment => /^\d+$/.test(segment));
    if (numericIndex >= 0) {
      const arrayPath = segments.slice(0, numericIndex).join('.');
      const leaf = segments.at(-1);
      const allowedFields: { strings: string[]; arrays: string[]; booleans: string[] } | undefined = {
        'now.ongoing': { strings: ['id', 'title', 'description'], arrays: ['relatedCharacterIds', 'relatedPlotlineIds'], booleans: [] },
        'now.upcoming': { strings: ['id', 'title', 'description', 'expectedTime'], arrays: ['relatedCharacterIds', 'relatedPlotlineIds'], booleans: [] },
        calendar: { strings: ['id', 'dateKey', 'title', 'description'], arrays: ['relatedCharacterIds', 'sourceFloorIds', 'sourceHostChatIds'], booleans: ['confirmed'] },
        plotlines: { strings: ['id', 'name', 'timeAnchor', 'currentState', 'nextStep', 'updatedAt'], arrays: ['drivers', 'relatedCharacterIds', 'sourceFloorIds', 'sourceHostChatIds'], booleans: ['stalled', 'pinned'] },
        plotPlans: { strings: ['id', 'title', 'description', 'location', 'threadDynamic', 'createdAt', 'updatedAt'], arrays: ['relatedPlotlineIds', 'relatedCharacterIds', 'sourceFloorIds', 'sourceHostChatIds'], booleans: ['pinned'] }
      }[arrayPath];
      if (!allowedFields || numericIndex !== segments.length - 2 || !leaf) fail('manualEdit.path', 'is not a supported array path');
      if (allowedFields.strings.includes(leaf)) stringValue(value, 'manualEdit.value');
      else if (allowedFields.arrays.includes(leaf)) stringArray(value, 'manualEdit.value');
      else if (allowedFields.booleans.includes(leaf)) {
        if (typeof value !== 'boolean') fail('manualEdit.value', 'must be boolean');
      } else fail('manualEdit.path', 'is not a supported array field');
      return;
    }
    const leaf = segments.at(-1);
    if (leaf && ['id', 'title', 'name', 'description', 'expectedTime', 'currentState', 'nextStep', 'timeAnchor', 'location', 'threadDynamic', 'updatedAt', 'createdAt'].includes(leaf)) stringValue(value, 'manualEdit.value');
    else if (leaf && ['pinned', 'stalled', 'confirmed'].includes(leaf)) {
      if (typeof value !== 'boolean') fail('manualEdit.value', 'must be boolean');
    } else if (leaf && ['relatedCharacterIds', 'relatedPlotlineIds', 'sourceFloorIds', 'sourceHostChatIds', 'drivers'].includes(leaf)) stringArray(value, 'manualEdit.value');
    else fail('manualEdit.path', 'is not a supported StoryState path');
    return;
  }
  fail('manualEdit.path', 'is not a supported schema path');
}

export function validateManualStateEdit(value: unknown, context?: StateSourceContext, lockedPaths: string[] = []): asserts value is ManualStateEdit {
  const item = objectValue(value, 'manualEdit');
  knownKeys(item, ['branchId', 'hostChatId', 'target', 'entityId', 'path', 'value', 'source', 'updatedAt'], 'manualEdit');
  const branchId = stringValue(item.branchId, 'manualEdit.branchId');
  if (context?.branchId && branchId !== context.branchId) fail('manualEdit.branchId', 'does not match the current branch');
  if (!['profile', 'trace', 'story'].includes(String(item.target))) fail('manualEdit.target', 'is invalid');
  if (item.target !== 'story') stringValue(item.entityId, 'manualEdit.entityId');
  const path = stringValue(item.path, 'manualEdit.path');
  const fullPath = item.target === 'story' ? `story.${path}` : `${item.target === 'profile' ? 'profiles' : 'traces'}.${String(item.entityId)}.${path}`;
  assertUnlocked(fullPath, lockedPaths, 'manualEdit.path', true);
  validateManualEditValue(item.target as ManualStateEdit['target'], path, item.value);
  source(item.source, 'manualEdit.source', { branchId });
  const editSource = item.source as Record<string, unknown>;
  if (editSource.sourceType !== 'manual') fail('manualEdit.source.sourceType', 'must be manual');
  stringValue(item.updatedAt, 'manualEdit.updatedAt');
}

const stringSchema = { type: 'string', minLength: 1 };
const stringArraySchema = { type: 'array', items: stringSchema };
const optionalStringFields = (fields: string[]) => Object.fromEntries(fields.map(field => [field, stringSchema]));
const sourceSchema = {
  type: 'object', additionalProperties: false,
  required: ['branchId', 'sourceFloorIds', 'sourceHostChatIds'],
  properties: { branchId: stringSchema, sourceFloorIds: stringArraySchema, sourceHostChatIds: stringArraySchema, sourceType: { enum: ['manual', 'story', 'card'] } }
};
const profileBasicSchema = { type: 'object', additionalProperties: false, properties: optionalStringFields(['gender', 'age', 'birthday', 'race', 'notes']) };
const profileAppearanceSchema = { type: 'object', additionalProperties: false, properties: { ...optionalStringFields(['height', 'build', 'face', 'hair', 'eyes', 'clothingStyle', 'notes']), distinctiveFeatures: stringArraySchema } };
const profileIdentitySchema = { type: 'object', additionalProperties: false, properties: { ...optionalStringFields(['occupation', 'background']), organizations: stringArraySchema, socialIdentity: stringArraySchema, importantRelations: stringArraySchema } };
const profilePersonalitySchema = { type: 'object', additionalProperties: false, properties: { coreTraits: stringArraySchema, behaviorStyle: stringArraySchema, expressionHabits: stringArraySchema, likes: stringArraySchema, dislikes: stringArraySchema, principles: stringArraySchema } };
const sourcePrioritySchema = { type: 'object', additionalProperties: { enum: ['manual', 'story', 'card'] } };
const profileSchema = {
  type: 'object', additionalProperties: false,
  required: ['characterId', 'canonicalName', 'aliases', 'basic', 'appearance', 'identity', 'personality', 'lifeDetails', 'lockedPaths', 'sourcePriority', 'source', 'updatedAt'],
  properties: { characterId: stringSchema, canonicalName: stringSchema, aliases: stringArraySchema, basic: profileBasicSchema, appearance: profileAppearanceSchema, identity: profileIdentitySchema, personality: profilePersonalitySchema, lifeDetails: stringArraySchema, nsfw: { type: 'object' }, lockedPaths: stringArraySchema, sourcePriority: sourcePrioritySchema, source: { $ref: '#/$defs/source' }, updatedAt: stringSchema }
};
const tendencySchema = { type: 'object', additionalProperties: false, required: ['id', 'text'], properties: { id: stringSchema, text: stringSchema, targetCharacterId: stringSchema } };
const situationSchema = tendencySchema;
const visibilitySchema = { type: 'object', additionalProperties: false, required: ['id', 'fact', 'knownBy'], properties: { id: stringSchema, fact: stringSchema, knownBy: stringArraySchema, unknownBy: stringArraySchema } };
const affinitySchema = { type: 'object', additionalProperties: false, required: ['inner', 'outer'], properties: { inner: { type: ['integer', 'null'], minimum: -2, maximum: 2 }, outer: { type: ['integer', 'null'], minimum: -2, maximum: 2 }, note: stringSchema } };
const traceSchema = {
  type: 'object', additionalProperties: false,
  required: ['characterId', 'longTermTendencies', 'currentSituations', 'visibility', 'affinity', 'source', 'updatedAt'],
  properties: { characterId: stringSchema, longTermTendencies: { type: 'array', items: tendencySchema }, currentSituations: { type: 'array', items: situationSchema }, visibility: { type: 'array', items: visibilitySchema }, affinity: affinitySchema, source: { $ref: '#/$defs/source' }, updatedAt: stringSchema }
};
const calendarSchema = { type: 'object', additionalProperties: false, required: ['id', 'dateKey', 'type', 'title', 'confirmed'], properties: { id: stringSchema, dateKey: stringSchema, type: { enum: ['story', 'festival', 'birthday', 'anniversary', 'custom'] }, title: stringSchema, description: stringSchema, relatedCharacterIds: stringArraySchema, sourceFloorIds: stringArraySchema, sourceHostChatIds: stringArraySchema, confirmed: { type: 'boolean' } } };
const ongoingSchema = { type: 'object', additionalProperties: false, required: ['id', 'title'], properties: { id: stringSchema, title: stringSchema, description: stringSchema, relatedCharacterIds: stringArraySchema, relatedPlotlineIds: stringArraySchema } };
const upcomingSchema = { type: 'object', additionalProperties: false, required: ['id', 'title'], properties: { id: stringSchema, title: stringSchema, description: stringSchema, expectedTime: stringSchema, relatedCharacterIds: stringArraySchema, relatedPlotlineIds: stringArraySchema } };
const plotlineSchema = { type: 'object', additionalProperties: false, required: ['id', 'name', 'stage', 'currentState', 'updatedAt'], properties: { id: stringSchema, name: stringSchema, stage: { enum: ['起线', '延展', '成形', '收束', '淡出'] }, timeAnchor: stringSchema, currentState: stringSchema, nextStep: stringSchema, drivers: stringArraySchema, stalled: { type: 'boolean' }, pinned: { type: 'boolean' }, relatedCharacterIds: stringArraySchema, sourceFloorIds: stringArraySchema, sourceHostChatIds: stringArraySchema, updatedAt: stringSchema } };
const plotPlanSchema = { type: 'object', additionalProperties: false, required: ['id', 'type', 'title', 'time', 'status', 'createdAt', 'updatedAt'], properties: { id: stringSchema, type: { enum: ['明线', '暗线', '红线'] }, title: stringSchema, description: stringSchema, time: { enum: ['今天', '明天', '后天', '未来'] }, location: stringSchema, threadDynamic: stringSchema, pinned: { type: 'boolean' }, relatedPlotlineIds: stringArraySchema, relatedCharacterIds: stringArraySchema, status: { enum: ['planned', 'triggered', 'cancelled', 'expired'] }, sourceFloorIds: stringArraySchema, sourceHostChatIds: stringArraySchema, createdAt: stringSchema, updatedAt: stringSchema } };
const storySchema = {
  type: 'object', additionalProperties: false, required: ['now', 'calendar', 'plotlines', 'plotPlans', 'source'],
  properties: { now: { type: 'object', additionalProperties: false, required: ['ongoing', 'upcoming'], properties: { currentTime: stringSchema, ongoing: { type: 'array', items: ongoingSchema }, upcoming: { type: 'array', items: upcomingSchema } } }, calendar: { type: 'array', items: calendarSchema }, plotlines: { type: 'array', items: plotlineSchema }, plotPlans: { type: 'array', items: plotPlanSchema }, source: { $ref: '#/$defs/source' } }
};
const partialProfileSchema = { type: 'object', additionalProperties: false, properties: { characterId: stringSchema, canonicalName: stringSchema, aliases: stringArraySchema, basic: profileBasicSchema, appearance: profileAppearanceSchema, identity: profileIdentitySchema, personality: profilePersonalitySchema, lifeDetails: stringArraySchema, nsfw: { type: 'object' }, lockedPaths: stringArraySchema, sourcePriority: sourcePrioritySchema, updatedAt: stringSchema } };
const partialTraceSchema = { type: 'object', additionalProperties: false, properties: { characterId: stringSchema, longTermTendencies: { type: 'array', items: tendencySchema }, currentSituations: { type: 'array', items: situationSchema }, visibility: { type: 'array', items: visibilitySchema }, affinity: affinitySchema, updatedAt: stringSchema } };
const partialStorySchema = { type: 'object', additionalProperties: false, properties: { now: { type: 'object', additionalProperties: false, properties: { currentTime: stringSchema, ongoing: { type: 'array', items: ongoingSchema }, upcoming: { type: 'array', items: upcomingSchema } } }, calendar: { type: 'array', items: calendarSchema }, plotlines: { type: 'array', items: plotlineSchema }, plotPlans: { type: 'array', items: plotPlanSchema } } };

export const STATE_SNAPSHOT_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'https://weavememory.local/schema/state-snapshot.v1.json', title: 'WeaveMemory StateSnapshot', type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'branchId', 'profiles', 'traces', 'story', 'updatedAt'],
  properties: { schemaVersion: { const: STATE_SCHEMA_VERSION }, branchId: stringSchema, profiles: { type: 'object', additionalProperties: profileSchema }, traces: { type: 'object', additionalProperties: traceSchema }, story: storySchema, updatedAt: stringSchema },
  $defs: { source: sourceSchema, characterProfile: profileSchema, characterTrace: traceSchema, calendarEntry: calendarSchema, plotline: plotlineSchema, plotPlan: plotPlanSchema, storyState: storySchema }
} as const;

export const STATE_ANALYSIS_RESPONSE_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'https://weavememory.local/schema/state-analysis-response.v1.json', title: 'WeaveMemory StateAnalysisResponse', type: 'object', additionalProperties: false,
  properties: { profiles: { type: 'object', additionalProperties: partialProfileSchema }, traces: { type: 'object', additionalProperties: partialTraceSchema }, story: partialStorySchema, touchedCharacterIds: stringArraySchema, notes: { type: 'array', items: { type: 'string' } } },
  $defs: { profile: partialProfileSchema, trace: partialTraceSchema, story: partialStorySchema, calendarEntry: calendarSchema, plotline: plotlineSchema, plotPlan: plotPlanSchema, source: sourceSchema }
} as const;
