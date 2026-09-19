import { dependencyFingerprint } from '../core/fingerprint';
import { STATE_PROTOCOL_VERSION } from '../protocol';
import type { StateChainStore, StateNodeRecord, StateDeltaRecord, StateNodeStatus } from '../storage/state-chain-store';
import { newCheckpointId, newDeltaId, newStateNodeId } from '../storage/state-chain-store';
import type { SqliteDatabase } from '../storage/sqlite-database';
import type { FloorRecord, MemoryStore } from '../storage/types';
import { applyCandidate, emptySnapshot, snapshotFingerprint } from './apply';
import { applyChangesInPlace, deepClone, diffValues, partitionChanges } from './diff';
import { STATE_SCHEMA_VERSION, validateStateAnalysisResponse, validateStateSnapshot, type StateAnalysisCandidate, type StateSnapshot } from './schema';

export class StateChainError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'StateChainError';
  }
}

export type ChainPosition = {
  messageIndex: number;
  floorId: string;
  swipeId: number | null;
  bodyFingerprint: string;
  floorStatus: FloorRecord['status'];
  /** Dependency fingerprint a valid node for this floor must carry (null once the strict chain is broken). */
  expectedDependency: string | null;
  /** The node representing this floor: the strictly valid one, else the lineage-valid one, else the latest known. */
  node: StateNodeRecord | null;
  /** Roadmap §21: body, previous state fingerprint, protocol, schema and prompt version all match. */
  valid: boolean;
  /** Structural validity only: the previous-state fingerprints link up, whatever prompt version produced the node. */
  lineageValid: boolean;
};

/**
 * Roadmap §21 "trusted prefix": walking the active floors in order, a floor is valid when it has a
 * node whose dependency fingerprint equals the one expected from the previous valid node and the
 * current prompt version. The first floor that fails breaks the strict chain for everything after
 * it. The lineage view ignores prompt drift so the last known state can still be shown.
 */
export type TrustedPrefix = {
  chatId: string;
  branchId: string;
  promptVersion: string;
  positions: ChainPosition[];
  firstInvalidIndex: number | null;
  firstLineageBreakIndex: number | null;
  head: StateNodeRecord | null;
  lineageHead: StateNodeRecord | null;
  /** Every node of the branch as loaded for this computation, so callers can avoid a second scan. */
  nodes: StateNodeRecord[];
};

export type PreviousResolution =
  | { kind: 'start' }
  | { kind: 'ready'; node: StateNodeRecord; floor: { messageIndex: number; floorId: string } }
  | { kind: 'blocked'; floor: { messageIndex: number; floorId: string }; reason: string };

export type ReplayResult = {
  snapshot: StateSnapshot;
  checkpointNodeId: string | null;
  appliedDeltas: number;
  fromHeadCache: boolean;
};

export type CommitCandidateInput = {
  chatId: string;
  branchId: string;
  hostChatId: string;
  floorId: string;
  messageIndex: number;
  swipeId: number | null;
  bodyFingerprint: string;
  dependencyFingerprint: string;
  candidate: StateAnalysisCandidate;
  previous: StateNodeRecord | null;
  now?: string;
};

export type CommitCandidateResult = {
  node: StateNodeRecord;
  delta: StateDeltaRecord;
  snapshot: StateSnapshot;
  checkpointId: string | null;
  changed: boolean;
};

export type CurrentStateView = {
  prefix: TrustedPrefix;
  /** Last lineage-valid node; equals prefix.head unless only prompt drift separates them. */
  node: StateNodeRecord | null;
  snapshot: StateSnapshot;
};

export type FloorStateView = {
  floorId: string;
  node: StateNodeRecord;
  snapshot: StateSnapshot;
  valid: boolean;
};

export type StatusSyncResult = { nodeUpdates: number; floorUpdates: number };

export type StateChainEngineDeps = {
  database: SqliteDatabase;
  chain: StateChainStore;
  store: MemoryStore;
  checkpointInterval: () => Promise<number>;
  /** Content hash of the active state prompt; part of every dependency fingerprint (§13). */
  promptVersion: () => Promise<string>;
};

