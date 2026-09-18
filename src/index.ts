import type { Router } from 'express';
import { registerRoutes } from './api/routes';
import { MemoryRuntime } from './core/runtime';
import { PerChatQueue } from './queue/per-chat-queue';
import { InMemoryStore } from './storage/memory-store';
import { ensureStorageDirectories, resolveStoragePaths } from './storage/data-directory';
import { SqliteDatabase } from './storage/sqlite-database';

interface PluginInfo { id: string; name: string; description: string; }
interface Plugin { init: (router: Router) => Promise<void>; exit: () => Promise<void>; info: PluginInfo; }

const runtime = new MemoryRuntime(new InMemoryStore(), new PerChatQueue());
let database: SqliteDatabase | null = null;

export async function init(router: Router): Promise<void> {
  const storagePaths = resolveStoragePaths();
  await ensureStorageDirectories(storagePaths);
  database = await SqliteDatabase.open(storagePaths.databasePath);
  registerRoutes(router, runtime, database);
  console.log('[WeaveMemory] server v0.1.0 loaded');
}

export async function exit(): Promise<void> {
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
