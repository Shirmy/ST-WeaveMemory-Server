import bodyParser from 'body-parser';
import type { Router } from 'express';
import { AiRequestError, OpenAiCompatibleClient } from '../ai/openai-compatible-client';
import type { StateTaskRunner } from '../ai/state-task-runner';
import { LONG_MEMORY_SETTING_LIMITS, RECALL_SETTING_LIMITS, STATE_TASK_SETTING_LIMITS, type AiChannelInput, type AiChannelRecord, type RecallSettings, type StateTaskSettings } from '../ai/types';
import type { KnownCharacter } from '../state/schema';
import { AiConfigStore, draftChannel, isAiRole, validatePromptContent } from '../storage/ai-config-store';
import { ApiError } from './errors';
import { bodyObject, optionalInteger, optionalString, requiredString, wrapRoute } from './request-utils';

export type AiRouteDependencies = {
  aiConfig: AiConfigStore;
  client: OpenAiCompatibleClient;
  stateTasks: StateTaskRunner;
};

/** Timeout used for model lists and connectivity probes when the channel has no explicit timeout. */
const DEFAULT_PROBE_TIMEOUT_SEC = 30;

function toApiError(error: unknown, code: string): unknown {
  if (error instanceof AiRequestError) {
    return new ApiError(502, code, error.message, { cause: error.code, retryable: error.retryable, status: error.status });
  }
  return error;
}

function knownCharactersFrom(value: unknown): KnownCharacter[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: KnownCharacter[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (typeof record.characterId !== 'string' || typeof record.canonicalName !== 'string') continue;
    const aliases = Array.isArray(record.aliases) ? record.aliases.filter((alias): alias is string => typeof alias === 'string') : [];
    result.push({ characterId: record.characterId, canonicalName: record.canonicalName, aliases });
  }
  return result;
}

