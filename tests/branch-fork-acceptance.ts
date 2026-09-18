import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fingerprint } from '../src/core/fingerprint';
import { ensureStorageDirectories, resolveStoragePaths } from '../src/storage/data-directory';
import { runMigrations } from '../src/storage/migrations';
import { SqliteDatabase } from '../src/storage/sqlite-database';
import { SqliteStore } from '../src/storage/sqlite-store';
import { floorKeyFor } from '../src/storage/types';

const dataRootGlobal = globalThis as typeof globalThis & { DATA_ROOT?: string };

async function main(): Promise<void> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'weavememory-phase2-fork-acceptance-'));
  dataRootGlobal.DATA_ROOT = dataRoot;
  try {
    const paths = resolveStoragePaths();
    await ensureStorageDirectories(paths);
    const database = await SqliteDatabase.open(paths.databasePath);
    await runMigrations(database, paths);
    const store = new SqliteStore(database);
    const chatId = 'branch-fork-acceptance-chat';
    const sourceBranchId = await store.getOrCreateActiveBranch(chatId);
    const sourceFloors = Array.from({ length: 5 }, (_, offset) => ({
      messageIndex: 10 + offset,
      swipeId: null,
      content: `${10 + offset}A`
    }));
    const source = await store.reconcileChat({ chatId, branchId: sourceBranchId, floors: sourceFloors });
    const forkFloorId = floorKeyFor(chatId, sourceBranchId, 12, null, fingerprint('12A'));

    const branchB = await store.createBranch({ chatId, sourceBranchId, forkFloorId });
    assert.equal(branchB.activeFloorIds.length, 3);
    for (const floorId of branchB.activeFloorIds) {
      assert.ok((await store.getFloor(floorId))!.messageIndex <= 12);
    }

    const branchFloors = [
      ...sourceFloors.slice(0, 3),
      { messageIndex: 13, swipeId: null, content: '13B' },
      { messageIndex: 14, swipeId: null, content: '14B' }
    ];
    const branchResult = await store.reconcileChat({ chatId, branchId: branchB.branch.branchId, floors: branchFloors });
    const source13 = source.activeFloorIds[3];
    const source14 = source.activeFloorIds[4];
    const branch13 = branchResult.activeFloorIds[3];
    const branch14 = branchResult.activeFloorIds[4];
    assert.notEqual(branch13, source13);
    assert.notEqual(branch14, source14);
    assert.equal((await store.getFloor(source13))?.content, '13A');
    assert.equal((await store.getFloor(source14))?.content, '14A');
    assert.equal((await store.getFloor(branch13))?.content, '13B');
    assert.equal((await store.getFloor(branch14))?.content, '14B');

    assert.deepEqual((await store.activateBranch(chatId, sourceBranchId)).activeFloorIds, source.activeFloorIds);
    assert.deepEqual((await store.activateBranch(chatId, branchB.branch.branchId)).activeFloorIds, branchResult.activeFloorIds);
    await database.close();
    console.log('Phase 2 branch fork acceptance passed');
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