function fingerprintOf(node: StateNodeRecord | null): string | null {
  return node?.stateFingerprint ?? null;
}

/**
 * Builds and reads the state chain (roadmap §12–§15, §21): one node per analysed floor variant,
 * program-computed deltas, periodic checkpoints, replay = nearest checkpoint + later deltas.
 * Node validity is derived at read time; node statuses are bookkeeping refreshed by syncStatuses().
 */
export class StateChainEngine {
  constructor(private readonly deps: StateChainEngineDeps) {}

  async trustedPrefix(chatId: string, branchId: string): Promise<TrustedPrefix> {
    const floors = await this.deps.chain.listActiveFloors(chatId, branchId);
    const nodes = await this.deps.chain.listNodes(branchId);
    const promptVersion = await this.deps.promptVersion();
    const byFloor = new Map<string, StateNodeRecord[]>();
    for (const node of nodes) {
      const list = byFloor.get(node.floorId) ?? [];
      list.push(node);
      byFloor.set(node.floorId, list);
    }
    for (const list of byFloor.values()) list.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const positions: ChainPosition[] = [];
    let strictPrevious: StateNodeRecord | null = null;
    let lineagePrevious: StateNodeRecord | null = null;
    let firstInvalidIndex: number | null = null;
    let firstLineageBreakIndex: number | null = null;
    for (const floor of floors) {
      const candidates = byFloor.get(floor.floorId) ?? [];
      const expectedDependency: string | null = firstInvalidIndex === null
        ? dependencyFingerprint({
          bodyFingerprint: floor.bodyFingerprint,
          previousStateFingerprint: fingerprintOf(strictPrevious),
          protocolVersion: STATE_PROTOCOL_VERSION,
          schemaVersion: STATE_SCHEMA_VERSION,
          promptVersion
        })
        : null;
      const strictMatch: StateNodeRecord | null = expectedDependency ? candidates.find(node => node.dependencyFingerprint === expectedDependency) ?? null : null;
      const lineageExpected: string | null = fingerprintOf(lineagePrevious);
      const lineageMatch: StateNodeRecord | null = firstLineageBreakIndex === null ? candidates.find(node => (node.previousStateFingerprint ?? null) === lineageExpected) ?? null : null;
      if (!strictMatch && firstInvalidIndex === null) firstInvalidIndex = floor.messageIndex;
      if (!lineageMatch && firstLineageBreakIndex === null) firstLineageBreakIndex = floor.messageIndex;
      positions.push({
        messageIndex: floor.messageIndex,
        floorId: floor.floorId,
        swipeId: floor.swipeId,
        bodyFingerprint: floor.bodyFingerprint,
        floorStatus: floor.status,
        expectedDependency,
        node: strictMatch ?? lineageMatch ?? candidates[0] ?? null,
        valid: Boolean(strictMatch),
        lineageValid: Boolean(lineageMatch)
      });
      if (strictMatch) strictPrevious = strictMatch;
      if (lineageMatch) lineagePrevious = lineageMatch;
    }
    return { chatId, branchId, promptVersion, positions, firstInvalidIndex, firstLineageBreakIndex, head: strictPrevious, lineageHead: lineagePrevious, nodes };
  }

  /** Which state a floor at `messageIndex` must be analysed against, plus the prefix it was derived from. */
  async resolvePreviousWithPrefix(chatId: string, branchId: string, messageIndex: number): Promise<{ resolution: PreviousResolution; prefix: TrustedPrefix }> {
    const prefix = await this.trustedPrefix(chatId, branchId);
    return { resolution: resolveFromPrefix(prefix, messageIndex), prefix };
  }

  async resolvePrevious(chatId: string, branchId: string, messageIndex: number): Promise<PreviousResolution> {
    return (await this.resolvePreviousWithPrefix(chatId, branchId, messageIndex)).resolution;
  }

  /** The node representing `floorId` inside the trusted prefix, if any. */
  async validNodeForFloor(chatId: string, branchId: string, floorId: string): Promise<StateNodeRecord | null> {
    return validNodeInPrefix(await this.trustedPrefix(chatId, branchId), floorId);
  }

