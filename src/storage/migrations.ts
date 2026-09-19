import fs from 'node:fs/promises';
import path from 'node:path';
import type { StoragePaths } from './data-directory';
import { SqliteDatabase } from './sqlite-database';

type Migration = { version: number; name: string; sql: string };

export const migrations: Migration[] = [{
  version: 1,
  name: 'initial-schema',
  sql: `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  chat_id TEXT PRIMARY KEY,
  active_branch_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS branches (
  branch_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  parent_branch_id TEXT,
  fork_floor_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  FOREIGN KEY (chat_id) REFERENCES chats(chat_id)
);

CREATE TABLE IF NOT EXISTS floor_variants (
  floor_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  message_index INTEGER NOT NULL,
  swipe_id INTEGER,
  body_fingerprint TEXT NOT NULL,
  content TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_floor_variants_chat_index
  ON floor_variants(chat_id, message_index);
CREATE INDEX IF NOT EXISTS idx_floor_variants_chat_swipe
  ON floor_variants(chat_id, message_index, swipe_id);
CREATE INDEX IF NOT EXISTS idx_floor_variants_fingerprint
  ON floor_variants(body_fingerprint);

CREATE TABLE IF NOT EXISTS state_nodes (
  state_node_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  floor_id TEXT NOT NULL,
  message_index INTEGER NOT NULL,
  swipe_id INTEGER,
  body_fingerprint TEXT NOT NULL,
  previous_state_node_id TEXT,
  previous_state_fingerprint TEXT,
  dependency_fingerprint TEXT NOT NULL,
  delta_id TEXT,
  checkpoint_id TEXT,
  status TEXT NOT NULL,
  state_fingerprint TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS state_deltas (
  delta_id TEXT PRIMARY KEY,
  state_node_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  state_node_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  snapshot_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS characters (
  character_id TEXT PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  aliases_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  character_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (character_id) REFERENCES characters(character_id)
);

CREATE TABLE IF NOT EXISTS traces (
  character_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (character_id) REFERENCES characters(character_id)
);

CREATE TABLE IF NOT EXISTS story_state (
  chat_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS long_memories (
  memory_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  slice_id TEXT NOT NULL,
  start_floor INTEGER NOT NULL,
  end_floor INTEGER NOT NULL,
  title TEXT,
  summary TEXT NOT NULL,
  narrative_time TEXT,
  end_state_node_id TEXT NOT NULL,
  end_state_fingerprint TEXT NOT NULL,
  bm25_indexed INTEGER NOT NULL DEFAULT 0,
  embedding_indexed INTEGER NOT NULL DEFAULT 0,
  stale INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_tags (
  memory_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (memory_id, tag),
  FOREIGN KEY (memory_id) REFERENCES long_memories(memory_id)
);

CREATE TABLE IF NOT EXISTS memory_characters (
  memory_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  PRIMARY KEY (memory_id, character_id),
  FOREIGN KEY (memory_id) REFERENCES long_memories(memory_id)
);

CREATE TABLE IF NOT EXISTS memory_plotlines (
  memory_id TEXT NOT NULL,
  plotline_id TEXT NOT NULL,
  PRIMARY KEY (memory_id, plotline_id),
  FOREIGN KEY (memory_id) REFERENCES long_memories(memory_id)
);

CREATE TABLE IF NOT EXISTS embedding_refs (
  memory_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  vector_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`
}, {
  version: 2,
  name: 'active-floor-set',
  sql: `
CREATE TABLE IF NOT EXISTS chat_active_floors (
  chat_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  message_index INTEGER NOT NULL,
  floor_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (chat_id, branch_id, message_index),
  FOREIGN KEY (floor_id) REFERENCES floor_variants(floor_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_active_floors_floor
  ON chat_active_floors(floor_id);
`
}, {
  version: 3,
  name: 'host-chat-branch-bindings',
  sql: `
CREATE TABLE IF NOT EXISTS host_chat_bindings (
  host_chat_id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL,
  parent_host_chat_id TEXT,
  main_chat_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (branch_id) REFERENCES branches(branch_id)
);

CREATE INDEX IF NOT EXISTS idx_host_chat_bindings_branch
  ON host_chat_bindings(branch_id);
`
}, {
  version: 4,
  name: 'ai-config-and-state-tasks',
  sql: `
CREATE TABLE IF NOT EXISTS ai_channels (
  channel_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  api_type TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key_encrypted TEXT,
  timeout INTEGER,
  headers_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_model_bindings (
  role TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  model TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (channel_id) REFERENCES ai_channels(channel_id)
);

CREATE TABLE IF NOT EXISTS prompt_presets (
  preset_id TEXT PRIMARY KEY,
  prompt_type TEXT NOT NULL,
  name TEXT NOT NULL,
  content_json TEXT NOT NULL,
  version INTEGER NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_prompt_presets_type
  ON prompt_presets(prompt_type);

ALTER TABLE jobs ADD COLUMN branch_id TEXT;
ALTER TABLE jobs ADD COLUMN floor_id TEXT;
ALTER TABLE jobs ADD COLUMN message_index INTEGER;
ALTER TABLE jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN result_json TEXT;
ALTER TABLE jobs ADD COLUMN error_code TEXT;
ALTER TABLE jobs ADD COLUMN error_message TEXT;
ALTER TABLE jobs ADD COLUMN started_at TEXT;
ALTER TABLE jobs ADD COLUMN finished_at TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_chat_kind_status
  ON jobs(chat_id, kind, status);
CREATE INDEX IF NOT EXISTS idx_jobs_floor
  ON jobs(floor_id);
`
}, {
  version: 5,
  name: 'state-chain-heads-and-indexes',
  sql: `
CREATE TABLE IF NOT EXISTS branch_state_heads (
  branch_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  state_node_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  snapshot_fingerprint TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_state_nodes_branch_index
  ON state_nodes(branch_id, message_index);
CREATE INDEX IF NOT EXISTS idx_state_nodes_floor
  ON state_nodes(floor_id);
CREATE INDEX IF NOT EXISTS idx_state_deltas_node
  ON state_deltas(state_node_id);
CREATE INDEX IF NOT EXISTS idx_checkpoints_branch
  ON checkpoints(branch_id, created_at);
`
}, {
  version: 6,
  name: 'dependency-lookups-for-rebuild',
  sql: `
ALTER TABLE jobs ADD COLUMN dependency_fingerprint TEXT;
UPDATE jobs SET dependency_fingerprint = json_extract(payload_json, '$.dependencyFingerprint') WHERE dependency_fingerprint IS NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_branch_dependency
  ON jobs(branch_id, dependency_fingerprint);
CREATE INDEX IF NOT EXISTS idx_state_nodes_branch_dependency
  ON state_nodes(branch_id, dependency_fingerprint);
`
}, {
  version: 7,
  name: 'long-memory-source-dependencies',
  sql: `
ALTER TABLE long_memories ADD COLUMN batch_dependency_fingerprint TEXT NOT NULL DEFAULT '';
ALTER TABLE long_memories ADD COLUMN source_floor_ids TEXT NOT NULL DEFAULT '[]';
`
}, {
  version: 8,
  name: 'long-memory-batches',
  sql: `
CREATE TABLE IF NOT EXISTS long_memory_batches (
  batch_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  batch_start_floor INTEGER NOT NULL,
  batch_end_floor INTEGER NOT NULL,
  source_floor_ids TEXT NOT NULL,
  batch_dependency_fingerprint TEXT NOT NULL,
  end_state_node_id TEXT NOT NULL,
  end_state_fingerprint TEXT NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_long_memory_batches_scope
  ON long_memory_batches(chat_id, branch_id, batch_start_floor, stale);
ALTER TABLE long_memories ADD COLUMN batch_start_floor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE long_memories ADD COLUMN batch_end_floor INTEGER NOT NULL DEFAULT 0;
UPDATE long_memories SET stale = 1 WHERE batch_start_floor = 0 OR batch_end_floor = 0;
`
}, {
  version: 9,
  name: 'unique-active-long-memory-batch-range',
  sql: `
UPDATE long_memory_batches
SET stale = 1
WHERE long_memory_batches.stale = 0
  AND EXISTS (
    SELECT 1
    FROM long_memory_batches newer
    WHERE newer.stale = 0
      AND newer.chat_id = long_memory_batches.chat_id
      AND newer.branch_id = long_memory_batches.branch_id
      AND newer.batch_start_floor = long_memory_batches.batch_start_floor
      AND newer.batch_end_floor = long_memory_batches.batch_end_floor
      AND newer.batch_id != long_memory_batches.batch_id
      AND (
        newer.updated_at > long_memory_batches.updated_at
        OR (newer.updated_at = long_memory_batches.updated_at AND newer.created_at > long_memory_batches.created_at)
        OR (newer.updated_at = long_memory_batches.updated_at AND newer.created_at = long_memory_batches.created_at AND newer.rowid > long_memory_batches.rowid)
      )
  );
UPDATE long_memories
SET stale = 1
WHERE batch_id IN (SELECT batch_id FROM long_memory_batches WHERE stale = 1);
CREATE UNIQUE INDEX IF NOT EXISTS uq_long_memory_active_batch_range
  ON long_memory_batches(chat_id, branch_id, batch_start_floor, batch_end_floor)
  WHERE stale = 0;
`
}, {
  version: 10,
  name: 'repair-active-long-memory-batch-survivor',
  sql: `
DROP INDEX IF EXISTS uq_long_memory_active_batch_range;
UPDATE long_memory_batches SET stale = 1;
UPDATE long_memory_batches
SET stale = 0
WHERE NOT EXISTS (
  SELECT 1
  FROM long_memory_batches newer
  WHERE newer.chat_id = long_memory_batches.chat_id
    AND newer.branch_id = long_memory_batches.branch_id
    AND newer.batch_start_floor = long_memory_batches.batch_start_floor
    AND newer.batch_end_floor = long_memory_batches.batch_end_floor
    AND newer.batch_id != long_memory_batches.batch_id
    AND (
      newer.updated_at > long_memory_batches.updated_at
      OR (newer.updated_at = long_memory_batches.updated_at AND newer.created_at > long_memory_batches.created_at)
      OR (newer.updated_at = long_memory_batches.updated_at AND newer.created_at = long_memory_batches.created_at AND newer.rowid > long_memory_batches.rowid)
    )
);
UPDATE long_memories
SET stale = CASE
  WHEN batch_id IN (SELECT batch_id FROM long_memory_batches WHERE stale = 0) THEN 0
  ELSE 1
END;
CREATE UNIQUE INDEX IF NOT EXISTS uq_long_memory_active_batch_range
  ON long_memory_batches(chat_id, branch_id, batch_start_floor, batch_end_floor)
  WHERE stale = 0;
`
}, {
  version: 11,
  name: 'repair-long-memory-active-state-safely',
  sql: `
UPDATE long_memory_batches SET stale = 1;
UPDATE long_memories SET stale = 1;
CREATE UNIQUE INDEX IF NOT EXISTS uq_long_memory_active_batch_range
  ON long_memory_batches(chat_id, branch_id, batch_start_floor, batch_end_floor)
  WHERE stale = 0;
`
}];

