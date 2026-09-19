import { randomUUID } from 'node:crypto';
import { BaseUrlError, normalizeBaseUrl } from '../ai/base-url';
import { BUILTIN_STATE_PROMPT_VERSION, DEFAULT_STATE_PROMPT, computePromptVersion } from '../ai/prompts/state-prompt';
import type { SecretBox } from '../ai/secret-box';
import {
  AI_API_TYPES,
  AI_ROLES,
  DEFAULT_STATE_TASK_SETTINGS,
  PROMPT_TYPES,
  type ActivePrompt,
  type AiApiType,
  type AiChannelInput,
  type AiChannelRecord,
  type AiChannelSummary,
  type AiModelBinding,
  type AiModelBindings,
  type AiRole,
  type PromptContent,
  type PromptPresetInput,
  type PromptPresetRecord,
  type PromptType,
  type StateTaskSettings
  , type LongMemorySettings
  , type RecallSettings
  , DEFAULT_LONG_MEMORY_SETTINGS
  , DEFAULT_RECALL_SETTINGS
  , RECALL_SETTING_LIMITS
} from '../ai/types';
import type { SqliteDatabase } from './sqlite-database';
import { DEFAULT_LONG_MEMORY_PROMPT } from '../memory/long-memory';

export class AiConfigError extends Error {
  constructor(message: string, readonly code: string = 'WM_INVALID_REQUEST') {
    super(message);
    this.name = 'AiConfigError';
  }
}

const MAX_PROMPT_LENGTH = 20000;
const MAX_HEADER_COUNT = 20;
const CHANNEL_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,80}$/;
const META_STATE_SETTINGS = 'ai.state.settings';
const META_LONG_MEMORY_SETTINGS = 'memory.long.settings';
const META_RECALL_SETTINGS = 'memory.recall.settings';
const metaActivePrompt = (type: PromptType): string => `prompt.active.${type}`;

export const BUILTIN_PRESET_IDS: Record<PromptType, string> = { state: 'builtin:state', summary: 'builtin:summary' };

const BUILTIN_PRESETS: Partial<Record<PromptType, { name: string; content: PromptContent; version: number }>> = {
  state: { name: '内置默认（状态分析）', content: DEFAULT_STATE_PROMPT, version: BUILTIN_STATE_PROMPT_VERSION },
  summary: { name: '内置默认（长期记忆总结）', content: DEFAULT_LONG_MEMORY_PROMPT, version: 1 }
};

type ChannelRow = {
  channel_id: string;
  name: string;
  api_type: string;
  base_url: string;
  api_key_encrypted: string | null;
  timeout: number | null;
  headers_json: string | null;
  created_at: string;
  updated_at: string;
};

type BindingRow = { role: string; channel_id: string; model: string; updated_at: string };

type PresetRow = {
  preset_id: string;
  prompt_type: string;
  name: string;
  content_json: string;
  version: number;
  is_default: number;
  created_at: string;
  updated_at: string;
};

export function isAiRole(value: unknown): value is AiRole {
  return typeof value === 'string' && (AI_ROLES as readonly string[]).includes(value);
}

export function isPromptType(value: unknown): value is PromptType {
  return typeof value === 'string' && (PROMPT_TYPES as readonly string[]).includes(value);
}

function isApiType(value: unknown): value is AiApiType {
  return typeof value === 'string' && (AI_API_TYPES as readonly string[]).includes(value);
}

function requireText(value: unknown, field: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim()) throw new AiConfigError(`${field} is required`);
  const text = value.trim();
  if (text.length > max) throw new AiConfigError(`${field} is too long`);
  return text;
}

function validateTimeout(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 600) {
    throw new AiConfigError('timeout must be an integer between 1 and 600 seconds');
  }
  return value;
}

