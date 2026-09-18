import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { OpenAiCompatibleClient } from '../src/ai/openai-compatible-client';
import { SecretBox } from '../src/ai/secret-box';
import { SnapshotContextProvider } from '../src/ai/snapshot-context-provider';
import { StateTaskRunner } from '../src/ai/state-task-runner';
import { MemoryRuntime } from '../src/core/runtime';
import { PerChatQueue } from '../src/queue/per-chat-queue';
import { StateChainEngine } from '../src/state/chain-engine';
import { validateStateSnapshot } from '../src/state/schema';
import { AiConfigStore } from '../src/storage/ai-config-store';
import { ensureStorageDirectories, resolveStoragePaths } from '../src/storage/data-directory';
import { runMigrations } from '../src/storage/migrations';
import { SqliteDatabase } from '../src/storage/sqlite-database';
import { SqliteStore } from '../src/storage/sqlite-store';
import { StateChainStore, type StateNodeRecord } from '../src/storage/state-chain-store';
import { StateTaskStore, type StateTaskRecord } from '../src/storage/state-task-store';

type Scripted = (body: Record<string, unknown>, res: http.ServerResponse) => void;
type Message = { role: string; content: string };

const dataRootGlobal = globalThis as typeof globalThis & { DATA_ROOT?: string };
const CHAT_ID = 'chain-chat';
const BRANCH_ID = `main:${CHAT_ID}`;

