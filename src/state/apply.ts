import {
  resolveCharacterIdentity,
  STATE_SCHEMA_VERSION,
  type CalendarEntry,
  type CharacterProfile,
  type CharacterTrace,
  type KnownCharacter,
  type Plotline,
  type PlotPlan,
  type StateAnalysisCandidate,
  type StateAnalysisProfileCandidate,
  type StateAnalysisTraceCandidate,
  type StateRecordSource,
  type StateSnapshot
} from './schema';
import { deepClone, deepEqual, hashCanonical, isPlainObject } from './diff';

export class StateApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateApplyError';
  }
}

export type ApplyContext = {
  branchId: string;
  floorId: string;
  hostChatId: string;
  now: string;
  /** Defaults to the characters already present in the previous snapshot. */
  knownCharacters?: KnownCharacter[];
};

export type ApplyResult = {
  snapshot: StateSnapshot;
  touchedCharacterIds: string[];
  changed: boolean;
};

/** Upper bound for provenance lists so a 1000-floor chat does not grow every record without limit. */
const MAX_SOURCE_IDS = 50;
const PROFILE_GROUPS = ['basic', 'appearance', 'identity', 'personality'] as const;
const STRING_ARRAY_FIELDS = new Set(['distinctiveFeatures', 'organizations', 'socialIdentity', 'importantRelations', 'coreTraits', 'behaviorStyle', 'expressionHabits', 'likes', 'dislikes', 'principles']);

export function emptySource(branchId: string): StateRecordSource {
  return { branchId, sourceFloorIds: [], sourceHostChatIds: [] };
}

export function emptySnapshot(branchId: string, now = '1970-01-01T00:00:00.000Z'): StateSnapshot {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    branchId,
    profiles: {},
    traces: {},
    story: { now: { ongoing: [], upcoming: [] }, calendar: [], plotlines: [], plotPlans: [], source: emptySource(branchId) },
    updatedAt: now
  };
}

/** Keys that describe bookkeeping rather than story state; they never influence the state fingerprint. */
const VOLATILE_KEYS = new Set(['updatedAt', 'source', 'sourceFloorIds', 'sourceHostChatIds']);

function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (VOLATILE_KEYS.has(key)) continue;
      result[key] = stripVolatile(entry);
    }
    return result;
  }
  return value;
}

/**
 * Semantic fingerprint of a snapshot (roadmap §12 stateFingerprint). Timestamps and provenance
 * (which floors confirmed a record) are excluded so a re-analysis that lands on the same story
 * state produces the same fingerprint even after floors were edited or renumbered, letting
 * downstream nodes be reused (§21 convergence).
 */
export function snapshotFingerprint(snapshot: StateSnapshot): string {
  return hashCanonical(stripVolatile(snapshot));
}

export function deriveKnownCharacters(snapshot: StateSnapshot): KnownCharacter[] {
  const known = new Map<string, KnownCharacter>();
  for (const profile of Object.values(snapshot.profiles)) {
    known.set(profile.characterId, { characterId: profile.characterId, canonicalName: profile.canonicalName, aliases: [...profile.aliases] });
  }
  for (const trace of Object.values(snapshot.traces)) {
    if (!known.has(trace.characterId)) known.set(trace.characterId, { characterId: trace.characterId, canonicalName: trace.characterId, aliases: [] });
  }
  return [...known.values()];
}

/** Locked paths in validator form (`profiles.<id>.<relative path>`). */
export function deriveLockedPaths(snapshot: StateSnapshot): string[] {
  const paths: string[] = [];
  for (const profile of Object.values(snapshot.profiles)) {
    for (const locked of profile.lockedPaths) paths.push(`profiles.${profile.characterId}.${locked}`);
  }
  return paths;
}

function normalizedPath(path: string): string {
  return path.trim().replace(/\[(\d+)\]/g, '.$1').replace(/^\./, '');
}