function validateHeaders(value: unknown): Record<string, string> {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new AiConfigError('headers must be an object');
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const name = key.trim();
    if (!name || typeof entry !== 'string') throw new AiConfigError('headers must map non-empty names to string values');
    result[name] = entry;
  }
  if (Object.keys(result).length > MAX_HEADER_COUNT) throw new AiConfigError('too many headers');
  return result;
}

function parseHeaders(json: string | null): Record<string, string> {
  if (!json) return {};
  try {
    return validateHeaders(JSON.parse(json));
  } catch {
    return {};
  }
}

export function validatePromptContent(value: unknown): PromptContent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AiConfigError('content must be an object with system and task');
  const item = value as Record<string, unknown>;
  if (typeof item.system !== 'string' || typeof item.task !== 'string') throw new AiConfigError('content.system and content.task must be strings');
  if (!item.system.trim() && !item.task.trim()) throw new AiConfigError('prompt content cannot be empty');
  if (item.system.length > MAX_PROMPT_LENGTH || item.task.length > MAX_PROMPT_LENGTH) throw new AiConfigError('prompt content is too long');
  return { system: item.system, task: item.task };
}

function parsePromptContent(json: string): PromptContent {
  try {
    return validatePromptContent(JSON.parse(json));
  } catch {
    throw new AiConfigError('stored prompt preset is corrupted', 'WM_INTERNAL_ERROR');
  }
}