const FLOOR_ONE = '{"profiles":{"alice":{"canonicalName":"Alice","aliases":["Ally"],"basic":{"age":"20"}}},"traces":{"alice":{"affinity":{"inner":1}}}}';
const FLOOR_TWO = '{"profiles":{"bob":{"canonicalName":"Bob"}},"traces":{"ally":{"affinity":{"outer":-1}},"bob":{"currentSituations":[{"id":"s1","text":"guarding the gate"}]}},"story":{"now":{"currentTime":"Day 1 noon"}}}';
const FLOOR_TWO_ALT = '{"profiles":{"bob":{"canonicalName":"Bob","basic":{"age":"40"}}},"traces":{"ally":{"affinity":{"outer":-1}},"bob":{"currentSituations":[{"id":"s1","text":"guarding the gate"}]}},"story":{"now":{"currentTime":"Day 1 noon"}}}';

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function completion(content: string): unknown {
  return { model: 'served', choices: [{ message: { content }, finish_reason: 'stop' }] };
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function isDone(job: StateTaskRecord): boolean {
  return job.status !== 'pending' && job.status !== 'running';
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
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'weavememory-state-chain-'));
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
  const reply = (content: string): void => {
    scripted.push((_body, res) => json(res, 200, completion(content)));
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
    const chainStore = new StateChainStore(database);
    const chain = new StateChainEngine({
      database,
      chain: chainStore,
      store,
      checkpointInterval: async () => (await aiConfig.getStateTaskSettings()).checkpointInterval
    });
    const queue = new PerChatQueue();
    const client = new OpenAiCompatibleClient();
    runner = new StateTaskRunner({ store, tasks, aiConfig, client, queue, context: new SnapshotContextProvider(chain, tasks), chain, backoffMs: () => 10 });
    const runtime = new MemoryRuntime(store, queue, runner);
    await aiConfig.saveChannel({ channelId: 'mock', name: 'mock', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'sk-test' });
    await aiConfig.saveBinding('state', 'mock', 'state-model');
    await aiConfig.saveStateTaskSettings({ timeoutSec: 1, maxAttempts: 2, checkpointInterval: 4 });

    const activeFloors: Array<{ messageIndex: number; swipeId: number | null; content: string }> = [];
    const finalize = async (messageIndex: number, content: string) => {
      const existing = activeFloors.findIndex(floor => floor.messageIndex === messageIndex);
      if (existing >= 0) activeFloors.splice(existing, 1);
      activeFloors.push({ messageIndex, swipeId: 0, content });
      activeFloors.sort((left, right) => left.messageIndex - right.messageIndex);
      const result = await runtime.finalizeFloor({ chatId: CHAT_ID, messageIndex, swipeId: 0, content });
      await runtime.reconcileChat({ chatId: CHAT_ID, floors: activeFloors });
      return result;
    };
    const finished = (jobId: string): Promise<StateTaskRecord> => waitFor(tasks, jobId, isDone);
    const nodeOf = async (job: StateTaskRecord): Promise<StateNodeRecord> => {
      const stateNodeId = job.result?.diagnostics.stateNodeId;
      assert.ok(stateNodeId, `job ${job.jobId} produced no state node (${job.status}: ${job.errorMessage ?? ''})`);
      const node = await chainStore.getNode(stateNodeId);
      assert.ok(node);
      return node;
    };

    // 1. three floors form a chain; the third floor changes nothing but still gets a node
    reply(FLOOR_ONE);
    const first = await finalize(1, 'Alice arrives at the gate.');
    const job1 = await finished(first.stateTask!.jobId!);
    assert.equal(job1.status, 'succeeded', job1.errorMessage ?? '');
    const node1 = await nodeOf(job1);
    assert.equal(node1.previousStateNodeId, null);
    assert.equal(node1.previousStateFingerprint, null);
    assert.equal(node1.status, 'synced');
    assert.equal(node1.dependencyFingerprint, job1.payload.dependencyFingerprint);
    assert.equal((await store.getFloor(first.floorKey))?.status, 'synced');

    reply(FLOOR_TWO);
    const second = await finalize(2, 'Bob appears. Alice hides her feelings.');
    const job2 = await finished(second.stateTask!.jobId!);
    assert.equal(job2.status, 'succeeded', job2.errorMessage ?? '');
    const node2 = await nodeOf(job2);
    assert.equal(node2.previousStateNodeId, node1.stateNodeId);
    assert.equal(node2.previousStateFingerprint, node1.stateFingerprint);
    assert.equal(job2.payload.previousStateFingerprint, node1.stateFingerprint);
    const secondRequest = (requests[1].messages as Message[])[1].content;
    assert.ok(secondRequest.includes('"alice"'), 'floor 2 sees the state left by floor 1');
    assert.ok(secondRequest.includes('"Ally"'), 'known characters carry aliases');
    const afterTwo = await chain.current(CHAT_ID, BRANCH_ID);
    validateStateSnapshot(afterTwo.snapshot, { branchId: BRANCH_ID });
    assert.equal(afterTwo.node?.stateNodeId, node2.stateNodeId);
    assert.equal(afterTwo.snapshot.traces.alice.affinity.inner, 1);
    assert.equal(afterTwo.snapshot.traces.alice.affinity.outer, -1);
    assert.equal(afterTwo.snapshot.profiles.alice.basic.age, '20');
    assert.equal(afterTwo.snapshot.traces.bob.currentSituations[0].text, 'guarding the gate');
    assert.equal(afterTwo.snapshot.story.now.currentTime, 'Day 1 noon');
    assert.deepEqual(afterTwo.snapshot.profiles.bob.source.sourceFloorIds, [second.floorKey]);

    reply('{}');
    const third = await finalize(3, 'A quiet moment passes.');
    const job3 = await finished(third.stateTask!.jobId!);
    const node3 = await nodeOf(job3);
    assert.equal(node3.previousStateNodeId, node2.stateNodeId);
    assert.equal(node3.stateFingerprint, node2.stateFingerprint, 'no-change floors keep the fingerprint');
    const delta3 = await chainStore.getDelta(node3.deltaId!);
    assert.deepEqual([delta3?.profileChanges, delta3?.traceChanges, delta3?.storyChanges, delta3?.rootChanges], [[], [], [], []]);

    // 2. replay reproduces the exact snapshot of an earlier node
    const replayTwo = await chain.snapshotAt(node2);
    assert.equal(replayTwo.fromHeadCache, false);
    assert.equal(replayTwo.appliedDeltas, 2);
    assert.deepEqual(replayTwo.snapshot, afterTwo.snapshot);

    // 3. checkpoints every 4 nodes shorten replay
    const nodes: StateNodeRecord[] = [node1, node2, node3];
    for (let index = 4; index <= 9; index += 1) {
      reply(`{"story":{"now":{"currentTime":"Day ${index}"}}}`);
      const result = await finalize(index, `Floor ${index} of the story.`);
      nodes.push(await nodeOf(await finished(result.stateTask!.jobId!)));
    }
    assert.equal(await chainStore.countCheckpoints(BRANCH_ID), 2);
    assert.ok(nodes[3].checkpointId, 'node 4 is a checkpoint');
    assert.ok(nodes[7].checkpointId, 'node 8 is a checkpoint');
    assert.equal(nodes[8].checkpointId, null);
    const replaySeven = await chain.snapshotAt(nodes[6]);
    assert.equal(replaySeven.checkpointNodeId, nodes[3].stateNodeId);
    assert.equal(replaySeven.appliedDeltas, 3);
    assert.equal(replaySeven.snapshot.story.now.currentTime, 'Day 7');
    const replayEight = await chain.snapshotAt(nodes[7]);
    assert.equal(replayEight.appliedDeltas, 0);
    assert.equal(replayEight.checkpointNodeId, nodes[7].stateNodeId);
    const replayNine = await chain.snapshotAt(nodes[8]);
    assert.equal(replayNine.fromHeadCache, true);
    assert.equal(replayNine.snapshot.story.now.currentTime, 'Day 9');

    // 4. a failed floor blocks the next one without calling the model; manual re-runs heal the chain in order
    scripted.push((_body, res) => json(res, 400, { error: { message: 'bad request' } }));
    const tenth = await finalize(10, 'Floor ten fails.');
    const job10 = await finished(tenth.stateTask!.jobId!);
    assert.equal(job10.status, 'failed');
    const requestsBeforeBlocked = requests.length;
    const eleventh = await finalize(11, 'Floor eleven waits.');
    const job11 = await finished(eleventh.stateTask!.jobId!);
    assert.equal(job11.status, 'failed');
    assert.equal(job11.errorCode, 'WM_STATE_PENDING');
    assert.equal(requests.length, requestsBeforeBlocked);
    reply('{"story":{"now":{"currentTime":"Day 10"}}}');
    const node10 = await nodeOf(await finished((await runner.requeueFloor(CHAT_ID, tenth.floorKey)).jobId!));
    assert.equal(node10.previousStateNodeId, nodes[8].stateNodeId);
    reply('{"story":{"now":{"currentTime":"Day 11"}}}');
    const node11 = await nodeOf(await finished((await runner.requeueFloor(CHAT_ID, eleventh.floorKey)).jobId!));
    assert.equal(node11.previousStateNodeId, node10.stateNodeId);
    const healed = await chain.trustedPrefix(CHAT_ID, BRANCH_ID);
    assert.equal(healed.firstInvalidIndex, null);
    assert.equal(healed.head?.stateNodeId, node11.stateNodeId);

    // 5. re-analysing an earlier floor with a different result breaks the lineage after it
    reply(FLOOR_TWO_ALT);
    const job2b = await finished((await runner.requeueFloor(CHAT_ID, second.floorKey)).jobId!);
    const node2b = await nodeOf(job2b);
    assert.equal(node2b.previousStateNodeId, node1.stateNodeId);
    assert.notEqual(node2b.stateFingerprint, node2.stateFingerprint);
    const broken = await chain.trustedPrefix(CHAT_ID, BRANCH_ID);
    assert.equal(broken.firstInvalidIndex, 3);
    assert.equal(broken.head?.stateNodeId, node2b.stateNodeId);
    reply('{}');
    const thirdAgain = await finalize(3, 'A quiet moment passes.');
    assert.equal(thirdAgain.stateTask?.outcome, 'queued', 'a changed previous state forbids reuse');
    const node3b = await nodeOf(await finished(thirdAgain.stateTask!.jobId!));
    assert.equal(node3b.previousStateFingerprint, node2b.stateFingerprint);
    assert.equal((await chain.trustedPrefix(CHAT_ID, BRANCH_ID)).firstInvalidIndex, 4);

    // 6. convergence: landing on the original state makes the original downstream nodes valid again with no model calls
    reply(FLOOR_TWO);
    const requestsBeforeConvergence = requests.length;
    const node2c = await nodeOf(await finished((await runner.requeueFloor(CHAT_ID, second.floorKey)).jobId!));
    assert.equal(node2c.stateFingerprint, node2.stateFingerprint);
    assert.equal(requests.length, requestsBeforeConvergence + 1);
    const converged = await chain.trustedPrefix(CHAT_ID, BRANCH_ID);
    assert.equal(converged.firstInvalidIndex, null);
    assert.equal(converged.head?.stateNodeId, node11.stateNodeId);
    assert.equal(converged.positions[2].node?.stateNodeId, node3.stateNodeId);

    // 7. state at a floor and the current view
    const atTwo = await chain.snapshotAtFloor(CHAT_ID, BRANCH_ID, 2, 0);
    assert.equal(atTwo?.node.stateNodeId, node2c.stateNodeId);
    assert.equal(atTwo?.valid, true);
    assert.equal(atTwo?.snapshot.profiles.bob.basic.age, undefined);
    const current = await chain.current(CHAT_ID, BRANCH_ID);
    validateStateSnapshot(current.snapshot, { branchId: BRANCH_ID });
    assert.equal(current.node?.stateNodeId, node11.stateNodeId);
    assert.equal(current.snapshot.story.now.currentTime, 'Day 11');

    // 8. finalizing an already synced floor again reuses the node without a job
    const requestsBeforeReuse = requests.length;
    const eleventhAgain = await finalize(11, 'Floor eleven waits.');
    assert.equal(eleventhAgain.stateTask?.outcome, 'reused');
    assert.equal(eleventhAgain.stateTask?.stateNodeId, node11.stateNodeId);
    assert.equal(requests.length, requestsBeforeReuse);

    // 9. a stored candidate with the same dependency is re-applied without the model
    await chainStore.updateNodeStatus(node3.stateNodeId, 'stale', new Date().toISOString());
    assert.equal((await chain.trustedPrefix(CHAT_ID, BRANCH_ID)).firstInvalidIndex, 3);
    const requestsBeforeReapply = requests.length;
    const thirdReapplied = await finalize(3, 'A quiet moment passes.');
    assert.equal(thirdReapplied.stateTask?.outcome, 'queued');
    const job3c = await finished(thirdReapplied.stateTask!.jobId!);
    assert.equal(job3c.status, 'succeeded', job3c.errorMessage ?? '');
    assert.equal(job3c.payload.reuseFromJobId, job3.jobId);
    assert.equal(job3c.result?.diagnostics.reusedFromJobId, job3.jobId);
    assert.equal(requests.length, requestsBeforeReapply);
    const node3c = await nodeOf(job3c);
    assert.equal(node3c.stateFingerprint, node3.stateFingerprint);
    const reapplied = await chain.trustedPrefix(CHAT_ID, BRANCH_ID);
    assert.equal(reapplied.firstInvalidIndex, null);
    assert.equal(reapplied.head?.stateNodeId, node11.stateNodeId);

    assert.equal(scripted.length, 0);
    console.log('Phase 5 state chain acceptance passed');
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