  async branchHasNodes(branchId: string): Promise<boolean> {
    return (await this.deps.chain.countNodes(branchId)) > 0;
  }

  /**
   * Refreshes derived bookkeeping (roadmap §12 / §16 statuses): nodes in the strict prefix are
   * `synced`, other nodes of active floors are `stale`, nodes of inactive variants are `inactive`;
   * active floors leave `synced` when their node stopped being valid.
   */
  async syncStatuses(prefix: TrustedPrefix): Promise<StatusSyncResult> {
    const { chain, store } = this.deps;
    const now = new Date().toISOString();
    const validNodeIds = new Set(prefix.positions.filter(position => position.valid && position.node).map(position => position.node!.stateNodeId));
    const activeFloorIds = new Set(prefix.positions.map(position => position.floorId));
    let nodeUpdates = 0;
    for (const node of prefix.nodes) {
      const desired: StateNodeStatus = validNodeIds.has(node.stateNodeId) ? 'synced' : activeFloorIds.has(node.floorId) ? 'stale' : 'inactive';
      if (node.status === desired) continue;
      await chain.updateNodeStatus(node.stateNodeId, desired, now);
      node.status = desired;
      nodeUpdates += 1;
    }
    let floorUpdates = 0;
    for (const position of prefix.positions) {
      const desired: FloorRecord['status'] | null = position.valid ? 'synced' : position.floorStatus === 'synced' ? 'pending' : null;
      if (!desired || desired === position.floorStatus) continue;
      await store.updateFloorStatus(position.floorId, desired);
      position.floorStatus = desired;
      floorUpdates += 1;
    }
    return { nodeUpdates, floorUpdates };
  }

  async snapshotAt(node: StateNodeRecord): Promise<ReplayResult> {
    const { chain } = this.deps;
    const head = await chain.getBranchHead(node.branchId);
    // The head cache is only an accelerator: it must name this node and its content must hash to the node's fingerprint.
    if (head && head.stateNodeId === node.stateNodeId && snapshotFingerprint(head.snapshot) === node.stateFingerprint) {
      return { snapshot: head.snapshot, checkpointNodeId: null, appliedDeltas: 0, fromHeadCache: true };
    }
    const byId = new Map((await chain.listNodes(node.branchId)).map(item => [item.stateNodeId, item]));
    const trail: StateNodeRecord[] = [];
    let base: StateSnapshot | null = null;
    let checkpointNodeId: string | null = null;
    let cursor: StateNodeRecord | null = node;
    while (cursor) {
      if (cursor.checkpointId) {
        const checkpoint = await chain.getCheckpoint(cursor.checkpointId);
        if (!checkpoint) throw new StateChainError('WM_STATE_SYNC_FAILED', `checkpoint ${cursor.checkpointId} of node ${cursor.stateNodeId} is missing`);
        if (checkpoint.snapshotFingerprint !== cursor.stateFingerprint) {
          throw new StateChainError('WM_STATE_SYNC_FAILED', `checkpoint ${cursor.checkpointId} does not match the fingerprint of node ${cursor.stateNodeId}`);
        }
        if (snapshotFingerprint(checkpoint.snapshot) !== checkpoint.snapshotFingerprint) {
          throw new StateChainError('WM_STATE_SYNC_FAILED', `checkpoint ${cursor.checkpointId} is corrupted; its snapshot does not hash to its fingerprint`);
        }
        base = checkpoint.snapshot;
        checkpointNodeId = cursor.stateNodeId;
        break;
      }
      trail.push(cursor);
      if (!cursor.previousStateNodeId) break;
      const previous = byId.get(cursor.previousStateNodeId);
      if (!previous) throw new StateChainError('WM_STATE_SYNC_FAILED', `state node ${cursor.previousStateNodeId} is missing from the chain`);
      cursor = previous;
    }
    trail.reverse();
    const deltas = await chain.getDeltasByNodeIds(trail.map(item => item.stateNodeId));
    let snapshot = deepClone(base ?? emptySnapshot(node.branchId));
    for (const item of trail) {
      const delta = deltas.get(item.stateNodeId);
      if (!delta) throw new StateChainError('WM_STATE_SYNC_FAILED', `state delta for node ${item.stateNodeId} is missing`);
      snapshot = applyChangesInPlace(snapshot, [...delta.profileChanges, ...delta.traceChanges, ...delta.storyChanges, ...delta.rootChanges]);
    }
    const fingerprint = snapshotFingerprint(snapshot);
    if (fingerprint !== node.stateFingerprint) {
      throw new StateChainError('WM_STATE_SYNC_FAILED', `replayed state of node ${node.stateNodeId} does not match its fingerprint`);
    }
    return { snapshot, checkpointNodeId, appliedDeltas: trail.length, fromHeadCache: false };
  }

