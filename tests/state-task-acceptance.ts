import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { OpenAiCompatibleClient } from '../src/ai/openai-compatible-client';
import { SecretBox } from '../src/ai/secret-box';
import { emptyRelevantState, type StateAnalysisContext, type StateContextProvider, type StateContextTarget } from '../src/ai/state-context';
import { StateTaskRunner } from '../src/ai/state-task-runner';
import { dependencyFingerprint, fingerprint } from '../src/core/fingerprint';
import { MemoryRuntime } from '../src/core/runtime';
import { STATE_PROTOCOL_VERSION } from '../src/protocol';
import { PerChatQueue } from '../src/queue/per-chat-queue';
import { STATE_SCHEMA_VERSION } from '../src/state/schema';
import { AiConfigStore } from '../src/storage/ai-config-store';
import { ensureStorageDirectories, resolveStoragePaths } from '../src/storage/data-directory';
import { runMigrations } from '../src/storage/migrations';
import { SqliteDatabase } from '../src/storage/sqlite-database';
import { SqliteStore } from '../src/storage/sqlite-store';
import { StateTaskStore, type StateTaskRecord } from '../src/storage/state-task-store';
import { floorKeyFor } from '../src/storage/types';

type Scripted = (body: Record<string, unknown>, res: http.ServerResponse) => void;
type Message = { role: string; content: string };

