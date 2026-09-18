import { dependencyFingerprint } from '../core/fingerprint';
import { STATE_PROTOCOL_VERSION } from '../protocol';
import type { PerChatQueue } from '../queue/per-chat-queue';
import { StateApplyError } from '../state/apply';
import { StateChainError, validNodeInPrefix, type StateChainEngine, type TrustedPrefix } from '../state/chain-engine';
import {
  normalizeStateAnalysisResponse,
  STATE_SCHEMA_VERSION,
  StateSchemaError,
  type KnownCharacter,
  type StateAnalysisCandidate,
  type StateAnalysisRequest
} from '../state/schema';
import type { AiConfigStore } from '../storage/ai-config-store';
import type { StateNodeRecord } from '../storage/state-chain-store';
import type { StateTaskFilter, StateTaskPayload, StateTaskRecord, StateTaskResult, StateTaskStore } from '../storage/state-task-store';
import type { ChatReconcileResult, MemoryStore } from '../storage/types';
import { extractJsonObject } from './json-output';
import { AiRequestError, type ChatCompletionResult, type OpenAiCompatibleClient } from './openai-compatible-client';
import { computePromptVersion, renderStateAnalysisMessages, type ChatMessage } from './prompts/state-prompt';
import { emptyRelevantState, type StateAnalysisContext, type StateContextProvider } from './state-context';
import type { AiChannelRecord, PromptContent, StateTaskSettings } from './types';

export const STATE_MAX_OUTPUT_TOKENS = 4096;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 4000;
const RAW_SNIPPET_LENGTH = 2000;
const CORRECTION_OUTPUT_LENGTH = 2000;
const ERROR_OUTPUT_LENGTH = 300;

export class StateTaskError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'StateTaskError';
  }
}

/** The model answered, but the output could not be turned into a valid candidate state. */
export class StateOutputError extends Error {
  constructor(message: string, readonly rawText: string) {
    super(message);
    this.name = 'StateOutputError';
  }
}

export type EnqueueFloorInput = {
  chatId: string;
  branchId: string;
  floorId: string;
  messageIndex: number;
  swipeId: number | null;
  bodyFingerprint: string;
  reason?: string;
  /** Skip every reuse shortcut and call the model again (manual re-run). */
  force?: boolean;
  /** A trusted prefix computed moments ago by the caller, reused instead of scanning the chain again. */
  prefix?: TrustedPrefix;
};

export type EnqueueOutcome = {
  jobId: string | null;
  /** Set when an existing valid state node already covers this floor and dependency. */
  stateNodeId: string | null;
  outcome: 'queued' | 'already-queued' | 'reused';
};

/** Result of a rebuild planning pass (roadmap §21). */
export type RebuildPlan = {
  chatId: string;
  branchId: string;
  firstInvalidIndex: number | null;
  firstLineageBreakIndex: number | null;
  cancelled: number;
  enqueued: EnqueueOutcome | null;
  /** Why nothing was enqueued: the chain is valid, the branch has no chain yet, only the prompt changed, or the floor keeps failing. */
  skipped: 'chain-valid' | 'no-chain' | 'prompt-version' | 'failed-floor' | null;
};

export type RebuildInput = {
  chatId: string;
  branchId?: string;
  /** With `force`, re-analyse this floor even if it is valid; everything after it is rebuilt in order. */
  fromMessageIndex?: number;
  force?: boolean;
};

export type AdHocStateAnalysisInput = {
  sampleContent: string;
  content?: PromptContent;
  presetId?: string;
  knownCharacters?: KnownCharacter[];
};

export type AdHocStateAnalysisResult = {
  candidate: StateAnalysisCandidate;
  rawText: string;
  durationMs: number;
  channelId: string;
  model: string;
  servedModel: string | null;
  promptVersion: string;
  usage: ChatCompletionResult['usage'];
};

export type StateTaskRunnerDeps = {
  store: MemoryStore;
  tasks: StateTaskStore;
  aiConfig: AiConfigStore;
  client: OpenAiCompatibleClient;
  queue: PerChatQueue;
  context: StateContextProvider;
  /** Phase 5 state chain; when absent, candidates are only recorded on the job. */
  chain?: StateChainEngine;
  /** Test hook: overrides the exponential backoff between attempts. */
  backoffMs?: (attempt: number) => number;
};

