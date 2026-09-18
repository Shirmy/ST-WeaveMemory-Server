import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { OpenAiCompatibleClient } from '../src/ai/openai-compatible-client';
import { SecretBox } from '../src/ai/secret-box';
import { SnapshotContextProvider } from '../src/ai/snapshot-context-provider';
import { StateTaskRunner } from '../src/ai/state-task-runner';
import { DEFAULT_STATE_TASK_SETTINGS } from '../src/ai/types';
import { MemoryRuntime } from '../src/core/runtime';
import { PerChatQueue } from '../src/queue/per-chat-queue';
import { applyCandidate, emptySnapshot, snapshotFingerprint } from '../src/state/apply';
import { StateChainEngine, StateChainError } from '../src/state/chain-engine';
import { applyChangesInPlace } from '../src/state/diff';
import { validateStateSnapshot, type StateAnalysisCandidate, type StateSnapshot } from '../src/state/schema';
import { AiConfigStore } from '../src/storage/ai-config-store';
import { ensureStorageDirectories, resolveStoragePaths } from '../src/storage/data-directory';
import { runMigrations } from '../src/storage/migrations';
import { SqliteDatabase } from '../src/storage/sqlite-database';
import { SqliteStore } from '../src/storage/sqlite-store';
import { StateChainStore, type StateNodeRecord } from '../src/storage/state-chain-store';
import { StateTaskStore } from '../src/storage/state-task-store';

const FLOORS = 1000;
const CHAT_ID = 'chain-1000';
const BRANCH_ID = `main:${CHAT_ID}`;
const CHECKPOINT_INTERVAL = DEFAULT_STATE_TASK_SETTINGS.checkpointInterval;
const SAMPLE_FLOORS = [1, 490, 500, 999, 1000];

const dataRootGlobal = globalThis as typeof globalThis & { DATA_ROOT?: string };

/** Deterministic candidate per floor: every third floor changes nothing, others move NPC state and story time. */
function candidateFor(index: number): StateAnalysisCandidate {
  if (index % 3 === 0) return {};
  const id = `npc${index % 25}`;
  const candidate: StateAnalysisCandidate = {
    traces: { [id]: { currentSituations: [{ id: `s${index}`, text: `situation ${index}` }], affinity: { inner: ((index % 5) - 2) as -2 | -1 | 0 | 1 | 2 } } },
    story: { now: { currentTime: `Day ${index}` } }
  };
  if (index % 7 === 1) candidate.profiles = { [id]: { canonicalName: `NPC ${index % 25}`, basic: { age: String(20 + (index % 40)) } } };
  return candidate;
}

function floorContent(index: number): string {
  return `Floor #${index}: the story continues.`;
}

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function expectChainError(work: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(work, (error: unknown) => error instanceof StateChainError && error.code === 'WM_STATE_SYNC_FAILED' && pattern.test(error.message));
}

