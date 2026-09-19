import bodyParser from 'body-parser';
import type { Router } from 'express';
import { LongMemoryGenerator, type LongMemoryBatchInput } from '../memory/long-memory';
import { LongMemoryStore } from '../storage/long-memory-store';
import { bodyObject, optionalString, requiredString, wrapRoute } from './request-utils';

export type MemoryRouteDependencies = { generator: LongMemoryGenerator; store: LongMemoryStore };

export function registerMemoryRoutes(router: Router, deps: MemoryRouteDependencies): void {
  const json = bodyParser.json({ limit: '4mb' });
  router.get('/memory/list', wrapRoute(async req => {
    const chatId = requiredString(req.query.chatId, 'chatId');
    return { memories: await deps.store.list(chatId, optionalString(req.query.branchId, 'branchId')) };
  }));
  router.post('/memory/resummarize', json, wrapRoute(async req => {
    const body = bodyObject(req);
    const input = body.input as LongMemoryBatchInput;
    if (!input || typeof input !== 'object') throw new Error('input is required');
    return { memories: await deps.generator.generate(input) };
  }));
}
