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
import { StateChainEngine, type TrustedPrefix } from '../src/state/chain-engine';
import { AiConfigStore } from '../src/storage/ai-config-store';
import { ensureStorageDirectories, resolveStoragePaths } from '../src/storage/data-directory';
import { runMigrations } from '../src/storage/migrations';
import { SqliteDatabase } from '../src/storage/sqlite-database';
import { SqliteStore } from '../src/storage/sqlite-store';
import { StateChainStore, type StateNodeRecord } from '../src/storage/state-chain-store';
import { StateTaskStore, type StateTaskRecord } from '../src/storage/state-task-store';

type Floor = { messageIndex: number; swipeId: number | null; content: string };

const dataRootGlobal = globalThis as typeof globalThis & { DATA_ROOT?: string };
const CHAT_ID = 'rebuild-chat';
const BRANCH_ID = `main:${CHAT_ID}`;

/** Candidate per story floor `k` and content version `v`; only floor 3 v3 changes the story state. */
function candidateFor(k: number, v: number): string {
  switch (k) {
    case 1: return '{"profiles":{"alice":{"canonicalName":"Alice","basic":{"age":"20"}}},"traces":{"alice":{"affinity":{"inner":0}}},"story":{"now":{"currentTime":"Day 1"}}}';
    case 2: return '{"traces":{"alice":{"affinity":{"inner":1}}},"story":{"now":{"currentTime":"Day 2"}}}';
    case 3: return v >= 3
      ? '{"profiles":{"alice":{"basic":{"age":"21"}}},"story":{"now":{"currentTime":"Day 3"}}}'
      : '{"story":{"now":{"currentTime":"Day 3"}}}';
    case 4: return '{"traces":{"bob":{"currentSituations":[{"id":"s4","text":"at the gate"}]}},"story":{"now":{"currentTime":"Day 4"}}}';
    case 5: return '{"profiles":{"alice":{"basic":{"age":"30"}}},"story":{"now":{"currentTime":"Day 5"}}}';
    default: return `{"story":{"now":{"currentTime":"Day ${k}"}}}`;
  }
}

