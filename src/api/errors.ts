import type { Response } from 'express';
import { AiRequestError } from '../ai/openai-compatible-client';
import { StateOutputError, StateTaskError } from '../ai/state-task-runner';
import { AiConfigError } from '../storage/ai-config-store';
import { StateChainError } from '../state/chain-engine';
import { StateSchemaError } from '../state/schema';
import { MemoryManagementError } from '../storage/long-memory-store';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly detail?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

function envelope(code: string, message: string, detail?: unknown): Record<string, unknown> {
  return { ok: false, error: { code, message, ...(detail === undefined ? {} : { detail }) } };
}

export function sendError(res: Response, error: unknown): void {
  if (error instanceof StateChainError || error instanceof StateSchemaError) {
    res.status(400).json(envelope(error instanceof StateChainError ? error.code : 'WM_INVALID_REQUEST', error.message));
    return;
  }
  if (error instanceof ApiError) {
    res.status(error.status).json(envelope(error.code, error.message, error.detail));
    return;
  }
  if (error instanceof AiConfigError || error instanceof StateTaskError || error instanceof MemoryManagementError) {
    res.status(error.code === 'WM_INTERNAL_ERROR' ? 500 : 400).json(envelope(error.code, error.message));
    return;
  }
  if (error instanceof AiRequestError) {
    res.status(502).json(envelope(error.code, error.message, { retryable: error.retryable, status: error.status }));
    return;
  }
  if (error instanceof StateOutputError) {
    res.status(422).json(envelope('WM_INVALID_RESPONSE', error.message, { rawText: error.rawText }));
    return;
  }
  console.error('[WeaveMemory] unhandled API error', error);
  res.status(500).json(envelope('WM_INTERNAL_ERROR', error instanceof Error ? error.message : 'internal error'));
}
