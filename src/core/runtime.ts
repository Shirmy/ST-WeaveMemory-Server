import { fingerprint } from './fingerprint';
import type { EnqueueOutcome, StateTaskRunner } from '../ai/state-task-runner';
import type { ChatReconcileRequest, CreateBranchRequest, FloorFinalizeRequest, GenerationPrepareRequest, HostChatBindingRequest } from '../protocol';
import { floorKeyFor, type MemoryStore } from '../storage/types';
import { PerChatQueue } from '../queue/per-chat-queue';
import type { ChainPosition, StateChainEngine, TrustedPrefix } from '../state/chain-engine';
import { renderCurrentState } from '../state/current-state';
import { buildRecentContext } from '../state/recent-context';
import { resolveExternalMappings } from '../state/external-mapping';
import type { RecallService } from '../memory/recall';
import type { LongMemoryStore } from '../storage/long-memory-store';
import type { AiConfigStore } from '../storage/ai-config-store';
import { packMemories } from '../memory/token-packer';
import { recordDiagnostics, currentDiagnostics } from './diagnostics';

const GENERATION_GATE_TIMEOUT_MS = 45_000;
const GENERATION_GATE_POLL_MS = 150;

export type FloorFinalizeResult = {
  accepted: boolean;
  floorKey: string;
  /** Null when no state task runner is attached (unit tests of the floor layer). */
  stateTask: EnqueueOutcome | null;
};

export class MemoryRuntime {
  constructor(
    private readonly store: MemoryStore,
    private readonly queue: PerChatQueue,
    private readonly stateTasks: StateTaskRunner | null = null,
    private readonly chain: StateChainEngine | null = null,
    private readonly recall: RecallService | null = null,
    private readonly longMemories: Pick<LongMemoryStore, 'list'> | null = null,
    private readonly aiConfig: Pick<AiConfigStore, 'getLongMemorySettings' | 'getRecallSettings'> | null = null
  ) {}

  async finalizeFloor(input: FloorFinalizeRequest): Promise<FloorFinalizeResult> {
    const result = await this.queue.run(input.chatId, async () => {
      const contentFingerprint = fingerprint(input.content);
      const branchId = input.branchId ?? await this.store.getOrCreateActiveBranch(input.chatId);
      const floorKey = floorKeyFor(input.chatId, branchId, input.messageIndex, input.swipeId, contentFingerprint);
      const now = new Date().toISOString();
      await this.store.upsertFloor({
        floorKey,
        chatId: input.chatId,
        branchId,
        messageIndex: input.messageIndex,
        swipeId: input.swipeId,
        contentFingerprint,
        content: input.content,
        active: true,
        status: 'pending',
        createdAt: now,
        updatedAt: now
      });
      const stateTask = this.stateTasks
        ? await this.stateTasks.enqueueForFloor({
          chatId: input.chatId,
          branchId,
          floorId: floorKey,
          messageIndex: input.messageIndex,
          swipeId: input.swipeId,
          bodyFingerprint: contentFingerprint,
          reason: 'finalize'
        })
        : null;
      return { accepted: true, floorKey, stateTask };
    });
    this.stateTasks?.kick(input.chatId);
    return result;
  }

  async reconcileChat(input: ChatReconcileRequest) {
    const result = await this.queue.run(input.chatId, async () => {
      const reconciled = await this.store.reconcileChat(input);
      const rebuild = this.stateTasks ? await this.stateTasks.handleReconcile(reconciled) : null;
      return { ...reconciled, rebuild };
    });
    this.stateTasks?.kick(input.chatId);
    return result;
  }

  async createBranch(input: CreateBranchRequest) {
    return this.queue.run(input.chatId, () => this.store.createBranch(input));
  }

  async activateBranch(chatId: string, branchId: string) {
    return this.queue.run(chatId, () => this.store.activateBranch(chatId, branchId));
  }

  async bindHostChat(input: HostChatBindingRequest) {
    return this.queue.run(input.chatId, () => this.store.bindHostChat(input));
  }

