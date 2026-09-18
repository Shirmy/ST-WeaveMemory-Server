import type { FloorRecord, MemoryStore } from './types';
import { SqliteDatabase } from './sqlite-database';

type FloorRow = {
  floor_id: string;
  chat_id: string;
  message_index: number;
  swipe_id: number | null;
  body_fingerprint: string;
  content: string;
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
        'main',
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
      `SELECT floor_id, chat_id, message_index, swipe_id, body_fingerprint,
              content, status, created_at, updated_at
       FROM floor_variants WHERE floor_id = ?`,
      [floorKey]
    );
    if (!row) return null;
    return {
      floorKey: row.floor_id,
      chatId: row.chat_id,
      messageIndex: row.message_index,
      swipeId: row.swipe_id,
      contentFingerprint: row.body_fingerprint,
      content: row.content,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}
