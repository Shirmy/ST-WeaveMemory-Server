import bodyParser from 'body-parser';
import type { Router } from 'express';
import { LongMemoryGenerator, type LongMemoryBatchInput } from '../memory/long-memory';
import { LongMemoryStore } from '../storage/long-memory-store';
import { Bm25SearchService } from '../memory/bm25';
import { EmbeddingSearchService } from '../memory/embedding';
import { RecallService, type RecallOptions } from '../memory/recall';
import { packMemories } from '../memory/token-packer';
import { RECALL_SETTING_LIMITS } from '../ai/types';
import { ApiError } from './errors';
import { recordDiagnostics } from '../core/diagnostics';
import type { AiConfigStore } from '../storage/ai-config-store';
import type { LongMemoryScheduler } from '../memory/long-memory-scheduler';
import { bodyObject, optionalInteger, optionalString, requiredString, wrapRoute } from './request-utils';

export type MemoryRouteDependencies = { generator: LongMemoryGenerator; store: LongMemoryStore; bm25: Bm25SearchService; embedding: EmbeddingSearchService; recall: RecallService; aiConfig?: AiConfigStore; scheduler?: LongMemoryScheduler };

/** Parses per-request recall overrides (roadmap §51 `/recall/debug`); every field is optional and range-checked. */
function recallOptions(raw: Record<string, unknown>): RecallOptions {
  const options: RecallOptions = {};
  for (const field of ['bm25TopK', 'embeddingTopK', 'rrfK', 'rerankCandidateLimit', 'finalRecallCount'] as const) {
    const value = optionalInteger(raw[field], `options.${field}`);
    if (value === undefined) continue;
    const { min, max } = RECALL_SETTING_LIMITS[field];
    if (value < min || value > max) throw new ApiError(400, 'WM_INVALID_REQUEST', `options.${field} must be between ${min} and ${max}`);
    options[field] = value;
  }
  if (raw.rerankEnabled !== undefined) {
    if (typeof raw.rerankEnabled !== 'boolean') throw new ApiError(400, 'WM_INVALID_REQUEST', 'options.rerankEnabled must be a boolean');
    options.rerankEnabled = raw.rerankEnabled;
  }
  return options;
}

