import { deriveKnownCharacters, deriveLockedPaths } from '../state/apply';
import type { StateChainEngine } from '../state/chain-engine';
import type { StateTaskStore } from '../storage/state-task-store';
import { emptyRelevantState, type StateAnalysisContext, type StateContextProvider, type StateContextTarget } from './state-context';

/**
 * Phase 5 context provider: the previous effective state comes from the trusted prefix of the
 * state chain (checkpoint + delta replay). When the floor before the target has no valid node the
 * context is marked blocked so the runner fails fast instead of analysing against a gap.
 */
export class SnapshotContextProvider implements StateContextProvider {
  constructor(private readonly chain: StateChainEngine, private readonly tasks: StateTaskStore) {}

  async load(target: StateContextTarget): Promise<StateAnalysisContext> {
    const resolution = await this.chain.resolvePrevious(target.chatId, target.branchId, target.messageIndex);
    if (resolution.kind === 'blocked') {
      const pending = await this.tasks.findActiveJobForFloor(resolution.floor.floorId);
      return {
        previousRelevantState: emptyRelevantState(target.branchId),
        previousStateFingerprint: null,
        lockedPaths: [],
        knownCharacters: [],
        previousNode: null,
        blocked: {
          code: 'WM_STATE_PENDING',
          message: `floor ${resolution.floor.messageIndex} has no valid state node (${resolution.reason})`,
          pendingJob: Boolean(pending)
        }
      };
    }
    if (resolution.kind === 'start') {
      return {
        previousRelevantState: emptyRelevantState(target.branchId),
        previousStateFingerprint: null,
        lockedPaths: [],
        knownCharacters: [],
        previousNode: null
      };
    }
    const { snapshot } = await this.chain.snapshotAt(resolution.node);
    return {
      previousRelevantState: { profiles: snapshot.profiles, traces: snapshot.traces, story: snapshot.story },
      previousStateFingerprint: resolution.node.stateFingerprint,
      lockedPaths: deriveLockedPaths(snapshot),
      knownCharacters: deriveKnownCharacters(snapshot),
      previousNode: resolution.node
    };
  }
}