type ReusePlan = { fromJobId: string; candidate: StateAnalysisCandidate };

type Prepared = {
  job: StateTaskRecord;
  channel: AiChannelRecord | null;
  model: string | null;
  messages: ChatMessage[];
  lockedPaths: string[];
  settings: StateTaskSettings;
  promptVersion: string;
  controller: AbortController;
  previousNode: StateNodeRecord | null;
  reuse: ReusePlan | null;
};

type AnalysisOutcome =
  | { ok: true; attempts: number; result: StateTaskResult }
  | { ok: false; attempts: number; error: AiRequestError };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted || ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

function dependencyOf(bodyFingerprint: string, loaded: StateAnalysisContext, promptVersion: string): string {
  return dependencyFingerprint({
    bodyFingerprint,
    previousStateFingerprint: loaded.previousStateFingerprint,
    protocolVersion: STATE_PROTOCOL_VERSION,
    schemaVersion: STATE_SCHEMA_VERSION,
    promptVersion
  });
}

/**
 * Runs state-analysis jobs: one job at a time per chat (state chains are sequential), with the
 * LLM call outside the chat queue so reconcile / finalize requests are never blocked by a slow
 * model. Before a result is written, the live floor and the full dependency fingerprint
 * (body + previous state + protocol + schema + prompt version) are re-verified; any drift
 * marks the job stale and discards the candidate. With a chain engine attached, accepted
 * candidates become state nodes (roadmap §12) and identical dependencies are reused (§21).
 */
export class StateTaskRunner {
  private readonly loops = new Map<string, Promise<void>>();
  private readonly kicked = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private stopped = false;

  constructor(private readonly deps: StateTaskRunnerDeps) {}

  /** Registers a job for a finalized floor. Must be called while holding the chat's queue slot. */
  async enqueueForFloor(input: EnqueueFloorInput): Promise<EnqueueOutcome> {
    const { tasks, aiConfig, context, store, chain } = this.deps;
    const active = await tasks.findActiveJobForFloor(input.floorId);
    if (active) return { jobId: active.jobId, stateNodeId: null, outcome: 'already-queued' };
    const prompt = await aiConfig.getActivePrompt('state');
    const loaded = await context.load({ chatId: input.chatId, branchId: input.branchId, floorId: input.floorId, messageIndex: input.messageIndex, prefix: input.prefix });
    let dependency: string | null = null;
    let reuseFromJobId: string | null = null;
    if (!loaded.blocked) {
      dependency = dependencyOf(input.bodyFingerprint, loaded, prompt.promptVersion);
      if (!input.force) {
        const priorJob = (await tasks.findSucceededJobs(input.floorId)).find(job => job.payload.dependencyFingerprint === dependency && job.result)
          ?? await tasks.findSucceededJobByDependency(input.branchId, dependency);
        if (chain) {
          const validNode = loaded.prefix ? validNodeInPrefix(loaded.prefix, input.floorId) : await chain.validNodeForFloor(input.chatId, input.branchId, input.floorId);
          if (validNode && validNode.dependencyFingerprint === dependency) {
            await store.updateFloorStatus(input.floorId, 'synced');
            return { jobId: priorJob?.jobId ?? null, stateNodeId: validNode.stateNodeId, outcome: 'reused' };
          }
          reuseFromJobId = priorJob?.jobId ?? null;
        } else if (priorJob) {
          await store.updateFloorStatus(input.floorId, 'synced');
          return { jobId: priorJob.jobId, stateNodeId: null, outcome: 'reused' };
        }
      }
    }
    const payload: StateTaskPayload = {
      swipeId: input.swipeId,
      bodyFingerprint: input.bodyFingerprint,
      dependencyFingerprint: dependency,
      statePromptVersion: prompt.promptVersion,
      previousStateFingerprint: loaded.previousStateFingerprint,
      protocolVersion: STATE_PROTOCOL_VERSION,
      schemaVersion: STATE_SCHEMA_VERSION,
      reason: input.reason ?? 'finalize',
      reuseFromJobId
    };
    const job = await tasks.createJob({ chatId: input.chatId, branchId: input.branchId, floorId: input.floorId, messageIndex: input.messageIndex, payload });
    await store.updateFloorStatus(input.floorId, 'pending');
    return { jobId: job.jobId, stateNodeId: null, outcome: 'queued' };
  }

