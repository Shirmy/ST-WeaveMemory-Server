import { AiRequestError, type OpenAiCompatibleClient } from '../ai/openai-compatible-client';
import type { AiChannelRecord, RecallSettings } from '../ai/types';
import type { AiConfigStore } from '../storage/ai-config-store';
import type { LongMemoryRecord } from './long-memory';
import type { Bm25SearchService } from './bm25';
import { embeddingText, type EmbeddingSearchService } from './embedding';

/** Roadmap §39: RRF merges the BM25 and Embedding rankings; k defaults to 60. */
export type RecallSource = 'bm25' | 'embedding';
export type RankedMemory = { memory: LongMemoryRecord; score: number };
export type FusedMemory = {
  memory: LongMemoryRecord;
  rrfScore: number;
  /** 1-based rank in each source list that contained the memory. */
  ranks: Partial<Record<RecallSource, number>>;
  scores: Partial<Record<RecallSource, number>>;
};
export type RerankedMemory = FusedMemory & { rerankScore: number };

/**
 * Why the reranker did or did not decide the final order (reference: shujuku `SummaryRerankStatus`).
 * `applied` is the only status where the rerank model changed the order; every other status keeps the RRF order.
 */
export type RerankStatus = 'applied' | 'disabled' | 'not_configured' | 'no_candidates' | 'skipped_within_final' | 'failed';

export type RecallStageError = { source: RecallSource | 'rerank'; code: string; message: string };

export type RecallResult = {
  query: string;
  settings: RecallSettings;
  bm25: RankedMemory[];
  embedding: RankedMemory[];
  rrf: FusedMemory[];
  rerank: { status: RerankStatus; documentCount: number; model: string | null; error?: string; candidates: RerankedMemory[] };
  /** Final candidates after RRF (and the reranker when applied), capped at `finalRecallCount`. */
  final: FusedMemory[];
  errors: RecallStageError[];
};

export type RecallOptions = Partial<Pick<RecallSettings, 'bm25TopK' | 'embeddingTopK' | 'rrfK' | 'rerankCandidateLimit' | 'finalRecallCount'>> & { rerankEnabled?: boolean };

type RecallBm25 = Pick<Bm25SearchService, 'search'>;
type RecallEmbedding = Pick<EmbeddingSearchService, 'search'>;
type RecallConfig = Pick<AiConfigStore, 'resolveRole' | 'getRecallSettings'>;
type RecallClient = Pick<OpenAiCompatibleClient, 'rerank'>;

const compareMemories = (left: LongMemoryRecord, right: LongMemoryRecord): number => left.startFloor - right.startFloor || left.memoryId.localeCompare(right.memoryId);

/** Roadmap §39: score = Σ 1 / (k + rank) with 1-based ranks; a memory found by both sources accumulates both terms. */
export function reciprocalRankFusion(lists: Array<{ source: RecallSource; results: RankedMemory[] }>, k: number): FusedMemory[] {
  const constant = Number.isFinite(k) && k >= 1 ? k : 60;
  const fused = new Map<string, FusedMemory>();
  for (const { source, results } of lists) {
    results.forEach((item, index) => {
      const rank = index + 1;
      const existing = fused.get(item.memory.memoryId) ?? { memory: item.memory, rrfScore: 0, ranks: {}, scores: {} };
      if (existing.ranks[source] !== undefined) return; // duplicate inside one source list: keep the best rank
      existing.rrfScore += 1 / (constant + rank);
      existing.ranks[source] = rank;
      existing.scores[source] = item.score;
      fused.set(item.memory.memoryId, existing);
    });
  }
  return [...fused.values()].sort((left, right) => right.rrfScore - left.rrfScore || compareMemories(left.memory, right.memory));
}

/** Text handed to the rerank model: same composition as the vector text so both stages judge identical content. */
export function rerankDocument(memory: LongMemoryRecord): string { return embeddingText(memory); }

/**
 * Long-memory recall pipeline (roadmap §36–§40, §45): BM25 and Embedding run independently, their rankings are
 * fused with RRF, and an optional rerank model reorders the top candidates. Any single stage failing degrades
 * gracefully: one retrieval source failing leaves the other; the reranker failing keeps the RRF order.
 */
export class RecallService {
  constructor(private readonly bm25: RecallBm25, private readonly embedding: RecallEmbedding, private readonly aiConfig: RecallConfig, private readonly client: RecallClient) {}

