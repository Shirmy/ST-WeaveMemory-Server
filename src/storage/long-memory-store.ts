import type { SqliteDatabase } from './sqlite-database';
import type { LongMemoryBatch, LongMemoryRecord } from '../memory/long-memory';

type Row = { memory_id: string; chat_id: string; branch_id: string; batch_id: string; slice_id: string; start_floor: number; end_floor: number; batch_start_floor: number; batch_end_floor: number; title: string | null; summary: string; narrative_time: string | null; end_state_node_id: string; end_state_fingerprint: string; batch_dependency_fingerprint: string; source_floor_ids: string; bm25_indexed: number; embedding_indexed: number; stale: number; created_at: string; updated_at: string };
type BatchRow = { batch_id: string; chat_id: string; branch_id: string; batch_start_floor: number; batch_end_floor: number; source_floor_ids: string; batch_dependency_fingerprint: string; end_state_node_id: string; end_state_fingerprint: string; stale: number; created_at: string; updated_at: string };
/** `bindingFingerprint` identifies the embedding channel / model configuration the vector was produced with (see `embeddingBindingFingerprint`). */
export type EmbeddingRef = { memoryId: string; provider: string; model: string; contentFingerprint: string; bindingFingerprint: string; vector: number[]; updatedAt: string };

function record(row: Row, tags: string[], characterIds: string[], plotlineIds: string[]): LongMemoryRecord {
  return { memoryId: row.memory_id, chatId: row.chat_id, branchId: row.branch_id, batchId: row.batch_id, sliceId: row.slice_id, startFloor: row.start_floor, endFloor: row.end_floor, batchStartFloor: row.batch_start_floor, batchEndFloor: row.batch_end_floor, ...(row.title ? { title: row.title } : {}), summary: row.summary, tags, characterIds, plotlineIds, ...(row.narrative_time ? { narrativeTime: row.narrative_time } : {}), sourceFloorIds: JSON.parse(row.source_floor_ids || '[]') as string[], batchDependencyFingerprint: row.batch_dependency_fingerprint, endStateNodeId: row.end_state_node_id, endStateFingerprint: row.end_state_fingerprint, bm25Indexed: row.bm25_indexed === 1, embeddingIndexed: row.embedding_indexed === 1, stale: row.stale === 1, createdAt: row.created_at, updatedAt: row.updated_at };
}

export class LongMemoryStore {
  constructor(private readonly database: SqliteDatabase) {}

  /** bm25Indexed describes the current in-memory index only; restart resets it. */
  async resetBm25Indexed(): Promise<void> {
    await this.database.run('UPDATE long_memories SET bm25_indexed = 0 WHERE bm25_indexed != 0');
  }

  async setBm25Indexed(memoryIds: string[], indexed: boolean): Promise<void> {
    if (!memoryIds.length) return;
    await this.database.run(`UPDATE long_memories SET bm25_indexed = ? WHERE memory_id IN (${memoryIds.map(() => '?').join(',')})`, [indexed ? 1 : 0, ...memoryIds]);
  }

  async resetEmbeddingIndexed(): Promise<void> { await this.database.run('UPDATE long_memories SET embedding_indexed = 0 WHERE embedding_indexed != 0'); }

  async listEmbeddingRefs(chatId: string, branchId: string): Promise<EmbeddingRef[]> {
    const rows = await this.database.all<{ memory_id: string; provider: string; model: string; content_fingerprint: string; binding_fingerprint: string; vector_json: string; updated_at: string }>(`SELECT e.* FROM embedding_refs e JOIN long_memories m ON m.memory_id = e.memory_id WHERE m.chat_id = ? AND m.branch_id = ?`, [chatId, branchId]);
    return rows.flatMap(row => { try { const vector = JSON.parse(row.vector_json) as unknown; return Array.isArray(vector) && vector.every(value => typeof value === 'number' && Number.isFinite(value)) ? [{ memoryId: row.memory_id, provider: row.provider, model: row.model, contentFingerprint: row.content_fingerprint, bindingFingerprint: row.binding_fingerprint ?? '', vector, updatedAt: row.updated_at }] : []; } catch { return []; } });
  }

  async saveEmbeddingRef(ref: EmbeddingRef): Promise<void> {
    await this.database.run(`INSERT INTO embedding_refs(memory_id, provider, model, vector_json, updated_at, content_fingerprint, binding_fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(memory_id) DO UPDATE SET provider = excluded.provider, model = excluded.model, vector_json = excluded.vector_json, updated_at = excluded.updated_at, content_fingerprint = excluded.content_fingerprint, binding_fingerprint = excluded.binding_fingerprint`, [ref.memoryId, ref.provider, ref.model, JSON.stringify(ref.vector), ref.updatedAt, ref.contentFingerprint, ref.bindingFingerprint]);
  }