export function registerMemoryRoutes(router: Router, deps: MemoryRouteDependencies): void {
  const json = bodyParser.json({ limit: '4mb' });
  router.get('/memory/list', wrapRoute(async req => {
    const chatId = requiredString(req.query.chatId, 'chatId');
    if (req.query.includeStale !== undefined && !['true', 'false'].includes(String(req.query.includeStale))) throw new ApiError(400, 'WM_INVALID_REQUEST', 'includeStale must be true or false');
    const includeStale = req.query.includeStale === 'true';
    return { memories: await deps.store.list(chatId, optionalString(req.query.branchId, 'branchId'), includeStale) };
  }));
  router.get('/memory/search', wrapRoute(async req => {
    const chatId = requiredString(req.query.chatId, 'chatId');
    const branchId = requiredString(req.query.branchId, 'branchId');
    const query = requiredString(req.query.query, 'query');
    const rawTopK = Number(req.query.topK ?? 10);
    const topK = Number.isSafeInteger(rawTopK) ? Math.min(50, Math.max(1, rawTopK)) : 10;
    return { query, candidates: await deps.bm25.search(chatId, branchId, query, topK) };
  }));
  router.get('/memory/vector-search', wrapRoute(async req => {
    const chatId = requiredString(req.query.chatId, 'chatId');
    const branchId = requiredString(req.query.branchId, 'branchId');
    const query = requiredString(req.query.query, 'query');
    const rawTopK = Number(req.query.topK ?? 10);
    const topK = Number.isSafeInteger(rawTopK) ? Math.min(50, Math.max(1, rawTopK)) : 10;
    return { query, candidates: await deps.embedding.search(chatId, branchId, query, topK) };
  }));
  router.post('/memory/vector-rebuild', json, wrapRoute(async req => {
    const body = bodyObject(req);
    return deps.embedding.rebuild(requiredString(body.chatId, 'chatId'), requiredString(body.branchId, 'branchId'));
  }));
  router.post('/memory/toggle-active', json, wrapRoute(async req => {
    const body = bodyObject(req);
    const memoryId = requiredString(body.memoryId, 'memoryId');
    if (typeof body.stale !== 'boolean') throw new ApiError(400, 'WM_INVALID_REQUEST', 'stale must be boolean');
    const stale = body.stale;
    await deps.store.setMemoryStale(memoryId, stale);
    if (stale) {
      await deps.store.setBm25Indexed([memoryId], false);
      await deps.store.setEmbeddingIndexed([memoryId], false);
    }
    return { memoryId, stale };
  }));

  router.post('/recall/debug', json, wrapRoute(async req => {
    const startedAt = performance.now();
    const body = bodyObject(req);
    const options = body.options && typeof body.options === 'object' && !Array.isArray(body.options) ? recallOptions(body.options as Record<string, unknown>) : {};
    const result = await deps.recall.recall(requiredString(body.chatId, 'chatId'), requiredString(body.branchId, 'branchId'), requiredString(body.query, 'query'), options);
    const chatId = requiredString(body.chatId, 'chatId');
    const branchId = requiredString(body.branchId, 'branchId');
    const fixedRecentCount = typeof body.fixedRecentCount === 'number' ? body.fixedRecentCount : (await deps.aiConfig?.getLongMemorySettings())?.latestForcedCount ?? 2;
    const activeMemories = await deps.store.list(chatId, branchId);
    const fixedRecentMemories = activeMemories
      .sort((left, right) => right.endFloor - left.endFloor || right.startFloor - left.startFloor || left.memoryId.localeCompare(right.memoryId))
      .slice(0, Number.isSafeInteger(fixedRecentCount) && (fixedRecentCount as number) >= 0 ? fixedRecentCount : 2);
    const packStartedAt = performance.now();
    const pack = packMemories({ recallCandidates: result.final, fixedRecentMemories }, {
      ...result.settings,
      contextWindow: typeof body.contextWindow === 'number' ? body.contextWindow : 0,
      maxMemoryCount: typeof body.maxMemoryCount === 'number' ? body.maxMemoryCount : result.settings.finalRecallCount,
      fixedRecentCount,
      tokenLimit: typeof body.tokenLimit === 'number' ? body.tokenLimit : undefined,
      currentState: typeof body.currentState === 'string' ? body.currentState : undefined
    });
    const packMs = performance.now() - packStartedAt;
    const timings = { ...result.timings, packMs, totalMs: performance.now() - startedAt };
    recordDiagnostics(chatId, branchId, { recall: { at: new Date().toISOString(), timings: result.timings, packMs, errors: result.errors } });
    return { ...result, pack, timings };
  }));
  router.post('/memory/resummarize-range', json, wrapRoute(async req => {
    const body = bodyObject(req);
    const chatId = requiredString(body.chatId, 'chatId');
    const branchId = requiredString(body.branchId, 'branchId');
    const batchId = optionalString(body.batchId, 'batchId');
    const batch = batchId ? (await deps.store.listBatches(chatId, branchId, true)).find(item => item.batchId === batchId) : undefined;
    if (batchId && !batch) throw new ApiError(400, 'WM_INVALID_REQUEST', 'batch is not in current scope');
    if (!deps.scheduler) throw new ApiError(503, 'WM_BACKEND_UNAVAILABLE', 'summary scheduler unavailable');
    const start = batch?.batchStartFloor ?? optionalInteger(body.startFloor, 'startFloor');
    const end = batch?.batchEndFloor ?? optionalInteger(body.endFloor, 'endFloor');
    if (start === undefined || end === undefined) throw new ApiError(400, 'WM_INVALID_REQUEST', 'batchId or startFloor/endFloor required');
    const input = await deps.scheduler.buildRange(chatId, branchId, start, end);
    return { memories: await deps.generator.generate(input, true) };
  }));
  router.post('/memory/resummarize', json, wrapRoute(async req => {
    const body = bodyObject(req);
    const input = body.input as LongMemoryBatchInput;
    if (!input || typeof input !== 'object') throw new Error('input is required');
    return { memories: await deps.generator.generate(input) };
  }));
}
