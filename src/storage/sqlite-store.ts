import { randomUUID } from 'node:crypto';
import type { FloorRecord, MemoryStore } from './types';
import { fingerprint } from '../core/fingerprint';
import { floorKeyFor, type ActivateBranchResult, type BranchRecord, type ChatReconcileRequest, type ChatReconcileResult, type CreateBranchRequest, type HostChatBindingRequest } from './types';
import { SqliteDatabase } from './sqlite-database';

type FloorRow = {
  floor_id: string;
  chat_id: string;
  branch_id: string;
  message_index: number;
  swipe_id: number | null;
  body_fingerprint: string;
  content: string;
  active: number;
  status: FloorRecord['status'];
  created_at: string;
  updated_at: string;
};

export class SqliteStore implements MemoryStore {
  constructor(private readonly database: SqliteDatabase) {}

  async upsertFloor(record: FloorRecord): Promise<void> {
    await this.database.run(
      `INSERT INTO floor_variants(
        floor_id, chat_id, branch_id, message_index, swipe_id, body_fingerprint,
        content, active, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(floor_id) DO UPDATE SET
        content = excluded.content,
        body_fingerprint = excluded.body_fingerprint,
        status = excluded.status,
        updated_at = excluded.updated_at`,
      [
        record.floorKey,
        record.chatId,
        record.branchId,
        record.messageIndex,
        record.swipeId,
        record.contentFingerprint,
        record.content,
        record.status,
        record.createdAt,
        record.updatedAt
      ]
    );
  }