  async recall(chatId: string, branchId: string, query: string, options: RecallOptions = {}): Promise<RecallResult> {
    const settings = { ...await this.aiConfig.getRecallSettings(), ...definedOnly(options) };
    const errors: RecallStageError[] = [];
    const [bm25, embedding] = await Promise.all([
      this.stage('bm25', errors, () => this.bm25.search(chatId, branchId, query, settings.bm25TopK)),
      this.stage('embedding', errors, () => this.embedding.search(chatId, branchId, query, settings.embeddingTopK))
    ]);
    if (bm25 === null && embedding === null) {
      const first = errors[0];
      throw new AiRequestError('WM_AI_REQUEST_FAILED', `long memory recall failed: ${first?.message ?? 'both retrieval sources failed'}`, false);
    }
    const rrf = reciprocalRankFusion([{ source: 'bm25', results: bm25 ?? [] }, { source: 'embedding', results: embedding ?? [] }], settings.rrfK);
    const rerank = await this.rerankStage(query, rrf, settings, errors);
    const ordered: FusedMemory[] = rerank.status === 'applied' ? rerank.candidates : rrf;
    return { query, settings, bm25: bm25 ?? [], embedding: embedding ?? [], rrf, rerank, final: ordered.slice(0, settings.finalRecallCount), errors };
  }

  private async stage<T>(source: RecallSource, errors: RecallStageError[], work: () => Promise<T>): Promise<T | null> {
    try { return await work(); }
    catch (error) {
      errors.push({ source, code: error instanceof AiRequestError ? error.code : 'WM_INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) });
      console.warn(`[WeaveMemory] ${source} recall failed; continuing with the other source`, error instanceof Error ? error.message : error);
      return null;
    }
  }

  private async rerankStage(query: string, fused: FusedMemory[], settings: RecallSettings, errors: RecallStageError[]): Promise<RecallResult['rerank']> {
    const none = (status: RerankStatus, extra: Partial<RecallResult['rerank']> = {}): RecallResult['rerank'] => ({ status, documentCount: 0, model: null, candidates: [], ...extra });
    if (!settings.rerankEnabled) return none('disabled');
    let binding: Awaited<ReturnType<RecallConfig['resolveRole']>>;
    try {
      binding = await this.aiConfig.resolveRole('rerank');
    } catch (error) {
      return this.rerankFailure(error, errors);
    }
    if (!binding) return none('not_configured');
    if (!fused.length) return none('no_candidates', { model: binding.model });
    const pool = fused.slice(0, settings.rerankCandidateLimit);
    // Reference (shujuku): a pool no larger than the final count cannot change who is selected; skip the request.
    if (pool.length <= settings.finalRecallCount) return none('skipped_within_final', { model: binding.model });
    try {
      const result = await this.client.rerank(binding.channel, binding.model, query, pool.map(item => rerankDocument(item.memory)), timeoutMs(binding.channel));
      const byIndex = new Map(result.scores.map(score => [score.index, score.relevanceScore]));
      const candidates: RerankedMemory[] = pool
        .map((item, index) => ({ ...item, rerankScore: byIndex.get(index) ?? Number.NEGATIVE_INFINITY }))
        .sort((left, right) => right.rerankScore - left.rerankScore || right.rrfScore - left.rrfScore || compareMemories(left.memory, right.memory));
      return { status: 'applied', documentCount: pool.length, model: result.model ?? binding.model, candidates };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ source: 'rerank', code: error instanceof AiRequestError ? error.code : 'WM_INTERNAL_ERROR', message });
      console.warn('[WeaveMemory] rerank failed; falling back to RRF order', message);
      return none('failed', { documentCount: pool.length, model: binding.model, error: message });
    }
  }

  private rerankFailure(error: unknown, errors: RecallStageError[]): RecallResult['rerank'] {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof AiRequestError ? error.code : 'WM_INTERNAL_ERROR';
    errors.push({ source: 'rerank', code, message });
    console.warn('[WeaveMemory] rerank setup failed; falling back to RRF order', message);
    return { status: 'failed', documentCount: 0, model: null, error: message, candidates: [] };
  }
}

function timeoutMs(channel: AiChannelRecord): number { return (channel.timeout ?? 120) * 1000; }

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}