export function registerAiRoutes(router: Router, deps: AiRouteDependencies): void {
  const json = bodyParser.json({ limit: '2mb' });
  const { aiConfig, client, stateTasks } = deps;

  /** Resolves a saved channel (optionally with a freshly typed key) or validates an unsaved draft. */
  async function channelForProbe(body: Record<string, unknown>): Promise<AiChannelRecord> {
    const channelId = optionalString(body.channelId, 'channelId');
    if (channelId) {
      const channel = await aiConfig.getChannel(channelId);
      if (!channel) throw new ApiError(404, 'WM_INVALID_REQUEST', 'channelId does not exist');
      if (typeof body.apiKey === 'string' && body.apiKey.trim()) return { ...channel, apiKey: body.apiKey.trim(), hasApiKey: true };
      return channel;
    }
    return draftChannel({ baseUrl: body.baseUrl, apiKey: body.apiKey, headers: body.headers, timeout: body.timeout });
  }

  const probeTimeoutMs = (channel: AiChannelRecord): number => (channel.timeout ?? DEFAULT_PROBE_TIMEOUT_SEC) * 1000;

  // ---------------------------------------------------------------- channels

  router.get('/ai/channels', wrapRoute(async () => ({ channels: await aiConfig.listChannels() })));

  router.post('/ai/channels/save', json, wrapRoute(async req => {
    const body = bodyObject(req);
    const input: AiChannelInput = {
      channelId: optionalString(body.channelId, 'channelId'),
      name: requiredString(body.name, 'name'),
      baseUrl: requiredString(body.baseUrl, 'baseUrl')
    };
    if (body.apiType !== undefined) input.apiType = body.apiType as AiChannelInput['apiType'];
    if (body.apiKey !== undefined) input.apiKey = body.apiKey === null ? null : String(body.apiKey);
    if (body.timeout !== undefined) input.timeout = body.timeout === null ? null : optionalInteger(body.timeout, 'timeout') ?? null;
    if (body.headers !== undefined) input.headers = body.headers as Record<string, string>;
    return { channel: await aiConfig.saveChannel(input) };
  }));

  router.post('/ai/channels/delete', json, wrapRoute(async req => {
    const body = bodyObject(req);
    return aiConfig.deleteChannel(requiredString(body.channelId, 'channelId'));
  }));

  router.post('/ai/channels/models', json, wrapRoute(async req => {
    const channel = await channelForProbe(bodyObject(req));
    try {
      return { models: await client.listModels(channel, probeTimeoutMs(channel)) };
    } catch (error) {
      throw toApiError(error, 'WM_MODEL_LIST_FAILED');
    }
  }));

  router.post('/ai/channels/test', json, wrapRoute(async req => {
    const channel = await channelForProbe(bodyObject(req));
    const startedAt = Date.now();
    try {
      const models = await client.listModels(channel, probeTimeoutMs(channel));
      return { ok: true, modelCount: models.length, durationMs: Date.now() - startedAt };
    } catch (error) {
      throw toApiError(error, 'WM_MODEL_TEST_FAILED');
    }
  }));

  router.post('/ai/models/test', json, wrapRoute(async req => {
    const body = bodyObject(req);
    if (!isAiRole(body.role)) throw new ApiError(400, 'WM_INVALID_REQUEST', 'role must be one of summary, state, embedding, rerank');
    const model = requiredString(body.model, 'model').trim();
    const channel = await channelForProbe(body);
    try {
      return await client.testModel(channel, model, body.role, probeTimeoutMs(channel));
    } catch (error) {
      throw toApiError(error, 'WM_MODEL_TEST_FAILED');
    }
  }));

  // ---------------------------------------------------------------- model bindings

  router.get('/ai/model-bindings', wrapRoute(async () => ({ bindings: await aiConfig.getBindings() })));

  router.post('/ai/model-bindings/save', json, wrapRoute(async req => {
    const body = bodyObject(req);
    if (body.channelId === null) {
      await aiConfig.clearBinding(body.role);
      return { binding: null };
    }
    return { binding: await aiConfig.saveBinding(body.role, body.channelId, body.model) };
  }));

  // ---------------------------------------------------------------- prompt presets

  router.get('/ai/prompts', wrapRoute(async req => {
    const promptType = typeof req.query.type === 'string' ? req.query.type : 'state';
    const presets = await aiConfig.listPresets(promptType);
    const active = await aiConfig.getActivePrompt(promptType);
    return { promptType, presets, activePresetId: active.preset.presetId, promptVersion: active.promptVersion };
  }));

  router.post('/ai/prompts/save', json, wrapRoute(async req => {
    const body = bodyObject(req);
    const preset = await aiConfig.savePreset({
      presetId: optionalString(body.presetId, 'presetId'),
      promptType: body.promptType as 'state',
      name: requiredString(body.name, 'name'),
      content: body.content as { system: string; task: string }
    });
    return { preset };
  }));

  router.post('/ai/prompts/delete', json, wrapRoute(async req => {
    const body = bodyObject(req);
    return aiConfig.deletePreset(requiredString(body.presetId, 'presetId'));
  }));

  router.post('/ai/prompts/activate', json, wrapRoute(async req => {
    const body = bodyObject(req);
    const active = await aiConfig.activatePreset(body.promptType, requiredString(body.presetId, 'presetId'));
    return { activePresetId: active.preset.presetId, promptVersion: active.promptVersion };
  }));

  router.post('/ai/prompts/reset', json, wrapRoute(async req => {
    const body = bodyObject(req);
    const active = await aiConfig.resetPrompt(body.promptType);
    return { activePresetId: active.preset.presetId, promptVersion: active.promptVersion };
  }));

  router.post('/ai/prompts/test', json, wrapRoute(async req => {
    const body = bodyObject(req);
    const promptType = body.promptType ?? 'state';
    if (promptType !== 'state') throw new ApiError(400, 'WM_INVALID_REQUEST', 'only the state prompt can be tested in this phase');
    const result = await stateTasks.runAdHoc({
      sampleContent: requiredString(body.sampleContent, 'sampleContent'),
      content: body.content === undefined ? undefined : validatePromptContent(body.content),
      presetId: optionalString(body.presetId, 'presetId'),
      knownCharacters: knownCharactersFrom(body.knownCharacters)
    });
    return { ok: true, ...result };
  }));

  // ---------------------------------------------------------------- task settings

  router.get('/ai/settings', wrapRoute(async () => ({ state: await aiConfig.getStateTaskSettings(), longMemory: await aiConfig.getLongMemorySettings(), recall: await aiConfig.getRecallSettings(), limits: STATE_TASK_SETTING_LIMITS, longMemoryLimits: LONG_MEMORY_SETTING_LIMITS, recallLimits: RECALL_SETTING_LIMITS })));

  router.post('/ai/settings/save', json, wrapRoute(async req => {
    const body = bodyObject(req);
    const state = body.state && typeof body.state === 'object' ? (body.state as Record<string, unknown>) : {};
    const longMemory = body.longMemory && typeof body.longMemory === 'object' ? (body.longMemory as Record<string, unknown>) : {};
    const patch: Partial<StateTaskSettings> = {};
    const timeoutSec = optionalInteger(state.timeoutSec, 'state.timeoutSec');
    const maxAttempts = optionalInteger(state.maxAttempts, 'state.maxAttempts');
    const checkpointInterval = optionalInteger(state.checkpointInterval, 'state.checkpointInterval');
    if (timeoutSec !== undefined) {
      const { min, max } = STATE_TASK_SETTING_LIMITS.timeoutSec;
      if (timeoutSec < min || timeoutSec > max) throw new ApiError(400, 'WM_INVALID_REQUEST', `state.timeoutSec must be between ${min} and ${max}`);
      patch.timeoutSec = timeoutSec;
    }
    if (maxAttempts !== undefined) {
      const { min, max } = STATE_TASK_SETTING_LIMITS.maxAttempts;
      if (maxAttempts < min || maxAttempts > max) throw new ApiError(400, 'WM_INVALID_REQUEST', `state.maxAttempts must be between ${min} and ${max}`);
      patch.maxAttempts = maxAttempts;
    }
    if (checkpointInterval !== undefined) {
      const { min, max } = STATE_TASK_SETTING_LIMITS.checkpointInterval;
      if (checkpointInterval < min || checkpointInterval > max) throw new ApiError(400, 'WM_INVALID_REQUEST', `state.checkpointInterval must be between ${min} and ${max}`);
      patch.checkpointInterval = checkpointInterval;
    }
    const longMemoryPatch: { summaryIntervalFloors?: number } = {};
    if (longMemory.summaryIntervalFloors !== undefined) longMemoryPatch.summaryIntervalFloors = optionalInteger(longMemory.summaryIntervalFloors, 'longMemory.summaryIntervalFloors');
    const recall = body.recall && typeof body.recall === 'object' ? (body.recall as Record<string, unknown>) : {};
    const recallPatch: Partial<RecallSettings> = {};
    for (const field of ['bm25TopK', 'embeddingTopK', 'rrfK', 'rerankCandidateLimit', 'finalRecallCount'] as const) {
      const value = optionalInteger(recall[field], `recall.${field}`);
      if (value === undefined) continue;
      const { min, max } = RECALL_SETTING_LIMITS[field];
      if (value < min || value > max) throw new ApiError(400, 'WM_INVALID_REQUEST', `recall.${field} must be between ${min} and ${max}`);
      recallPatch[field] = value;
    }
    if (recall.rerankEnabled !== undefined) {
      if (typeof recall.rerankEnabled !== 'boolean') throw new ApiError(400, 'WM_INVALID_REQUEST', 'recall.rerankEnabled must be a boolean');
      recallPatch.rerankEnabled = recall.rerankEnabled;
    }
    return { state: await aiConfig.saveStateTaskSettings(patch), longMemory: await aiConfig.saveLongMemorySettings(longMemoryPatch), recall: await aiConfig.saveRecallSettings(recallPatch) };
  }));
}