function isLocked(path: string, lockedPaths: string[]): boolean {
  const candidate = normalizedPath(path);
  return lockedPaths.some(locked => {
    const normalized = normalizedPath(locked);
    return candidate === normalized || candidate.startsWith(`${normalized}.`) || normalized.startsWith(`${candidate}.`);
  });
}

function pushBounded(list: string[] | undefined, id: string): string[] {
  const next = (list ?? []).filter(item => item !== id);
  next.push(id);
  return next.slice(-MAX_SOURCE_IDS);
}

function touchSource(previous: StateRecordSource | undefined, context: ApplyContext): StateRecordSource {
  return {
    branchId: context.branchId,
    sourceFloorIds: pushBounded(previous?.sourceFloorIds, context.floorId),
    sourceHostChatIds: pushBounded(previous?.sourceHostChatIds, context.hostChatId),
    sourceType: 'story'
  };
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function textArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map(item => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
  return [...new Set(items)];
}

function newProfile(characterId: string, displayName: string, context: ApplyContext): CharacterProfile {
  return {
    characterId,
    canonicalName: text(displayName) ?? characterId,
    aliases: [],
    basic: {},
    appearance: {},
    identity: {},
    personality: {},
    lifeDetails: [],
    lockedPaths: [],
    sourcePriority: {},
    source: touchSource(undefined, context),
    updatedAt: context.now
  };
}

function newTrace(characterId: string, context: ApplyContext): CharacterTrace {
  return {
    characterId,
    longTermTendencies: [],
    currentSituations: [],
    visibility: [],
    affinity: { inner: null, outer: null },
    source: touchSource(undefined, context),
    updatedAt: context.now
  };
}

function mergeProfile(base: CharacterProfile, patch: StateAnalysisProfileCandidate): { profile: CharacterProfile; changedPaths: string[] } {
  const profile = deepClone(base);
  const changedPaths: string[] = [];
  const canonicalName = text(patch.canonicalName);
  if (canonicalName !== undefined && canonicalName !== profile.canonicalName) {
    profile.canonicalName = canonicalName;
    changedPaths.push('canonicalName');
  }
  const aliases = textArray(patch.aliases);
  if (aliases !== undefined && !deepEqual(aliases, profile.aliases)) {
    profile.aliases = aliases;
    changedPaths.push('aliases');
  }
  for (const group of PROFILE_GROUPS) {
    const groupPatch = patch[group];
    if (!isPlainObject(groupPatch)) continue;
    const target = profile[group] as Record<string, unknown>;
    for (const [field, value] of Object.entries(groupPatch)) {
      if (value === undefined) continue;
      const normalized = STRING_ARRAY_FIELDS.has(field) ? textArray(value) : text(value);
      if (normalized === undefined || deepEqual(target[field], normalized)) continue;
      target[field] = normalized;
      changedPaths.push(`${group}.${field}`);
    }
  }
  const lifeDetails = textArray(patch.lifeDetails);
  if (lifeDetails !== undefined && !deepEqual(lifeDetails, profile.lifeDetails)) {
    profile.lifeDetails = lifeDetails;
    changedPaths.push('lifeDetails');
  }
  if (isPlainObject(patch.nsfw)) {
    const nsfw: Record<string, unknown> = { ...(profile.nsfw ?? {}) };
    for (const [key, value] of Object.entries(patch.nsfw)) {
      if (value === undefined || deepEqual(nsfw[key], value)) continue;
      nsfw[key] = deepClone(value);
      changedPaths.push(`nsfw.${key}`);
    }
    if (changedPaths.some(path => path.startsWith('nsfw.'))) profile.nsfw = nsfw;
  }
  return { profile, changedPaths };
}

function normalizeTendencies(value: unknown): CharacterTrace['longTermTendencies'] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(item => {
    const record = item as Record<string, unknown>;
    const entry: CharacterTrace['longTermTendencies'][number] = { id: text(record.id) ?? '', text: text(record.text) ?? '' };
    const target = text(record.targetCharacterId);
    if (target) entry.targetCharacterId = target;
    return entry;
  }).filter(entry => entry.id && entry.text);
}

