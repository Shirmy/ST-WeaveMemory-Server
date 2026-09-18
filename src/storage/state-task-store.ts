import { randomUUID } from 'node:crypto';
import type { StateAnalysisCandidate } from '../state/schema';
import type { SqliteDatabase } from './sqlite-database';

export const STATE_TASK_KIND = 'state-analysis';

export const STATE_TASK_STATUSES = ['pending', 'running', 'succeeded', 'failed', 'cancelled', 'stale'] as const;
export type StateTaskStatus = (typeof STATE_TASK_STATUSES)[number];

export function isStateTaskStatus(value: unknown): value is StateTaskStatus {
  return typeof value === 'string' && (STATE_TASK_STATUSES as readonly string[]).includes(value);
}

export type StateTaskPayload = {
  swipeId: number | null;
  bodyFingerprint: string;
  dependencyFingerprint: string | null;
  statePromptVersion: string | null;
  previousStateFingerprint: string | null;
  protocolVersion: number;
  schemaVersion: number;
  reason: string;
  /** Set when the job reapplies an earlier candidate instead of calling the model (§21 reuse). */
  reuseFromJobId?: string | null;
};

export type StateTaskDiagnostics = {
  attempts: number;
  durationMs: number;
  channelId: string;
  model: string;
  servedModel: string | null;
  finishReason: string | null;
  promptVersion: string;
  usage: { promptTokens: number | null; completionTokens: number | null } | null;
  rawTextSnippet: string;
  /** Phase 5: the state node produced from this candidate (null when no chain engine is attached). */
  stateNodeId: string | null;
  stateFingerprint: string | null;
  checkpointId: string | null;
  reusedFromJobId: string | null;
};

export type StateTaskResult = {
  candidate: StateAnalysisCandidate;
  diagnostics: StateTaskDiagnostics;
};