async function main(): Promise<void> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'weavememory-chain-1000-'));
  dataRootGlobal.DATA_ROOT = dataRoot;
  let modelCalls = 0;
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      json(res, 404, { error: { message: 'not found' } });
      return;
    }
    const match = body.match(/Floor #(\d+):/);
    if (!match) {
      json(res, 400, { error: { message: 'floor marker missing' } });
      return;
    }
    modelCalls += 1;
    json(res, 200, { model: 'served', choices: [{ message: { content: JSON.stringify(candidateFor(Number(match[1]))) }, finish_reason: 'stop' }] });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;

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
    assert.equal(CHECKPOINT_INTERVAL, 20, 'roadmap §14.2 default: a checkpoint every 20 synced nodes');
    assert.equal((await aiConfig.getStateTaskSettings()).checkpointInterval, 20);
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
    runner = new StateTaskRunner({ store, tasks, aiConfig, client: new OpenAiCompatibleClient(), queue, context: new SnapshotContextProvider(chain, tasks), chain, backoffMs: () => 10 });
    const runtime = new MemoryRuntime(store, queue, runner);
    await aiConfig.saveChannel({ channelId: 'mock', name: 'mock', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'sk-test' });
    await aiConfig.saveBinding('state', 'mock', 'state-model');

    // 1. a real chat / branch with 1000 persisted, consecutive, active floors
    const floors = Array.from({ length: FLOORS }, (_, offset) => ({ messageIndex: offset + 1, swipeId: 0, content: floorContent(offset + 1) }));
    const reconciled = await runtime.reconcileChat({ chatId: CHAT_ID, floors });
    assert.equal(reconciled.branchId, BRANCH_ID);
    assert.equal(reconciled.activeFloorIds.length, FLOORS);

    // 2. every floor is finalized through the real pipeline; jobs run sequentially in floor order
    const startedAll = performance.now();
    const floorKeys: string[] = [];
    let lastJobId: string | null = null;
    for (const floor of floors) {
      const result = await runtime.finalizeFloor({ chatId: CHAT_ID, messageIndex: floor.messageIndex, swipeId: 0, content: floor.content });
      floorKeys.push(result.floorKey);
      assert.equal(result.stateTask?.outcome, 'queued');
      lastJobId = result.stateTask?.jobId ?? null;
    }
    assert.ok(lastJobId);
    const deadline = Date.now() + 600_000;
    for (;;) {
      const job = await tasks.getJob(lastJobId);
      if (job && job.status !== 'pending' && job.status !== 'running') break;
      if (Date.now() > deadline) throw new Error(`timed out waiting for the last job; status ${job?.status ?? 'missing'}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const jobs = await tasks.listJobs({ chatId: CHAT_ID, limit: FLOORS });
    const failed = jobs.find(job => job.status !== 'succeeded');
    assert.equal(failed, undefined, failed ? `job for floor ${failed.messageIndex} ended ${failed.status}: ${failed.errorMessage ?? ''}` : '');
    assert.equal(jobs.length, FLOORS);
    assert.equal(modelCalls, FLOORS);
    const chainMs = performance.now() - startedAll;

    // 3. no gaps: every floor has a synced node, links are consistent, and the whole chain is the trusted prefix
    const nodes = await chainStore.listNodes(BRANCH_ID);
    assert.equal(nodes.length, FLOORS);
    const byFloor = new Map(nodes.map(node => [node.floorId, node]));
    const ordered: StateNodeRecord[] = floorKeys.map(floorKey => {
      const node = byFloor.get(floorKey);
      assert.ok(node, `floor ${floorKey} has no state node`);
      return node;
    });
    for (let index = 0; index < ordered.length; index += 1) {
      const node = ordered[index];
      const previous = index > 0 ? ordered[index - 1] : null;
      assert.equal(node.status, 'synced');
      assert.equal(node.messageIndex, index + 1);
      assert.ok(node.deltaId, 'every node stores a delta');
      assert.ok(node.stateFingerprint);
      assert.equal(node.previousStateNodeId, previous?.stateNodeId ?? null);
      assert.equal(node.previousStateFingerprint, previous?.stateFingerprint ?? null);
    }
    const prefix = await chain.trustedPrefix(CHAT_ID, BRANCH_ID);
    assert.equal(prefix.firstInvalidIndex, null);
    assert.equal(prefix.positions.length, FLOORS);
    assert.ok(prefix.positions.every(position => position.valid));
    assert.equal(prefix.head?.stateNodeId, ordered[FLOORS - 1].stateNodeId);

    // 4. checkpoints follow the default interval and match their nodes
    assert.equal(await chainStore.countCheckpoints(BRANCH_ID), FLOORS / CHECKPOINT_INTERVAL);
    for (const node of ordered) {
      const expectCheckpoint: boolean = node.messageIndex % CHECKPOINT_INTERVAL === 0;
      assert.equal(Boolean(node.checkpointId), expectCheckpoint, `checkpoint presence on floor ${node.messageIndex}`);
      if (!node.checkpointId) continue;
      const checkpoint = await chainStore.getCheckpoint(node.checkpointId);
      assert.ok(checkpoint);
      assert.equal(checkpoint.stateNodeId, node.stateNodeId);
      assert.equal(checkpoint.snapshotFingerprint, node.stateFingerprint);
    }

    // 5. independent expectation: fold the candidates in memory with the timestamps the chain used
    const expected = new Map<number, StateSnapshot>();
    let folded = emptySnapshot(BRANCH_ID);
    const deltasById = await chainStore.getDeltasByNodeIds(ordered.map(node => node.stateNodeId));
    for (let index = 1; index <= FLOORS; index += 1) {
      const node = ordered[index - 1];
      const before = folded;
      folded = applyCandidate(before, candidateFor(index), { branchId: BRANCH_ID, floorId: floorKeys[index - 1], hostChatId: CHAT_ID, now: node.createdAt }).snapshot;
      assert.equal(snapshotFingerprint(folded), node.stateFingerprint, `fingerprint of floor ${index}`);
      const delta = deltasById.get(node.stateNodeId);
      assert.ok(delta, `delta of floor ${index}`);
      const changeCount = delta.profileChanges.length + delta.traceChanges.length + delta.storyChanges.length + delta.rootChanges.length;
      if (index % 3 === 0) {
        assert.equal(changeCount, 0, `no-change floor ${index} still has a node with an empty delta`);
        assert.equal(node.stateFingerprint, ordered[index - 2].stateFingerprint);
      } else {
        assert.ok(changeCount > 0, `floor ${index} recorded changes`);
      }
      if (SAMPLE_FLOORS.includes(index)) expected.set(index, structuredClone(folded));
    }

    // 6. recovery without the head cache must go through checkpoint + later deltas and match exactly
    await database.run('DELETE FROM branch_state_heads WHERE branch_id = ?', [BRANCH_ID]);
    const expectedCheckpointDistance = (index: number): { checkpointFloor: number | null; applied: number } => {
      const checkpointFloor = Math.floor(index / CHECKPOINT_INTERVAL) * CHECKPOINT_INTERVAL;
      return checkpointFloor === 0 ? { checkpointFloor: null, applied: index } : { checkpointFloor, applied: index - checkpointFloor };
    };
    for (const index of SAMPLE_FLOORS) {
      const node = ordered[index - 1];
      const replay = await chain.snapshotAt(node);
      const distance = expectedCheckpointDistance(index);
      assert.equal(replay.fromHeadCache, false);
      assert.equal(replay.checkpointNodeId, distance.checkpointFloor ? ordered[distance.checkpointFloor - 1].stateNodeId : null, `checkpoint used for floor ${index}`);
      assert.equal(replay.appliedDeltas, distance.applied, `deltas applied for floor ${index}`);
      assert.ok(replay.appliedDeltas < CHECKPOINT_INTERVAL, 'replay never walks further than one checkpoint interval');
      validateStateSnapshot(replay.snapshot, { branchId: BRANCH_ID });
      assert.deepEqual(replay.snapshot, expected.get(index));
      assert.equal(snapshotFingerprint(replay.snapshot), node.stateFingerprint);
    }
    const current = await chain.current(CHAT_ID, BRANCH_ID);
    assert.equal(current.node?.stateNodeId, ordered[FLOORS - 1].stateNodeId);
    assert.deepEqual(current.snapshot, expected.get(FLOORS));

    // 7. replaying all 1000 persisted deltas from the empty state stays under the roadmap §66 budget
    const fullTrail = ordered.map(node => {
      const delta = deltasById.get(node.stateNodeId);
      assert.ok(delta);
      return [...delta.profileChanges, ...delta.traceChanges, ...delta.storyChanges, ...delta.rootChanges];
    });
    let replayed: StateSnapshot = emptySnapshot(BRANCH_ID);
    const replayStarted = performance.now();
    for (const changes of fullTrail) replayed = applyChangesInPlace(replayed, changes);
    const replayMs = performance.now() - replayStarted;
    assert.deepEqual(replayed, expected.get(FLOORS));
    assert.ok(replayMs < 100, `replaying 1000 persisted deltas took ${replayMs.toFixed(1)} ms; roadmap §66 requires under 100 ms`);

    // 8. the head cache accelerates but never overrides the chain
    const headNode = ordered[FLOORS - 1];
    await chainStore.upsertBranchHead({ branchId: BRANCH_ID, chatId: CHAT_ID, stateNodeId: headNode.stateNodeId, snapshot: expected.get(FLOORS)!, snapshotFingerprint: headNode.stateFingerprint!, updatedAt: new Date().toISOString() });
    const cached = await chain.snapshotAt(headNode);
    assert.equal(cached.fromHeadCache, true);
    assert.deepEqual(cached.snapshot, expected.get(FLOORS));
    const tamperedSnapshot = structuredClone(expected.get(FLOORS)!);
    tamperedSnapshot.story.now.currentTime = 'tampered';
    await database.run('UPDATE branch_state_heads SET snapshot_json = ? WHERE branch_id = ?', [JSON.stringify(tamperedSnapshot), BRANCH_ID]);
    const afterTamper = await chain.snapshotAt(headNode);
    assert.equal(afterTamper.fromHeadCache, false, 'a cache whose content does not hash to the node fingerprint is ignored');
    assert.deepEqual(afterTamper.snapshot, expected.get(FLOORS));
    await database.run('UPDATE branch_state_heads SET snapshot_json = ?, snapshot_fingerprint = ? WHERE branch_id = ?', [JSON.stringify(expected.get(FLOORS)), 'sha256:bogus', BRANCH_ID]);
    assert.equal((await chain.snapshotAt(headNode)).fromHeadCache, true, 'cache validity is decided by the content hash, not the stored column');
    await database.run('DELETE FROM branch_state_heads WHERE branch_id = ?', [BRANCH_ID]);
    assert.deepEqual((await chain.snapshotAt(headNode)).snapshot, expected.get(FLOORS));

    // 9. a missing, corrupted or mismatching checkpoint is a sync error, never a silently wrong state
    const checkpointNode = ordered[980 - 1];
    const targetNode = ordered[999 - 1];
    const original = await chainStore.getCheckpoint(checkpointNode.checkpointId!);
    assert.ok(original);
    const corrupted = structuredClone(original.snapshot);
    corrupted.story.now.currentTime = 'corrupted';
    await database.run('UPDATE checkpoints SET snapshot_json = ? WHERE checkpoint_id = ?', [JSON.stringify(corrupted), original.checkpointId]);
    await expectChainError(() => chain.snapshotAt(targetNode), /corrupted/);
    await database.run('UPDATE checkpoints SET snapshot_json = ?, snapshot_fingerprint = ? WHERE checkpoint_id = ?', [JSON.stringify(original.snapshot), 'sha256:bogus', original.checkpointId]);
    await expectChainError(() => chain.snapshotAt(targetNode), /does not match/);
    await database.run('DELETE FROM checkpoints WHERE checkpoint_id = ?', [original.checkpointId]);
    await expectChainError(() => chain.snapshotAt(targetNode), /missing/);
    await chainStore.insertCheckpoint(original);
    const restored = await chain.snapshotAt(targetNode);
    assert.equal(restored.checkpointNodeId, checkpointNode.stateNodeId);
    assert.deepEqual(restored.snapshot, expected.get(999));

    console.log(`Phase 5 state chain 1000-floor acceptance passed (chain built in ${(chainMs / 1000).toFixed(1)} s, full 1000-delta replay ${replayMs.toFixed(1)} ms)`);
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
