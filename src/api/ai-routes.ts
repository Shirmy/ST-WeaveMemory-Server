import bodyParser from 'body-parser';
import type { Request, Response, Router } from 'express';
import { STATE_TASK_SETTING_LIMITS, type AiChannelInput, type StateTaskSettings } from '../ai/types';
import { AiConfigStore } from '../storage/ai-config-store';
import { ApiError, sendError } from './errors';
import { bodyObject, optionalInteger, optionalString, requiredString } from './request-utils';

type RouteWork = (req: Request, res: Response) => Promise<unknown>;

export type AiRouteDependencies = {
  aiConfig: AiConfigStore;
};

export function registerAiRoutes(router: Router, deps: AiRouteDependencies): void {
  const json = bodyParser.json({ limit: '2mb' });
  const { aiConfig } = deps;
  const wrap = (work: RouteWork) => async (req: Request, res: Response) => {
    try {
      res.json(await work(req, res));
    } catch (error) {
      sendError(res, error);
    }
  };

  // ---------------------------------------------------------------- channels

  router.get('/ai/channels', wrap(async () => ({ channels: await aiConfig.listChannels() })));

  router.post('/ai/channels/save', json, wrap(async req => {
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

  router.post('/ai/channels/delete', json, wrap(async req => {
    const body = bodyObject(req);
    return aiConfig.deleteChannel(requiredString(body.channelId, 'channelId'));
  }));

  // ---------------------------------------------------------------- model bindings

  router.get('/ai/model-bindings', wrap(async () => ({ bindings: await aiConfig.getBindings() })));

  router.post('/ai/model-bindings/save', json, wrap(async req => {
    const body = bodyObject(req);
    if (body.channelId === null) {
      await aiConfig.clearBinding(body.role);
      return { binding: null };
    }
    return { binding: await aiConfig.saveBinding(body.role, body.channelId, body.model) };
  }));

  // ---------------------------------------------------------------- prompt presets

  router.get('/ai/prompts', wrap(async req => {
    const promptType = typeof req.query.type === 'string' ? req.query.type : 'state';
    const presets = await aiConfig.listPresets(promptType);
    const active = await aiConfig.getActivePrompt(promptType);
    return { promptType, presets, activePresetId: active.preset.presetId, promptVersion: active.promptVersion };
  }));

  router.post('/ai/prompts/save', json, wrap(async req => {
    const body = bodyObject(req);
    const preset = await aiConfig.savePreset({
      presetId: optionalString(body.presetId, 'presetId'),
      promptType: body.promptType as 'state',
      name: requiredString(body.name, 'name'),
      content: body.content as { system: string; task: string }
    });
    return { preset };
  }));

  router.post('/ai/prompts/delete', json, wrap(async req => {
    const body = bodyObject(req);
    return aiConfig.deletePreset(requiredString(body.presetId, 'presetId'));
  }));

  router.post('/ai/prompts/activate', json, wrap(async req => {
    const body = bodyObject(req);
    const active = await aiConfig.activatePreset(body.promptType, requiredString(body.presetId, 'presetId'));
    return { activePresetId: active.preset.presetId, promptVersion: active.promptVersion };
  }));

  router.post('/ai/prompts/reset', json, wrap(async req => {
    const body = bodyObject(req);
    const active = await aiConfig.resetPrompt(body.promptType);
    return { activePresetId: active.preset.presetId, promptVersion: active.promptVersion };
  }));

  // ---------------------------------------------------------------- task settings

  router.get('/ai/settings', wrap(async () => ({ state: await aiConfig.getStateTaskSettings(), limits: STATE_TASK_SETTING_LIMITS })));

  router.post('/ai/settings/save', json, wrap(async req => {
    const body = bodyObject(req);
    const state = body.state && typeof body.state === 'object' ? (body.state as Record<string, unknown>) : {};
    const patch: Partial<StateTaskSettings> = {};
    const timeoutSec = optionalInteger(state.timeoutSec, 'state.timeoutSec');
    const maxAttempts = optionalInteger(state.maxAttempts, 'state.maxAttempts');
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
    return { state: await aiConfig.saveStateTaskSettings(patch) };
  }));
}
