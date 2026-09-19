import bodyParser from 'body-parser';
import type { Router } from 'express';
import { LongMemoryGenerator, type LongMemoryBatchInput } from '../memory/long-memory';
import { LongMemoryStore } from '../storage/long-memory-store';
import { Bm25SearchService } from '../memory/bm25';
import { bodyObject, optionalString, requiredString, wrapRoute } from './request-utils';

export type MemoryRouteDependencies = { generator: LongMemoryGenerator; store: LongMemoryStore; bm25: Bm25SearchService };

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
  router.post('/memory/resummarize', json, wrapRoute(async req => {
    const body = bodyObject(req);
    const input = body.input as LongMemoryBatchInput;
    if (!input || typeof input !== 'object') throw new Error('input is required');
    return { memories: await deps.generator.generate(input) };
  }));
}