function normalizeVisibility(value: unknown): CharacterTrace['visibility'] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(item => {
    const record = item as Record<string, unknown>;
    const entry: CharacterTrace['visibility'][number] = { id: text(record.id) ?? '', fact: text(record.fact) ?? '', knownBy: textArray(record.knownBy) ?? [] };
    const unknownBy = textArray(record.unknownBy);
    if (unknownBy) entry.unknownBy = unknownBy;
    return entry;
  }).filter(entry => entry.id && entry.fact);
}

function mergeTrace(base: CharacterTrace, patch: StateAnalysisTraceCandidate): { trace: CharacterTrace; changed: boolean } {
  const trace = deepClone(base);
  let changed = false;
  const replaceList = <K extends 'longTermTendencies' | 'currentSituations' | 'visibility'>(field: K, next: CharacterTrace[K] | undefined): void => {
    if (next === undefined || deepEqual(next, trace[field])) return;
    trace[field] = next;
    changed = true;
  };
  replaceList('longTermTendencies', normalizeTendencies(patch.longTermTendencies));
  replaceList('currentSituations', normalizeTendencies(patch.currentSituations));
  replaceList('visibility', normalizeVisibility(patch.visibility));
  if (isPlainObject(patch.affinity)) {
    for (const field of ['inner', 'outer'] as const) {
      const value = patch.affinity[field];
      if (value === undefined || value === trace.affinity[field]) continue;
      if (value !== null && ![-2, -1, 0, 1, 2].includes(value)) throw new StateApplyError(`affinity.${field} must be -2..2 or null`);
      trace.affinity[field] = value;
      changed = true;
    }
    const note = text(patch.affinity.note);
    if (note !== undefined && note !== trace.affinity.note) {
      trace.affinity.note = note;
      changed = true;
    }
  }
  return { trace, changed };
}

type SourcedItem = { id: string; sourceFloorIds?: string[]; sourceHostChatIds?: string[] };

function withoutSourceFields<T extends SourcedItem>(item: T): Omit<T, 'sourceFloorIds' | 'sourceHostChatIds'> {
  const copy: Partial<T> = { ...item };
  delete copy.sourceFloorIds;
  delete copy.sourceHostChatIds;
  return copy as Omit<T, 'sourceFloorIds' | 'sourceHostChatIds'>;
}

/** Program-owned provenance for story collections: unchanged entries keep theirs, new or edited entries record this floor. */
function mergeCollection<T extends SourcedItem>(previous: T[], incoming: T[], context: ApplyContext): T[] {
  const byId = new Map(previous.map(item => [item.id, item]));
  return incoming.map(item => {
    const before = byId.get(item.id);
    if (before && deepEqual(withoutSourceFields(before), withoutSourceFields(item))) {
      return { ...deepClone(item), sourceFloorIds: before.sourceFloorIds ?? [], sourceHostChatIds: before.sourceHostChatIds ?? [] };
    }
    return {
      ...deepClone(item),
      sourceFloorIds: pushBounded(before?.sourceFloorIds, context.floorId),
      sourceHostChatIds: pushBounded(before?.sourceHostChatIds, context.hostChatId)
    };
  });
}

/**
 * Merges a validated candidate (roadmap §8.2 deep-partial protocol) into the previous snapshot:
 * missing fields keep their value, arrays replace as a whole, `{}` means no change, identity and
 * provenance fields are supplied by the program (§3), locked paths are never overwritten (§4.2).
 */