export type StateTaskRecord = {
  jobId: string;
  chatId: string;
  branchId: string;
  floorId: string;
  messageIndex: number;
  status: StateTaskStatus;
  attempts: number;
  payload: StateTaskPayload;
  result: StateTaskResult | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type StateTaskFilter = {
  chatId: string;
  branchId?: string;
  floorId?: string;
  status?: StateTaskStatus;
  limit?: number;
};

export type StateTaskPatch = Partial<Pick<StateTaskRecord, 'status' | 'attempts' | 'payload' | 'result' | 'errorCode' | 'errorMessage' | 'startedAt' | 'finishedAt'>>;

export type CreateStateTaskInput = {
  chatId: string;
  branchId: string;
  floorId: string;
  messageIndex: number;
  payload: StateTaskPayload;
  status?: StateTaskStatus;
};

type JobRow = {
  job_id: string;
  chat_id: string;
  kind: string;
  status: string;
  payload_json: string;
  created_at: string;
  updated_at: string;
  branch_id: string | null;
  floor_id: string | null;
  message_index: number | null;
  attempts: number;
  result_json: string | null;
  error_code: string | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
};

const ACTIVE_STATUSES: StateTaskStatus[] = ['pending', 'running'];
const SELECT_COLUMNS = `job_id, chat_id, kind, status, payload_json, created_at, updated_at, branch_id, floor_id,
  message_index, attempts, result_json, error_code, error_message, started_at, finished_at`;

function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function toRecord(row: JobRow): StateTaskRecord {
  const fallbackPayload: StateTaskPayload = {
    swipeId: null,
    bodyFingerprint: '',
    dependencyFingerprint: null,
    statePromptVersion: null,
    previousStateFingerprint: null,
    protocolVersion: 0,
    schemaVersion: 0,
    reason: 'unknown'
  };
  return {
    jobId: row.job_id,
    chatId: row.chat_id,
    branchId: row.branch_id ?? '',
    floorId: row.floor_id ?? '',
    messageIndex: row.message_index ?? -1,
    status: isStateTaskStatus(row.status) ? row.status : 'failed',
    attempts: row.attempts,
    payload: parseJson<StateTaskPayload>(row.payload_json, fallbackPayload),
    result: parseJson<StateTaskResult | null>(row.result_json, null),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at
  };
}

/** Persistence for state-analysis jobs, stored in the generic `jobs` table. */
export class StateTaskStore {
  constructor(private readonly database: SqliteDatabase) {}

  async createJob(input: CreateStateTaskInput): Promise<StateTaskRecord> {
    const jobId = `job_${randomUUID()}`;
    const now = new Date().toISOString();
    await this.database.run(
      `INSERT INTO jobs(job_id, chat_id, kind, status, payload_json, created_at, updated_at, branch_id, floor_id, message_index, attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [jobId, input.chatId, STATE_TASK_KIND, input.status ?? 'pending', JSON.stringify(input.payload), now, now, input.branchId, input.floorId, input.messageIndex]
    );
    const created = await this.getJob(jobId);
    if (!created) throw new Error('state task could not be created');
    return created;
  }

  async getJob(jobId: string): Promise<StateTaskRecord | null> {
    const row = await this.database.get<JobRow>(`SELECT ${SELECT_COLUMNS} FROM jobs WHERE job_id = ? AND kind = ?`, [jobId, STATE_TASK_KIND]);
    return row ? toRecord(row) : null;
  }

  async listJobs(filter: StateTaskFilter): Promise<StateTaskRecord[]> {
    const clauses = ['chat_id = ?', 'kind = ?'];
    const params: unknown[] = [filter.chatId, STATE_TASK_KIND];
    if (filter.branchId) {
      clauses.push('branch_id = ?');
      params.push(filter.branchId);
    }
    if (filter.floorId) {
      clauses.push('floor_id = ?');
      params.push(filter.floorId);
    }
    if (filter.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    const limit = Math.min(Math.max(Math.floor(filter.limit ?? 200), 1), 1000);
    const rows = await this.database.all<JobRow>(
      `SELECT ${SELECT_COLUMNS} FROM jobs WHERE ${clauses.join(' AND ')} ORDER BY message_index ASC, created_at ASC LIMIT ?`,
      [...params, limit]
    );
    return rows.map(toRecord);
  }

  async findActiveJobForFloor(floorId: string): Promise<StateTaskRecord | null> {
    const row = await this.database.get<JobRow>(
      `SELECT ${SELECT_COLUMNS} FROM jobs WHERE floor_id = ? AND kind = ? AND status IN ('pending', 'running') ORDER BY created_at ASC LIMIT 1`,
      [floorId, STATE_TASK_KIND]
    );
    return row ? toRecord(row) : null;
  }

  async findSucceededJobs(floorId: string): Promise<StateTaskRecord[]> {
    const rows = await this.database.all<JobRow>(
      `SELECT ${SELECT_COLUMNS} FROM jobs WHERE floor_id = ? AND kind = ? AND status = 'succeeded' ORDER BY finished_at DESC, created_at DESC`,
      [floorId, STATE_TASK_KIND]
    );
    return rows.map(toRecord);
  }

  async nextPendingJob(chatId: string): Promise<StateTaskRecord | null> {
    const row = await this.database.get<JobRow>(
      `SELECT ${SELECT_COLUMNS} FROM jobs WHERE chat_id = ? AND kind = ? AND status = 'pending' ORDER BY message_index ASC, created_at ASC LIMIT 1`,
      [chatId, STATE_TASK_KIND]
    );
    return row ? toRecord(row) : null;
  }

  async updateJob(jobId: string, patch: StateTaskPatch): Promise<StateTaskRecord | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const assign = (column: string, value: unknown): void => {
      sets.push(`${column} = ?`);
      params.push(value);
    };
    if (patch.status !== undefined) assign('status', patch.status);
    if (patch.attempts !== undefined) assign('attempts', patch.attempts);
    if (patch.payload !== undefined) assign('payload_json', JSON.stringify(patch.payload));
    if (patch.result !== undefined) assign('result_json', patch.result === null ? null : JSON.stringify(patch.result));
    if (patch.errorCode !== undefined) assign('error_code', patch.errorCode);
    if (patch.errorMessage !== undefined) assign('error_message', patch.errorMessage);
    if (patch.startedAt !== undefined) assign('started_at', patch.startedAt);
    if (patch.finishedAt !== undefined) assign('finished_at', patch.finishedAt);
    assign('updated_at', new Date().toISOString());
    await this.database.run(`UPDATE jobs SET ${sets.join(', ')} WHERE job_id = ? AND kind = ?`, [...params, jobId, STATE_TASK_KIND]);
    return this.getJob(jobId);
  }

  /** Marks pending/running jobs of the given floors as cancelled and returns them (pre-update state). */
  async cancelActiveJobs(floorIds: string[], reason: string): Promise<StateTaskRecord[]> {
    const unique = [...new Set(floorIds)].filter(Boolean);
    if (!unique.length) return [];
    const placeholders = unique.map(() => '?').join(', ');
    const rows = await this.database.all<JobRow>(
      `SELECT ${SELECT_COLUMNS} FROM jobs WHERE kind = ? AND status IN ('pending', 'running') AND floor_id IN (${placeholders})`,
      [STATE_TASK_KIND, ...unique]
    );
    const now = new Date().toISOString();
    for (const row of rows) {
      await this.database.run(
        `UPDATE jobs SET status = 'cancelled', error_code = 'WM_TASK_CANCELLED', error_message = ?, finished_at = ?, updated_at = ? WHERE job_id = ?`,
        [reason, now, now, row.job_id]
      );
    }
    return rows.map(toRecord);
  }

  /** Returns interrupted (running) jobs to pending after a restart and reports the affected chats. */
  async resetRunningJobs(): Promise<string[]> {
    const rows = await this.database.all<{ chat_id: string }>(
      `SELECT DISTINCT chat_id FROM jobs WHERE kind = ? AND status = 'running'`,
      [STATE_TASK_KIND]
    );
    if (rows.length) {
      await this.database.run(
        `UPDATE jobs SET status = 'pending', started_at = NULL, updated_at = ? WHERE kind = ? AND status = 'running'`,
        [new Date().toISOString(), STATE_TASK_KIND]
      );
    }
    return rows.map(row => row.chat_id);
  }

  async chatIdsWithPendingJobs(): Promise<string[]> {
    const rows = await this.database.all<{ chat_id: string }>(
      `SELECT DISTINCT chat_id FROM jobs WHERE kind = ? AND status = 'pending'`,
      [STATE_TASK_KIND]
    );
    return rows.map(row => row.chat_id);
  }

  isActive(job: StateTaskRecord): boolean {
    return ACTIVE_STATUSES.includes(job.status);
  }
}
