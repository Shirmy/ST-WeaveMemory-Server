import type { LongMemoryRecord } from './long-memory';
import type { LongMemoryStore } from '../storage/long-memory-store';

export type Bm25Result = { memory: LongMemoryRecord; score: number };

type IndexedDocument = {
  memory: LongMemoryRecord;
  terms: Map<string, number>;
  length: number;
  fingerprint: string;
};

const FIELD_WEIGHTS = { title: 3, summary: 1, tags: 2, characters: 2, plotlines: 2 } as const;

/** Tokenizer shared by indexing and querying. CJK uses unigrams and bigrams; latin text uses words. */
export function tokenize(input: string): string[] {
  const text = input.normalize('NFKC').toLocaleLowerCase();
  const tokens: string[] = [];
  for (const match of text.matchAll(/[\p{Script=Han}]+|[\p{L}\p{N}]+/gu)) {
    const part = match[0];
    if (/^[\p{Script=Han}]+$/u.test(part)) {
      const chars = [...part];
      tokens.push(...chars);
      for (let i = 0; i + 1 < chars.length; i += 1) tokens.push(chars[i] + chars[i + 1]);
    } else {
      tokens.push(part);
    }
  }
  return tokens;
}

export function memorySearchText(memory: LongMemoryRecord): string {
  return [memory.title ?? '', memory.summary, ...memory.tags, ...memory.characterIds, ...memory.plotlineIds].join(' ');
}

function fingerprintFor(memory: LongMemoryRecord): string {
  return JSON.stringify({ id: memory.memoryId, stale: memory.stale, title: memory.title ?? '', summary: memory.summary, tags: memory.tags, characterIds: memory.characterIds, plotlineIds: memory.plotlineIds });
}

function weightedTerms(memory: LongMemoryRecord): Map<string, number> {
  const terms = new Map<string, number>();
  const add = (value: string, weight: number) => { for (const token of tokenize(value)) terms.set(token, (terms.get(token) ?? 0) + weight); };
  add(memory.title ?? '', FIELD_WEIGHTS.title);
  add(memory.summary, FIELD_WEIGHTS.summary);
  add(memory.tags.join(' '), FIELD_WEIGHTS.tags);
  add(memory.characterIds.join(' '), FIELD_WEIGHTS.characters);
  add(memory.plotlineIds.join(' '), FIELD_WEIGHTS.plotlines);
  return terms;
}

export class Bm25Index {
  private readonly documents = new Map<string, IndexedDocument>();

  upsert(memory: LongMemoryRecord): void {
    if (memory.stale) { this.remove(memory.memoryId); return; }
    const fingerprint = fingerprintFor(memory);
    const old = this.documents.get(memory.memoryId);
    if (old?.fingerprint === fingerprint) return;
    const terms = weightedTerms(memory);
    this.documents.set(memory.memoryId, { memory, terms, length: [...terms.values()].reduce((sum, value) => sum + value, 0), fingerprint });
  }

  remove(memoryId: string): void { this.documents.delete(memoryId); }

  clear(): void { this.documents.clear(); }

  get size(): number { return this.documents.size; }

  ids(): string[] { return [...this.documents.keys()]; }

  search(query: string, topK = 10): Bm25Result[] {
    const limit = Number.isSafeInteger(topK) && topK > 0 ? topK : 10;
    const queryTerms = new Set(tokenize(query));
    if (!queryTerms.size || !this.documents.size) return [];
    const averageLength = [...this.documents.values()].reduce((sum, doc) => sum + doc.length, 0) / this.documents.size;
    const scores = new Map<string, number>();
    const k1 = 1.2; const b = 0.75;
    for (const term of queryTerms) {
      let documentFrequency = 0;
      for (const doc of this.documents.values()) if (doc.terms.has(term)) documentFrequency += 1;
      if (!documentFrequency) continue;
      const idf = Math.log(1 + (this.documents.size - documentFrequency + 0.5) / (documentFrequency + 0.5));
      for (const doc of this.documents.values()) {
        const frequency = doc.terms.get(term) ?? 0;
        if (!frequency) continue;
        const denominator = frequency + k1 * (1 - b + b * doc.length / Math.max(averageLength, 1));
        scores.set(doc.memory.memoryId, (scores.get(doc.memory.memoryId) ?? 0) + idf * (frequency * (k1 + 1) / denominator));
      }
    }
    return [...scores.entries()].map(([id, score]) => ({ memory: this.documents.get(id)!.memory, score }))
      .sort((a, b) => b.score - a.score || a.memory.startFloor - b.memory.startFloor || a.memory.memoryId.localeCompare(b.memory.memoryId))
      .slice(0, limit);
  }
}

export class Bm25SearchService {
  private readonly scopes = new Map<string, { index: Bm25Index }>();
  private readonly syncs = new Map<string, Promise<void>>();

  constructor(private readonly store: LongMemoryStore) {}

  private scope(chatId: string, branchId: string): { key: string; index: Bm25Index } {
    const key = `${chatId}\u0000${branchId}`;
    let value = this.scopes.get(key);
    if (!value) { value = { index: new Bm25Index() }; this.scopes.set(key, value); }
    return { key, index: value.index };
  }

  async search(chatId: string, branchId: string, query: string, topK = 10): Promise<Bm25Result[]> {
    const scope = this.scope(chatId, branchId);
    await this.sync(chatId, branchId);
    return scope.index.search(query, topK);
  }

  async sync(chatId: string, branchId: string): Promise<void> {
    const scope = this.scope(chatId, branchId);
    const previous = this.syncs.get(scope.key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.syncScope(chatId, branchId, scope.index));
    this.syncs.set(scope.key, current);
    try { await current; }
    finally { if (this.syncs.get(scope.key) === current) this.syncs.delete(scope.key); }
  }

  private async syncScope(chatId: string, branchId: string, index: Bm25Index): Promise<void> {
    const records = await this.store.list(chatId, branchId);
    const activeIds = new Set(records.map(record => record.memoryId));
    for (const record of records) index.upsert({ ...record, bm25Indexed: true });
    const removedIds = index.ids().filter(id => !activeIds.has(id));
    for (const id of removedIds) index.remove(id);
    await this.store.setBm25Indexed([...activeIds], true);
    if (removedIds.length) await this.store.setBm25Indexed(removedIds, false);
  }
}