  /**
   * Called inside the reconcile queue slot (roadmap §19 / §20 / §54): jobs of stale or no longer
   * active floors are cancelled, then the chain is re-planned so the first invalid floor is rebuilt.
   */
  async handleReconcile(result: ChatReconcileResult): Promise<RebuildPlan | null> {
    await this.cancelForFloors(result.staleFloorIds, 'floor became stale during reconcile');
    const { chain, tasks } = this.deps;
    if (!chain) return null;
    const active = new Set(result.activeFloorIds);
    const inactiveJobs = (await tasks.listActiveJobs(result.chatId, result.branchId)).filter(job => !active.has(job.floorId));
    await this.cancelJobs(inactiveJobs, 'floor is no longer the active variant');
    return this.planRebuild(result.chatId, result.branchId, 'auto');
  }

  async cancelForFloors(floorIds: string[], reason: string): Promise<number> {
    if (!floorIds.length) return 0;
    const cancelled = await this.deps.tasks.cancelActiveJobs(floorIds, reason);
    for (const job of cancelled) this.controllers.get(job.jobId)?.abort();
    return cancelled.length;
  }

  /**
   * Roadmap §21: compute the trusted prefix, drop in-flight work that depends on an invalid
   * predecessor, and queue the first invalid floor. Convergence stops the cascade by itself because
   * downstream nodes that still match are simply kept. Must be called while holding the chat's queue slot.
   */
  async planRebuild(chatId: string, branchId: string, mode: 'auto' | 'manual'): Promise<RebuildPlan> {
    const { chain, tasks, store } = this.deps;
    if (!chain) throw new StateTaskError('WM_INTERNAL_ERROR', 'state chain is not available');
    const prefix = await chain.trustedPrefix(chatId, branchId);
    await chain.syncStatuses(prefix);
    const plan: RebuildPlan = {
      chatId,
      branchId,
      firstInvalidIndex: prefix.firstInvalidIndex,
      firstLineageBreakIndex: prefix.firstLineageBreakIndex,
      cancelled: 0,
      enqueued: null,
      skipped: null
    };
    if (prefix.firstInvalidIndex === null) {
      plan.skipped = 'chain-valid';
      return plan;
    }
    const first = prefix.positions.find(position => position.messageIndex === prefix.firstInvalidIndex);
    if (!first) return plan;
    const activeJobs = await tasks.listActiveJobs(chatId, branchId);
    const headFingerprint = prefix.head?.stateFingerprint ?? null;
    // Pending downstream jobs compute their dependency when they start, so only running ones hold a stale previous state.
    plan.cancelled += await this.cancelJobs(
      activeJobs.filter(job => job.messageIndex > first.messageIndex && job.status === 'running'),
      'the chain before this floor is no longer valid; it is rebuilt in order'
    );
    const firstJob = activeJobs.find(job => job.floorId === first.floorId);
    if (firstJob) {
      const stillRight = firstJob.status === 'pending' || (firstJob.payload.previousStateFingerprint ?? null) === headFingerprint;
      if (stillRight) {
        plan.enqueued = { jobId: firstJob.jobId, stateNodeId: null, outcome: 'already-queued' };
        return plan;
      }
      plan.cancelled += await this.cancelJobs([firstJob], 'its previous state changed; re-queued by rebuild');
    }
    if (mode === 'auto') {
      if (first.node && first.lineageValid) {
        // Only the prompt (or protocol) version differs: re-analysing everything is a user decision.
        plan.skipped = 'prompt-version';
        return plan;
      }
      if (!(await chain.branchHasNodes(branchId))) {
        plan.skipped = 'no-chain';
        return plan;
      }
      const latest = (await tasks.listJobs({ chatId, floorId: first.floorId, limit: 1000 })).at(-1);
      // A floor that only failed because its predecessor was not ready is retried; real analysis failures wait for the user.
      if (latest?.status === 'failed' && latest.errorCode !== 'WM_STATE_PENDING') {
        plan.skipped = 'failed-floor';
        return plan;
      }
    }
    const floor = await store.getFloor(first.floorId);
    if (!floor) throw new StateTaskError('WM_INTERNAL_ERROR', `active floor ${first.floorId} is missing`);
    plan.enqueued = await this.enqueueForFloor({
      chatId,
      branchId,
      floorId: floor.floorKey,
      messageIndex: floor.messageIndex,
      swipeId: floor.swipeId,
      bodyFingerprint: floor.contentFingerprint,
      reason: mode === 'auto' ? 'rebuild' : 'manual-rebuild',
      prefix
    });
    return plan;
  }