  async getFloor(floorKey: string): Promise<FloorRecord | null> {
    const row = await this.database.get<FloorRow>(
      `SELECT floor_id, chat_id, branch_id, message_index, swipe_id, body_fingerprint,
              content, active, status, created_at, updated_at
       FROM floor_variants WHERE floor_id = ?`,
      [floorKey]
    );
    if (!row) return null;
    return {
      floorKey: row.floor_id,
      chatId: row.chat_id,
      branchId: row.branch_id,
      messageIndex: row.message_index,
      swipeId: row.swipe_id,
      contentFingerprint: row.body_fingerprint,
      content: row.content,
      active: row.active === 1,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  async updateFloorStatus(floorKey: string, status: FloorRecord['status']): Promise<void> {
    await this.database.run(
      'UPDATE floor_variants SET status = ?, updated_at = ? WHERE floor_id = ?',
      [status, new Date().toISOString(), floorKey]
    );
  }

  async getOrCreateActiveBranch(chatId: string): Promise<string> {
    const existing = await this.database.get<{ active_branch_id: string | null }>(
      'SELECT active_branch_id FROM chats WHERE chat_id = ?',
      [chatId]
    );
    if (existing?.active_branch_id) return existing.active_branch_id;

    const branchId = `main:${chatId}`;
    const now = new Date().toISOString();
    await this.database.transaction(async () => {
      await this.database.run(
        `INSERT INTO chats(chat_id, active_branch_id, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET updated_at = excluded.updated_at`,
        [chatId, branchId, now, now]
      );
      await this.database.run(
        `INSERT INTO branches(branch_id, chat_id, active, created_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(branch_id) DO UPDATE SET active = 1`,
        [branchId, chatId, now]
      );
    });
    return branchId;
  }

  async createBranch(input: CreateBranchRequest): Promise<ActivateBranchResult> {
    const sourceBranchId = input.sourceBranchId ?? await this.getOrCreateActiveBranch(input.chatId);
    const source = await this.database.get<{ branch_id: string; chat_id: string }>(
      'SELECT branch_id, chat_id FROM branches WHERE branch_id = ? AND chat_id = ?',
      [sourceBranchId, input.chatId]
    );
    if (!source) throw new Error('source branch does not exist for chat');

    const forkFloorId = input.forkFloorId;
    const forkFloor = await this.database.get<{ floor_id: string; message_index: number }>(
      `SELECT floor_id, message_index FROM floor_variants
       WHERE floor_id = ? AND chat_id = ? AND branch_id = ?`,
      [forkFloorId, input.chatId, sourceBranchId]
    );
    if (!forkFloor) throw new Error('forkFloorId must belong to source branch');

    const branchId = `branch:${input.chatId}:${randomUUID()}`;
    const now = new Date().toISOString();
    const activeFloorIds: string[] = [];
    await this.database.transaction(async () => {
      await this.database.run(
        `INSERT INTO branches(branch_id, chat_id, parent_branch_id, fork_floor_id, active, created_at)
         VALUES (?, ?, ?, ?, 1, ?)`,
        [branchId, input.chatId, sourceBranchId, forkFloorId, now]
      );

      const sourceFloors = await this.database.all<FloorRow>(
        `SELECT floor_id, chat_id, branch_id, message_index, swipe_id, body_fingerprint,
                content, active, status, created_at, updated_at
         FROM floor_variants WHERE chat_id = ? AND branch_id = ? AND message_index <= ?`,
        [input.chatId, sourceBranchId, forkFloor.message_index]
      );
      for (const floor of sourceFloors) {
        const newFloorId = floorKeyFor(input.chatId, branchId, floor.message_index, floor.swipe_id, floor.body_fingerprint);
        await this.database.run(
          `INSERT INTO floor_variants(
            floor_id, chat_id, branch_id, message_index, swipe_id, body_fingerprint,
            content, active, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(floor_id) DO NOTHING`,
          [newFloorId, input.chatId, branchId, floor.message_index, floor.swipe_id, floor.body_fingerprint,
            floor.content, floor.active, floor.status, floor.created_at, floor.updated_at]
        );
      }

      const activeFloors = await this.database.all<{ message_index: number; floor_id: string }>(
        `SELECT active.message_index, floors.floor_id, floors.swipe_id, floors.body_fingerprint
         FROM chat_active_floors AS active
         JOIN floor_variants AS floors ON floors.floor_id = active.floor_id
         WHERE active.chat_id = ? AND active.branch_id = ? AND active.message_index <= ? ORDER BY active.message_index`,
        [input.chatId, sourceBranchId, forkFloor.message_index]
      );
      for (const floor of activeFloors) {
        const sourceFloor = await this.database.get<FloorRow>(
          `SELECT message_index, swipe_id, body_fingerprint FROM floor_variants WHERE floor_id = ?`,
          [floor.floor_id]
        );
        if (!sourceFloor) continue;
        const newFloorId = floorKeyFor(input.chatId, branchId, sourceFloor.message_index, sourceFloor.swipe_id, sourceFloor.body_fingerprint);
        activeFloorIds.push(newFloorId);
        await this.database.run(
          `INSERT INTO chat_active_floors(chat_id, branch_id, message_index, floor_id, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
          [input.chatId, branchId, floor.message_index, newFloorId, now]
        );
      }
      await this.database.run('UPDATE branches SET active = 0 WHERE chat_id = ?', [input.chatId]);
      await this.database.run('UPDATE branches SET active = 1 WHERE branch_id = ?', [branchId]);
      await this.database.run('UPDATE chats SET active_branch_id = ?, updated_at = ? WHERE chat_id = ?', [branchId, now, input.chatId]);
    });

    return {
      branch: { branchId, chatId: input.chatId, parentBranchId: sourceBranchId, forkFloorId, active: true, createdAt: now },
      activeFloorIds
    };
  }

  async activateBranch(chatId: string, branchId: string): Promise<ActivateBranchResult> {
    const branch = await this.database.get<{
      branch_id: string;
      chat_id: string;
      parent_branch_id: string | null;
      fork_floor_id: string | null;
      active: number;
      created_at: string;
    }>('SELECT branch_id, chat_id, parent_branch_id, fork_floor_id, active, created_at FROM branches WHERE branch_id = ?', [branchId]);
    if (!branch) throw new Error('branch does not exist for chat');
    const now = new Date().toISOString();
    await this.database.transaction(async () => {
      await this.database.run('UPDATE branches SET active = 0 WHERE chat_id = ?', [chatId]);
      await this.database.run('UPDATE branches SET active = 1 WHERE branch_id = ?', [branchId]);
      await this.database.run('UPDATE chats SET active_branch_id = ?, updated_at = ? WHERE chat_id = ?', [branchId, now, chatId]);
    });
    const activeRows = await this.database.all<{ floor_id: string }>(
      `SELECT floor_id FROM chat_active_floors WHERE chat_id = ? AND branch_id = ? ORDER BY message_index`,
      [chatId, branchId]
    );
    const branchRecord: BranchRecord = {
      branchId: branch.branch_id,
      chatId: branch.chat_id,
      parentBranchId: branch.parent_branch_id,
      forkFloorId: branch.fork_floor_id,
      active: true,
      createdAt: branch.created_at
    };
    return { branch: branchRecord, activeFloorIds: activeRows.map(row => row.floor_id) };
  }

  async reconcileChat(input: ChatReconcileRequest): Promise<ChatReconcileResult> {
    const branchId = input.branchId ?? await this.getOrCreateActiveBranch(input.chatId);
    const branch = await this.database.get<{ branch_id: string }>(
      'SELECT branch_id FROM branches WHERE branch_id = ?',
      [branchId]
    );
    if (!branch) throw new Error('branch does not exist for chat');
    const now = new Date().toISOString();
    const activeFloorIds: string[] = [];
    const reusedFloorIds: string[] = [];
    const createdFloorIds: string[] = [];
    const staleFloorIds: string[] = [];
    const seenLocators = new Set<string>();

    await this.database.transaction(async () => {
      await this.database.run(
        `INSERT INTO chats(chat_id, active_branch_id, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET active_branch_id = excluded.active_branch_id, updated_at = excluded.updated_at`,
        [input.chatId, branchId, now, now]
      );
      await this.database.run(
        `INSERT INTO branches(branch_id, chat_id, active, created_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(branch_id) DO UPDATE SET active = 1`,
        [branchId, input.chatId, now]
      );
      await this.database.run('UPDATE branches SET active = 0 WHERE chat_id = ? AND branch_id <> ?', [input.chatId, branchId]);

      const existing = await this.database.all<FloorRow & { branch_id: string }>(
        `SELECT floor_id, chat_id, branch_id, message_index, swipe_id, body_fingerprint,
                content, active, status, created_at, updated_at
         FROM floor_variants WHERE chat_id = ? AND branch_id = ?`,
        [input.chatId, branchId]
      );
      const byFloorId = new Map(existing.map(row => [row.floor_id, row]));
      const byLocator = new Map(existing.map(row => [`${row.message_index}:${row.swipe_id ?? 0}`, row]));
      const incomingIds = new Set<string>();
      const seenMessageIndexes = new Set(input.floors.map(floor => floor.messageIndex));

      for (const floor of input.floors) {
        const locator = `${floor.messageIndex}:${floor.swipeId ?? 0}`;
        if (seenLocators.has(locator)) throw new Error(`duplicate floor locator: ${locator}`);
        seenLocators.add(locator);
        const contentFingerprint = fingerprint(floor.content);
        const floorId = floorKeyFor(input.chatId, branchId, floor.messageIndex, floor.swipeId, contentFingerprint);
        incomingIds.add(floorId);
        activeFloorIds.push(floorId);
        const current = byFloorId.get(floorId);
        if (current) {
          reusedFloorIds.push(floorId);
          await this.database.run(
            `UPDATE floor_variants SET active = 1, status = CASE WHEN status = 'stale' THEN 'pending' ELSE status END, updated_at = ? WHERE floor_id = ?`,
            [now, floorId]
          );
        } else {
          const oldAtLocator = byLocator.get(locator);
          if (oldAtLocator && oldAtLocator.floor_id !== floorId) {
            staleFloorIds.push(oldAtLocator.floor_id);
            await this.database.run(
              `UPDATE floor_variants SET active = 0, status = 'stale', updated_at = ? WHERE floor_id = ?`,
              [now, oldAtLocator.floor_id]
            );
          }
          createdFloorIds.push(floorId);
          await this.database.run(
            `INSERT INTO floor_variants(
              floor_id, chat_id, branch_id, message_index, swipe_id, body_fingerprint,
              content, active, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'pending', ?, ?)`,
            [floorId, input.chatId, branchId, floor.messageIndex, floor.swipeId, contentFingerprint, floor.content, now, now]
          );
        }
      }

      for (const row of existing) {
        if (incomingIds.has(row.floor_id)) continue;
        if (!seenMessageIndexes.has(row.message_index)) {
          staleFloorIds.push(row.floor_id);
          await this.database.run(
            `UPDATE floor_variants SET active = 0, status = 'stale', updated_at = ? WHERE floor_id = ?`,
            [now, row.floor_id]
          );
        } else {
          await this.database.run('UPDATE floor_variants SET active = 0, updated_at = ? WHERE floor_id = ?', [now, row.floor_id]);
        }
      }

      await this.database.run('DELETE FROM chat_active_floors WHERE chat_id = ? AND branch_id = ?', [input.chatId, branchId]);
      for (const floor of input.floors) {
        const floorId = activeFloorIds[input.floors.indexOf(floor)];
        await this.database.run(
          `INSERT INTO chat_active_floors(chat_id, branch_id, message_index, floor_id, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
          [input.chatId, branchId, floor.messageIndex, floorId, now]
        );
      }
    });

    const branchRecord = await this.database.get<{
      branch_id: string; chat_id: string; parent_branch_id: string | null;
      fork_floor_id: string | null; active: number; created_at: string;
    }>(
      `SELECT branch_id, chat_id, parent_branch_id, fork_floor_id, active, created_at
       FROM branches WHERE branch_id = ?`,
      [branchId]
    );
    if (!branchRecord) throw new Error('branch does not exist for chat');
    return {
      chatId: input.chatId,
      branchId,
      branch: {
        branchId: branchRecord.branch_id,
        chatId: branchRecord.chat_id,
        parentBranchId: branchRecord.parent_branch_id,
        forkFloorId: branchRecord.fork_floor_id,
        active: branchRecord.active === 1,
        createdAt: branchRecord.created_at
      },
      activeFloorIds,
      reusedFloorIds,
      createdFloorIds,
      staleFloorIds: [...new Set(staleFloorIds)]
    };
  }

  async bindHostChat(input: HostChatBindingRequest): Promise<ActivateBranchResult> {
    const existing = await this.database.get<{ branch_id: string }>(
      'SELECT branch_id FROM host_chat_bindings WHERE host_chat_id = ?', [input.chatId]
    );
    if (existing) {
      const branch = await this.database.get<{
        branch_id: string; chat_id: string; parent_branch_id: string | null;
        fork_floor_id: string | null; active: number; created_at: string;
      }>('SELECT branch_id, chat_id, parent_branch_id, fork_floor_id, active, created_at FROM branches WHERE branch_id = ?', [existing.branch_id]);
      if (!branch) throw new Error('host chat binding points to missing branch');
      const activeRows = await this.database.all<{ floor_id: string }>(
        'SELECT floor_id FROM chat_active_floors WHERE chat_id = ? AND branch_id = ? ORDER BY message_index',
        [input.chatId, existing.branch_id]
      );
      return {
        branch: {
          branchId: branch.branch_id, chatId: branch.chat_id,
          parentBranchId: branch.parent_branch_id, forkFloorId: branch.fork_floor_id,
          active: branch.active === 1, createdAt: branch.created_at
        },
        activeFloorIds: activeRows.map(row => row.floor_id)
      };
    }

    const mainChatId = input.mainChatId ?? null;
    if (!mainChatId) {
      const sourceBranchId = await this.getOrCreateActiveBranch(input.chatId);
      const now = new Date().toISOString();
      await this.database.run(
        `INSERT INTO host_chat_bindings(host_chat_id, branch_id, parent_host_chat_id, main_chat_id, created_at, updated_at)
         VALUES (?, ?, NULL, NULL, ?, ?)`, [input.chatId, sourceBranchId, now, now]
      );
      return this.activateBranch(input.chatId, sourceBranchId);
    }

    const parentBinding = await this.database.get<{ branch_id: string }>(
      'SELECT branch_id FROM host_chat_bindings WHERE host_chat_id = ?', [mainChatId]
    );
    const sourceBranchId = parentBinding?.branch_id ?? await this.getOrCreateActiveBranch(mainChatId);
    if (!parentBinding) {
      const now = new Date().toISOString();
      await this.database.run(
        `INSERT INTO host_chat_bindings(host_chat_id, branch_id, parent_host_chat_id, main_chat_id, created_at, updated_at)
         VALUES (?, ?, NULL, NULL, ?, ?)`, [mainChatId, sourceBranchId, now, now]
      );
    }
    if (!input.forkFloor) throw new Error('forkFloor is required for a host branch');
    const fork = await this.database.get<{ floor_id: string }>(
      `SELECT floor_id FROM floor_variants
       WHERE chat_id = ? AND branch_id = ? AND message_index = ?
         AND swipe_id IS ? AND body_fingerprint = ?`,
      [mainChatId, sourceBranchId, input.forkFloor.messageIndex, input.forkFloor.swipeId, fingerprint(input.forkFloor.content)]
    );
    if (!fork) throw new Error('host branch fork floor does not belong to parent chat branch');
    const branchId = `branch:${mainChatId}:${randomUUID()}`;
    const now = new Date().toISOString();
    await this.database.transaction(async () => {
      await this.database.run(
        `INSERT INTO branches(branch_id, chat_id, parent_branch_id, fork_floor_id, active, created_at)
         VALUES (?, ?, ?, ?, 1, ?)`,
        [branchId, mainChatId, sourceBranchId, fork.floor_id, now]
      );
      await this.database.run('UPDATE branches SET active = 0 WHERE chat_id = ?', [mainChatId]);
      await this.database.run('UPDATE branches SET active = 1 WHERE branch_id = ?', [branchId]);
      await this.database.run('UPDATE chats SET active_branch_id = ?, updated_at = ? WHERE chat_id = ?', [branchId, now, mainChatId]);
    });
    await this.database.run(
      `INSERT INTO host_chat_bindings(host_chat_id, branch_id, parent_host_chat_id, main_chat_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`, [input.chatId, branchId, mainChatId, mainChatId, now, now]
    );
    return {
      branch: {
        branchId,
        chatId: mainChatId,
        parentBranchId: sourceBranchId,
        forkFloorId: fork.floor_id,
        active: true,
        createdAt: now
      },
      activeFloorIds: []
    };
  }
}
