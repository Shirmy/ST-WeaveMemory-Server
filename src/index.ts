import type { Router } from 'express';
import { registerAiRoutes } from './api/ai-routes';
import { registerRoutes } from './api/routes';
import { registerStateRoutes } from './api/state-routes';
import { OpenAiCompatibleClient } from './ai/openai-compatible-client';
import { SecretBox } from './ai/secret-box';
import { SnapshotContextProvider } from './ai/snapshot-context-provider';
import { StateTaskRunner } from './ai/state-task-runner';
import { MemoryRuntime } from './core/runtime';
import { PerChatQueue } from './queue/per-chat-queue';
import { StateChainEngine } from './state/chain-engine';
import { AiConfigStore } from './storage/ai-config-store';
import { ensureStorageDirectories, resolveStoragePaths } from './storage/data-directory';
import { createDailyBackup, runMigrations } from './storage/migrations';
import { SqliteDatabase } from './storage/sqlite-database';
import { SqliteStore } from './storage/sqlite-store';
import { StateChainStore } from './storage/state-chain-store';
import { StateTaskStore } from './storage/state-task-store';

interface PluginInfo { id: string; name: string; description: string; }
interface Plugin { init: (router: Router) => Promise<void>; exit: () => Promise<void>; info: PluginInfo; }

let database: SqliteDatabase | null = null;
let stateTasks: StateTaskRunner | null = null;

export async function init(router: Router): Promise<void> {
  const storagePaths = resolveStoragePaths();
  await ensureStorageDirectories(storagePaths);
  const openedDatabase = await SqliteDatabase.open(storagePaths.databasePath);
  database = openedDatabase;
  let aiConfig: AiConfigStore;
  try {
    await runMigrations(openedDatabase, storagePaths);
    await createDailyBackup(openedDatabase, storagePaths);
    const secretBox = await SecretBox.load(storagePaths.secretKeyPath);
    aiConfig = new AiConfigStore(openedDatabase, secretBox);
    await aiConfig.ensureBuiltinPresets();
  } catch (error) {
    await openedDatabase.close();
    database = null;
    throw error;
  }
  const store = new SqliteStore(openedDatabase);
  const queue = new PerChatQueue();
  const client = new OpenAiCompatibleClient();
  const tasks = new StateTaskStore(openedDatabase);
  const chain = new StateChainEngine({
    database: openedDatabase,
    chain: new StateChainStore(openedDatabase),
    store,
    checkpointInterval: async () => (await aiConfig.getStateTaskSettings()).checkpointInterval,
    promptVersion: async () => (await aiConfig.getActivePrompt('state')).promptVersion
  });
  const runner = new StateTaskRunner({
    store,
    tasks,
    aiConfig,
    client,
    queue,
    context: new SnapshotContextProvider(chain, tasks),
    chain
  });
  stateTasks = runner;
  const activeRuntime = new MemoryRuntime(store, queue, runner, chain);
  registerRoutes(router, activeRuntime, openedDatabase);
  registerAiRoutes(router, { aiConfig, client, stateTasks: runner });
  registerStateRoutes(router, { stateTasks: runner, chain, store });
  await runner.resumePending();
  console.log('[WeaveMemory] server v0.1.0 loaded');
}

export async function exit(): Promise<void> {
  await stateTasks?.shutdown();
  stateTasks = null;
  await database?.close();
  database = null;
  console.log('[WeaveMemory] server stopped');
}

export const info: PluginInfo = {
  id: 'weavememory',
  name: 'WeaveMemory Server',
  description: 'State-chain and long-term-memory backend for WeaveMemory.'
};

const plugin: Plugin = { init, exit, info };
export default plugin;