  /** Manual rebuild (roadmap §51 /state/rebuild): resume from the first invalid floor, or force a floor and everything after it. */
  async rebuild(input: RebuildInput): Promise<RebuildPlan> {
    const { chain, store, tasks, queue } = this.deps;
    if (!chain) throw new StateTaskError('WM_INTERNAL_ERROR', 'state chain is not available');
    const branchId = input.branchId ?? await store.getOrCreateActiveBranch(input.chatId);
    const plan = await queue.run(input.chatId, async () => {
      if (!input.force) return this.planRebuild(input.chatId, branchId, 'manual');
      const from = input.fromMessageIndex;
      if (from === undefined) throw new StateTaskError('WM_INVALID_REQUEST', 'fromMessageIndex is required for a forced rebuild');
      const prefix = await chain.trustedPrefix(input.chatId, branchId);
      const target = prefix.positions.find(position => position.messageIndex === from);
      if (!target) throw new StateTaskError('WM_INVALID_REQUEST', `no active AI floor at message index ${from}`);
      if (prefix.firstInvalidIndex !== null && prefix.firstInvalidIndex < from) {
        throw new StateTaskError('WM_INVALID_REQUEST', `the chain is already invalid from floor ${prefix.firstInvalidIndex}; rebuild from there first`);
      }
      const activeJobs = await tasks.listActiveJobs(input.chatId, branchId);
      const cancelled = await this.cancelJobs(activeJobs.filter(job => job.messageIndex >= from), 'forced rebuild from an earlier floor');
      const floor = await store.getFloor(target.floorId);
      if (!floor) throw new StateTaskError('WM_INTERNAL_ERROR', `active floor ${target.floorId} is missing`);
      const enqueued = await this.enqueueForFloor({
        chatId: input.chatId,
        branchId,
        floorId: floor.floorKey,
        messageIndex: floor.messageIndex,
        swipeId: floor.swipeId,
        bodyFingerprint: floor.contentFingerprint,
        reason: 'manual',
        force: true
      });
      return { chatId: input.chatId, branchId, firstInvalidIndex: prefix.firstInvalidIndex, firstLineageBreakIndex: prefix.firstLineageBreakIndex, cancelled, enqueued, skipped: null } satisfies RebuildPlan;
    });
    this.kick(input.chatId);
    return plan;
  }

  private async cancelJobs(jobs: StateTaskRecord[], reason: string): Promise<number> {
    if (!jobs.length) return 0;
    await this.deps.tasks.cancelJobsByIds(jobs.map(job => job.jobId), reason);
    for (const job of jobs) this.controllers.get(job.jobId)?.abort();
    return jobs.length;
  }

  /** Starts (or nudges) the per-chat drain loop. Safe to call from anywhere outside the queue. */
  kick(chatId: string): void {
    if (this.stopped) return;
    this.kicked.add(chatId);
    if (this.loops.has(chatId)) return;
    const loop = this.runChat(chatId)
      .catch(error => console.error('[WeaveMemory] state task loop failed', chatId, errorMessage(error)))
      .finally(() => {
        if (this.loops.get(chatId) === loop) this.loops.delete(chatId);
      });
    this.loops.set(chatId, loop);
  }

  async requeueFloor(chatId: string, floorId: string): Promise<EnqueueOutcome> {
    const outcome = await this.deps.queue.run(chatId, async () => {
      const floor = await this.deps.store.getFloor(floorId);
      if (!floor || floor.chatId !== chatId) throw new StateTaskError('WM_INVALID_REQUEST', 'floorId does not exist for this chat');
      if (!floor.active) throw new StateTaskError('WM_INVALID_REQUEST', 'floor is not active');
      return this.enqueueForFloor({
        chatId,
        branchId: floor.branchId,
        floorId,
        messageIndex: floor.messageIndex,
        swipeId: floor.swipeId,
        bodyFingerprint: floor.contentFingerprint,
        reason: 'manual',
        force: true
      });
    });
    this.kick(chatId);
    return outcome;
  }

  listTasks(filter: StateTaskFilter): Promise<StateTaskRecord[]> {
    return this.deps.tasks.listJobs(filter);
  }