export async function runMigrations(database: SqliteDatabase, paths: StoragePaths): Promise<void> {
  const current = await database.get<{ user_version: number }>('PRAGMA user_version');
  const currentVersion = Number(current?.user_version ?? 0);
  const latestVersion = migrations.at(-1)?.version ?? 0;
  if (currentVersion > latestVersion) {
    throw new Error(`Database schema ${currentVersion} is newer than supported schema ${latestVersion}`);
  }
  if (currentVersion === latestVersion) return;

  await createBackup(database, paths, currentVersion);
  await database.transaction(async () => {
    for (const migration of migrations.filter(item => item.version > currentVersion)) {
      await database.exec(migration.sql);
      await database.run(
        'INSERT INTO migrations(version, name, applied_at) VALUES (?, ?, ?)',
        [migration.version, migration.name, new Date().toISOString()]
      );
      await database.run('PRAGMA user_version = ' + migration.version);
    }
    await database.run(
      `INSERT INTO meta(key, value) VALUES ('schemaVersion', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [String(latestVersion)]
    );
  });
}

export async function createDailyBackup(database: SqliteDatabase, paths: StoragePaths): Promise<void> {
  await database.checkpoint();
  try {
    const stat = await fs.stat(paths.databasePath);
    if (!stat.isFile() || stat.size === 0) return;
  } catch {
    return;
  }

  const day = new Date().toISOString().slice(0, 10);
  const backupPath = path.join(paths.backupDirectory, `weavememory-daily-${day}.sqlite`);
  try {
    await fs.stat(backupPath);
    return;
  } catch {
    await fs.copyFile(paths.databasePath, backupPath);
  }
  await pruneBackups(paths);
}

async function createBackup(database: SqliteDatabase, paths: StoragePaths, currentVersion: number): Promise<void> {
  await database.checkpoint();
  try {
    const stat = await fs.stat(paths.databasePath);
    if (!stat.isFile() || stat.size === 0) return;
  } catch {
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(paths.backupDirectory, `weavememory-schema-${currentVersion}-${stamp}.sqlite`);
  await fs.copyFile(paths.databasePath, backupPath);

  await pruneBackups(paths);
}

async function pruneBackups(paths: StoragePaths): Promise<void> {
  const backups = (await fs.readdir(paths.backupDirectory))
    .filter(name => name.endsWith('.sqlite'))
    .sort()
    .reverse();
  for (const oldBackup of backups.slice(5)) {
    await fs.unlink(path.join(paths.backupDirectory, oldBackup));
  }
}