  async snapshotForPrevious(resolution: PreviousResolution, branchId: string): Promise<StateSnapshot> {
    if (resolution.kind === 'ready') return (await this.snapshotAt(resolution.node)).snapshot;
    return emptySnapshot(branchId);
  }

  /** Applies a validated candidate on top of `previous`, persists node + delta (+ checkpoint) atomically. */
  async commitCandidate(input: CommitCandidateInput): Promise<CommitCandidateResult> {
    const { chain, database, store } = this.deps;
    const now = input.now ?? new Date().toISOString();
    const previousSnapshot = input.previous ? (await this.snapshotAt(input.previous)).snapshot : emptySnapshot(input.branchId);
    const applied = applyCandidate(previousSnapshot, input.candidate, {
      branchId: input.branchId,
      floorId: input.floorId,
      hostChatId: input.hostChatId,
      now
    });
    const changes = diffValues(previousSnapshot, applied.snapshot);
    const parts = partitionChanges(changes);
    const stateFingerprint = snapshotFingerprint(applied.snapshot);
    const stateNodeId = newStateNodeId();
    const deltaId = newDeltaId();
    const interval = Math.max(1, Math.floor(await this.deps.checkpointInterval()));
    const sinceCheckpoint = await this.nodesSinceCheckpoint(input.previous);
    const checkpointId = sinceCheckpoint + 1 >= interval ? newCheckpointId() : null;
    const node: StateNodeRecord = {
      stateNodeId,
      chatId: input.chatId,
      branchId: input.branchId,
      floorId: input.floorId,
      messageIndex: input.messageIndex,
      swipeId: input.swipeId,
      bodyFingerprint: input.bodyFingerprint,
      previousStateNodeId: input.previous?.stateNodeId ?? null,
      previousStateFingerprint: fingerprintOf(input.previous),
      dependencyFingerprint: input.dependencyFingerprint,
      deltaId,
      checkpointId,
      status: 'synced',
      stateFingerprint,
      createdAt: now,
      updatedAt: now
    };
    const delta: StateDeltaRecord = {
      deltaId,
      stateNodeId,
      floorId: input.floorId,
      previousStateNodeId: node.previousStateNodeId,
      ...parts,
      createdAt: now
    };
    await database.transaction(async () => {
      await chain.insertDelta(delta);
      await chain.insertNode(node);
      if (checkpointId) {
        await chain.insertCheckpoint({
          checkpointId,
          chatId: input.chatId,
          branchId: input.branchId,
          stateNodeId,
          snapshot: applied.snapshot,
          snapshotFingerprint: stateFingerprint,
          createdAt: now
        });
      }
      await chain.upsertBranchHead({
        branchId: input.branchId,
        chatId: input.chatId,
        stateNodeId,
        snapshot: applied.snapshot,
        snapshotFingerprint: stateFingerprint,
        updatedAt: now
      });
      await store.updateFloorStatus(input.floorId, 'synced');
    });
    return { node, delta, snapshot: applied.snapshot, checkpointId, changed: applied.changed };
  }

  async current(chatId: string, branchId: string): Promise<CurrentStateView> {
    const prefix = await this.trustedPrefix(chatId, branchId);
    const node = prefix.lineageHead;
    if (!node) {
      const head = await this.deps.chain.getBranchHead(branchId);
      return { prefix, node: null, snapshot: head?.snapshot ?? emptySnapshot(branchId) };
    }
    const replay = await this.snapshotAt(node);
    return { prefix, node, snapshot: replay.snapshot };
  }