  /** Boot: interrupted jobs go back to pending and every chat with work gets a drain loop. */
  async resumePending(): Promise<void> {
    const reset = await this.deps.tasks.resetRunningJobs();
    const pending = await this.deps.tasks.chatIdsWithPendingJobs();
    for (const chatId of new Set([...reset, ...pending])) this.kick(chatId);
  }

  /** Aborts in-flight requests; interrupted jobs stay `running` so resumePending() retries them. */
  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([...this.loops.values()]);
  }

  /** Runs the state prompt once against sample text without touching any chat data. */
  async runAdHoc(input: AdHocStateAnalysisInput): Promise<AdHocStateAnalysisResult> {
    const { aiConfig, client } = this.deps;
    const binding = await aiConfig.resolveRole('state');
    if (!binding) throw new AiRequestError('WM_AI_CHANNEL_UNAVAILABLE', 'state model is not bound to any channel', false);
    const settings = await aiConfig.getStateTaskSettings();
    let content = input.content;
    if (!content && input.presetId) {
      const preset = await aiConfig.getPreset(input.presetId);
      if (!preset) throw new StateTaskError('WM_INVALID_REQUEST', 'presetId does not exist');
      content = preset.content;
    }
    if (!content) content = (await aiConfig.getActivePrompt('state')).preset.content;
    const promptVersion = computePromptVersion('state', content);
    const request: StateAnalysisRequest = {
      protocolVersion: STATE_PROTOCOL_VERSION,
      schemaVersion: STATE_SCHEMA_VERSION,
      statePromptVersion: promptVersion,
      floor: { hostChatId: 'adhoc', branchId: 'adhoc', floorId: 'adhoc', messageIndex: 0, swipeId: null, content: input.sampleContent },
      previousRelevantState: emptyRelevantState('adhoc'),
      lockedPaths: [],
      knownCharacters: input.knownCharacters ?? []
    };
    const startedAt = Date.now();
    const completion = await client.chatCompletion(binding.channel, {
      model: binding.model,
      messages: renderStateAnalysisMessages(request, content),
      temperature: 0,
      maxTokens: STATE_MAX_OUTPUT_TOKENS,
      timeoutMs: Math.max(1000, Math.round(settings.timeoutSec * 1000))
    });
    try {
      const candidate = normalizeStateAnalysisResponse(extractJsonObject(completion.text), []);
      return {
        candidate,
        rawText: completion.text,
        durationMs: Date.now() - startedAt,
        channelId: binding.channel.channelId,
        model: binding.model,
        servedModel: completion.model,
        promptVersion,
        usage: completion.usage
      };
    } catch (error) {
      throw new StateOutputError(errorMessage(error), completion.text);
    }
  }

  // ---------------------------------------------------------------- internals

  private async runChat(chatId: string): Promise<void> {
    const { tasks, queue } = this.deps;
    while (!this.stopped) {
      this.kicked.delete(chatId);
      const job = await queue.run(chatId, () => tasks.nextPendingJob(chatId));
      if (!job) {
        if (this.kicked.has(chatId)) continue;
        this.loops.delete(chatId);
        return;
      }
      try {
        await this.executeJob(job);
      } catch (error) {
        console.error('[WeaveMemory] state task crashed', job.jobId, errorMessage(error));
        await queue.run(chatId, async () => {
          const current = await tasks.getJob(job.jobId);
          if (current && (current.status === 'pending' || current.status === 'running')) {
            await tasks.updateJob(job.jobId, { status: 'failed', errorCode: 'WM_INTERNAL_ERROR', errorMessage: errorMessage(error), finishedAt: new Date().toISOString() });
          }
        });
      }
    }
    this.loops.delete(chatId);
  }

  private async executeJob(job: StateTaskRecord): Promise<void> {
    const { queue } = this.deps;
    const prepared = await queue.run(job.chatId, () => this.prepare(job));
    if (!prepared) return;
    let outcome: AnalysisOutcome;
    try {
      outcome = await this.analyze(prepared);
    } finally {
      this.controllers.delete(job.jobId);
    }
    await queue.run(job.chatId, () => this.commit(prepared, outcome));
  }

  private async prepare(job: StateTaskRecord): Promise<Prepared | null> {
    const { tasks, store, aiConfig, context, chain } = this.deps;
    const current = await tasks.getJob(job.jobId);
    if (!current || current.status !== 'pending') return null;
    const now = new Date().toISOString();
    const floor = await store.getFloor(current.floorId);
    if (!floor || floor.contentFingerprint !== current.payload.bodyFingerprint) {
      await tasks.updateJob(current.jobId, { status: 'stale', errorCode: 'WM_TASK_STALE', errorMessage: 'floor no longer exists with the analysed content', finishedAt: now });
      return null;
    }
    if (!floor.active) {
      await tasks.updateJob(current.jobId, { status: 'stale', errorCode: 'WM_TASK_STALE', errorMessage: 'floor is no longer the active variant', finishedAt: now });
      return null;
    }
    const loaded = await context.load({ chatId: current.chatId, branchId: current.branchId, floorId: current.floorId, messageIndex: current.messageIndex });
    if (loaded.blocked) {
      await tasks.updateJob(current.jobId, { status: 'failed', errorCode: loaded.blocked.code, errorMessage: loaded.blocked.message, finishedAt: now });
      return null;
    }
    const settings = await aiConfig.getStateTaskSettings();
    const prompt = await aiConfig.getActivePrompt('state');
    const dependency = dependencyOf(floor.contentFingerprint, loaded, prompt.promptVersion);
    const manual = current.payload.reason === 'manual';
    if (chain && !manual) {
      const validNode = loaded.prefix ? validNodeInPrefix(loaded.prefix, current.floorId) : await chain.validNodeForFloor(current.chatId, current.branchId, current.floorId);
      if (validNode && validNode.dependencyFingerprint === dependency) {
        await tasks.updateJob(current.jobId, { status: 'cancelled', errorCode: 'WM_TASK_CANCELLED', errorMessage: 'floor already has a valid state node for this dependency', finishedAt: now });
        await store.updateFloorStatus(current.floorId, 'synced');
        return null;
      }
    }
    let reuse: ReusePlan | null = null;
    if (chain && !manual) {
      const preferred = current.payload.reuseFromJobId ? await tasks.getJob(current.payload.reuseFromJobId) : null;
      const source = preferred && preferred.result && preferred.payload.dependencyFingerprint === dependency
        ? preferred
        : (await tasks.findSucceededJobs(current.floorId)).find(item => item.jobId !== current.jobId && item.result && item.payload.dependencyFingerprint === dependency)
          ?? await tasks.findSucceededJobByDependency(current.branchId, dependency);
      if (source?.result) reuse = { fromJobId: source.jobId, candidate: source.result.candidate };
    }
    let channel: AiChannelRecord | null = null;
    let model: string | null = null;
    let messages: ChatMessage[] = [];
    if (!reuse) {
      const binding = await aiConfig.resolveRole('state');
      if (!binding) {
        await tasks.updateJob(current.jobId, { status: 'failed', errorCode: 'WM_AI_CHANNEL_UNAVAILABLE', errorMessage: 'state model is not bound to any channel', finishedAt: now });
        await store.updateFloorStatus(current.floorId, 'failed');
        return null;
      }
      channel = binding.channel;
      model = binding.model;
      const request: StateAnalysisRequest = {
        protocolVersion: STATE_PROTOCOL_VERSION,
        schemaVersion: STATE_SCHEMA_VERSION,
        statePromptVersion: prompt.promptVersion,
        floor: {
          hostChatId: current.chatId,
          branchId: current.branchId,
          floorId: current.floorId,
          messageIndex: current.messageIndex,
          swipeId: current.payload.swipeId,
          content: floor.content
        },
        previousRelevantState: loaded.previousRelevantState,
        lockedPaths: loaded.lockedPaths,
        knownCharacters: loaded.knownCharacters
      };
      messages = renderStateAnalysisMessages(request, prompt.preset.content);
    }
    const controller = new AbortController();
    this.controllers.set(current.jobId, controller);
    await tasks.updateJob(current.jobId, {
      status: 'running',
      startedAt: now,
      payload: {
        ...current.payload,
        dependencyFingerprint: dependency,
        statePromptVersion: prompt.promptVersion,
        previousStateFingerprint: loaded.previousStateFingerprint,
        reuseFromJobId: reuse?.fromJobId ?? null
      }
    });
    return {
      job: current,
      channel,
      model,
      messages,
      lockedPaths: loaded.lockedPaths,
      settings,
      promptVersion: prompt.promptVersion,
      controller,
      previousNode: loaded.previousNode ?? null,
      reuse
    };
  }

  private async analyze(prepared: Prepared): Promise<AnalysisOutcome> {
    if (prepared.reuse) {
      return {
        ok: true,
        attempts: 0,
        result: {
          candidate: prepared.reuse.candidate,
          diagnostics: {
            attempts: 0,
            durationMs: 0,
            channelId: '',
            model: '',
            servedModel: null,
            finishReason: null,
            promptVersion: prepared.promptVersion,
            usage: null,
            rawTextSnippet: '',
            stateNodeId: null,
            stateFingerprint: null,
            checkpointId: null,
            reusedFromJobId: prepared.reuse.fromJobId
          }
        }
      };
    }
    const { client } = this.deps;
    const channel = prepared.channel;
    const model = prepared.model;
    if (!channel || !model) return { ok: false, attempts: 0, error: new AiRequestError('WM_AI_CHANNEL_UNAVAILABLE', 'state model is not bound to any channel', false) };
    const maxAttempts = Math.max(1, Math.floor(prepared.settings.maxAttempts));
    const timeoutMs = Math.max(1000, Math.round(prepared.settings.timeoutSec * 1000));
    const startedAt = Date.now();
    const signal = prepared.controller.signal;
    let messages = prepared.messages;
    let attempts = 0;
    let lastError: AiRequestError | null = null;
    while (attempts < maxAttempts) {
      attempts += 1;
      if (signal.aborted) {
        lastError = new AiRequestError('WM_TASK_CANCELLED', 'task was cancelled', false);
        break;
      }
      let completion: ChatCompletionResult;
      try {
        completion = await client.chatCompletion(channel, {
          model,
          messages,
          temperature: 0,
          maxTokens: STATE_MAX_OUTPUT_TOKENS,
          timeoutMs,
          signal
        });
      } catch (error) {
        lastError = error instanceof AiRequestError ? error : new AiRequestError('WM_AI_REQUEST_FAILED', errorMessage(error), false);
        if (lastError.code === 'WM_TASK_CANCELLED' || !lastError.retryable || attempts >= maxAttempts) break;
        await this.backoff(attempts, signal);
        continue;
      }
      try {
        const candidate = normalizeStateAnalysisResponse(extractJsonObject(completion.text), prepared.lockedPaths);
        return {
          ok: true,
          attempts,
          result: {
            candidate,
            diagnostics: {
              attempts,
              durationMs: Date.now() - startedAt,
              channelId: channel.channelId,
              model,
              servedModel: completion.model,
              finishReason: completion.finishReason,
              promptVersion: prepared.promptVersion,
              usage: completion.usage,
              rawTextSnippet: completion.text.slice(0, RAW_SNIPPET_LENGTH),
              stateNodeId: null,
              stateFingerprint: null,
              checkpointId: null,
              reusedFromJobId: null
            }
          }
        };
      } catch (error) {
        const reason = error instanceof StateSchemaError ? `candidate state rejected (${error.message})` : errorMessage(error);
        const outputSnippet = completion.text.replace(/\s+/g, ' ').slice(0, ERROR_OUTPUT_LENGTH);
        lastError = new AiRequestError('WM_INVALID_RESPONSE', `${reason}; output: ${outputSnippet}`, true);
        if (attempts >= maxAttempts) break;
        messages = [
          ...prepared.messages,
          { role: 'assistant', content: completion.text.slice(0, CORRECTION_OUTPUT_LENGTH) },
          { role: 'user', content: `上一次输出不符合要求：${reason}。请只输出一个符合 JSON Schema 的 JSON 对象，不要围栏，不要解释。` }
        ];
        await this.backoff(attempts, signal);
      }
    }
    return { ok: false, attempts, error: lastError ?? new AiRequestError('WM_AI_REQUEST_FAILED', 'state analysis produced no result', false) };
  }

  private async commit(prepared: Prepared, outcome: AnalysisOutcome): Promise<void> {
    const { tasks, store, aiConfig, context, chain } = this.deps;
    const jobId = prepared.job.jobId;
    const current = await tasks.getJob(jobId);
    if (!current || current.status !== 'running') return;
    const now = new Date().toISOString();
    const discardAsStale = (message: string): Promise<StateTaskRecord | null> =>
      tasks.updateJob(jobId, { status: 'stale', attempts: outcome.attempts, errorCode: 'WM_TASK_STALE', errorMessage: `${message}; result discarded`, finishedAt: now });
    if (!outcome.ok) {
      if (outcome.error.code === 'WM_TASK_CANCELLED') {
        // A shutdown interrupts the job; leave it `running` so the next boot retries it.
        if (this.stopped) return;
        await tasks.updateJob(jobId, { status: 'cancelled', attempts: outcome.attempts, errorCode: outcome.error.code, errorMessage: outcome.error.message, finishedAt: now });
        return;
      }
      await tasks.updateJob(jobId, { status: 'failed', attempts: outcome.attempts, errorCode: outcome.error.code, errorMessage: outcome.error.message, finishedAt: now });
      await store.updateFloorStatus(current.floorId, 'failed');
      return;
    }
    // Roadmap §54: re-verify the live floor and the full dependency fingerprint (§13) before accepting the candidate.
    const floor = await store.getFloor(current.floorId);
    if (!floor || floor.contentFingerprint !== current.payload.bodyFingerprint) {
      await discardAsStale('floor changed during analysis');
      return;
    }
    if (!floor.active) {
      await discardAsStale('floor is no longer the active variant');
      return;
    }
    const loaded = await context.load({ chatId: current.chatId, branchId: current.branchId, floorId: current.floorId, messageIndex: current.messageIndex });
    const activePrompt = await aiConfig.getActivePrompt('state');
    const currentDependency = dependencyOf(floor.contentFingerprint, loaded, activePrompt.promptVersion);
    if (loaded.blocked || currentDependency !== current.payload.dependencyFingerprint) {
      const cause = loaded.blocked
        ? 'previous state is no longer available'
        : activePrompt.promptVersion !== current.payload.statePromptVersion
          ? 'state prompt changed during analysis'
          : loaded.previousStateFingerprint !== current.payload.previousStateFingerprint
            ? 'previous effective state changed during analysis'
            : 'dependency fingerprint changed during analysis';
      await discardAsStale(cause);
      return;
    }
    const result = outcome.result;
    if (chain) {
      try {
        const committed = await chain.commitCandidate({
          chatId: current.chatId,
          branchId: current.branchId,
          hostChatId: current.chatId,
          floorId: current.floorId,
          messageIndex: current.messageIndex,
          swipeId: current.payload.swipeId,
          bodyFingerprint: floor.contentFingerprint,
          dependencyFingerprint: currentDependency,
          candidate: result.candidate,
          previous: loaded.previousNode ?? null,
          now
        });
        result.diagnostics = {
          ...result.diagnostics,
          stateNodeId: committed.node.stateNodeId,
          stateFingerprint: committed.node.stateFingerprint,
          checkpointId: committed.checkpointId
        };
      } catch (error) {
        if (error instanceof StateApplyError || error instanceof StateChainError) {
          await tasks.updateJob(jobId, { status: 'failed', attempts: outcome.attempts, errorCode: 'WM_STATE_SYNC_FAILED', errorMessage: `candidate could not be applied: ${error.message}`, finishedAt: now });
          await store.updateFloorStatus(current.floorId, 'failed');
          return;
        }
        throw error;
      }
      await tasks.updateJob(jobId, { status: 'succeeded', attempts: outcome.attempts, result, errorCode: null, errorMessage: null, finishedAt: now });
      // Roadmap §21: keep rebuilding forward until the chain converges or ends. A cascade started by the
      // user (manual re-run or forced rebuild) keeps its manual intent so prompt-version and failure guards do not stop it.
      const mode = current.payload.reason === 'manual' || current.payload.reason === 'manual-rebuild' ? 'manual' : 'auto';
      try {
        await this.planRebuild(current.chatId, current.branchId, mode);
      } catch (error) {
        console.error('[WeaveMemory] rebuild planning after commit failed', current.chatId, errorMessage(error));
      }
      return;
    }
    await tasks.updateJob(jobId, { status: 'succeeded', attempts: outcome.attempts, result, errorCode: null, errorMessage: null, finishedAt: now });
    await store.updateFloorStatus(current.floorId, 'synced');
  }

  private backoff(attempt: number, signal: AbortSignal): Promise<void> {
    const ms = this.deps.backoffMs ? this.deps.backoffMs(attempt) : Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS);
    return sleep(ms, signal);
  }
}
