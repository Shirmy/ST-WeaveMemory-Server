import { randomUUID } from 'node:crypto';
import type { JsonPatchLikeChange } from '../state/diff';
import type { StateSnapshot } from '../state/schema';
import type { SqliteDatabase } from './sqlite-database';
import type { FloorRecord } from './types';

export type StateNodeStatus = 'pending' | 'synced' | 'failed' | 'stale' | 'inactive';

/** Roadmap §12 StateNode. */
export type StateNodeRecord = {
  stateNodeId: string;
  chatId: string;
  branchId: string;
  floorId: string;
  messageIndex: number;
  swipeId: number | null;
  bodyFingerprint: string;
  previousStateNodeId: string | null;
  previousStateFingerprint: string | null;
  dependencyFingerprint: string;
  deltaId: string | null;
  checkpointId: string | null;
  status: StateNodeStatus;
  stateFingerprint: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Roadmap §11 StateDelta, extended with `rootChanges` for snapshot-level fields such as updatedAt. */
export type StateDeltaRecord = {
  deltaId: string;
  stateNodeId: string;
  floorId: string;
  previousStateNodeId: string | null;
  profileChanges: JsonPatchLikeChange[];
  traceChanges: JsonPatchLikeChange[];
  storyChanges: JsonPatchLikeChange[];
  rootChanges: JsonPatchLikeChange[];
  createdAt: string;
};

/** Roadmap §14 Checkpoint. */
export type CheckpointRecord = {
  checkpointId: string;
  chatId: string;
  branchId: string;
  stateNodeId: string;
  snapshot: StateSnapshot;
  snapshotFingerprint: string;
  createdAt: string;
};

/** Cached snapshot of the most recently committed node of a branch (roadmap §15 currentSnapshot). */
export type BranchHeadRecord = {
  branchId: string;
  chatId: string;
  stateNodeId: string;
  snapshot: StateSnapshot;
  snapshotFingerprint: string;
  updatedAt: string;
};

export type ActiveFloorRef = {
  messageIndex: number;
  floorId: string;
  swipeId: number | null;
  bodyFingerprint: string;
  status: FloorRecord['status'];
};

type NodeRow = {
  state_node_id: string;
  chat_id: string;
  branch_id: string;
  floor_id: string;
  message_index: number;
  swipe_id: number | null;
  body_fingerprint: string;
  previous_state_node_id: string | null;
  previous_state_fingerprint: string | null;
  dependency_fingerprint: string;
  delta_id: string | null;
  checkpoint_id: string | null;
  status: string;
  state_fingerprint: string | null;
  created_at: string;
  updated_at: string;
};

type DeltaRow = { delta_id: string; state_node_id: string; payload_json: string; created_at: string };
type CheckpointRow = { checkpoint_id: string; chat_id: string; branch_id: string; state_node_id: string; snapshot_json: string; snapshot_fingerprint: string; created_at: string };
type HeadRow = { branch_id: string; chat_id: string; state_node_id: string; snapshot_json: string; snapshot_fingerprint: string; updated_at: string };

const NODE_COLUMNS = `state_node_id, chat_id, branch_id, floor_id, message_index, swipe_id, body_fingerprint, previous_state_node_id,
  previous_state_fingerprint, dependency_fingerprint, delta_id, checkpoint_id, status, state_fingerprint, created_at, updated_at`;

function toNode(row: NodeRow): StateNodeRecord {
  return {
    stateNodeId: row.state_node_id,
    chatId: row.chat_id,
    branchId: row.branch_id,
    floorId: row.floor_id,
    messageIndex: row.message_index,
    swipeId: row.swipe_id,
    bodyFingerprint: row.body_fingerprint,
    previousStateNodeId: row.previous_state_node_id,
    previousStateFingerprint: row.previous_state_fingerprint,
    dependencyFingerprint: row.dependency_fingerprint,
    deltaId: row.delta_id,
    checkpointId: row.checkpoint_id,
    status: row.status as StateNodeStatus,
    stateFingerprint: row.state_fingerprint,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toDelta(row: DeltaRow): StateDeltaRecord {
  const payload = JSON.parse(row.payload_json) as Omit<StateDeltaRecord, 'deltaId' | 'stateNodeId' | 'createdAt'>;
  return {
    deltaId: row.delta_id,
    stateNodeId: row.state_node_id,
    floorId: payload.floorId,
    previousStateNodeId: payload.previousStateNodeId ?? null,
    profileChanges: payload.profileChanges ?? [],
    traceChanges: payload.traceChanges ?? [],
    storyChanges: payload.storyChanges ?? [],
    rootChanges: payload.rootChanges ?? [],
    createdAt: row.created_at
  };
}

function toCheckpoint(row: CheckpointRow): CheckpointRecord {
  return {
    checkpointId: row.checkpoint_id,
    chatId: row.chat_id,
    branchId: row.branch_id,
    stateNodeId: row.state_node_id,
    snapshot: JSON.parse(row.snapshot_json) as StateSnapshot,
    snapshotFingerprint: row.snapshot_fingerprint,
    createdAt: row.created_at
  };
}

export function newStateNodeId(): string {
  return `node_${randomUUID()}`;
}

export function newDeltaId(): string {
  return `delta_${randomUUID()}`;
}

export function newCheckpointId(): string {
  return `ckpt_${randomUUID()}`;
}

/**
 * Persistence for state nodes, deltas, checkpoints and per-branch head caches. Methods run single
 * statements; callers compose them inside `SqliteDatabase.transaction` when atomicity matters.
 */
export class StateChainStore {
  constructor(private readonly database: SqliteDatabase) {}

  async listActiveFloors(chatId: string, branchId: string): Promise<ActiveFloorRef[]> {
    const rows = await this.database.all<{ message_index: number; floor_id: string; swipe_id: number | null; body_fingerprint: string; status: FloorRecord['status'] }>(
      `SELECT active.message_index, active.floor_id, floors.swipe_id, floors.body_fingerprint, floors.status
       FROM chat_active_floors AS active
       JOIN floor_variants AS floors ON floors.floor_id = active.floor_id
       WHERE active.chat_id = ? AND active.branch_id = ?
       ORDER BY active.message_index ASC`,
      [chatId, branchId]
    );
    return rows.map(row => ({ messageIndex: row.message_index, floorId: row.floor_id, swipeId: row.swipe_id, bodyFingerprint: row.body_fingerprint, status: row.status }));
  }

  async countNodes(branchId: string): Promise<number> {
    const row = await this.database.get<{ count: number }>('SELECT COUNT(*) AS count FROM state_nodes WHERE branch_id = ?', [branchId]);
    return Number(row?.count ?? 0);
  }

  /** Floor variants at a host locator (null and 0 swipe ids are the same locator), active ones first. */
  async findFloorIds(chatId: string, branchId: string, messageIndex: number, swipeId: number | null): Promise<string[]> {
    const rows = await this.database.all<{ floor_id: string }>(
      `SELECT floor_id FROM floor_variants
       WHERE chat_id = ? AND branch_id = ? AND message_index = ? AND COALESCE(swipe_id, 0) = ?
       ORDER BY active DESC, updated_at DESC`,
      [chatId, branchId, messageIndex, swipeId ?? 0]
    );
    return rows.map(row => row.floor_id);
  }

  async listNodes(branchId: string): Promise<StateNodeRecord[]> {
    const rows = await this.database.all<NodeRow>(
      `SELECT ${NODE_COLUMNS} FROM state_nodes WHERE branch_id = ? ORDER BY message_index ASC, created_at ASC`,
      [branchId]
    );
    return rows.map(toNode);
  }

  async getNode(stateNodeId: string): Promise<StateNodeRecord | null> {
    const row = await this.database.get<NodeRow>(`SELECT ${NODE_COLUMNS} FROM state_nodes WHERE state_node_id = ?`, [stateNodeId]);
    return row ? toNode(row) : null;
  }

  async listNodesForFloor(floorId: string): Promise<StateNodeRecord[]> {
    const rows = await this.database.all<NodeRow>(
      `SELECT ${NODE_COLUMNS} FROM state_nodes WHERE floor_id = ? ORDER BY created_at DESC`,
      [floorId]
    );
    return rows.map(toNode);
  }

  async insertNode(record: StateNodeRecord): Promise<void> {
    await this.database.run(
      `INSERT INTO state_nodes(${NODE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.stateNodeId, record.chatId, record.branchId, record.floorId, record.messageIndex, record.swipeId,
        record.bodyFingerprint, record.previousStateNodeId, record.previousStateFingerprint, record.dependencyFingerprint,
        record.deltaId, record.checkpointId, record.status, record.stateFingerprint, record.createdAt, record.updatedAt
      ]
    );
  }

  async setNodeCheckpoint(stateNodeId: string, checkpointId: string, updatedAt: string): Promise<void> {
    await this.database.run('UPDATE state_nodes SET checkpoint_id = ?, updated_at = ? WHERE state_node_id = ?', [checkpointId, updatedAt, stateNodeId]);
  }

  async updateNodeStatus(stateNodeId: string, status: StateNodeStatus, updatedAt: string): Promise<void> {
    await this.database.run('UPDATE state_nodes SET status = ?, updated_at = ? WHERE state_node_id = ?', [status, updatedAt, stateNodeId]);
  }

  async insertDelta(record: StateDeltaRecord): Promise<void> {
    const payload = {
      floorId: record.floorId,
      previousStateNodeId: record.previousStateNodeId,
      profileChanges: record.profileChanges,
      traceChanges: record.traceChanges,
      storyChanges: record.storyChanges,
      rootChanges: record.rootChanges
    };
    await this.database.run(
      'INSERT INTO state_deltas(delta_id, state_node_id, payload_json, created_at) VALUES (?, ?, ?, ?)',
      [record.deltaId, record.stateNodeId, JSON.stringify(payload), record.createdAt]
    );
  }

  async getDelta(deltaId: string): Promise<StateDeltaRecord | null> {
    const row = await this.database.get<DeltaRow>('SELECT delta_id, state_node_id, payload_json, created_at FROM state_deltas WHERE delta_id = ?', [deltaId]);
    return row ? toDelta(row) : null;
  }

  async getDeltasByNodeIds(stateNodeIds: string[]): Promise<Map<string, StateDeltaRecord>> {
    const result = new Map<string, StateDeltaRecord>();
    for (let offset = 0; offset < stateNodeIds.length; offset += 200) {
      const chunk = stateNodeIds.slice(offset, offset + 200);
      const rows = await this.database.all<DeltaRow>(
        `SELECT delta_id, state_node_id, payload_json, created_at FROM state_deltas WHERE state_node_id IN (${chunk.map(() => '?').join(', ')})`,
        chunk
      );
      for (const row of rows) result.set(row.state_node_id, toDelta(row));
    }
    return result;
  }

  async insertCheckpoint(record: CheckpointRecord): Promise<void> {
    await this.database.run(
      `INSERT INTO checkpoints(checkpoint_id, chat_id, branch_id, state_node_id, snapshot_json, snapshot_fingerprint, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [record.checkpointId, record.chatId, record.branchId, record.stateNodeId, JSON.stringify(record.snapshot), record.snapshotFingerprint, record.createdAt]
    );
  }

  async getCheckpoint(checkpointId: string): Promise<CheckpointRecord | null> {
    const row = await this.database.get<CheckpointRow>(
      'SELECT checkpoint_id, chat_id, branch_id, state_node_id, snapshot_json, snapshot_fingerprint, created_at FROM checkpoints WHERE checkpoint_id = ?',
      [checkpointId]
    );
    return row ? toCheckpoint(row) : null;
  }

  async countCheckpoints(branchId: string): Promise<number> {
    const row = await this.database.get<{ count: number }>('SELECT COUNT(*) AS count FROM checkpoints WHERE branch_id = ?', [branchId]);
    return Number(row?.count ?? 0);
  }

  async upsertBranchHead(record: BranchHeadRecord): Promise<void> {
    await this.database.run(
      `INSERT INTO branch_state_heads(branch_id, chat_id, state_node_id, snapshot_json, snapshot_fingerprint, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(branch_id) DO UPDATE SET chat_id = excluded.chat_id, state_node_id = excluded.state_node_id,
         snapshot_json = excluded.snapshot_json, snapshot_fingerprint = excluded.snapshot_fingerprint, updated_at = excluded.updated_at`,
      [record.branchId, record.chatId, record.stateNodeId, JSON.stringify(record.snapshot), record.snapshotFingerprint, record.updatedAt]
    );
  }

  async getBranchHead(branchId: string): Promise<BranchHeadRecord | null> {
    const row = await this.database.get<HeadRow>(
      'SELECT branch_id, chat_id, state_node_id, snapshot_json, snapshot_fingerprint, updated_at FROM branch_state_heads WHERE branch_id = ?',
      [branchId]
    );
    if (!row) return null;
    return {
      branchId: row.branch_id,
      chatId: row.chat_id,
      stateNodeId: row.state_node_id,
      snapshot: JSON.parse(row.snapshot_json) as StateSnapshot,
      snapshotFingerprint: row.snapshot_fingerprint,
      updatedAt: row.updated_at
    };
  }
}
