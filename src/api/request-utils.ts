import type { Request } from 'express';
import { ApiError } from './errors';

export function bodyObject(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ApiError(400, 'WM_INVALID_REQUEST', `${name} is required`);
  return value;
}

export function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredString(value, name);
}

export function optionalInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isInteger(number)) throw new ApiError(400, 'WM_INVALID_REQUEST', `${name} must be an integer`);
  return number;
}
