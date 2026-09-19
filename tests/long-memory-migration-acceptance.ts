import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureStorageDirectories, resolveStoragePaths } from '../src/storage/data-directory';
import { runMigrations } from '../src/storage/migrations';
import { SqliteDatabase } from '../src/storage/sqlite-database';

const dataRootGlobal = globalThis as typeof globalThis & { DATA_ROOT?: string };

async function main(): Promise<void> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'weavememory-long-memory-migration-'));
  dataRootGlobal.DATA_ROOT = dataRoot;
  try {
    const paths = resolveStoragePaths();
    await ensureStorageDirectories(paths);
    const database = await SqliteDatabase.open(paths.databasePath);
    await runMigrations(database, paths);

    await database.exec('DROP INDEX IF EXISTS uq_long_memory_active_batch_range');
    await database.run('DELETE FROM migrations WHERE version >= 9');
    await database.run('PRAGMA user_version = 8');

    const insertBatch = async (batchId: string, start: number, end: number, createdAt: string, updatedAt: string): Promise<void> => {
      await database.run(`INSERT INTO long_memory_batches(batch_id, chat_id, branch_id, batch_start_floor, batch_end_floor, source_floor_ids, batch_dependency_fingerprint, end_state_node_id, end_state_fingerprint, stale, created_at, updated_at) VALUES (?, 'chat', 'branch', ?, ?, '[]', ?, ?, ?, 0, ?, ?)`, [batchId, start, end, `dep-${batchId}`, `node-${batchId}`, `state-${batchId}`, createdAt, updatedAt]);
      await database.run(`INSERT INTO long_memories(memory_id, chat_id, branch_id, batch_id, slice_id, start_floor, end_floor, batch_start_floor, batch_end_floor, summary, end_state_node_id, end_state_fingerprint, batch_dependency_fingerprint, source_floor_ids, stale, created_at, updated_at) VALUES (?, 'chat', 'branch', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 0, ?, ?)`, [`memory-${batchId}`, batchId, `slice-${batchId}`, start, end, start, end, `summary-${batchId}`, `node-${batchId}`, `state-${batchId}`, `dep-${batchId}`, createdAt, updatedAt]);
    };

    await insertBatch('A', 1, 30, '2026-01-01T10:00:00.000Z', '2026-01-01T10:00:00.000Z');
    await insertBatch('B', 1, 30, '2026-01-01T10:05:00.000Z', '2026-01-01T10:05:00.000Z');
    await insertBatch('C', 1, 30, '2026-01-01T10:10:00.000Z', '2026-01-01T10:10:00.000Z');
    await insertBatch('TIE-A', 31, 60, '2026-01-01T11:00:00.000Z', '2026-01-01T11:00:00.000Z');
    await insertBatch('TIE-B', 31, 60, '2026-01-01T11:00:00.000Z', '2026-01-01T11:00:00.000Z');

    await runMigrations(database, paths);

    const batches = await database.all<{ batch_id: string; stale: number }>('SELECT batch_id, stale FROM long_memory_batches ORDER BY rowid');
    const stale = new Map(batches.map(item => [item.batch_id, item.stale]));
    assert.equal(stale.get('A'), 1);
    assert.equal(stale.get('B'), 1);
    assert.equal(stale.get('C'), 0);
    assert.equal(batches.filter(item => item.batch_id.startsWith('TIE-') && item.stale === 0).length, 1);

    const slices = await database.all<{ batch_id: string; stale: number }>('SELECT batch_id, stale FROM long_memories');
    const sliceStale = new Map(slices.map(item => [item.batch_id, item.stale]));
    assert.equal(sliceStale.get('A'), 1);
    assert.equal(sliceStale.get('B'), 1);
    assert.equal(sliceStale.get('C'), 0);
    assert.equal(slices.filter(item => item.batch_id.startsWith('TIE-') && item.stale === 0).length, 1);

    const activeCount = await database.get<{ count: number }>(`SELECT COUNT(*) AS count FROM long_memory_batches WHERE chat_id = 'chat' AND branch_id = 'branch' AND batch_start_floor = 1 AND batch_end_floor = 30 AND stale = 0`);
    assert.equal(activeCount?.count, 1);
    await assert.rejects(database.run(`INSERT INTO long_memory_batches(batch_id, chat_id, branch_id, batch_start_floor, batch_end_floor, source_floor_ids, batch_dependency_fingerprint, end_state_node_id, end_state_fingerprint, stale, created_at, updated_at) VALUES ('ACTIVE-DUP', 'chat', 'branch', 1, 30, '[]', 'dep', 'node', 'state', 0, '2026-01-01', '2026-01-01')`));
    await database.run(`INSERT INTO long_memory_batches(batch_id, chat_id, branch_id, batch_start_floor, batch_end_floor, source_floor_ids, batch_dependency_fingerprint, end_state_node_id, end_state_fingerprint, stale, created_at, updated_at) VALUES ('STALE-HISTORY', 'chat', 'branch', 1, 30, '[]', 'dep', 'node', 'state', 1, '2026-01-01', '2026-01-01')`);

    const version = await database.get<{ user_version: number }>('PRAGMA user_version');
    assert.equal(version?.user_version, 10);
    await database.close();
    console.log('long memory migration acceptance passed');
  } finally {
    delete dataRootGlobal.DATA_ROOT;
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
