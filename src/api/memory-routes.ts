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
import { bodyObject, optionalInteger, optionalString, requiredString, wrapRoute } from './request-utils';

export type MemoryRouteDependencies = { generator: LongMemoryGenerator; store: LongMemoryStore; bm25: Bm25SearchService; embedding: EmbeddingSearchService; recall: RecallService };

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
    return { memories: await deps.store.list(chatId, optionalString(req.query.branchId, 'branchId')) };
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
  router.post('/recall/debug', json, wrapRoute(async req => {
    const body = bodyObject(req);
    const options = body.options && typeof body.options === 'object' && !Array.isArray(body.options) ? recallOptions(body.options as Record<string, unknown>) : {};
    const result = await deps.recall.recall(requiredString(body.chatId, 'chatId'), requiredString(body.branchId, 'branchId'), requiredString(body.query, 'query'), options);
    const packCandidates = result.rerank.status === 'applied' ? result.rerank.candidates : result.rrf;
    const pack = packMemories(packCandidates, {
      contextWindow: typeof body.contextWindow === 'number' ? body.contextWindow : 0,
      maxMemoryCount: typeof body.maxMemoryCount === 'number' ? body.maxMemoryCount : undefined,
      fixedRecentCount: typeof body.fixedRecentCount === 'number' ? body.fixedRecentCount : undefined,
      tokenLimit: typeof body.tokenLimit === 'number' ? body.tokenLimit : undefined,
      currentState: typeof body.currentState === 'string' ? body.currentState : undefined
    });
    return { ...result, pack };
  }));
  router.post('/memory/resummarize', json, wrapRoute(async req => {
    const body = bodyObject(req);
    const input = body.input as LongMemoryBatchInput;
    if (!input || typeof input !== 'object') throw new Error('input is required');
    return { memories: await deps.generator.generate(input) };
  }));
}
