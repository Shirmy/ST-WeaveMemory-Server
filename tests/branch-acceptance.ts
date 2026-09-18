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
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'weavememory-phase2-branch-acceptance-'));
  dataRootGlobal.DATA_ROOT = dataRoot;
  try {
    const paths = resolveStoragePaths();
    await ensureStorageDirectories(paths);
    const database = await SqliteDatabase.open(paths.databasePath);
    await runMigrations(database, paths);
    const store = new SqliteStore(database);
    const chatId = 'branch-acceptance-chat';
    const mainBranchId = await store.getOrCreateActiveBranch(chatId);

    const swipeIds = new Map<number, string>();
    for (const swipeId of [0, 1, 2]) {
      const content = `floor 10 swipe ${swipeId}`;
      const result = await store.reconcileChat({ chatId, floors: [{ messageIndex: 10, swipeId, content }] });
      swipeIds.set(swipeId, result.activeFloorIds[0]);
    }
    const restoredSwipe0 = await store.reconcileChat({
      chatId,
      floors: [{ messageIndex: 10, swipeId: 0, content: 'floor 10 swipe 0' }]
    });
    assert.equal(restoredSwipe0.reusedFloorIds[0], swipeIds.get(0));

    const branchB = await store.createBranch({ chatId, sourceBranchId: mainBranchId, forkFloorId: swipeIds.get(0) });
    assert.notEqual(branchB.branch.branchId, mainBranchId);
    assert.equal(branchB.branch.parentBranchId, mainBranchId);
    assert.equal(branchB.activeFloorIds.length, 1);

    const branchBReconcile = await store.reconcileChat({
      chatId,
      branchId: branchB.branch.branchId,
      floors: [
        { messageIndex: 10, swipeId: 0, content: 'floor 10 swipe 0' },
        { messageIndex: 11, swipeId: null, content: 'branch B continues' }
      ]
    });
    const branchAFloorId = swipeIds.get(0)!;
    const branchBFloorId = branchBReconcile.activeFloorIds[0];
    assert.notEqual(branchBFloorId, branchAFloorId);
    assert.equal((await store.getFloor(branchAFloorId))?.branchId, mainBranchId);
    assert.equal((await store.getFloor(branchBFloorId))?.branchId, branchB.branch.branchId);

    const mainActive = await store.activateBranch(chatId, mainBranchId);
    assert.deepEqual(mainActive.activeFloorIds, [branchAFloorId]);
    const branchBActive = await store.activateBranch(chatId, branchB.branch.branchId);
    assert.deepEqual(branchBActive.activeFloorIds, branchBReconcile.activeFloorIds);

    const edited = await store.reconcileChat({
      chatId,
      branchId: branchB.branch.branchId,
      floors: [
        { messageIndex: 10, swipeId: 2, content: 'floor 10 swipe 2' },
        { messageIndex: 11, swipeId: null, content: 'branch B edited continuation' }
      ]
    });
    assert.equal(edited.reusedFloorIds[0], floorKeyFor(chatId, branchB.branch.branchId, 10, 2, fingerprint('floor 10 swipe 2')));
    assert.ok(edited.staleFloorIds.includes(branchBReconcile.activeFloorIds[1]));

    const deleted = await store.reconcileChat({
      chatId,
      branchId: branchB.branch.branchId,
      floors: [{ messageIndex: 10, swipeId: 2, content: 'floor 10 swipe 2' }]
    });
    assert.ok(deleted.staleFloorIds.includes(edited.activeFloorIds[1]));
    assert.deepEqual((await store.activateBranch(chatId, mainBranchId)).activeFloorIds, [branchAFloorId]);
    assert.deepEqual((await store.activateBranch(chatId, branchB.branch.branchId)).activeFloorIds, deleted.activeFloorIds);

    await database.close();
    console.log('Phase 2 branch acceptance passed');
  } finally {
    delete dataRootGlobal.DATA_ROOT;
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

void main();
