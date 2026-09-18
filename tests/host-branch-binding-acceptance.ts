import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureStorageDirectories, resolveStoragePaths } from '../src/storage/data-directory';
import { runMigrations } from '../src/storage/migrations';
import { SqliteDatabase } from '../src/storage/sqlite-database';
import { SqliteStore } from '../src/storage/sqlite-store';

const dataRootGlobal = globalThis as typeof globalThis & { DATA_ROOT?: string };

async function main(): Promise<void> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'weavememory-host-branch-binding-'));
  dataRootGlobal.DATA_ROOT = dataRoot;
  try {
    const paths = resolveStoragePaths();
    await ensureStorageDirectories(paths);
    let database = await SqliteDatabase.open(paths.databasePath);
    await runMigrations(database, paths);
    let store = new SqliteStore(database);
    const chatA = 'host-chat-A';
    const chatB = 'host-chat-B';

    const bindingA = await store.bindHostChat({ chatId: chatA });
    const floorsA = Array.from({ length: 5 }, (_, offset) => ({
      messageIndex: 10 + offset,
      swipeId: null,
      content: `${10 + offset}A`
    }));
    const resultA = await store.reconcileChat({ chatId: chatA, branchId: bindingA.branch.branchId, floors: floorsA });

    const bindingB = await store.bindHostChat({
      chatId: chatB,
      mainChatId: chatA,
      forkFloor: { messageIndex: 12, swipeId: null, content: '12A' }
    });
    assert.equal(bindingB.branch.parentBranchId, bindingA.branch.branchId);
    assert.notEqual(bindingB.branch.branchId, bindingA.branch.branchId);
    const floorsB = [
      ...floorsA.slice(0, 3),
      { messageIndex: 13, swipeId: null, content: '13B' },
      { messageIndex: 14, swipeId: null, content: '14B' }
    ];
    const resultB = await store.reconcileChat({ chatId: chatB, branchId: bindingB.branch.branchId, floors: floorsB });
    assert.notEqual(resultB.activeFloorIds[3], resultA.activeFloorIds[3]);
    assert.notEqual(resultB.activeFloorIds[4], resultA.activeFloorIds[4]);

    await database.close();
    database = await SqliteDatabase.open(paths.databasePath);
    await runMigrations(database, paths);
    store = new SqliteStore(database);

    const restoredA = await store.bindHostChat({ chatId: chatA });
    assert.equal(restoredA.branch.branchId, bindingA.branch.branchId);
    assert.deepEqual(restoredA.activeFloorIds, resultA.activeFloorIds);
    const restoredB = await store.bindHostChat({ chatId: chatB, mainChatId: chatA });
    assert.equal(restoredB.branch.branchId, bindingB.branch.branchId);
    assert.deepEqual(restoredB.activeFloorIds, resultB.activeFloorIds);
    assert.equal((await store.getFloor(restoredA.activeFloorIds[3]))?.content, '13A');
    assert.equal((await store.getFloor(restoredA.activeFloorIds[4]))?.content, '14A');
    assert.equal((await store.getFloor(restoredB.activeFloorIds[3]))?.content, '13B');
    assert.equal((await store.getFloor(restoredB.activeFloorIds[4]))?.content, '14B');
    await database.close();
    console.log('Phase 2 host branch binding acceptance passed');
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
