import type { FloorRecord, MemoryStore } from './types';
import { fingerprint } from '../core/fingerprint';
import { floorKeyFor, type ChatReconcileRequest, type ChatReconcileResult } from './types';
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

  async getOrCreateActiveBranch(chatId: string): Promise<string> {
    const branchId = `main:${chatId}`;
    const now = new Date().toISOString();
    await this.database.transaction(async () => {
      await this.database.run(
        `INSERT INTO chats(chat_id, active_branch_id, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET active_branch_id = excluded.active_branch_id, updated_at = excluded.updated_at`,
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

  async reconcileChat(input: ChatReconcileRequest): Promise<ChatReconcileResult> {
    const branchId = `main:${input.chatId}`;
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
        const floorId = floorKeyFor(input.chatId, floor.messageIndex, floor.swipeId, contentFingerprint);
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

    return {
      chatId: input.chatId,
      branchId,
      activeFloorIds,
      reusedFloorIds,
      createdFloorIds,
      staleFloorIds: [...new Set(staleFloorIds)]
    };
  }
}
