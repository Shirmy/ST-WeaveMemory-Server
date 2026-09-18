import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { computePromptVersion, DEFAULT_STATE_PROMPT } from '../src/ai/prompts/state-prompt';
import { SecretBox } from '../src/ai/secret-box';
import { AiConfigError, AiConfigStore, BUILTIN_PRESET_IDS } from '../src/storage/ai-config-store';
import { ensureStorageDirectories, resolveStoragePaths } from '../src/storage/data-directory';
import { runMigrations } from '../src/storage/migrations';
import { SqliteDatabase } from '../src/storage/sqlite-database';

const dataRootGlobal = globalThis as typeof globalThis & { DATA_ROOT?: string };

async function expectConfigError(work: () => Promise<unknown>, code = 'WM_INVALID_REQUEST'): Promise<void> {
  await assert.rejects(work, (error: unknown) => error instanceof AiConfigError && error.code === code);
}

async function main(): Promise<void> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'weavememory-ai-config-'));
  dataRootGlobal.DATA_ROOT = dataRoot;
  try {
    const paths = resolveStoragePaths();
    await ensureStorageDirectories(paths);
    let database = await SqliteDatabase.open(paths.databasePath);
    await runMigrations(database, paths);
    let secrets = await SecretBox.load(paths.secretKeyPath);
    let store = new AiConfigStore(database, secrets);
    await store.ensureBuiltinPresets();

    // channels: key is encrypted at rest and never returned in summaries
    const saved = await store.saveChannel({ channelId: 'relay', name: '中转', baseUrl: 'https://relay.example.com/', apiKey: 'sk-secret-123', timeout: 60, headers: { 'X-Test': '1' } });
    assert.equal(saved.baseUrl, 'https://relay.example.com/v1');
    assert.equal(saved.hasApiKey, true);
    assert.equal('apiKey' in saved, false);
    const rawRow = await database.get<{ api_key_encrypted: string }>('SELECT api_key_encrypted FROM ai_channels WHERE channel_id = ?', ['relay']);
    assert.ok(rawRow?.api_key_encrypted.startsWith('v1:'));
    assert.equal(rawRow?.api_key_encrypted.includes('sk-secret-123'), false);
    assert.equal((await store.getChannel('relay'))?.apiKey, 'sk-secret-123');

    const kept = await store.saveChannel({ channelId: 'relay', name: '中转-改名', baseUrl: 'https://relay.example.com/v1/chat/completions' });
    assert.equal(kept.baseUrl, 'https://relay.example.com/v1');
    assert.equal(kept.hasApiKey, true);
    assert.equal(kept.timeout, 60);
    assert.deepEqual(kept.headers, { 'X-Test': '1' });
    assert.equal((await store.getChannel('relay'))?.apiKey, 'sk-secret-123');

    const cleared = await store.saveChannel({ channelId: 'relay', name: '中转', baseUrl: 'https://relay.example.com/v1', apiKey: '' });
    assert.equal(cleared.hasApiKey, false);
    await store.saveChannel({ channelId: 'relay', name: '中转', baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-secret-456' });

    await expectConfigError(() => store.saveChannel({ name: 'bad', baseUrl: 'ftp://relay.example.com' }));
    await expectConfigError(() => store.saveChannel({ name: 'bad', baseUrl: 'https://relay.example.com', timeout: 0 }));
    await expectConfigError(() => store.saveChannel({ name: 'bad', baseUrl: 'https://relay.example.com', apiType: 'anthropic' as never }));
    const generated = await store.saveChannel({ name: '自动 ID', baseUrl: 'http://127.0.0.1:8000' });
    assert.ok(generated.channelId.startsWith('ch_'));
    assert.equal(generated.baseUrl, 'http://127.0.0.1:8000/v1');
    assert.equal((await store.listChannels()).length, 2);

    // model bindings
    const binding = await store.saveBinding('state', 'relay', 'gpt-4o-mini');
    assert.equal(binding.model, 'gpt-4o-mini');
    assert.equal((await store.getBindings()).state?.channelId, 'relay');
    await expectConfigError(() => store.saveBinding('planner', 'relay', 'x'));
    await expectConfigError(() => store.saveBinding('summary', 'missing', 'x'));
    await expectConfigError(() => store.saveBinding('summary', 'relay', ''));
    const resolved = await store.resolveRole('state');
    assert.equal(resolved?.channel.apiKey, 'sk-secret-456');
    assert.equal(resolved?.model, 'gpt-4o-mini');
    assert.equal(await store.resolveRole('rerank'), null);

    // reopen: the same key file decrypts, migrations and builtin seeding are idempotent
    await database.close();
    database = await SqliteDatabase.open(paths.databasePath);
    await runMigrations(database, paths);
    secrets = await SecretBox.load(paths.secretKeyPath);
    store = new AiConfigStore(database, secrets);
    await store.ensureBuiltinPresets();
    assert.equal((await store.getChannel('relay'))?.apiKey, 'sk-secret-456');
    assert.equal((await store.listPresets('state')).length, 1);

    // deleting a channel unbinds the roles that used it
    assert.deepEqual(await store.deleteChannel('relay'), { deleted: true, unboundRoles: ['state'] });
    assert.equal((await store.getBindings()).state, null);
    assert.deepEqual(await store.deleteChannel('relay'), { deleted: false, unboundRoles: [] });

    // prompt presets and promptVersion (content hash)
    const presets = await store.listPresets('state');
    assert.equal(presets[0]?.presetId, BUILTIN_PRESET_IDS.state);
    assert.equal(presets[0]?.isBuiltin, true);
    const builtinActive = await store.getActivePrompt('state');
    assert.equal(builtinActive.preset.presetId, BUILTIN_PRESET_IDS.state);
    assert.equal(builtinActive.promptVersion, computePromptVersion('state', DEFAULT_STATE_PROMPT));
    assert.match(builtinActive.promptVersion, /^pv1:[0-9a-f]{16}$/);

    const custom = await store.savePreset({ promptType: 'state', name: '我的', content: { system: '自定义系统提示', task: '自定义任务' } });
    assert.equal(custom.version, 1);
    const updated = await store.savePreset({ presetId: custom.presetId, promptType: 'state', name: '我的', content: { system: '自定义系统提示 v2', task: '自定义任务' } });
    assert.equal(updated.version, 2);
    const activated = await store.activatePreset('state', custom.presetId);
    assert.equal(activated.preset.presetId, custom.presetId);
    assert.notEqual(activated.promptVersion, builtinActive.promptVersion);
    const reverted = await store.savePreset({ presetId: custom.presetId, promptType: 'state', name: '我的', content: DEFAULT_STATE_PROMPT });
    assert.equal(reverted.version, 3);
    assert.equal((await store.getActivePrompt('state')).promptVersion, builtinActive.promptVersion);

    await expectConfigError(() => store.savePreset({ presetId: BUILTIN_PRESET_IDS.state, promptType: 'state', name: 'x', content: { system: 'x', task: '' } }));
    await expectConfigError(() => store.savePreset({ presetId: custom.presetId, promptType: 'summary', name: 'x', content: { system: 'x', task: '' } }));
    await expectConfigError(() => store.savePreset({ promptType: 'state', name: 'x', content: { system: '', task: '' } }));
    await expectConfigError(() => store.deletePreset(BUILTIN_PRESET_IDS.state));
    await expectConfigError(() => store.activatePreset('summary', custom.presetId));
    const removed = await store.deletePreset(custom.presetId);
    assert.equal(removed.activePresetId, BUILTIN_PRESET_IDS.state);
    assert.equal((await store.getActivePrompt('state')).preset.presetId, BUILTIN_PRESET_IDS.state);

    // state task settings persist across reopen
    assert.deepEqual(await store.getStateTaskSettings(), { timeoutSec: 45, maxAttempts: 3 });
    assert.deepEqual(await store.saveStateTaskSettings({ timeoutSec: 60 }), { timeoutSec: 60, maxAttempts: 3 });
    await expectConfigError(() => store.saveStateTaskSettings({ maxAttempts: 0 }));
    await database.close();
    database = await SqliteDatabase.open(paths.databasePath);
    await runMigrations(database, paths);
    store = new AiConfigStore(database, secrets);
    assert.deepEqual(await store.getStateTaskSettings(), { timeoutSec: 60, maxAttempts: 3 });

    // schema reached v4 and the jobs table gained the state task columns
    const version = await database.get<{ user_version: number }>('PRAGMA user_version');
    assert.equal(version?.user_version, 4);
    const jobColumns = await database.all<{ name: string }>('PRAGMA table_info(jobs)');
    for (const column of ['branch_id', 'floor_id', 'message_index', 'attempts', 'result_json', 'error_code', 'error_message', 'started_at', 'finished_at']) {
      assert.ok(jobColumns.some(item => item.name === column), `jobs.${column} missing`);
    }
    await database.close();
    console.log('Phase 4 AI config acceptance passed');
  } finally {
    delete dataRootGlobal.DATA_ROOT;
    try {
      await fs.rm(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EBUSY')) throw error;
    }
  }
}

void main();
