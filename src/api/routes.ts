import bodyParser from 'body-parser';
import type { Router } from 'express';
import { API_VERSION, BACKEND_VERSION, SCHEMA_VERSION, type FloorFinalizeRequest, type GenerationPrepareRequest } from '../protocol';
import { MemoryRuntime } from '../core/runtime';
import type { SqliteDatabase } from '../storage/sqlite-database';

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value;
}

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
        capabilities: ['generation-gate', 'floor-binding', 'persistent-storage', 'state-chain-planned', 'long-memory-planned']
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
        latestUserText: String(body.latestUserText ?? '')
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
}