function channelSummary(row: ChannelRow): AiChannelSummary {
  return {
    channelId: row.channel_id,
    name: row.name,
    apiType: row.api_type as AiApiType,
    baseUrl: row.base_url,
    hasApiKey: Boolean(row.api_key_encrypted),
    timeout: row.timeout,
    headers: parseHeaders(row.headers_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export type ChannelDraftInput = { baseUrl: unknown; apiKey?: unknown; headers?: unknown; timeout?: unknown };

/** Validates an unsaved channel configuration so it can be probed before the user saves it. */
export function draftChannel(input: ChannelDraftInput): AiChannelRecord {
  let baseUrl: string;
  try {
    baseUrl = normalizeBaseUrl(input.baseUrl);
  } catch (error) {
    if (error instanceof BaseUrlError) throw new AiConfigError(error.message);
    throw error;
  }
  if (input.apiKey !== undefined && input.apiKey !== null && typeof input.apiKey !== 'string') throw new AiConfigError('apiKey must be a string');
  const apiKey = typeof input.apiKey === 'string' && input.apiKey.trim() ? input.apiKey.trim() : null;
  const now = new Date().toISOString();
  return {
    channelId: '',
    name: '(draft)',
    apiType: 'openai-compatible',
    baseUrl,
    hasApiKey: Boolean(apiKey),
    timeout: validateTimeout(input.timeout),
    headers: validateHeaders(input.headers),
    createdAt: now,
    updatedAt: now,
    apiKey
  };
}

function presetRecord(row: PresetRow): PromptPresetRecord {
  return {
    presetId: row.preset_id,
    promptType: row.prompt_type as PromptType,
    name: row.name,
    content: parsePromptContent(row.content_json),
    version: row.version,
    isBuiltin: row.is_default === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class AiConfigStore {
  constructor(private readonly database: SqliteDatabase, private readonly secrets: SecretBox) {}

  // ---------------------------------------------------------------- channels

  async listChannels(): Promise<AiChannelSummary[]> {
    const rows = await this.database.all<ChannelRow>('SELECT * FROM ai_channels ORDER BY created_at, channel_id');
    return rows.map(channelSummary);
  }

  async getChannelSummary(channelId: string): Promise<AiChannelSummary | null> {
    const row = await this.channelRow(channelId);
    return row ? channelSummary(row) : null;
  }

  /** Returns the channel with its decrypted API key. Internal use only. */
  async getChannel(channelId: string): Promise<AiChannelRecord | null> {
    const row = await this.channelRow(channelId);
    if (!row) return null;
    let apiKey: string | null = null;
    if (row.api_key_encrypted) {
      try {
        apiKey = this.secrets.decrypt(row.api_key_encrypted);
      } catch {
        throw new AiConfigError(`stored API key of channel ${channelId} cannot be decrypted; enter the key again`, 'WM_AI_CHANNEL_UNAVAILABLE');
      }
    }
    return { ...channelSummary(row), apiKey };
  }

  async saveChannel(input: AiChannelInput): Promise<AiChannelSummary> {
    const channelId = input.channelId?.trim() || `ch_${randomUUID()}`;
    if (!CHANNEL_ID_PATTERN.test(channelId)) throw new AiConfigError('channelId contains invalid characters');
    const existing = await this.channelRow(channelId);
    const name = requireText(input.name, 'name', 80);
    const apiType = input.apiType ?? (existing?.api_type as AiApiType | undefined) ?? 'openai-compatible';
    if (!isApiType(apiType)) throw new AiConfigError(`apiType must be one of ${AI_API_TYPES.join(', ')}`);
    let baseUrl: string;
    try {
      baseUrl = normalizeBaseUrl(input.baseUrl);
    } catch (error) {
      if (error instanceof BaseUrlError) throw new AiConfigError(error.message);
      throw error;
    }
    const timeout = input.timeout === undefined ? existing?.timeout ?? null : validateTimeout(input.timeout);
    const headers = input.headers === undefined ? parseHeaders(existing?.headers_json ?? null) : validateHeaders(input.headers);
    let apiKeyEncrypted = existing?.api_key_encrypted ?? null;
    if (input.apiKey !== undefined) {
      if (input.apiKey !== null && typeof input.apiKey !== 'string') throw new AiConfigError('apiKey must be a string');
      const trimmed = input.apiKey?.trim() ?? '';
      apiKeyEncrypted = trimmed ? this.secrets.encrypt(trimmed) : null;
    }
    const now = new Date().toISOString();
    await this.database.run(
      `INSERT INTO ai_channels(channel_id, name, api_type, base_url, api_key_encrypted, timeout, headers_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel_id) DO UPDATE SET
         name = excluded.name, api_type = excluded.api_type, base_url = excluded.base_url,
         api_key_encrypted = excluded.api_key_encrypted, timeout = excluded.timeout,
         headers_json = excluded.headers_json, updated_at = excluded.updated_at`,
      [channelId, name, apiType, baseUrl, apiKeyEncrypted, timeout, JSON.stringify(headers), existing?.created_at ?? now, now]
    );
    const saved = await this.channelRow(channelId);
    if (!saved) throw new AiConfigError('channel could not be saved', 'WM_INTERNAL_ERROR');
    return channelSummary(saved);
  }

  async deleteChannel(channelId: string): Promise<{ deleted: boolean; unboundRoles: AiRole[] }> {
    const existing = await this.channelRow(channelId);
    if (!existing) return { deleted: false, unboundRoles: [] };
    const bindings = await this.database.all<BindingRow>('SELECT role FROM ai_model_bindings WHERE channel_id = ?', [channelId]);
    await this.database.transaction(async () => {
      await this.database.run('DELETE FROM ai_model_bindings WHERE channel_id = ?', [channelId]);
      await this.database.run('DELETE FROM ai_channels WHERE channel_id = ?', [channelId]);
    });
    return { deleted: true, unboundRoles: bindings.map(row => row.role).filter(isAiRole) };
  }

  private channelRow(channelId: string): Promise<ChannelRow | undefined> {
    return this.database.get<ChannelRow>('SELECT * FROM ai_channels WHERE channel_id = ?', [channelId]);
  }

  // ---------------------------------------------------------------- bindings

  async getBindings(): Promise<AiModelBindings> {
    const rows = await this.database.all<BindingRow>('SELECT role, channel_id, model, updated_at FROM ai_model_bindings');
    const result: AiModelBindings = { summary: null, state: null, embedding: null, rerank: null };
    for (const row of rows) {
      if (isAiRole(row.role)) result[row.role] = { role: row.role, channelId: row.channel_id, model: row.model, updatedAt: row.updated_at };
    }
    return result;
  }

  async getBinding(role: AiRole): Promise<AiModelBinding | null> {
    return (await this.getBindings())[role];
  }

  async saveBinding(role: unknown, channelId: unknown, model: unknown): Promise<AiModelBinding> {
    if (!isAiRole(role)) throw new AiConfigError(`role must be one of ${AI_ROLES.join(', ')}`);
    const channel = await this.channelRow(requireText(channelId, 'channelId', 80));
    if (!channel) throw new AiConfigError('channelId does not exist');
    const modelName = requireText(model, 'model', 200);
    const now = new Date().toISOString();
    await this.database.run(
      `INSERT INTO ai_model_bindings(role, channel_id, model, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(role) DO UPDATE SET channel_id = excluded.channel_id, model = excluded.model, updated_at = excluded.updated_at`,
      [role, channel.channel_id, modelName, now]
    );
    return { role, channelId: channel.channel_id, model: modelName, updatedAt: now };
  }

  async clearBinding(role: unknown): Promise<void> {
    if (!isAiRole(role)) throw new AiConfigError(`role must be one of ${AI_ROLES.join(', ')}`);
    await this.database.run('DELETE FROM ai_model_bindings WHERE role = ?', [role]);
  }

  /** Resolves the channel (with key) and model bound to a role, or null when the role is unbound. */
  async resolveRole(role: AiRole): Promise<{ channel: AiChannelRecord; model: string } | null> {
    const binding = await this.getBinding(role);
    if (!binding) return null;
    const channel = await this.getChannel(binding.channelId);
    if (!channel) return null;
    return { channel, model: binding.model };
  }

  // ---------------------------------------------------------------- prompt presets

  async ensureBuiltinPresets(): Promise<void> {
    const now = new Date().toISOString();
    for (const type of PROMPT_TYPES) {
      const builtin = BUILTIN_PRESETS[type];
      if (!builtin) continue;
      const presetId = BUILTIN_PRESET_IDS[type];
      const existing = await this.presetRow(presetId);
      const contentJson = JSON.stringify(builtin.content);
      if (existing && existing.content_json === contentJson && existing.version === builtin.version && existing.name === builtin.name) continue;
      if (type === 'summary' && existing) {
        const activeId = await this.getMeta(metaActivePrompt(type));
        if (!activeId || activeId === presetId) await this.invalidateSummary();
      }
      await this.database.run(
        `INSERT INTO prompt_presets(preset_id, prompt_type, name, content_json, version, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(preset_id) DO UPDATE SET
           name = excluded.name, content_json = excluded.content_json, version = excluded.version,
           is_default = 1, updated_at = excluded.updated_at`,
        [presetId, type, builtin.name, contentJson, builtin.version, existing?.created_at ?? now, now]
      );
    }
  }

  async listPresets(promptType: unknown): Promise<PromptPresetRecord[]> {
    if (!isPromptType(promptType)) throw new AiConfigError(`promptType must be one of ${PROMPT_TYPES.join(', ')}`);
    const rows = await this.database.all<PresetRow>(
      'SELECT * FROM prompt_presets WHERE prompt_type = ? ORDER BY is_default DESC, created_at, preset_id',
      [promptType]
    );
    return rows.map(presetRecord);
  }

  async getPreset(presetId: string): Promise<PromptPresetRecord | null> {
    const row = await this.presetRow(presetId);
    return row ? presetRecord(row) : null;
  }

  async savePreset(input: PromptPresetInput): Promise<PromptPresetRecord> {
    return this.database.transaction(async () => {
    if (!isPromptType(input.promptType)) throw new AiConfigError(`promptType must be one of ${PROMPT_TYPES.join(', ')}`);
    const name = requireText(input.name, 'name', 80);
    const content = validatePromptContent(input.content);
    const now = new Date().toISOString();
    const presetId = input.presetId?.trim() || `preset_${randomUUID()}`;
    if (presetId.startsWith('builtin:')) throw new AiConfigError('builtin presets cannot be modified; save a copy instead');
    const existing = await this.presetRow(presetId);
    if (existing && existing.prompt_type !== input.promptType) throw new AiConfigError('promptType cannot change for an existing preset');
    const version = existing ? existing.version + 1 : 1;
    await this.database.run(
      `INSERT INTO prompt_presets(preset_id, prompt_type, name, content_json, version, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(preset_id) DO UPDATE SET
         name = excluded.name, content_json = excluded.content_json, version = excluded.version, updated_at = excluded.updated_at`,
      [presetId, input.promptType, name, JSON.stringify(content), version, existing?.created_at ?? now, now]
    );
    const saved = await this.presetRow(presetId);
    if (!saved) throw new AiConfigError('prompt preset could not be saved', 'WM_INTERNAL_ERROR');
    if (input.promptType === 'summary' && (await this.getActivePrompt('summary')).preset.presetId === presetId) await this.invalidateSummary();
    return presetRecord(saved);
    });
  }

  async deletePreset(presetId: string): Promise<{ deleted: boolean; activePresetId: string }> {
    const existing = await this.presetRow(presetId);
    if (!existing) throw new AiConfigError('presetId does not exist');
    if (existing.is_default === 1) throw new AiConfigError('builtin presets cannot be deleted');
    const type = existing.prompt_type as PromptType;
    await this.database.transaction(async () => {
      if (type === 'summary' && (await this.getMeta(metaActivePrompt(type))) === presetId) await this.invalidateSummary();
      await this.database.run('DELETE FROM prompt_presets WHERE preset_id = ?', [presetId]);
      if ((await this.getMeta(metaActivePrompt(type))) === presetId) await this.setMeta(metaActivePrompt(type), BUILTIN_PRESET_IDS[type]);
    });
    return { deleted: true, activePresetId: (await this.getActivePrompt(type)).preset.presetId };
  }

  async activatePreset(promptType: unknown, presetId: string): Promise<ActivePrompt> {
    if (!isPromptType(promptType)) throw new AiConfigError(`promptType must be one of ${PROMPT_TYPES.join(', ')}`);
    const row = await this.presetRow(presetId);
    if (!row || row.prompt_type !== promptType) throw new AiConfigError('presetId does not exist for this promptType');
    await this.database.transaction(async () => {
      await this.setMeta(metaActivePrompt(promptType), presetId);
      if (promptType === 'summary') await this.invalidateSummary();
    });
    return this.getActivePrompt(promptType);
  }

  async resetPrompt(promptType: unknown): Promise<ActivePrompt> {
    if (!isPromptType(promptType)) throw new AiConfigError(`promptType must be one of ${PROMPT_TYPES.join(', ')}`);
    await this.database.transaction(async () => {
      await this.setMeta(metaActivePrompt(promptType), BUILTIN_PRESET_IDS[promptType]);
      if (promptType === 'summary') await this.invalidateSummary();
    });
    return this.getActivePrompt(promptType);
  }

  async getActivePrompt(promptType: unknown): Promise<ActivePrompt> {
    if (!isPromptType(promptType)) throw new AiConfigError(`promptType must be one of ${PROMPT_TYPES.join(', ')}`);
    const activeId = await this.getMeta(metaActivePrompt(promptType));
    let row = activeId ? await this.presetRow(activeId) : undefined;
    if (!row || row.prompt_type !== promptType) row = await this.presetRow(BUILTIN_PRESET_IDS[promptType]);
    if (!row) throw new AiConfigError(`no prompt preset is available for ${promptType}`, 'WM_INTERNAL_ERROR');
    const preset = presetRecord(row);
    return { preset, promptVersion: computePromptVersion(promptType, preset.content) };
  }

  private presetRow(presetId: string): Promise<PresetRow | undefined> {
    return this.database.get<PresetRow>('SELECT * FROM prompt_presets WHERE preset_id = ?', [presetId]);
  }

  private async invalidateSummary(): Promise<void> {
    const now = new Date().toISOString();
    await this.database.run('UPDATE long_memory_batches SET stale = 1, updated_at = ? WHERE stale = 0', [now]);
    await this.database.run('UPDATE long_memories SET stale = 1, bm25_indexed = 0, embedding_indexed = 0, updated_at = ? WHERE stale = 0', [now]);
  }

  // ---------------------------------------------------------------- state task settings

  async saveSettings(state: Partial<StateTaskSettings>, longMemory: Partial<LongMemorySettings>, recall: Partial<RecallSettings>): Promise<{ state: StateTaskSettings; longMemory: LongMemorySettings; recall: RecallSettings }> {
    return this.database.transaction(async () => ({ state: await this.saveStateTaskSettings(state), longMemory: await this.saveLongMemorySettings(longMemory), recall: await this.saveRecallSettings(recall) }));
  }

  async getStateTaskSettings(): Promise<StateTaskSettings> {
    const raw = await this.getMeta(META_STATE_SETTINGS);
    if (!raw) return { ...DEFAULT_STATE_TASK_SETTINGS };
    try {
      const parsed = JSON.parse(raw) as Partial<StateTaskSettings>;
      return {
        timeoutSec: typeof parsed.timeoutSec === 'number' ? parsed.timeoutSec : DEFAULT_STATE_TASK_SETTINGS.timeoutSec,
        maxAttempts: typeof parsed.maxAttempts === 'number' ? parsed.maxAttempts : DEFAULT_STATE_TASK_SETTINGS.maxAttempts,
        checkpointInterval: typeof parsed.checkpointInterval === 'number' ? parsed.checkpointInterval : DEFAULT_STATE_TASK_SETTINGS.checkpointInterval
      };
    } catch {
      return { ...DEFAULT_STATE_TASK_SETTINGS };
    }
  }

  async getLongMemorySettings(): Promise<LongMemorySettings> {
    const raw = await this.getMeta(META_LONG_MEMORY_SETTINGS);
    if (!raw) return { ...DEFAULT_LONG_MEMORY_SETTINGS };
    try { const parsed = JSON.parse(raw) as Partial<LongMemorySettings>; const interval = Number(parsed.summaryIntervalFloors); const latest = Number(parsed.latestForcedCount); return { summaryIntervalFloors: Number.isSafeInteger(interval) && interval >= 1 && interval <= 500 ? interval : 30, latestForcedCount: Number.isSafeInteger(latest) && latest >= 0 && latest <= 20 ? latest : 2 }; }
    catch { return { ...DEFAULT_LONG_MEMORY_SETTINGS }; }
  }

  async saveLongMemorySettings(patch: Partial<LongMemorySettings>): Promise<LongMemorySettings> {
    const current = await this.getLongMemorySettings();
    const value = Number(patch.summaryIntervalFloors ?? current.summaryIntervalFloors);
    const latest = Number(patch.latestForcedCount ?? current.latestForcedCount);
    if (!Number.isSafeInteger(value) || value < 1 || value > 500) throw new AiConfigError('summaryIntervalFloors must be between 1 and 500');
    if (!Number.isSafeInteger(latest) || latest < 0 || latest > 20) throw new AiConfigError('latestForcedCount must be between 0 and 20');
    const next = { summaryIntervalFloors: value, latestForcedCount: latest };
    await this.setMeta(META_LONG_MEMORY_SETTINGS, JSON.stringify(next));
    return next;
  }

  async getRecallSettings(): Promise<RecallSettings> {
    const raw = await this.getMeta(META_RECALL_SETTINGS);
    if (!raw) return { ...DEFAULT_RECALL_SETTINGS };
    try { return normalizeRecallSettings(JSON.parse(raw) as Partial<RecallSettings>); }
    catch { return { ...DEFAULT_RECALL_SETTINGS }; }
  }

  async saveRecallSettings(patch: Partial<RecallSettings>): Promise<RecallSettings> {
    const current = await this.getRecallSettings();
    const next: RecallSettings = { ...current };
    for (const field of ['bm25TopK', 'embeddingTopK', 'rrfK', 'rerankCandidateLimit', 'finalRecallCount'] as const) {
      const value = patch[field];
      if (value === undefined) continue;
      const { min, max } = RECALL_SETTING_LIMITS[field];
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new AiConfigError(`${field} must be an integer between ${min} and ${max}`);
      next[field] = value;
    }
    for (const field of ['tokenRatio', 'minTokenBudget', 'maxTokenBudget'] as const) {
      const value = patch[field];
      if (value === undefined) continue;
      const { min, max } = RECALL_SETTING_LIMITS[field];
      if (typeof value !== 'number' || !Number.isFinite(value) || (field !== 'tokenRatio' && !Number.isSafeInteger(value)) || value < min || value > max) throw new AiConfigError(`${field} must be between ${min} and ${max}${field === 'tokenRatio' ? '' : ' (integer)'}`);
      next[field] = value;
    }
    if (next.minTokenBudget > next.maxTokenBudget) throw new AiConfigError('minTokenBudget cannot exceed maxTokenBudget');
    if (patch.rerankEnabled !== undefined) {
      if (typeof patch.rerankEnabled !== 'boolean') throw new AiConfigError('rerankEnabled must be a boolean');
      next.rerankEnabled = patch.rerankEnabled;
    }
    await this.setMeta(META_RECALL_SETTINGS, JSON.stringify(next));
    return next;
  }

  /** Persists settings as given; range validation belongs to the API layer so tests can use short timeouts. */
  async saveStateTaskSettings(patch: Partial<StateTaskSettings>): Promise<StateTaskSettings> {
    const current = await this.getStateTaskSettings();
    const next: StateTaskSettings = {
      timeoutSec: patch.timeoutSec ?? current.timeoutSec,
      maxAttempts: patch.maxAttempts ?? current.maxAttempts,
      checkpointInterval: patch.checkpointInterval ?? current.checkpointInterval
    };
    for (const [field, value] of Object.entries(next)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new AiConfigError(`${field} must be a positive number`);
    }
    await this.setMeta(META_STATE_SETTINGS, JSON.stringify(next));
    return next;
  }

  // ---------------------------------------------------------------- meta helpers

  private async getMeta(key: string): Promise<string | null> {
    const row = await this.database.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key]);
    return row?.value ?? null;
  }

  private async setMeta(key: string, value: string): Promise<void> {
    await this.database.run(
      'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, value]
    );
  }
}

/** Falls back to the default for any stored value outside the documented range so a corrupt row never breaks recall. */
function normalizeRecallSettings(parsed: Partial<RecallSettings>): RecallSettings {
  const next: RecallSettings = { ...DEFAULT_RECALL_SETTINGS };
  for (const field of ['bm25TopK', 'embeddingTopK', 'rrfK', 'rerankCandidateLimit', 'finalRecallCount'] as const) {
    const value = Number(parsed[field]);
    const { min, max } = RECALL_SETTING_LIMITS[field];
    if (Number.isSafeInteger(value) && value >= min && value <= max) next[field] = value;
  }
  for (const field of ['tokenRatio', 'minTokenBudget', 'maxTokenBudget'] as const) {
    const value = Number(parsed[field]);
    const { min, max } = RECALL_SETTING_LIMITS[field];
    if (Number.isFinite(value) && (field === 'tokenRatio' || Number.isSafeInteger(value)) && value >= min && value <= max) next[field] = value;
  }
  if (next.minTokenBudget > next.maxTokenBudget) return { ...DEFAULT_RECALL_SETTINGS };
  if (typeof parsed.rerankEnabled === 'boolean') next.rerankEnabled = parsed.rerankEnabled;
  return next;
}
