import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureStorageDirectories, resolveStoragePaths } from '../src/storage/data-directory';
import { runMigrations } from '../src/storage/migrations';
import { fingerprint } from '../src/core/fingerprint';
import { SqliteDatabase } from '../src/storage/sqlite-database';
import { SqliteStore } from '../src/storage/sqlite-store';
import { floorKeyFor } from '../src/storage/types';

const dataRootGlobal = globalThis as typeof globalThis & { DATA_ROOT?: string };

async function main(): Promise<void> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'weavememory-phase2-acceptance-'));
  dataRootGlobal.DATA_ROOT = dataRoot;
  try {
    const paths = resolveStoragePaths();
    await ensureStorageDirectories(paths);
    const database = await SqliteDatabase.open(paths.databasePath);
    await runMigrations(database, paths);
    const store = new SqliteStore(database);

    const first = await store.reconcileChat({
      chatId: 'phase2-chat',
      floors: [
        { messageIndex: 2, swipeId: 0, content: 'first swipe' },
        { messageIndex: 4, swipeId: 0, content: 'stable floor' }
      ]
    });
    assert.equal(first.createdFloorIds.length, 2);
    assert.equal(first.reusedFloorIds.length, 0);

    const branchId = 'main:phase2-chat';
    const stableId = floorKeyFor('phase2-chat', branchId, 4, 0, fingerprint('stable floor'));
    const oldSwipeId = floorKeyFor('phase2-chat', branchId, 2, 0, fingerprint('first swipe'));
    const second = await store.reconcileChat({
      chatId: 'phase2-chat',
      floors: [
        { messageIndex: 2, swipeId: 1, content: 'second swipe' },
        { messageIndex: 4, swipeId: 0, content: 'stable floor' }
      ]
    });
    const newSwipeId = floorKeyFor('phase2-chat', branchId, 2, 1, fingerprint('second swipe'));
    assert.deepEqual(second.reusedFloorIds, [stableId]);
    assert.deepEqual(second.createdFloorIds, [newSwipeId]);
    assert.deepEqual(second.staleFloorIds, []);

    const oldSwipe = await store.getFloor(oldSwipeId);
    const newSwipe = await store.getFloor(newSwipeId);
    assert.equal(oldSwipe?.active, false);
    assert.equal(oldSwipe?.status, 'pending');
    assert.equal(newSwipe?.active, true);
    assert.equal(newSwipe?.branchId, 'main:phase2-chat');

    const third = await store.reconcileChat({
      chatId: 'phase2-chat',
      floors: [{ messageIndex: 4, swipeId: 0, content: 'stable floor' }]
    });
    assert.deepEqual(third.activeFloorIds, [stableId]);
    assert.ok(third.staleFloorIds.includes(newSwipeId));
    assert.ok(third.staleFloorIds.includes(oldSwipeId));
    await database.close();
    console.log('Phase 2 floor reconcile acceptance passed');
  } finally {
    delete dataRootGlobal.DATA_ROOT;
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

void main();
