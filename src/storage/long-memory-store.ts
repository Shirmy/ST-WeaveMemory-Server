import type { SqliteDatabase } from './sqlite-database';
import type { LongMemoryRecord } from '../memory/long-memory';

type Row = { memory_id: string; chat_id: string; branch_id: string; batch_id: string; slice_id: string; start_floor: number; end_floor: number; title: string | null; summary: string; narrative_time: string | null; end_state_node_id: string; end_state_fingerprint: string; bm25_indexed: number; embedding_indexed: number; stale: number; created_at: string; updated_at: string };

function record(row: Row, tags: string[], characterIds: string[], plotlineIds: string[]): LongMemoryRecord {
  return { memoryId: row.memory_id, chatId: row.chat_id, branchId: row.branch_id, batchId: row.batch_id, sliceId: row.slice_id, startFloor: row.start_floor, endFloor: row.end_floor, ...(row.title ? { title: row.title } : {}), summary: row.summary, tags, characterIds, plotlineIds, ...(row.narrative_time ? { narrativeTime: row.narrative_time } : {}), endStateNodeId: row.end_state_node_id, endStateFingerprint: row.end_state_fingerprint, bm25Indexed: row.bm25_indexed === 1, embeddingIndexed: row.embedding_indexed === 1, stale: row.stale === 1, createdAt: row.created_at, updatedAt: row.updated_at };
}

export class LongMemoryStore {
  constructor(private readonly database: SqliteDatabase) {}

  async insertBatch(records: LongMemoryRecord[]): Promise<void> {
    await this.database.transaction(async () => { for (const item of records) { await this.database.run(`INSERT INTO long_memories(memory_id, chat_id, branch_id, batch_id, slice_id, start_floor, end_floor, title, summary, narrative_time, end_state_node_id, end_state_fingerprint, bm25_indexed, embedding_indexed, stale, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)`, [item.memoryId, item.chatId, item.branchId, item.batchId, item.sliceId, item.startFloor, item.endFloor, item.title ?? null, item.summary, item.narrativeTime ?? null, item.endStateNodeId, item.endStateFingerprint, item.createdAt, item.updatedAt]); for (const tag of item.tags) await this.database.run('INSERT INTO memory_tags(memory_id, tag) VALUES (?, ?)', [item.memoryId, tag]); for (const id of item.characterIds) await this.database.run('INSERT INTO memory_characters(memory_id, character_id) VALUES (?, ?)', [item.memoryId, id]); for (const id of item.plotlineIds) await this.database.run('INSERT INTO memory_plotlines(memory_id, plotline_id) VALUES (?, ?)', [item.memoryId, id]); } });
  }

  async list(chatId: string, branchId?: string, includeStale = false): Promise<LongMemoryRecord[]> {
    const rows = await this.database.all<Row>(`SELECT * FROM long_memories WHERE chat_id = ? ${branchId ? 'AND branch_id = ?' : ''} ${includeStale ? '' : 'AND stale = 0'} ORDER BY start_floor ASC, slice_id ASC`, branchId ? [chatId, branchId] : [chatId]);
    return Promise.all(rows.map(async row => record(row, (await this.database.all<{ tag: string }>('SELECT tag FROM memory_tags WHERE memory_id = ?', [row.memory_id])).map(item => item.tag), (await this.database.all<{ character_id: string }>('SELECT character_id FROM memory_characters WHERE memory_id = ?', [row.memory_id])).map(item => item.character_id), (await this.database.all<{ plotline_id: string }>('SELECT plotline_id FROM memory_plotlines WHERE memory_id = ?', [row.memory_id])).map(item => item.plotline_id))));
  }

  async markStaleByFloor(chatId: string, branchId: string, messageIndex: number): Promise<number> {
    const result = await this.database.run('UPDATE long_memories SET stale = 1, updated_at = ? WHERE chat_id = ? AND branch_id = ? AND start_floor <= ? AND end_floor >= ?', [new Date().toISOString(), chatId, branchId, messageIndex, messageIndex]);
    return result.changes ?? 0;
  }
}
