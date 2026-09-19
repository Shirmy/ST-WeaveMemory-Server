import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateChainEngine } from '../src/state/chain-engine';
import { SqliteDatabase } from '../src/storage/sqlite-database';
import { SqliteStore } from '../src/storage/sqlite-store';
import { StateChainStore } from '../src/storage/state-chain-store';
import { runMigrations } from '../src/storage/migrations';
import { ensureStorageDirectories, resolveStoragePaths } from '../src/storage/data-directory';
import { fingerprint, dependencyFingerprint } from '../src/core/fingerprint';
import { STATE_PROTOCOL_VERSION } from '../src/protocol';
import { STATE_SCHEMA_VERSION } from '../src/state/schema';
import { applyChanges } from '../src/state/diff';
import { emptySnapshot } from '../src/state/apply';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wm-manual-'));
  (globalThis as typeof globalThis & { DATA_ROOT: string }).DATA_ROOT = root;
  const paths = resolveStoragePaths();
  await ensureStorageDirectories(paths);
  const db = await SqliteDatabase.open(paths.databasePath);
  try {
    await runMigrations(db, paths);
    await db.exec('CREATE TEMP TABLE transaction_probe (value TEXT)');
    const concurrent = await Promise.allSettled([
      db.transaction(async () => {
        await db.run("INSERT INTO transaction_probe VALUES ('rolled-back')");
        await new Promise(resolve => setTimeout(resolve, 10));
        throw new Error('rollback first transaction');
      }),
      db.transaction(async () => { await db.run("INSERT INTO transaction_probe VALUES ('committed')"); }),
      db.run("INSERT INTO transaction_probe VALUES ('outside')")
    ]);
    assert.equal(concurrent[0].status, 'rejected');
    assert.equal(concurrent[1].status, 'fulfilled');
    assert.equal(concurrent[2].status, 'fulfilled');
    assert.deepEqual(await db.all('SELECT value FROM transaction_probe ORDER BY value'), [{ value: 'committed' }, { value: 'outside' }], 'rollback must never include another request');
    const store = new SqliteStore(db), nodes = new StateChainStore(db);
    const chain = new StateChainEngine({ database: db, chain: nodes, store, checkpointInterval: async () => 1, promptVersion: async () => 'manual-test' });
    const chatId = 'manual', branchId = await store.getOrCreateActiveBranch(chatId);
    await assert.rejects(chain.applyManualEdit({ chatId, branchId, target: 'story', fieldPath: 'now.currentTime', value: 'no state' }), /first state/);
    const floors = await store.reconcileChat({ chatId, branchId, floors: [{ messageIndex: 1, swipeId: 0, content: 'day one' }, { messageIndex: 2, swipeId: 0, content: 'day two' }, { messageIndex: 3, swipeId: 0, content: 'day three' }] });
    const first = await store.getFloor(floors.activeFloorIds[0]);
    assert.ok(first);
    const committed = await chain.commitCandidate({ chatId, branchId, hostChatId: chatId, floorId: first.floorKey, messageIndex: 1, swipeId: 0, bodyFingerprint: fingerprint(first.content), dependencyFingerprint: dependencyFingerprint({ bodyFingerprint: fingerprint(first.content), previousStateFingerprint: null, protocolVersion: STATE_PROTOCOL_VERSION, schemaVersion: STATE_SCHEMA_VERSION, promptVersion: 'manual-test' }), candidate: { profiles: { alice: { canonicalName: 'Alice', basic: { age: '20' } } } }, previous: null });
    const original = await nodes.getNode(committed.node.stateNodeId);
    const originalDelta = await nodes.getDeltasByNodeIds([committed.node.stateNodeId]);
    const originalCheckpoint = await nodes.getCheckpoint(committed.checkpointId!);
    await chain.applyManualEdit({ chatId, branchId, target: 'profile', entityId: 'alice', fieldPath: 'basic.age', value: '21' });
    const edited = await chain.current(chatId, branchId);
    assert.notEqual(edited.node!.stateNodeId, committed.node.stateNodeId);
    assert.equal(edited.node!.dependencyFingerprint, committed.node.dependencyFingerprint);
    assert.equal(edited.node!.previousStateNodeId, null);
    assert.equal(edited.snapshot.profiles.alice.basic.age, '21');
    assert.equal(edited.snapshot.profiles.alice.sourcePriority['basic.age'], 'manual');
    assert.equal((await nodes.getNode(committed.node.stateNodeId))!.stateFingerprint, original!.stateFingerprint);
    assert.deepEqual(await nodes.getDeltasByNodeIds([committed.node.stateNodeId]), originalDelta);
    assert.deepEqual(await nodes.getCheckpoint(committed.checkpointId!), originalCheckpoint);
    const delta = (await nodes.getDeltasByNodeIds([edited.node!.stateNodeId])).get(edited.node!.stateNodeId)!;
    assert.deepEqual(applyChanges(emptySnapshot(branchId), [...delta.rootChanges, ...delta.profileChanges, ...delta.traceChanges, ...delta.storyChanges]), edited.snapshot);
    assert.equal((await chain.snapshotAt(committed.node)).snapshot.profiles.alice.basic.age, '20');
    const second = await store.getFloor(floors.activeFloorIds[1]);
    assert.ok(second);
    const oldSecond = await chain.commitCandidate({ chatId, branchId, hostChatId: chatId, floorId: second.floorKey, messageIndex: 2, swipeId: 0, bodyFingerprint: fingerprint(second.content), dependencyFingerprint: dependencyFingerprint({ bodyFingerprint: fingerprint(second.content), previousStateFingerprint: committed.node.stateFingerprint, protocolVersion: STATE_PROTOCOL_VERSION, schemaVersion: STATE_SCHEMA_VERSION, promptVersion: 'manual-test' }), candidate: {}, previous: committed.node });
    const third = await store.getFloor(floors.activeFloorIds[2]);
    assert.ok(third);
    const oldThird = await chain.commitCandidate({ chatId, branchId, hostChatId: chatId, floorId: third.floorKey, messageIndex: 3, swipeId: 0, bodyFingerprint: fingerprint(third.content), dependencyFingerprint: dependencyFingerprint({ bodyFingerprint: fingerprint(third.content), previousStateFingerprint: oldSecond.node.stateFingerprint, protocolVersion: STATE_PROTOCOL_VERSION, schemaVersion: STATE_SCHEMA_VERSION, promptVersion: 'manual-test' }), candidate: {}, previous: oldSecond.node });
    assert.equal((await chain.trustedPrefix(chatId, branchId)).firstInvalidIndex, 2, 'downstream old fingerprint is invalid');
    const count = (await nodes.listNodes(branchId)).length;
    for (const [target, fieldPath, value] of [['profile', 'basic.species', 'elf'], ['trace', 'affinity', { inner: 99, outer: null }], ['story', 'calendar', [{ id: 'x', title: 'invalid' }]]] as const) {
      await assert.rejects(chain.applyManualEdit({ chatId, branchId, target, entityId: 'alice', fieldPath, value }));
    }
    assert.equal((await nodes.listNodes(branchId)).length, count);
    const insertCheckpoint = nodes.insertCheckpoint.bind(nodes);
    nodes.insertCheckpoint = async () => { throw new Error('injected checkpoint failure'); };
    await assert.rejects(chain.applyManualEdit({ chatId, branchId, target: 'profile', entityId: 'alice', fieldPath: 'basic.age', value: '22' }), /injected/);
    nodes.insertCheckpoint = insertCheckpoint;
    assert.equal((await nodes.listNodes(branchId)).length, count, 'failed checkpoint rolls back node and delta');
    assert.equal((await chain.current(chatId, branchId)).snapshot.profiles.alice.basic.age, '21');
    const syncStatuses = chain.syncStatuses.bind(chain);
    const headBeforeFailure = await nodes.getBranchHead(branchId);
    chain.syncStatuses = async () => { throw new Error('injected status sync failure'); };
    await assert.rejects(chain.applyManualEdit({ chatId, branchId, target: 'profile', entityId: 'alice', fieldPath: 'basic.age', value: '22' }), /injected/);
    chain.syncStatuses = syncStatuses;
    assert.equal((await nodes.listNodes(branchId)).length, count);
    assert.deepEqual(await nodes.getBranchHead(branchId), headBeforeFailure, 'status failure rolls back new head too');
    await chain.applyManualEdit({ chatId, branchId, target: 'profile', entityId: 'alice', fieldPath: 'basic.age', action: 'lock' });
    await chain.applyManualEdit({ chatId, branchId, target: 'profile', entityId: 'alice', fieldPath: 'basic.age', action: 'restore-ai' });
    const restored = (await chain.current(chatId, branchId)).snapshot.profiles.alice;
    assert.equal(restored.basic.age, '21');
    assert.equal(restored.sourcePriority['basic.age'], undefined);
    assert.deepEqual(restored.lockedPaths, []);
    const beforeRebuild = (await chain.current(chatId, branchId)).node!;
    await chain.commitCandidate({ chatId, branchId, hostChatId: chatId, floorId: second.floorKey, messageIndex: 2, swipeId: 0, bodyFingerprint: fingerprint(second.content), dependencyFingerprint: dependencyFingerprint({ bodyFingerprint: fingerprint(second.content), previousStateFingerprint: beforeRebuild.stateFingerprint, protocolVersion: STATE_PROTOCOL_VERSION, schemaVersion: STATE_SCHEMA_VERSION, promptVersion: 'manual-test' }), candidate: { profiles: { alice: { basic: { age: '20' } } } }, previous: beforeRebuild });
    const converged = await chain.trustedPrefix(chatId, branchId);
    assert.equal(converged.firstInvalidIndex, null);
    assert.equal(converged.head!.stateNodeId, oldThird.node.stateNodeId, 'unchanged downstream state converges to original third node');
    console.log('Manual state edit acceptance passed');
  } finally { await db.close(); await fs.rm(root, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