  /** State after a specific floor variant, whether or not it is part of the current chain. */
  async applyManualEdit(input: {
    chatId: string;
    branchId: string;
    target: 'profile' | 'trace' | 'story' | 'candidate';
    entityId?: string;
    fieldPath?: string;
    value?: unknown;
    lockedPaths?: string[];
    action?: 'lock' | 'unlock' | 'restore-ai';
    candidate?: StateAnalysisCandidate;
    now?: string;
  }): Promise<{ snapshot: StateSnapshot; changed: boolean }> {
    return this.deps.database.transaction(async () => {
    const { chain } = this.deps;
    const prefix = await this.trustedPrefix(input.chatId, input.branchId);
    if (!prefix.head) throw new StateChainError('WM_MANUAL_EDIT_REQUIRES_STATE', 'current branch has no valid state node; generate the first state before editing manually');
    const currentView = { node: prefix.head, snapshot: (await this.snapshotAt(prefix.head)).snapshot };
    const now = new Date(Math.max(Date.parse(input.now ?? new Date().toISOString()), Date.parse(currentView.node.createdAt) + 1)).toISOString();
    if (!['profile', 'trace', 'story', 'candidate'].includes(input.target)) throw new StateChainError('WM_INVALID_REQUEST', 'invalid manual target');
    if (input.action && !['lock', 'unlock', 'restore-ai'].includes(input.action)) throw new StateChainError('WM_INVALID_REQUEST', 'invalid manual action');
    if (input.action && input.target !== 'profile') throw new StateChainError('WM_INVALID_REQUEST', 'locks apply to profile fields');
    const assertPath = (path: string): void => {
      if (!path || path.split('.').some(part => !part || ['__proto__', 'prototype', 'constructor', 'source', 'characterId', 'updatedAt', 'sourcePriority', 'lockedPaths'].includes(part))) throw new StateChainError('WM_INVALID_REQUEST', 'invalid manual field path');
    };
    const profilePaths = new Set(['canonicalName', 'aliases', 'lifeDetails', 'basic.gender', 'basic.age', 'basic.birthday', 'basic.race', 'basic.notes', 'appearance.height', 'appearance.build', 'appearance.face', 'appearance.hair', 'appearance.eyes', 'appearance.distinctiveFeatures', 'appearance.clothingStyle', 'appearance.notes', 'identity.occupation', 'identity.organizations', 'identity.socialIdentity', 'identity.background', 'identity.importantRelations', 'personality.coreTraits', 'personality.behaviorStyle', 'personality.expressionHabits', 'personality.likes', 'personality.dislikes', 'personality.principles']);
    if (input.target === 'profile' && input.fieldPath && !profilePaths.has(input.fieldPath)) throw new StateChainError('WM_INVALID_REQUEST', 'unknown profile field');
    if (input.lockedPaths?.some(path => !profilePaths.has(path))) throw new StateChainError('WM_INVALID_REQUEST', 'unknown lock field');
    if (input.action && !input.fieldPath) throw new StateChainError('WM_INVALID_REQUEST', 'fieldPath is required');
    if (input.fieldPath) assertPath(input.fieldPath);
    if (input.entityId && ['__proto__', 'prototype', 'constructor'].includes(input.entityId)) throw new StateChainError('WM_INVALID_REQUEST', 'invalid entity id');
    if (input.lockedPaths) input.lockedPaths.forEach(assertPath);
    const setField = (target: object, path: string, value: unknown): void => {
      const parts = path.split('.');
      if (parts.length > 2) throw new StateChainError('WM_INVALID_REQUEST', 'unsupported manual field path');
      const record = target as Record<string, unknown>;
      if (parts.length === 1) {
        if (value === '') delete record[parts[0]];
        else record[parts[0]] = value;
      }
      else {
        const group = record[parts[0]];
        if (!group || typeof group !== 'object' || Array.isArray(group)) throw new StateChainError('WM_INVALID_REQUEST', 'invalid manual field group');
        if (value === '') delete (group as Record<string, unknown>)[parts[1]];
        else (group as Record<string, unknown>)[parts[1]] = value;
      }
    };
    let snapshot = deepClone(currentView.snapshot);
    let changed = false;

    if (input.target === 'profile') {
      if (!input.entityId) throw new StateChainError('WM_INVALID_REQUEST', 'entityId is required for profile edit');
      let profile = snapshot.profiles[input.entityId];
      if (!profile) {
        profile = {
          characterId: input.entityId,
          canonicalName: input.entityId,
          aliases: [],
          basic: {},
          appearance: {},
          identity: {},
          personality: {},
          lifeDetails: [],
          lockedPaths: [],
          sourcePriority: {},
          source: { branchId: input.branchId, sourceFloorIds: [], sourceHostChatIds: [], sourceType: 'manual' },
          updatedAt: now
        };
        snapshot.profiles[input.entityId] = profile;
        changed = true;
      }

      if (input.action === 'lock' && input.fieldPath) {
        if (!profile.lockedPaths.includes(input.fieldPath)) {
          profile.lockedPaths.push(input.fieldPath);
          changed = true;
        }
      } else if (input.action === 'unlock' && input.fieldPath) {
        if (profile.lockedPaths.includes(input.fieldPath)) {
          profile.lockedPaths = profile.lockedPaths.filter(p => p !== input.fieldPath);
          changed = true;
        }
      } else if (input.action === 'restore-ai' && input.fieldPath) {
        if (profile.lockedPaths.includes(input.fieldPath)) {
          profile.lockedPaths = profile.lockedPaths.filter(p => p !== input.fieldPath);
          changed = true;
        }
        if (profile.sourcePriority[input.fieldPath]) {
          delete profile.sourcePriority[input.fieldPath];
          changed = true;
        }
      } else if (input.fieldPath && input.value !== undefined) {
        setField(profile, input.fieldPath, input.value);
        profile.sourcePriority[input.fieldPath] = 'manual';
        profile.updatedAt = now;
        changed = true;
      }
      if (Array.isArray(input.lockedPaths)) {
        profile.lockedPaths = [...new Set(input.lockedPaths)];
        changed = true;
      }
    } else if (input.target === 'trace') {
      if (!input.entityId) throw new StateChainError('WM_INVALID_REQUEST', 'entityId is required for trace edit');
      let trace = snapshot.traces[input.entityId];
      if (!trace) {
        trace = {
          characterId: input.entityId,
          longTermTendencies: [],
          currentSituations: [],
          visibility: [],
          affinity: { inner: null, outer: null },
          source: { branchId: input.branchId, sourceFloorIds: [], sourceHostChatIds: [], sourceType: 'manual' },
          updatedAt: now
        };
        snapshot.traces[input.entityId] = trace;
        changed = true;
      }
      if (input.fieldPath && input.value !== undefined) {
        setField(trace, input.fieldPath, input.value);
        trace.source.sourceType = 'manual';
        trace.updatedAt = now;
        changed = true;
      }
    } else if (input.target === 'story') {
      if (input.fieldPath && input.value !== undefined) {
        setField(snapshot.story, input.fieldPath, input.value);
        if (snapshot.story.source) snapshot.story.source.sourceType = 'manual';
        changed = true;
      }
    } else if (input.target === 'candidate' && input.candidate) {
      validateStateAnalysisResponse(input.candidate);
      const applied = applyCandidate(snapshot, input.candidate, {
        branchId: input.branchId,
        floorId: currentView.node?.floorId ?? 'manual-floor',
        hostChatId: input.chatId,
        now
      });
      for (const [id, profile] of Object.entries(applied.snapshot.profiles)) {
        const old = snapshot.profiles[id];
        for (const path of profilePaths) {
          const read = (value: unknown): unknown => path.split('.').reduce<unknown>((entry, key) => entry && typeof entry === 'object' ? (entry as Record<string, unknown>)[key] : undefined, value);
          if (JSON.stringify(read(old)) !== JSON.stringify(read(profile))) profile.sourcePriority[path] = 'manual';
        }
      }
      for (const [id, trace] of Object.entries(applied.snapshot.traces)) {
        if (JSON.stringify(trace) !== JSON.stringify(snapshot.traces[id])) trace.source.sourceType = 'manual';
      }
      if (JSON.stringify(applied.snapshot.story) !== JSON.stringify(snapshot.story) && applied.snapshot.story.source) applied.snapshot.story.source.sourceType = 'manual';
      snapshot = applied.snapshot;
      changed = applied.changed;
    }

    if (changed) {
      snapshot.updatedAt = now;
      validateStateSnapshot(snapshot, { branchId: input.branchId });
      const stateFingerprint = snapshotFingerprint(snapshot);
      const head = currentView.node;
      const previous = head.previousStateNodeId ? await chain.getNode(head.previousStateNodeId) : null;
      const previousSnapshot = previous ? (await this.snapshotAt(previous)).snapshot : emptySnapshot(input.branchId);
      const parts = partitionChanges(diffValues(previousSnapshot, snapshot));
      const stateNodeId = newStateNodeId();
      const deltaId = newDeltaId();
      const checkpointId = newCheckpointId();
      const replacement: StateNodeRecord = { ...head, stateNodeId, deltaId, checkpointId, previousStateNodeId: head.previousStateNodeId, previousStateFingerprint: head.previousStateFingerprint, stateFingerprint, status: 'stale', createdAt: now, updatedAt: now };
      const delta: StateDeltaRecord = { deltaId, stateNodeId, floorId: head.floorId, previousStateNodeId: replacement.previousStateNodeId, ...parts, createdAt: now };
        await chain.insertDelta(delta);
        await chain.insertNode(replacement);
        await chain.insertCheckpoint({ checkpointId, chatId: input.chatId, branchId: input.branchId, stateNodeId, snapshot, snapshotFingerprint: stateFingerprint, createdAt: now });
        await chain.upsertBranchHead({ branchId: input.branchId, chatId: input.chatId, stateNodeId, snapshot, snapshotFingerprint: stateFingerprint, updatedAt: now });
      await this.syncStatuses(await this.trustedPrefix(input.chatId, input.branchId));
    }

    return { snapshot, changed };
    });
  }