const body = (k: number, v = 1): string => `Floor #${k} v${v}: the story continues.`;

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'weavememory-rebuild-'));
  dataRootGlobal.DATA_ROOT = dataRoot;
  let calls = 0;
  const delays = new Map<string, number>();
  const failing = new Set<string>();
  const server = http.createServer(async (req, res) => {
    const text = await readBody(req);
    const match = text.match(/Floor #(\d+) v(\d+):/);
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions' || !match) {
      json(res, 404, { error: { message: 'not found' } });
      return;
    }
    calls += 1;
    const marker = `${match[1]} v${match[2]}`;
    const respond = (): void => {
      if (failing.has(marker)) {
        json(res, 400, { error: { message: `scripted failure for ${marker}` } });
        return;
      }
      json(res, 200, { model: 'served', choices: [{ message: { content: candidateFor(Number(match[1]), Number(match[2])) }, finish_reason: 'stop' }] });
    };
    const delay = delays.get(marker);
    if (delay) setTimeout(respond, delay);
    else respond();
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
    const store = new SqliteStore(database);
    const tasks = new StateTaskStore(database);
    const chainStore = new StateChainStore(database);
    const chain = new StateChainEngine({
      database,
      chain: chainStore,
      store,
      checkpointInterval: async () => (await aiConfig.getStateTaskSettings()).checkpointInterval,
      promptVersion: async () => (await aiConfig.getActivePrompt('state')).promptVersion
    });
    const queue = new PerChatQueue();
    runner = new StateTaskRunner({ store, tasks, aiConfig, client: new OpenAiCompatibleClient(), queue, context: new SnapshotContextProvider(chain, tasks), chain, backoffMs: () => 10 });
    const runtime = new MemoryRuntime(store, queue, runner);
    await aiConfig.saveChannel({ channelId: 'mock', name: 'mock', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'sk-test' });
    await aiConfig.saveBinding('state', 'mock', 'state-model');
    await aiConfig.saveStateTaskSettings({ timeoutSec: 2, maxAttempts: 2, checkpointInterval: 3 });

    const floors: Floor[] = [];
    const reconcile = () => runtime.reconcileChat({ chatId: CHAT_ID, floors: floors.map(floor => ({ ...floor })) });
    const settle = async (chatId = CHAT_ID, timeoutMs = 20000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const active = await tasks.listActiveJobs(chatId, `main:${chatId}`);
        if (!active.length) {
          // Rebuild planning runs inside the commit's queue slot; wait for the queue to drain before reading.
          await queue.run(chatId, async () => undefined);
          if (!(await tasks.listActiveJobs(chatId, `main:${chatId}`)).length) return;
        }
        if (Date.now() > deadline) throw new Error(`jobs did not settle: ${active.map(job => `${job.messageIndex}:${job.status}`).join(', ')}`);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    };
    const prefixNow = (): Promise<TrustedPrefix> => chain.trustedPrefix(CHAT_ID, BRANCH_ID);
    const nodeAt = (prefix: TrustedPrefix, messageIndex: number): StateNodeRecord => {
      const position = prefix.positions.find(item => item.messageIndex === messageIndex);
      assert.ok(position?.node, `floor ${messageIndex} has no node`);
      return position.node;
    };
    const latestJobFor = async (floorId: string): Promise<StateTaskRecord | undefined> => (await tasks.listJobs({ chatId: CHAT_ID, floorId })).at(-1);

    // 1. baseline: eight floors generated one after another, reconciled after each like the frontend does
    for (let k = 1; k <= 8; k += 1) {
      floors.push({ messageIndex: k, swipeId: 0, content: body(k) });
      await runtime.finalizeFloor({ chatId: CHAT_ID, messageIndex: k, swipeId: 0, content: body(k) });
      const result = await reconcile();
      assert.equal(result.rebuild?.enqueued?.outcome, 'already-queued', 'reconcile right after finalize keeps the pending job');
      await settle();
    }
    assert.equal(calls, 8);
    const baseline = await prefixNow();
    assert.equal(baseline.firstInvalidIndex, null);
    const baselineNodes = new Map(baseline.positions.map(position => [position.messageIndex, position.node!]));
    const baselineView = await chain.current(CHAT_ID, BRANCH_ID);
    assert.equal(baselineView.snapshot.profiles.alice.basic.age, '30');
    assert.equal(baselineView.snapshot.story.now.currentTime, 'Day 8');

    // 2. editing floor 3 without changing its meaning: one re-analysis, then the chain converges and keeps every downstream node
    floors[2] = { messageIndex: 3, swipeId: 0, content: body(3, 2) };
    const editSame = await reconcile();
    assert.equal(editSame.rebuild?.firstInvalidIndex, 3);
    assert.equal(editSame.rebuild?.enqueued?.outcome, 'queued');
    await settle();
    assert.equal(calls, 9, 'only the edited floor is re-analysed');
    const afterEditSame = await prefixNow();
    assert.equal(afterEditSame.firstInvalidIndex, null);
    assert.notEqual(nodeAt(afterEditSame, 3).stateNodeId, baselineNodes.get(3)!.stateNodeId);
    assert.equal(nodeAt(afterEditSame, 3).stateFingerprint, baselineNodes.get(3)!.stateFingerprint, 'same meaning, same fingerprint despite the new floor id');
    for (const k of [4, 5, 6, 7, 8]) assert.equal(nodeAt(afterEditSame, k).stateNodeId, baselineNodes.get(k)!.stateNodeId, `floor ${k} keeps its node`);
    assert.equal((await chainStore.getNode(baselineNodes.get(3)!.stateNodeId))?.status, 'inactive', 'the node of the replaced floor variant is marked inactive');
    assert.ok(afterEditSame.positions.every(position => position.floorStatus === 'synced'));

    // 3. editing floor 3 so the story changes: floors 4 and 5 are re-analysed, floor 5 resets the state, floors 6-8 converge
    floors[2] = { messageIndex: 3, swipeId: 0, content: body(3, 3) };
    await reconcile();
    await settle();
    assert.equal(calls, 12, 'floors 3, 4 and 5 re-analysed; 6-8 reused by convergence');
    const afterEditChange = await prefixNow();
    assert.equal(afterEditChange.firstInvalidIndex, null);
    assert.notEqual(nodeAt(afterEditChange, 4).stateNodeId, baselineNodes.get(4)!.stateNodeId);
    assert.notEqual(nodeAt(afterEditChange, 4).stateFingerprint, baselineNodes.get(4)!.stateFingerprint);
    assert.notEqual(nodeAt(afterEditChange, 5).stateNodeId, baselineNodes.get(5)!.stateNodeId);
    assert.equal(nodeAt(afterEditChange, 5).stateFingerprint, baselineNodes.get(5)!.stateFingerprint, 'floor 5 resets the age, so the state converges');
    for (const k of [6, 7, 8]) assert.equal(nodeAt(afterEditChange, k).stateNodeId, baselineNodes.get(k)!.stateNodeId);
    assert.equal((await chainStore.getNode(baselineNodes.get(4)!.stateNodeId))?.status, 'stale', 'a superseded node of an active floor is marked stale');
    const atFour = await chain.snapshotAtFloor(CHAT_ID, BRANCH_ID, 4, 0);
    assert.equal(atFour?.snapshot.profiles.alice.basic.age, '21');
    assert.equal((await chain.current(CHAT_ID, BRANCH_ID)).snapshot.profiles.alice.basic.age, '30');

    // 4. deleting floor 3 shifts every later floor: the shifted bodies are reused by dependency, only the new floor 3 calls the model
    floors.splice(2, 1);
    floors.forEach((floor, index) => { floor.messageIndex = index + 1; });
    const deleted = await reconcile();
    assert.equal(deleted.rebuild?.firstInvalidIndex, 3);
    await settle();
    assert.equal(calls, 13, 'after the deletion only the floor that changed its predecessor is re-analysed');
    const afterDelete = await prefixNow();
    assert.equal(afterDelete.positions.length, 7);
    assert.equal(afterDelete.firstInvalidIndex, null);
    for (const k of [4, 5, 6, 7]) {
      const job = await latestJobFor(nodeAt(afterDelete, k).floorId);
      assert.ok(job?.payload.reuseFromJobId, `shifted floor ${k} reused a stored candidate`);
      assert.equal(job?.result?.diagnostics.reusedFromJobId, job?.payload.reuseFromJobId);
      assert.equal(nodeAt(afterDelete, k).stateFingerprint, baselineNodes.get(k + 1)!.stateFingerprint);
    }
    assert.equal((await chain.current(CHAT_ID, BRANCH_ID)).snapshot.story.now.currentTime, 'Day 8');

    // 5. swiping the last floor analyses the new variant once; swiping back and forth reuses both variants
    const last = floors[floors.length - 1];
    const lastNodeBefore = nodeAt(afterDelete, last.messageIndex);
    const altSwipe: Floor = { messageIndex: last.messageIndex, swipeId: 1, content: body(8, 2) };
    floors[floors.length - 1] = altSwipe;
    const swiped = await reconcile();
    assert.equal(swiped.rebuild?.enqueued?.outcome, 'queued');
    await settle();
    assert.equal(calls, 14);
    const swipedPrefix = await prefixNow();
    assert.equal(swipedPrefix.firstInvalidIndex, null);
    const altNode = nodeAt(swipedPrefix, last.messageIndex);
    assert.notEqual(altNode.stateNodeId, lastNodeBefore.stateNodeId);
    assert.equal((await chainStore.getNode(lastNodeBefore.stateNodeId))?.status, 'inactive');
    floors[floors.length - 1] = last;
    const swipedBack = await reconcile();
    assert.equal(swipedBack.rebuild?.skipped, 'chain-valid');
    await settle();
    assert.equal(calls, 14, 'swiping back reuses the old variant');
    assert.equal(nodeAt(await prefixNow(), last.messageIndex).stateNodeId, lastNodeBefore.stateNodeId);
    assert.equal((await chainStore.getNode(altNode.stateNodeId))?.status, 'inactive');
    floors[floors.length - 1] = altSwipe;
    await reconcile();
    await settle();
    assert.equal(calls, 14, 'swiping forward again reuses the other variant');
    assert.equal(nodeAt(await prefixNow(), last.messageIndex).stateNodeId, altNode.stateNodeId);
    assert.equal((await chainStore.getNode(altNode.stateNodeId))?.status, 'synced');

    // 6. an in-flight job downstream of an edited floor is cancelled, the edit converges, and the tail is rebuilt afterwards
    delays.set('9 v1', 800);
    floors.push({ messageIndex: 8, swipeId: 0, content: body(9) });
    const tail = await runtime.finalizeFloor({ chatId: CHAT_ID, messageIndex: 8, swipeId: 0, content: body(9) });
    await reconcile();
    for (;;) {
      const job = await tasks.getJob(tail.stateTask!.jobId!);
      if (job?.status === 'running') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    floors[1] = { messageIndex: 2, swipeId: 0, content: body(2, 2) };
    const editUpstream = await reconcile();
    assert.equal(editUpstream.rebuild?.cancelled, 1);
    const cancelledTail = await tasks.getJob(tail.stateTask!.jobId!);
    assert.equal(cancelledTail?.status, 'cancelled');
    assert.match(cancelledTail?.errorMessage ?? '', /rebuilt in order/);
    await settle();
    assert.equal(calls, 17, 'cancelled attempt + floor 2 + the tail again');
    const afterUpstream = await prefixNow();
    assert.equal(afterUpstream.firstInvalidIndex, null);
    assert.equal(afterUpstream.positions.length, 8);
    for (const k of [3, 4, 5, 6]) assert.equal(nodeAt(afterUpstream, k).stateNodeId, nodeAt(afterDelete, k).stateNodeId, `floor ${k} converged after the upstream edit`);
    assert.equal((await chain.current(CHAT_ID, BRANCH_ID)).snapshot.story.now.currentTime, 'Day 9');
    delays.clear();

    // 7. a prompt change invalidates the whole chain but is never rebuilt automatically; reverting the prompt revalidates the old nodes
    const custom = await aiConfig.savePreset({ promptType: 'state', name: 'custom', content: { system: '你是另一套状态模型。', task: '输出 JSON。' } });
    await aiConfig.activatePreset('state', custom.presetId);
    const promptChanged = await reconcile();
    assert.equal(promptChanged.rebuild?.skipped, 'prompt-version');
    assert.equal(promptChanged.rebuild?.firstInvalidIndex, 1);
    assert.equal(promptChanged.rebuild?.firstLineageBreakIndex, null);
    assert.equal(calls, 17);
    const drifted = await chain.current(CHAT_ID, BRANCH_ID);
    assert.equal(drifted.node?.messageIndex, 8, 'the last lineage-valid state is still served');
    assert.equal(drifted.snapshot.story.now.currentTime, 'Day 9');
    const manual = await runner.rebuild({ chatId: CHAT_ID });
    assert.equal(manual.enqueued?.outcome, 'queued');
    await settle();
    assert.equal(calls, 25, 'a manual rebuild re-analyses all eight floors under the new prompt');
    assert.equal((await prefixNow()).firstInvalidIndex, null);
    await aiConfig.resetPrompt('state');
    const reverted = await reconcile();
    assert.equal(reverted.rebuild?.skipped, 'chain-valid');
    assert.equal(calls, 25, 'reverting the prompt makes the original nodes valid again without any call');
    assert.equal(nodeAt(await prefixNow(), 8).stateNodeId, nodeAt(afterUpstream, 8).stateNodeId);

    // 8. a chat without any chain is never backfilled automatically; a manual rebuild does it
    const otherChat = 'rebuild-fresh';
    const fresh = await runtime.reconcileChat({ chatId: otherChat, floors: [1, 2, 3].map(k => ({ messageIndex: k, swipeId: 0, content: body(k) })) });
    assert.equal(fresh.rebuild?.skipped, 'no-chain');
    assert.equal((await tasks.listActiveJobs(otherChat, `main:${otherChat}`)).length, 0);
    await runner.rebuild({ chatId: otherChat });
    await settle(otherChat);
    assert.equal(calls, 28);
    assert.equal((await chain.trustedPrefix(otherChat, `main:${otherChat}`)).firstInvalidIndex, null);

    // 9. a forced rebuild from a valid floor re-analyses it and converges right after
    const forced = await runner.rebuild({ chatId: CHAT_ID, fromMessageIndex: 4, force: true });
    assert.equal(forced.enqueued?.outcome, 'queued');
    await settle();
    assert.equal(calls, 29);
    assert.equal((await prefixNow()).firstInvalidIndex, null);
    await assert.rejects(runner.rebuild({ chatId: CHAT_ID, force: true }), /fromMessageIndex/);

    // 10. a floor whose analysis keeps failing is not retried by automatic rebuilds
    failing.add('6 v2');
    floors[4] = { messageIndex: 5, swipeId: 0, content: body(6, 2) };
    await reconcile();
    await settle();
    assert.equal(calls, 30);
    const failedPosition = (await prefixNow()).positions.find(position => position.messageIndex === 5);
    assert.ok(failedPosition && !failedPosition.valid);
    assert.equal((await latestJobFor(failedPosition.floorId))?.status, 'failed');
    const guarded = await reconcile();
    assert.equal(guarded.rebuild?.skipped, 'failed-floor');
    assert.equal(calls, 30);
    failing.clear();
    await runner.rebuild({ chatId: CHAT_ID });
    await settle();
    assert.equal(calls, 31);
    assert.equal((await prefixNow()).firstInvalidIndex, null);

    console.log('Phase 6 state rebuild acceptance passed');
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
