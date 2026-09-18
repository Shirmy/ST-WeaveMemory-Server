import type { Response } from 'express';
import { AiConfigError } from '../storage/ai-config-store';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly detail?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

export function sendError(res: Response, error: unknown): void {
  if (error instanceof ApiError) {
    res.status(error.status).json({
      ok: false,
      error: { code: error.code, message: error.message, ...(error.detail === undefined ? {} : { detail: error.detail }) }
    });
    return;
  }
  if (error instanceof AiConfigError) {
    res.status(error.code === 'WM_INTERNAL_ERROR' ? 500 : 400).json({ ok: false, error: { code: error.code, message: error.message } });
    return;
  }
  console.error('[WeaveMemory] unhandled API error', error);
  res.status(500).json({ ok: false, error: { code: 'WM_INTERNAL_ERROR', message: error instanceof Error ? error.message : 'internal error' } });
}