export function applyCandidate(previous: StateSnapshot, candidate: StateAnalysisCandidate, context: ApplyContext): ApplyResult {
  const snapshot = deepClone(previous);
  snapshot.schemaVersion = STATE_SCHEMA_VERSION;
  snapshot.branchId = context.branchId;
  const known = [...(context.knownCharacters ?? deriveKnownCharacters(previous))];
  const touched = new Set<string>();
  let changed = false;

  const resolveId = (raw: string): string => {
    const id = resolveCharacterIdentity(raw, known);
    if (!id) throw new StateApplyError('character id must not be empty');
    return id;
  };
  const ensureProfile = (id: string, displayName: string): void => {
    if (snapshot.profiles[id]) return;
    snapshot.profiles[id] = newProfile(id, displayName, context);
    known.push({ characterId: id, canonicalName: snapshot.profiles[id].canonicalName, aliases: [] });
    touched.add(id);
    changed = true;
  };

  for (const [rawId, patch] of Object.entries(candidate.profiles ?? {})) {
    const id = resolveId(rawId);
    const existing = snapshot.profiles[id];
    if (!existing) ensureProfile(id, text(patch.canonicalName) ?? rawId);
    const base = snapshot.profiles[id];
    const merged = mergeProfile(base, patch);
    const violated = merged.changedPaths.find(path => isLocked(path, base.lockedPaths));
    if (violated) throw new StateApplyError(`profiles.${id}.${violated} is locked`);
    if (!merged.changedPaths.length) continue;
    for (const path of merged.changedPaths) merged.profile.sourcePriority[path] = 'story';
    merged.profile.source = touchSource(existing ? base.source : undefined, context);
    merged.profile.updatedAt = context.now;
    snapshot.profiles[id] = merged.profile;
    const knownEntry = known.find(entry => entry.characterId === id);
    if (knownEntry) {
      knownEntry.canonicalName = merged.profile.canonicalName;
      knownEntry.aliases = [...merged.profile.aliases];
    }
    touched.add(id);
    changed = true;
  }

  for (const [rawId, patch] of Object.entries(candidate.traces ?? {})) {
    const id = resolveId(rawId);
    ensureProfile(id, rawId);
    const existing = snapshot.traces[id];
    const base = existing ?? newTrace(id, context);
    const merged = mergeTrace(base, patch);
    if (existing && !merged.changed) continue;
    merged.trace.source = touchSource(existing ? base.source : undefined, context);
    merged.trace.updatedAt = context.now;
    snapshot.traces[id] = merged.trace;
    touched.add(id);
    changed = true;
  }

  const storyPatch = candidate.story;
  if (storyPatch) {
    let storyChanged = false;
    const story = snapshot.story;
    if (isPlainObject(storyPatch.now)) {
      const currentTime = text(storyPatch.now.currentTime);
      if (currentTime !== undefined && currentTime !== story.now.currentTime) {
        story.now.currentTime = currentTime;
        storyChanged = true;
      }
      for (const field of ['ongoing', 'upcoming'] as const) {
        const incoming = storyPatch.now[field];
        if (!Array.isArray(incoming) || deepEqual(incoming, story.now[field])) continue;
        (story.now as Record<string, unknown>)[field] = deepClone(incoming);
        storyChanged = true;
      }
    }
    if (Array.isArray(storyPatch.calendar)) {
      const next = mergeCollection<CalendarEntry>(story.calendar, storyPatch.calendar, context);
      if (!deepEqual(next, story.calendar)) {
        story.calendar = next;
        storyChanged = true;
      }
    }
    if (Array.isArray(storyPatch.plotlines)) {
      const next = mergeCollection<Plotline>(story.plotlines, storyPatch.plotlines, context);
      if (!deepEqual(next, story.plotlines)) {
        story.plotlines = next;
        storyChanged = true;
      }
    }
    if (Array.isArray(storyPatch.plotPlans)) {
      const next = mergeCollection<PlotPlan>(story.plotPlans, storyPatch.plotPlans, context);
      if (!deepEqual(next, story.plotPlans)) {
        story.plotPlans = next;
        storyChanged = true;
      }
    }
    if (storyChanged) {
      story.source = touchSource(previous.story.source, context);
      changed = true;
    }
  }

  if (changed) snapshot.updatedAt = context.now;
  return { snapshot, touchedCharacterIds: [...touched], changed };
}
