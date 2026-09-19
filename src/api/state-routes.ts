import bodyParser from 'body-parser';
import type { Router } from 'express';
import type { StateTaskRunner } from '../ai/state-task-runner';
import type { StateChainEngine, TrustedPrefix } from '../state/chain-engine';
import type { StateAnalysisCandidate } from '../state/schema';
import { renderCurrentState } from '../state/current-state';
import { isStateTaskStatus } from '../storage/state-task-store';
import type { MemoryStore } from '../storage/types';
import { ApiError } from './errors';
import { bodyObject, optionalInteger, optionalString, queryObject, requiredString, wrapRoute } from './request-utils';

export type StateRouteDependencies = {
  stateTasks: StateTaskRunner;
  chain: StateChainEngine;
  store: MemoryStore;
};

export type ChainSyncStatus = 'empty' | 'synced' | 'pending' | 'failed' | 'stale' | 'missing';

export function registerStateRoutes(router: Router, deps: StateRouteDependencies): void {
  const json = bodyParser.json({ limit: '2mb' });

  async function describeSync(prefix: TrustedPrefix): Promise<ChainSyncStatus> {
    if (!prefix.positions.length) return 'empty';
    if (prefix.firstInvalidIndex === null) return 'synced';
    const broken = prefix.positions.find(position => position.messageIndex === prefix.firstInvalidIndex);
    if (!broken) return 'missing';
    const jobs = await deps.stateTasks.listTasks({ chatId: prefix.chatId, floorId: broken.floorId });
    if (jobs.some(job => job.status === 'pending' || job.status === 'running')) return 'pending';
    const latest = jobs.at(-1);
    if (latest?.status === 'failed') return 'failed';
    return broken.node ? 'stale' : 'missing';
  }

  router.get('/state/tasks', wrapRoute(async req => {
    const query = queryObject(req);
    const status = optionalString(query.status, 'status');
    if (status !== undefined && !isStateTaskStatus(status)) throw new ApiError(400, 'WM_INVALID_REQUEST', 'status is invalid');
    const tasks = await deps.stateTasks.listTasks({
      chatId: requiredString(query.chatId, 'chatId'),
      branchId: optionalString(query.branchId, 'branchId'),
      floorId: optionalString(query.floorId, 'floorId'),
      status,
      limit: optionalInteger(query.limit, 'limit')
    });
    return { tasks };
  }));

  router.post('/state/tasks/run', json, wrapRoute(async req => {
    const body = bodyObject(req);
    return deps.stateTasks.requeueFloor(requiredString(body.chatId, 'chatId'), requiredString(body.floorId, 'floorId'));
  }));

  router.post('/state/rebuild', json, wrapRoute(async req => {
    const body = bodyObject(req);
    return deps.stateTasks.rebuild({
      chatId: requiredString(body.chatId, 'chatId'),
      branchId: optionalString(body.branchId, 'branchId'),
      fromMessageIndex: optionalInteger(body.fromMessageIndex, 'fromMessageIndex'),
      force: body.force === true
    });
  }));

  router.post('/state/manual-edit', json, wrapRoute(async req => {
    const body = bodyObject(req);
    const allowed = new Set(['chatId', 'branchId', 'target', 'entityId', 'fieldPath', 'value', 'lockedPaths', 'action', 'candidate']);
    if (Object.keys(body).some(key => !allowed.has(key))) throw new ApiError(400, 'WM_INVALID_REQUEST', 'unknown manual edit field');
    const chatId = requiredString(body.chatId, 'chatId');
    const branchId = optionalString(body.branchId, 'branchId') ?? await deps.store.getOrCreateActiveBranch(chatId);
    const target = body.target === undefined ? 'profile' : body.target;
    if (target !== 'profile' && target !== 'trace' && target !== 'story' && target !== 'candidate') throw new ApiError(400, 'WM_INVALID_REQUEST', 'target is invalid');
    const action = body.action === undefined ? undefined : body.action;
    if (action !== undefined && action !== 'lock' && action !== 'unlock' && action !== 'restore-ai') throw new ApiError(400, 'WM_INVALID_REQUEST', 'action is invalid');
    if (target === 'candidate' ? body.candidate === undefined : body.fieldPath === undefined && body.lockedPaths === undefined) throw new ApiError(400, 'WM_INVALID_REQUEST', 'manual edit has no changes');
    if (body.lockedPaths !== undefined && (!Array.isArray(body.lockedPaths) || !body.lockedPaths.every(path => typeof path === 'string'))) throw new ApiError(400, 'WM_INVALID_REQUEST', 'lockedPaths must contain strings');
    const result = await deps.stateTasks.manualEdit({
      chatId,
      branchId,
      target,
      entityId: optionalString(body.entityId, 'entityId'),
      fieldPath: optionalString(body.fieldPath, 'fieldPath'),
      value: body.value,
      lockedPaths: Array.isArray(body.lockedPaths) ? body.lockedPaths as string[] : undefined,
      action,
      candidate: body.candidate as StateAnalysisCandidate | undefined
    });
    return result;
  }));

  router.get('/state/current', wrapRoute(async req => {
    const query = queryObject(req);
    const chatId = requiredString(query.chatId, 'chatId');
    const branchId = optionalString(query.branchId, 'branchId') ?? await deps.store.getOrCreateActiveBranch(chatId);
    const view = await deps.chain.current(chatId, branchId);
    // The editing UI must show the same valid base used by manual-edit, even
    // when a historical lineage continues beyond the currently trusted head.
    if (view.prefix.head && view.node?.stateNodeId !== view.prefix.head.stateNodeId) {
      view.node = view.prefix.head;
      view.snapshot = (await deps.chain.snapshotAt(view.node)).snapshot;
    }
    const latest = view.prefix.positions.at(-1) ?? null;
    const recentPositions = view.prefix.positions.slice(-4);
    const recentFloors = await Promise.all(recentPositions.map(position => deps.store.getFloor(position.floorId)));
    const relevantCharacterIds = renderCurrentState({ snapshot: view.snapshot, userText: '', recentFloorTexts: recentFloors.map(floor => floor?.content ?? ''), recentPositions }).characterIds;
    return {
      chatId,
      branchId,
      stateNodeId: view.node?.stateNodeId ?? null,
      stateFingerprint: view.node?.stateFingerprint ?? null,
      headMessageIndex: view.node?.messageIndex ?? null,
      latestMessageIndex: latest?.messageIndex ?? null,
      firstInvalidMessageIndex: view.prefix.firstInvalidIndex,
      firstLineageBreakMessageIndex: view.prefix.firstLineageBreakIndex,
      promptVersion: view.prefix.promptVersion,
      syncStatus: await describeSync(view.prefix),
      relevantCharacterIds,
      snapshot: view.snapshot
    };
  }));

  router.get('/state/at', wrapRoute(async req => {
    const query = queryObject(req);
    const chatId = requiredString(query.chatId, 'chatId');
    const messageIndex = optionalInteger(query.messageIndex, 'messageIndex');
    if (messageIndex === undefined || messageIndex < 0) throw new ApiError(400, 'WM_INVALID_REQUEST', 'messageIndex is required');
    const swipeId = optionalInteger(query.swipeId, 'swipeId') ?? null;
    const branchId = optionalString(query.branchId, 'branchId') ?? await deps.store.getOrCreateActiveBranch(chatId);
    const view = await deps.chain.snapshotAtFloor(chatId, branchId, messageIndex, swipeId);
    if (!view) throw new ApiError(404, 'WM_INVALID_REQUEST', 'no state node exists for this floor');
    return {
      chatId,
      branchId,
      floorId: view.floorId,
      stateNodeId: view.node.stateNodeId,
      stateFingerprint: view.node.stateFingerprint,
      valid: view.valid,
      snapshot: view.snapshot
    };
  }));
}
