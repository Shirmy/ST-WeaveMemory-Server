import type { KnownCharacter, StateSnapshot } from '../state/schema';

export type RelevantState = Pick<StateSnapshot, 'profiles' | 'traces' | 'story'>;

export type StateAnalysisContext = {
  previousRelevantState: RelevantState;
  /** Fingerprint of the previous effective state; null until Phase 5 provides state nodes. */
  previousStateFingerprint: string | null;
  lockedPaths: string[];
  knownCharacters: KnownCharacter[];
};

export type StateContextTarget = {
  chatId: string;
  branchId: string;
  floorId: string;
  messageIndex: number;
};

export interface StateContextProvider {
  load(target: StateContextTarget): Promise<StateAnalysisContext>;
}

export function emptyRelevantState(branchId: string): RelevantState {
  return {
    profiles: {},
    traces: {},
    story: {
      now: { ongoing: [], upcoming: [] },
      calendar: [],
      plotlines: [],
      plotPlans: [],
      source: { branchId, sourceFloorIds: [], sourceHostChatIds: [] }
    }
  };
}

/**
 * Phase 4 placeholder: no persisted snapshot exists yet, so every floor is analysed against an
 * empty previous state. Phase 5 replaces this with checkpoint + delta replay.
 */
export class EmptyStateContextProvider implements StateContextProvider {
  async load(target: StateContextTarget): Promise<StateAnalysisContext> {
    return {
      previousRelevantState: emptyRelevantState(target.branchId),
      previousStateFingerprint: null,
      lockedPaths: [],
      knownCharacters: []
    };
  }
}