  async deleteEmbeddingRefs(memoryIds: string[]): Promise<void> {
    if (!memoryIds.length) return;
    await this.database.run(`DELETE FROM embedding_refs WHERE memory_id IN (${memoryIds.map(() => '?').join(',')})`, memoryIds);
  }

  async setEmbeddingIndexed(memoryIds: string[], indexed: boolean): Promise<void> {
    if (!memoryIds.length) return;
    await this.database.run(`UPDATE long_memories SET embedding_indexed = ? WHERE memory_id IN (${memoryIds.map(() => '?').join(',')})`, [indexed ? 1 : 0, ...memoryIds]);
  }

  async insertBatch(records: LongMemoryRecord[], batch: LongMemoryBatch): Promise<void> {
    await this.database.transaction(async () => { const now = new Date().toISOString(); await this.database.run('UPDATE long_memory_batches SET stale = 1, updated_at = ? WHERE chat_id = ? AND branch_id = ? AND batch_start_floor = ? AND batch_end_floor = ? AND batch_id != ? AND stale = 0', [now, batch.chatId, batch.branchId, batch.batchStartFloor, batch.batchEndFloor, batch.batchId]); await this.database.run('UPDATE long_memories SET stale = 1, updated_at = ? WHERE chat_id = ? AND branch_id = ? AND batch_start_floor = ? AND batch_end_floor = ? AND batch_id != ? AND stale = 0', [now, batch.chatId, batch.branchId, batch.batchStartFloor, batch.batchEndFloor, batch.batchId]); await this.database.run(`INSERT INTO long_memory_batches(batch_id, chat_id, branch_id, batch_start_floor, batch_end_floor, source_floor_ids, batch_dependency_fingerprint, end_state_node_id, end_state_fingerprint, stale, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`, [batch.batchId, batch.chatId, batch.branchId, batch.batchStartFloor, batch.batchEndFloor, JSON.stringify(batch.sourceFloorIds), batch.batchDependencyFingerprint, batch.endStateNodeId, batch.endStateFingerprint, batch.createdAt, batch.updatedAt]); for (const item of records) { await this.database.run(`INSERT INTO long_memories(memory_id, chat_id, branch_id, batch_id, slice_id, start_floor, end_floor, batch_start_floor, batch_end_floor, title, summary, narrative_time, end_state_node_id, end_state_fingerprint, batch_dependency_fingerprint, source_floor_ids, bm25_indexed, embedding_indexed, stale, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)`, [item.memoryId, item.chatId, item.branchId, item.batchId, item.sliceId, item.startFloor, item.endFloor, item.batchStartFloor, item.batchEndFloor, item.title ?? null, item.summary, item.narrativeTime ?? null, item.endStateNodeId, item.endStateFingerprint, item.batchDependencyFingerprint, JSON.stringify(item.sourceFloorIds), item.createdAt, item.updatedAt]); for (const tag of item.tags) await this.database.run('INSERT INTO memory_tags(memory_id, tag) VALUES (?, ?)', [item.memoryId, tag]); for (const id of item.characterIds) await this.database.run('INSERT INTO memory_characters(memory_id, character_id) VALUES (?, ?)', [item.memoryId, id]); for (const id of item.plotlineIds) await this.database.run('INSERT INTO memory_plotlines(memory_id, plotline_id) VALUES (?, ?)', [item.memoryId, id]); } });
  }

  async markStaleByFloorIds(chatId: string, branchId: string, floorIds: string[]): Promise<number> {
    if (!floorIds.length) return 0;
    const batches = await this.listBatches(chatId, branchId, true);
    const staleIds = batches.filter(batch => batch.sourceFloorIds.some(id => floorIds.includes(id))).map(batch => batch.batchId);
    if (!staleIds.length) return 0;
    const now = new Date().toISOString();
    return this.database.transaction(async () => { await this.database.run(`UPDATE long_memory_batches SET stale = 1, updated_at = ? WHERE batch_id IN (${staleIds.map(() => '?').join(',')})`, [now, ...staleIds]); const result = await this.database.run(`UPDATE long_memories SET stale = 1, updated_at = ? WHERE batch_id IN (${staleIds.map(() => '?').join(',')})`, [now, ...staleIds]); return result.changes ?? 0; });
  }

