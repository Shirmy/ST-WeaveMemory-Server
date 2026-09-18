import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureStorageDirectories, resolveStoragePaths } from '../src/storage/data-directory';
import { runMigrations } from '../src/storage/migrations';
import { SqliteDatabase } from '../src/storage/sqlite-database';
import { SqliteStore } from '../src/storage/sqlite-store';
import type { FloorRecord } from '../src/storage/types';

const dataRootGlobal = globalThis as typeof globalThis & { DATA_ROOT?: string };
async function main(): Promise<void> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'weavememory-phase1-acceptance-'));
  dataRootGlobal.DATA_ROOT = dataRoot;
  try {
    const paths = resolveStoragePaths();
    await ensureStorageDirectories(paths);

    const firstDatabase = await SqliteDatabase.open(paths.databasePath);
    await runMigrations(firstDatabase, paths);
    const firstStore = new SqliteStore(firstDatabase);
    const record: FloorRecord = {
      floorKey: 'main:acceptance-chat:acceptance-floor-1',
      chatId: 'acceptance-chat',
      branchId: 'main:acceptance-chat',
      messageIndex: 1,
      swipeId: null,
      contentFingerprint: 'sha256:acceptance',
      content: 'Phase 1 persistence acceptance',
      active: true,
      status: 'pending',
      createdAt: '2026-09-19T00:00:00.000Z',
      updatedAt: '2026-09-19T00:00:00.000Z'
    };
    await firstStore.upsertFloor(record);
    await firstDatabase.close();

    const secondDatabase = await SqliteDatabase.open(paths.databasePath);
    await runMigrations(secondDatabase, paths);
    const restored = await new SqliteStore(secondDatabase).getFloor(record.floorKey);
    await secondDatabase.close();

    assert.deepEqual(restored, record);
    console.log('Phase 1 persistence acceptance passed');
  } finally {
    delete dataRootGlobal.DATA_ROOT;
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

void main();
