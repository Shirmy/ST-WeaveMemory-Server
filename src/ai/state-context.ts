import { emptySnapshot } from '../state/apply';
import type { TrustedPrefix } from '../state/chain-engine';
import type { KnownCharacter, StateSnapshot } from '../state/schema';
import type { StateNodeRecord } from '../storage/state-chain-store';

export type RelevantState = Pick<StateSnapshot, 'profiles' | 'traces' | 'story'>;

export type StateContextBlock = {
  code: 'WM_STATE_PENDING';
  message: string;
  /** True when the blocking floor has a pending or running analysis job of its own. */
  pendingJob: boolean;
};

export type StateAnalysisContext = {
  previousRelevantState: RelevantState;
  /** Fingerprint of the previous effective state; null at the chain start or while blocked. */
  previousStateFingerprint: string | null;
  lockedPaths: string[];
  knownCharacters: KnownCharacter[];
  /** The state node the floor is analysed against (Phase 5 chain); null at the chain start. */
  previousNode?: StateNodeRecord | null;
  /** The trusted prefix the context was derived from, so callers can reuse it instead of recomputing. */
  prefix?: TrustedPrefix;
  /** Set when the chain before the floor is not usable yet (roadmap §7: no gaps in the chain). */
  blocked?: StateContextBlock;
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
  const { profiles, traces, story } = emptySnapshot(branchId);
  return { profiles, traces, story };
}

/**
 * Chain-less provider: every floor is analysed against an empty previous state. Kept for tests of
 * the task runner itself; production wiring uses SnapshotContextProvider.
 */
export class EmptyStateContextProvider implements StateContextProvider {
  async load(target: StateContextTarget): Promise<StateAnalysisContext> {
    return {
      previousRelevantState: emptyRelevantState(target.branchId),
      previousStateFingerprint: null,
      lockedPaths: [],
      knownCharacters: [],
      previousNode: null
    };
  }
}