  async list(chatId: string, branchId?: string, includeStale = false): Promise<LongMemoryRecord[]> {
    const rows = await this.database.all<Row>(`SELECT * FROM long_memories WHERE chat_id = ? ${branchId ? 'AND branch_id = ?' : ''} ${includeStale ? '' : 'AND stale = 0'} ORDER BY start_floor ASC, slice_id ASC`, branchId ? [chatId, branchId] : [chatId]);
    return Promise.all(rows.map(async row => record(row, (await this.database.all<{ tag: string }>('SELECT tag FROM memory_tags WHERE memory_id = ?', [row.memory_id])).map(item => item.tag), (await this.database.all<{ character_id: string }>('SELECT character_id FROM memory_characters WHERE memory_id = ?', [row.memory_id])).map(item => item.character_id), (await this.database.all<{ plotline_id: string }>('SELECT plotline_id FROM memory_plotlines WHERE memory_id = ?', [row.memory_id])).map(item => item.plotline_id))));
  }

  async findByDependency(chatId: string, branchId: string, dependency: string, options: { includeStale?: boolean } = {}): Promise<LongMemoryRecord[]> {
    const records = await this.list(chatId, branchId, options.includeStale ?? true);
    return records.filter(record => record.batchDependencyFingerprint === dependency);
  }

  async listBatches(chatId: string, branchId: string, includeStale = false): Promise<LongMemoryBatch[]> {
    const rows = await this.database.all<BatchRow>(`SELECT * FROM long_memory_batches WHERE chat_id = ? AND branch_id = ? ${includeStale ? '' : 'AND stale = 0'} ORDER BY batch_start_floor ASC`, [chatId, branchId]);
    return rows.map(row => ({ batchId: row.batch_id, chatId: row.chat_id, branchId: row.branch_id, batchStartFloor: row.batch_start_floor, batchEndFloor: row.batch_end_floor, sourceFloorIds: JSON.parse(row.source_floor_ids || '[]') as string[], batchDependencyFingerprint: row.batch_dependency_fingerprint, endStateNodeId: row.end_state_node_id, endStateFingerprint: row.end_state_fingerprint, stale: row.stale === 1, createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  async listScopes(): Promise<Array<{ chatId: string; branchId: string }>> {
    const rows = await this.database.all<{ chat_id: string; branch_id: string }>('SELECT DISTINCT chat_id, branch_id FROM long_memory_batches ORDER BY chat_id, branch_id');
    return rows.map(row => ({ chatId: row.chat_id, branchId: row.branch_id }));
  }

  async listByBatch(batchId: string): Promise<LongMemoryRecord[]> {
    const rows = await this.database.all<Row>('SELECT * FROM long_memories WHERE batch_id = ? ORDER BY start_floor ASC, slice_id ASC', [batchId]);
    return Promise.all(rows.map(async row => record(row, (await this.database.all<{ tag: string }>('SELECT tag FROM memory_tags WHERE memory_id = ?', [row.memory_id])).map(item => item.tag), (await this.database.all<{ character_id: string }>('SELECT character_id FROM memory_characters WHERE memory_id = ?', [row.memory_id])).map(item => item.character_id), (await this.database.all<{ plotline_id: string }>('SELECT plotline_id FROM memory_plotlines WHERE memory_id = ?', [row.memory_id])).map(item => item.plotline_id))));
  }

  async activateBatch(batchId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.database.transaction(async () => { const target = await this.database.get<BatchRow>('SELECT * FROM long_memory_batches WHERE batch_id = ?', [batchId]); if (!target) throw new Error(`long memory batch ${batchId} does not exist`); await this.database.run('UPDATE long_memory_batches SET stale = 1, updated_at = ? WHERE chat_id = ? AND branch_id = ? AND batch_start_floor = ? AND batch_end_floor = ? AND batch_id != ?', [now, target.chat_id, target.branch_id, target.batch_start_floor, target.batch_end_floor, batchId]); await this.database.run('UPDATE long_memories SET stale = 1, updated_at = ? WHERE chat_id = ? AND branch_id = ? AND batch_start_floor = ? AND batch_end_floor = ? AND batch_id != ?', [now, target.chat_id, target.branch_id, target.batch_start_floor, target.batch_end_floor, batchId]); await this.database.run('UPDATE long_memory_batches SET stale = 0, updated_at = ? WHERE batch_id = ?', [now, batchId]); await this.database.run('UPDATE long_memories SET stale = 0, updated_at = ? WHERE batch_id = ?', [now, batchId]); });
  }

  async markAllBatchesStale(chatId: string, branchId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.database.transaction(async () => { await this.database.run('UPDATE long_memory_batches SET stale = 1, updated_at = ? WHERE chat_id = ? AND branch_id = ? AND stale = 0', [now, chatId, branchId]); await this.database.run('UPDATE long_memories SET stale = 1, updated_at = ? WHERE chat_id = ? AND branch_id = ? AND stale = 0', [now, chatId, branchId]); });
  }

}