  async snapshotAtFloor(chatId: string, branchId: string, messageIndex: number, swipeId: number | null): Promise<FloorStateView | null> {
    const floorIds = await this.deps.chain.findFloorIds(chatId, branchId, messageIndex, swipeId);
    if (!floorIds.length) return null;
    const prefix = await this.trustedPrefix(chatId, branchId);
    for (const floorId of floorIds) {
      const position = prefix.positions.find(item => item.floorId === floorId);
      const node = position?.valid && position.node ? position.node : (await this.deps.chain.listNodesForFloor(floorId))[0] ?? null;
      if (!node) continue;
      const replay = await this.snapshotAt(node);
      return { floorId, node, snapshot: replay.snapshot, valid: Boolean(position?.valid) };
    }
    return null;
  }

  private async nodesSinceCheckpoint(previous: StateNodeRecord | null): Promise<number> {
    let count = 0;
    let cursor: StateNodeRecord | null = previous;
    while (cursor && !cursor.checkpointId) {
      count += 1;
      cursor = cursor.previousStateNodeId ? await this.deps.chain.getNode(cursor.previousStateNodeId) : null;
    }
    return count;
  }
}

/** The node representing `floorId` inside an already computed trusted prefix, if any. */
export function validNodeInPrefix(prefix: TrustedPrefix, floorId: string): StateNodeRecord | null {
  const position = prefix.positions.find(item => item.floorId === floorId);
  return position?.valid ? position.node : null;
}

/** Which state a floor at `messageIndex` must be analysed against, read off an already computed prefix. */
export function resolveFromPrefix(prefix: TrustedPrefix, messageIndex: number): PreviousResolution {
  const before = prefix.positions.filter(position => position.messageIndex < messageIndex);
  const last = before.at(-1);
  if (!last) return { kind: 'start' };
  const floor = { messageIndex: last.messageIndex, floorId: last.floorId };
  if (last.valid && last.node) return { kind: 'ready', node: last.node, floor };
  const reason = last.node
    ? last.lineageValid ? 'its state node was produced under a different prompt version' : 'its state node no longer matches the chain before it'
    : 'it has no synced state node';
  return { kind: 'blocked', floor, reason };
}
