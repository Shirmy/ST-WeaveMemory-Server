import bodyParser from 'body-parser';
import type { Router } from 'express';
import { API_VERSION, BACKEND_VERSION, SCHEMA_VERSION, type ActivateBranchRequest, type ChatReconcileRequest, type CreateBranchRequest, type FloorFinalizeRequest, type GenerationPrepareRequest, type HostChatBindingRequest } from '../protocol';
import { MemoryRuntime } from '../core/runtime';
import type { SqliteDatabase } from '../storage/sqlite-database';
import { requiredString } from './request-utils';

export function registerRoutes(router: Router, runtime: MemoryRuntime, database: SqliteDatabase): void {
  const json = bodyParser.json({ limit: '2mb' });

  router.get('/health', async (_req, res) => {
    try {
      const databaseHealth = await database.health();
      return res.json({
        ok: true,
        plugin: 'weavememory',
        backendVersion: BACKEND_VERSION,
        apiVersion: API_VERSION,
        schemaVersion: SCHEMA_VERSION,
        database: databaseHealth,
        capabilities: ['generation-gate', 'floor-binding', 'persistent-storage', 'ai-channels', 'prompt-presets', 'state-analysis', 'state-chain', 'long-memory-planned']
      });
    } catch (error) {
      return res.status(503).json({
        ok: false,
        plugin: 'weavememory',
        error: 'WM_DB_UNAVAILABLE',
        detail: error instanceof Error ? error.message : 'database health check failed'
      });
    }
  });

  router.post('/generation/prepare', json, async (req, res) => {
    try {
      const body = req.body ?? {};
      const payload: GenerationPrepareRequest = {
        chatId: requiredString(body.chatId, 'chatId'),
        generationType: String(body.generationType ?? 'normal'),
        contextSize: Number(body.contextSize) || 0,
        latestUserIndex: Number.isSafeInteger(body.latestUserIndex) ? body.latestUserIndex : null,
        latestUserText: String(body.latestUserText ?? ''),
        recentContextMode: body.recentContextMode === 'summary' ? 'summary' : 'raw',
        recentSummaryRegex: typeof body.recentSummaryRegex === 'string' ? body.recentSummaryRegex : '',
        recentFloorCount: Number.isSafeInteger(body.recentFloorCount) ? body.recentFloorCount : 4,
        externalState: body.externalState && typeof body.externalState === 'object' ? body.externalState : undefined
      };
      return res.json(await runtime.prepareGeneration(payload));
    } catch (error) {
      return res.status(400).json({ ready: false, reason: error instanceof Error ? error.message : 'invalid request' });
    }
  });

  router.post('/floor/finalize', json, async (req, res) => {
    try {
      const body = req.body ?? {};
      const payload: FloorFinalizeRequest = {
        chatId: requiredString(body.chatId, 'chatId'),
        branchId: body.branchId === undefined || body.branchId === null ? undefined : requiredString(body.branchId, 'branchId'),
        messageIndex: Number(body.messageIndex),
        swipeId: Number.isSafeInteger(body.swipeId) ? body.swipeId : null,
        content: String(body.content ?? '')
      };
      if (!Number.isSafeInteger(payload.messageIndex) || payload.messageIndex < 0) throw new Error('messageIndex is invalid');
      if (!payload.content) throw new Error('content is required');
      return res.json(await runtime.finalizeFloor(payload));
    } catch (error) {
      return res.status(400).json({ accepted: false, error: error instanceof Error ? error.message : 'invalid request' });
    }
  });

  router.post('/chat/reconcile', json, async (req, res) => {
    try {
      const body = req.body ?? {};
      const floors = body.floors;
      if (!Array.isArray(floors)) throw new Error('floors must be an array');
      const payload: ChatReconcileRequest = {
        chatId: requiredString(body.chatId, 'chatId'),
        branchId: body.branchId === undefined || body.branchId === null ? undefined : requiredString(body.branchId, 'branchId'),
        floors: floors.map((floor: unknown) => {
          const item = floor && typeof floor === 'object' ? floor as Record<string, unknown> : {};
          const messageIndex = Number(item.messageIndex);
          const swipeId = item.swipeId === null || item.swipeId === undefined ? null : Number(item.swipeId);
          const content = String(item.content ?? '');
          if (!Number.isSafeInteger(messageIndex) || messageIndex < 0) throw new Error('floor messageIndex is invalid');
          if (swipeId !== null && (!Number.isSafeInteger(swipeId) || swipeId < 0)) throw new Error('floor swipeId is invalid');
          if (!content) throw new Error('floor content is required');
          return { messageIndex, swipeId, content };
        })
      };
      return res.json(await runtime.reconcileChat(payload));
    } catch (error) {
      return res.status(400).json({ accepted: false, error: error instanceof Error ? error.message : 'invalid request' });
    }
  });

  router.post('/branch/create', json, async (req, res) => {
    try {
      const body = req.body ?? {};
      const payload: CreateBranchRequest = {
        chatId: requiredString(body.chatId, 'chatId'),
        sourceBranchId: body.sourceBranchId === undefined || body.sourceBranchId === null ? undefined : requiredString(body.sourceBranchId, 'sourceBranchId'),
        forkFloorId: requiredString(body.forkFloorId, 'forkFloorId')
      };
      return res.json(await runtime.createBranch(payload));
    } catch (error) {
      return res.status(400).json({ accepted: false, error: error instanceof Error ? error.message : 'invalid request' });
    }
  });

  router.post('/branch/activate', json, async (req, res) => {
    try {
      const body = req.body ?? {};
      const payload: ActivateBranchRequest = {
        chatId: requiredString(body.chatId, 'chatId'),
        branchId: requiredString(body.branchId, 'branchId')
      };
      return res.json(await runtime.activateBranch(payload.chatId, payload.branchId));
    } catch (error) {
      return res.status(400).json({ accepted: false, error: error instanceof Error ? error.message : 'invalid request' });
    }
  });

  router.post('/host-chat/bind', json, async (req, res) => {
    try {
      const body = req.body ?? {};
      const fork = body.forkFloor;
      let forkFloor: HostChatBindingRequest['forkFloor'] = null;
      if (fork !== undefined && fork !== null) {
        if (typeof fork !== 'object') throw new Error('forkFloor is invalid');
        const messageIndex = Number(fork.messageIndex);
        const swipeId = fork.swipeId === null || fork.swipeId === undefined ? null : Number(fork.swipeId);
        const content = String(fork.content ?? '');
        if (!Number.isSafeInteger(messageIndex) || messageIndex < 0) throw new Error('forkFloor messageIndex is invalid');
        if (swipeId !== null && (!Number.isSafeInteger(swipeId) || swipeId < 0)) throw new Error('forkFloor swipeId is invalid');
        if (!content) throw new Error('forkFloor content is required');
        forkFloor = { messageIndex, swipeId, content };
      }
      const payload: HostChatBindingRequest = {
        chatId: requiredString(body.chatId, 'chatId'),
        mainChatId: body.mainChatId === undefined || body.mainChatId === null || body.mainChatId === '' ? null : requiredString(body.mainChatId, 'mainChatId'),
        forkFloor
      };
      return res.json(await runtime.bindHostChat(payload));
    } catch (error) {
      return res.status(400).json({ accepted: false, error: error instanceof Error ? error.message : 'invalid request' });
    }
  });
}