const dataRootGlobal = globalThis as typeof globalThis & { DATA_ROOT?: string };
const CHAT_ID = 'task-chat';
const BRANCH_ID = `main:${CHAT_ID}`;

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function completion(content: string, finishReason = 'stop'): unknown {
  return { model: 'served-state-model', choices: [{ message: { content }, finish_reason: finishReason }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function isDone(job: StateTaskRecord): boolean {
  return job.status !== 'pending' && job.status !== 'running';
}

/** Stand-in for the Phase 5 snapshot provider: the test flips the previous-state fingerprint at will. */
class MutableContextProvider implements StateContextProvider {
  previousStateFingerprint: string | null = null;

  async load(target: StateContextTarget): Promise<StateAnalysisContext> {
    return {
      previousRelevantState: emptyRelevantState(target.branchId),
      previousStateFingerprint: this.previousStateFingerprint,
      lockedPaths: [],
      knownCharacters: []
    };
  }
}

async function waitFor(tasks: StateTaskStore, jobId: string, predicate: (job: StateTaskRecord) => boolean, timeoutMs = 15000): Promise<StateTaskRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await tasks.getJob(jobId);
    if (job && predicate(job)) return job;
    if (Date.now() > deadline) throw new Error(`timed out waiting for job ${jobId}; last status ${job?.status ?? 'missing'}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function main(): Promise<void> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'weavememory-state-task-'));
  dataRootGlobal.DATA_ROOT = dataRoot;
  const scripted: Scripted[] = [];
  const requests: Record<string, unknown>[] = [];
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      requests.push(parsed);
      const handler = scripted.shift();
      if (!handler) {
        json(res, 500, { error: { message: 'no scripted response left' } });
        return;
      }
      handler(parsed, res);
      return;
    }
    json(res, 404, { error: { message: 'not found' } });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  const reply = (content: string, finishReason = 'stop'): void => {
    scripted.push((_body, res) => json(res, 200, completion(content, finishReason)));
  };

  let database: SqliteDatabase | null = null;
  let runner: StateTaskRunner | null = null;
  try {
    const paths = resolveStoragePaths();
    await ensureStorageDirectories(paths);
    database = await SqliteDatabase.open(paths.databasePath);
    await runMigrations(database, paths);
    const secrets = await SecretBox.load(paths.secretKeyPath);
    const aiConfig = new AiConfigStore(database, secrets);
    await aiConfig.ensureBuiltinPresets();
    const store = new SqliteStore(database);
    const tasks = new StateTaskStore(database);
    const queue = new PerChatQueue();
    const client = new OpenAiCompatibleClient();
    const contextProvider = new MutableContextProvider();
    const buildRunner = (): StateTaskRunner => new StateTaskRunner({ store, tasks, aiConfig, client, queue, context: contextProvider, backoffMs: () => 10 });
    runner = buildRunner();
    let runtime = new MemoryRuntime(store, queue, runner);

    await aiConfig.saveChannel({ channelId: 'mock', name: 'mock', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'sk-test' });
    await aiConfig.saveBinding('state', 'mock', 'state-model');
    await aiConfig.saveStateTaskSettings({ timeoutSec: 1, maxAttempts: 3 });

    const activeFloors: Array<{ messageIndex: number; swipeId: number | null; content: string }> = [];
    const finalize = async (messageIndex: number, content: string) => {
      const existing = activeFloors.findIndex(floor => floor.messageIndex === messageIndex);
      if (existing >= 0) activeFloors.splice(existing, 1);
      activeFloors.push({ messageIndex, swipeId: 0, content });
      return runtime.finalizeFloor({ chatId: CHAT_ID, messageIndex, swipeId: 0, content });
    };
    const finished = (jobId: string): Promise<StateTaskRecord> => waitFor(tasks, jobId, isDone);

    // 1. happy path: reasoning block + fenced JSON -> normalized candidate, floor synced
    const floor1Content = 'Alice smiled at Bob under the morning sun. It was the first day of spring.';
    reply('<think>let me see</think>\n```json\n{"profiles":{"alice":{"canonicalName":"Alice","aliases":["Ally"]}},"traces":{"alice":{"affinity":{"inner":1}}},"story":{"now":{"currentTime":"Spring, day 1"}},"touchedCharacterIds":["alice"]}\n```');
    const first = await finalize(1, floor1Content);
    assert.equal(first.stateTask?.outcome, 'queued');
    const job1 = await finished(first.stateTask!.jobId);
    assert.equal(job1.status, 'succeeded', job1.errorMessage ?? '');
    assert.equal(job1.attempts, 1);
    assert.equal(job1.result?.candidate.profiles?.alice.canonicalName, 'Alice');
    assert.equal(job1.result?.candidate.traces?.alice.affinity?.inner, 1);
    assert.equal(job1.result?.diagnostics.model, 'state-model');
    assert.equal(job1.result?.diagnostics.servedModel, 'served-state-model');
    assert.equal(job1.payload.statePromptVersion, (await aiConfig.getActivePrompt('state')).promptVersion);
    assert.equal((await store.getFloor(first.floorKey))?.status, 'synced');
    const request1 = requests[0];
    const messages1 = request1.messages as Message[];
    assert.equal(request1.model, 'state-model');
    assert.equal(request1.stream, false);
    assert.equal(request1.temperature, 0);
    assert.equal(request1.max_tokens, 4096);
    assert.equal(messages1[0].role, 'system');
    assert.ok(messages1[0].content.includes('输出契约'));
    assert.ok(messages1[0].content.includes('StateAnalysisResponse'));
    assert.equal(messages1[1].role, 'user');
    assert.ok(messages1[1].content.includes(floor1Content));
    assert.equal(messages1[1].content.includes('"source"'), false);
    assert.equal(messages1[1].content.includes('hostChatId'), false);

    // 2. prose instead of JSON -> corrective retry -> empty candidate for a no-change floor
    reply('Sure! Nothing changed in this scene.');
    reply('{}');
    const second = await finalize(2, 'Nothing much happens here.');
    const job2 = await finished(second.stateTask!.jobId);
    assert.equal(job2.status, 'succeeded', job2.errorMessage ?? '');
    assert.equal(job2.attempts, 2);
    assert.deepEqual(job2.result?.candidate, {});
    const retryMessages = requests[2].messages as Message[];
    assert.equal(retryMessages.length, 4);
    assert.equal(retryMessages[2].role, 'assistant');
    assert.ok(retryMessages[3].content.includes('不符合要求'));

    // 3. schema violation (affinity out of range) -> retry -> accepted
    reply('{"traces":{"bob":{"affinity":{"inner":3}}}}');
    reply('{"traces":{"bob":{"affinity":{"inner":2}}}}');
    const third = await finalize(3, 'Bob confessed.');
    const job3 = await finished(third.stateTask!.jobId);
    assert.equal(job3.status, 'succeeded', job3.errorMessage ?? '');
    assert.equal(job3.attempts, 2);
    assert.equal(job3.result?.candidate.traces?.bob.affinity?.inner, 2);

    // 4. rate limited once -> retry -> success
    scripted.push((_body, res) => json(res, 429, { error: { message: 'slow down' } }));
    reply('{}');
    const fourth = await finalize(4, 'Quiet evening.');
    const job4 = await finished(fourth.stateTask!.jobId);
    assert.equal(job4.status, 'succeeded', job4.errorMessage ?? '');
    assert.equal(job4.attempts, 2);

    // 5. non-retryable provider error -> failed immediately
    scripted.push((_body, res) => json(res, 400, { error: { message: 'bad request' } }));
    const fifth = await finalize(5, 'Broken request.');
    const job5 = await finished(fifth.stateTask!.jobId);
    assert.equal(job5.status, 'failed');
    assert.equal(job5.attempts, 1);
    assert.equal(job5.errorCode, 'WM_AI_REQUEST_FAILED');
    assert.equal((await store.getFloor(fifth.floorKey))?.status, 'failed');

    // 6. timeouts exhaust the attempt budget
    await aiConfig.saveStateTaskSettings({ maxAttempts: 2 });
    for (let index = 0; index < 2; index += 1) {
      scripted.push((_body, res) => {
        setTimeout(() => json(res, 200, completion('{}')), 1500);
      });
    }
    const sixth = await finalize(6, 'Slow model.');
    const job6 = await finished(sixth.stateTask!.jobId);
    assert.equal(job6.status, 'failed');
    assert.equal(job6.errorCode, 'WM_AI_TIMEOUT');
    assert.equal(job6.attempts, 2);
    await aiConfig.saveStateTaskSettings({ maxAttempts: 3 });

    // 7. floor edited while the model is thinking -> job cancelled, late result discarded
    scripted.push((_body, res) => {
      setTimeout(() => json(res, 200, completion('{"story":{"now":{"currentTime":"stale"}}}')), 400);
    });
    const seventh = await finalize(7, 'Version one of floor seven.');
    await waitFor(tasks, seventh.stateTask!.jobId, job => job.status === 'running');
    const requestCountBeforeEdit = requests.length;
    activeFloors.splice(activeFloors.findIndex(floor => floor.messageIndex === 7), 1, { messageIndex: 7, swipeId: 0, content: 'Version two of floor seven.' });
    const reconciled = await runtime.reconcileChat({ chatId: CHAT_ID, floors: activeFloors });
    assert.ok(reconciled.staleFloorIds.includes(seventh.floorKey));
    const job7 = await finished(seventh.stateTask!.jobId);
    assert.equal(job7.status, 'cancelled');
    assert.equal(job7.result, null);
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(requests.length, requestCountBeforeEdit);
    reply('{"story":{"now":{"currentTime":"v2"}}}');
    const seventhV2 = await finalize(7, 'Version two of floor seven.');
    assert.equal(seventhV2.stateTask?.outcome, 'queued');
    const job7v2 = await finished(seventhV2.stateTask!.jobId);
    assert.equal(job7v2.status, 'succeeded', job7v2.errorMessage ?? '');
    assert.equal(job7v2.result?.candidate.story?.now?.currentTime, 'v2');

    // 8. no state model bound -> fail fast without calling any endpoint
    await aiConfig.clearBinding('state');
    const requestCountBeforeUnbound = requests.length;
    const eighth = await finalize(8, 'Unbound.');
    const job8 = await finished(eighth.stateTask!.jobId);
    assert.equal(job8.status, 'failed');
    assert.equal(job8.errorCode, 'WM_AI_CHANNEL_UNAVAILABLE');
    assert.equal(requests.length, requestCountBeforeUnbound);
    await aiConfig.saveBinding('state', 'mock', 'state-model');

    // 9. identical floor + prompt -> reuse the earlier result, no new request
    const requestCountBeforeReuse = requests.length;
    const reused = await finalize(1, floor1Content);
    assert.equal(reused.stateTask?.outcome, 'reused');
    assert.equal(reused.stateTask?.jobId, job1.jobId);
    assert.equal(requests.length, requestCountBeforeReuse);
    assert.equal((await store.getFloor(first.floorKey))?.status, 'synced');

    // 10. prompt change invalidates the dependency -> new job
    const custom = await aiConfig.savePreset({ promptType: 'state', name: 'custom', content: { system: '你是测试用状态模型。', task: '输出 JSON。' } });
    await aiConfig.activatePreset('state', custom.presetId);
    reply('{}');
    const promptChanged = await finalize(1, floor1Content);
    assert.equal(promptChanged.stateTask?.outcome, 'queued');
    const job10 = await finished(promptChanged.stateTask!.jobId);
    assert.equal(job10.status, 'succeeded', job10.errorMessage ?? '');
    assert.notEqual(job10.payload.statePromptVersion, job1.payload.statePromptVersion);
    assert.notEqual(job10.payload.dependencyFingerprint, job1.payload.dependencyFingerprint);
    assert.ok((requests.at(-1)?.messages as Message[])[0].content.startsWith('你是测试用状态模型。'));
    await aiConfig.resetPrompt('state');

    // 11. manual re-run ignores the reuse shortcut
    reply('{}');
    const manual = await runner.requeueFloor(CHAT_ID, first.floorKey);
    assert.equal(manual.outcome, 'queued');
    const job11 = await finished(manual.jobId);
    assert.equal(job11.status, 'succeeded', job11.errorMessage ?? '');
    assert.equal(job11.payload.reason, 'manual');

    // 12. task listing and filters
    const all = await runner.listTasks({ chatId: CHAT_ID });
    assert.equal(all.length, 11);
    assert.equal(all.every(job => job.chatId === CHAT_ID), true);
    const forFloor1 = await runner.listTasks({ chatId: CHAT_ID, floorId: first.floorKey });
    assert.equal(forFloor1.length, 3);
    const failed = await runner.listTasks({ chatId: CHAT_ID, status: 'failed' });
    assert.deepEqual(failed.map(job => job.messageIndex), [5, 6, 8]);
    assert.equal((await runner.listTasks({ chatId: CHAT_ID, branchId: 'other' })).length, 0);

    // 13. restart recovery: a job interrupted mid-flight is picked up by the next runner
    const floor2Key = floorKeyFor(CHAT_ID, BRANCH_ID, 2, 0, fingerprint('Nothing much happens here.'));
    const interrupted = await tasks.createJob({
      chatId: CHAT_ID,
      branchId: BRANCH_ID,
      floorId: floor2Key,
      messageIndex: 2,
      status: 'running',
      payload: { ...job2.payload, reason: 'crash-test' }
    });
    await runner.shutdown();
    runner = buildRunner();
    runtime = new MemoryRuntime(store, queue, runner);
    reply('{"story":{"now":{"currentTime":"after restart"}}}');
    await runner.resumePending();
    const job13 = await finished(interrupted.jobId);
    assert.equal(job13.status, 'succeeded', job13.errorMessage ?? '');
    assert.equal(job13.result?.candidate.story?.now?.currentTime, 'after restart');

    // 14. ad-hoc prompt test does not touch chat data
    const taskCountBefore = (await runner.listTasks({ chatId: CHAT_ID })).length;
    reply('{"story":{"now":{"currentTime":"Day 2"}}}');
    const adHoc = await runner.runAdHoc({ sampleContent: 'The clock struck midnight; day two began.', knownCharacters: [{ characterId: 'alice', canonicalName: 'Alice', aliases: [] }] });
    assert.equal(adHoc.candidate.story?.now?.currentTime, 'Day 2');
    assert.ok(adHoc.rawText.includes('Day 2'));
    assert.equal(adHoc.model, 'state-model');
    assert.ok(((requests.at(-1)?.messages as Message[])[1].content).includes('"characterId":"alice"'));
    assert.equal((await runner.listTasks({ chatId: CHAT_ID })).length, taskCountBefore);

    // 15. the previous effective state changes while the model is thinking -> dependency mismatch -> stale
    contextProvider.previousStateFingerprint = 'sha256:previous-state-A';
    scripted.push((_body, res) => {
      setTimeout(() => json(res, 200, completion('{"story":{"now":{"currentTime":"computed against state A"}}}')), 400);
    });
    const dependentContent = 'Floor twenty depends on the state left by floor nineteen.';
    const dependent = await finalize(20, dependentContent);
    assert.equal(dependent.stateTask?.outcome, 'queued');
    const runningDependent = await waitFor(tasks, dependent.stateTask!.jobId, job => job.status === 'running');
    assert.equal(runningDependent.payload.previousStateFingerprint, 'sha256:previous-state-A');
    contextProvider.previousStateFingerprint = 'sha256:previous-state-B';
    const job15 = await finished(dependent.stateTask!.jobId);
    assert.equal(job15.status, 'stale');
    assert.equal(job15.errorCode, 'WM_TASK_STALE');
    assert.match(job15.errorMessage ?? '', /previous effective state changed/);
    assert.equal(job15.result, null);
    assert.equal((await store.getFloor(dependent.floorKey))?.status, 'pending');

    // 16. the same floor under the new previous state is not reused; it is analysed again and accepted
    reply('{"story":{"now":{"currentTime":"computed against state B"}}}');
    const dependentAgain = await finalize(20, dependentContent);
    assert.equal(dependentAgain.stateTask?.outcome, 'queued');
    assert.notEqual(dependentAgain.stateTask?.jobId, dependent.stateTask?.jobId);
    const job16 = await finished(dependentAgain.stateTask!.jobId);
    assert.equal(job16.status, 'succeeded', job16.errorMessage ?? '');
    assert.equal(job16.result?.candidate.story?.now?.currentTime, 'computed against state B');
    assert.equal(job16.payload.previousStateFingerprint, 'sha256:previous-state-B');
    assert.equal(job16.payload.dependencyFingerprint, dependencyFingerprint({
      bodyFingerprint: fingerprint(dependentContent),
      previousStateFingerprint: 'sha256:previous-state-B',
      protocolVersion: STATE_PROTOCOL_VERSION,
      schemaVersion: STATE_SCHEMA_VERSION,
      promptVersion: (await aiConfig.getActivePrompt('state')).promptVersion
    }));
    assert.equal((await store.getFloor(dependentAgain.floorKey))?.status, 'synced');

    // 17. control case: previous state unchanged during analysis -> normal success
    reply('{}');
    const stableDependent = await finalize(21, 'Floor twenty-one continues quietly.');
    const job17 = await finished(stableDependent.stateTask!.jobId);
    assert.equal(job17.status, 'succeeded', job17.errorMessage ?? '');
    assert.equal(job17.payload.previousStateFingerprint, 'sha256:previous-state-B');
    assert.equal((await store.getFloor(stableDependent.floorKey))?.status, 'synced');

    assert.equal(scripted.length, 0);
    console.log('Phase 4 state task acceptance passed');
  } finally {
    await runner?.shutdown();
    server.closeAllConnections();
    server.close();
    await database?.close();
    delete dataRootGlobal.DATA_ROOT;
    try {
      await fs.rm(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EBUSY')) throw error;
    }
  }
}

void main();