  async debugCurrent(chatId: string, branchId: string) {
    const tasks = await this.stateTasks?.listTasks({ chatId, branchId, limit: 100 }) ?? [];
    const last = tasks.filter(task => task.result).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    return { ...currentDiagnostics(chatId, branchId), stateTask: last?.result ? { durationMs: last.result.diagnostics.durationMs, model: last.result.diagnostics.model, channelId: last.result.diagnostics.channelId, promptVersion: last.result.diagnostics.promptVersion } : null };
  }

  async prepareGeneration(input: GenerationPrepareRequest) {
    const branchId = await this.store.getOrCreateActiveBranch(input.chatId);
    if (!this.chain || !this.stateTasks) return this.gateFailure('STATE_SYNC_FAILED', null);
    const deadline = Date.now() + GENERATION_GATE_TIMEOUT_MS;
    let resyncStarted = false;
    while (true) {
      const prefix = await this.chain.trustedPrefix(input.chatId, branchId);
      const previous = previousAiPosition(prefix, input.latestUserIndex);
      if (!previous || previous.valid) {
        const view = previous
          ? await this.chain.snapshotAtFloor(input.chatId, branchId, previous.messageIndex, previous.swipeId)
          : null;
        const snapshot = view?.snapshot ?? (await this.chain.current(input.chatId, branchId)).snapshot;
        const recentPositions = prefix.positions.filter(position => position.messageIndex < (input.latestUserIndex ?? Number.MAX_SAFE_INTEGER)).slice(-20);
        const recentFloors = await Promise.all(recentPositions.map(position => this.store.getFloor(position.floorId)));
        const recentItems = buildRecentContext(
          recentFloors.filter(Boolean).map(floor => ({ floorId: floor!.floorKey, messageIndex: floor!.messageIndex, content: floor!.content })),
          { mode: input.recentContextMode, summaryRegex: input.recentSummaryRegex, recentFloorCount: input.recentFloorCount }
        );
        const renderInput = {
          snapshot,
          userText: input.latestUserText,
          recentFloorTexts: recentItems.map(item => item.text),
          recentPositions,
          recentContext: recentItems
        };
        let resolution = resolveExternalMappings();
        try { resolution = resolveExternalMappings(input.externalState); } catch (error) { console.warn('[WeaveMemory] external mapping ignored', error); }
        const before = renderCurrentState(renderInput);
        const rendered = renderCurrentState({ ...renderInput, suppressedWeaveFields: resolution.suppressedWeaveFields });
        const external = input.externalState;
        let longMemory = '';
        let memoryDiagnostics = { memoryCount: 0, memoryTokens: 0, memoryTokenLimit: 0, recallCandidateCount: 0, fixedRecentCount: 0, packedFixedRecentCount: 0, packedHighRelevanceCount: 0, skippedByTokenBudget: 0, skippedByCount: 0 };
        if (this.recall && this.longMemories) {
          try {
            const query = [input.latestUserText, ...recentItems.map(item => item.text)].filter(text => text.trim()).join('\n');
            const recalled = await this.recall.recall(input.chatId, branchId, query);
            const active = await this.longMemories.list(input.chatId, branchId);
            const longSettings = this.aiConfig ? await this.aiConfig.getLongMemorySettings() : { latestForcedCount: 2 };
            const recallSettings = this.aiConfig ? await this.aiConfig.getRecallSettings() : undefined;
            const fixedRecent = active.sort((left, right) => right.endFloor - left.endFloor || right.startFloor - left.startFloor || left.memoryId.localeCompare(right.memoryId)).slice(0, longSettings.latestForcedCount);
            const packStarted = performance.now();
            const packed = packMemories({ recallCandidates: recalled.final, fixedRecentMemories: fixedRecent }, { contextWindow: input.contextSize, currentState: rendered.text, fixedRecentCount: longSettings.latestForcedCount, maxMemoryCount: recallSettings?.finalRecallCount, tokenRatio: recallSettings?.tokenRatio, minTokenBudget: recallSettings?.minTokenBudget, maxTokenBudget: recallSettings?.maxTokenBudget });
            recordDiagnostics(input.chatId, branchId, { recall: { at: new Date().toISOString(), timings: recalled.timings, packMs: performance.now() - packStarted, errors: recalled.errors } });
            longMemory = packed.text;
            memoryDiagnostics = { memoryCount: packed.diagnostics.packedCount, memoryTokens: packed.estimatedTokens, memoryTokenLimit: packed.tokenLimit, recallCandidateCount: packed.diagnostics.recallCandidateCount, fixedRecentCount: packed.diagnostics.fixedRecentCandidateCount, packedFixedRecentCount: packed.diagnostics.packedFixedRecentCount, packedHighRelevanceCount: packed.diagnostics.packedHighRelevanceCount, skippedByTokenBudget: packed.diagnostics.skippedByTokenBudget, skippedByCount: packed.diagnostics.skippedByCount };
          } catch (error) {
            console.warn('[WeaveMemory] long-memory recall failed; blocking generation', error instanceof Error ? error.message : error);
            return this.gateFailure('LONG_MEMORY_RECALL_FAILED', previous?.node?.stateNodeId ?? null);
          }
        }
        recordDiagnostics(input.chatId, branchId, { generation: { at: new Date().toISOString(), longMemory, currentState: rendered.text, estimatedTokens: rendered.tokens + memoryDiagnostics.memoryTokens } });
        return { ready: true, longMemory, currentState: rendered.text, diagnostics: { ...memoryDiagnostics, stateTokens: rendered.tokens, stateNodeId: previous?.node?.stateNodeId, externalSource: external?.source ?? null, mvuDetected: external?.detected ?? false, sourceMessageIndex: external?.messageIndex ?? null, sourceSwipeId: external?.swipeId ?? null, mappingCount: resolution.mappingCount, activeEquivalentMappings: resolution.activeEquivalentMappings, activeRelatedMappings: resolution.activeRelatedMappings, suppressedWeaveFields: resolution.suppressedWeaveFields, mappingFailures: resolution.mappingFailures, tokensBeforeMapping: before.tokens, tokensAfterMapping: rendered.tokens } };
      }
      const status = await this.positionStatus(previous, input.chatId);
      if (!resyncStarted && (status === 'failed' || status === 'missing' || status === 'stale')) {
        resyncStarted = true;
        try { await this.stateTasks.rebuild({ chatId: input.chatId, branchId }); }
        catch (error) {
          console.warn('[WeaveMemory] generation gate resync failed', error);
          return this.gateFailure('STATE_SYNC_FAILED', previous.node?.stateNodeId ?? null);
        }
      }
      if (resyncStarted && status !== 'pending') return this.gateFailure('STATE_SYNC_FAILED', previous.node?.stateNodeId ?? null);
      if (Date.now() >= deadline) return this.gateFailure(status === 'pending' ? 'STATE_SYNC_PENDING_TIMEOUT' : 'STATE_SYNC_FAILED', previous.node?.stateNodeId ?? null);
      await wait(GENERATION_GATE_POLL_MS);
    }
  }

  private async positionStatus(position: ChainPosition, chatId: string): Promise<'pending' | 'failed' | 'missing' | 'stale'> {
    const tasks = await this.stateTasks!.listTasks({ chatId, floorId: position.floorId, limit: 20 });
    if (tasks.some(task => task.status === 'pending' || task.status === 'running')) return 'pending';
    if (tasks.at(-1)?.status === 'failed') return 'failed';
    return position.node ? 'stale' : 'missing';
  }

  private gateFailure(reason: string, stateNodeId: string | null) {
    return { ready: false, reason, longMemory: '', currentState: '', diagnostics: { memoryCount: 0, memoryTokens: 0, stateTokens: 0, stateNodeId: stateNodeId ?? undefined } };
  }
}

function previousAiPosition(prefix: TrustedPrefix, latestUserIndex: number | null): ChainPosition | null {
  const candidates = latestUserIndex === null ? prefix.positions : prefix.positions.filter(position => position.messageIndex < latestUserIndex);
  return candidates.at(-1) ?? null;
}

function wait(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
