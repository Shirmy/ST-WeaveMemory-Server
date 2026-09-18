import assert from 'node:assert/strict';
import { MemoryRuntime } from '../src/core/runtime';
import type { StateTaskRunner } from '../src/ai/state-task-runner';
import type { StateChainEngine } from '../src/state/chain-engine';
import type { PerChatQueue } from '../src/queue/per-chat-queue';
import type { MemoryStore } from '../src/storage/types';

type Position = { messageIndex: number; floorId: string; valid: boolean; node: { stateNodeId: string } | null };

async function main(): Promise<void> {
  let rebuilds = 0;
  let polls = 0;
  let taskStatus: 'pending' | 'failed' = 'pending';
  const position: Position = { messageIndex: 1, floorId: 'floor-1', valid: false, node: null };
  const chain = {
    trustedPrefix: async () => ({ chatId: 'chat', branchId: 'branch', promptVersion: 'p', positions: [position], firstInvalidIndex: 1, firstLineageBreakIndex: 1, head: null, lineageHead: null, nodes: [] })
  };
  const tasks = {
    listTasks: async () => [{ status: taskStatus }],
    rebuild: async () => { rebuilds += 1; return { skipped: null }; }
  };
  const store = { getOrCreateActiveBranch: async () => 'branch' };
  const runtime = new MemoryRuntime(
    store as unknown as MemoryStore,
    {} as unknown as PerChatQueue,
    tasks as unknown as StateTaskRunner,
    chain as unknown as StateChainEngine
  );

  const pending = runtime.prepareGeneration({ chatId: 'chat', generationType: 'normal', contextSize: 0, latestUserIndex: 2, latestUserText: 'next' });
  const timer = setInterval(() => {
    polls += 1;
    if (polls === 2) {
      position.valid = true;
      position.node = { stateNodeId: 'node-1' };
    }
  }, 20);
  const ready = await pending;
  clearInterval(timer);
  assert.equal(ready.ready, true);
  assert.equal(ready.diagnostics.stateNodeId, 'node-1');
  assert.equal(rebuilds, 0);

  position.valid = false;
  position.node = null;
  taskStatus = 'failed';
  const failed = await runtime.prepareGeneration({ chatId: 'chat', generationType: 'normal', contextSize: 0, latestUserIndex: 2, latestUserText: 'next' });
  assert.equal(failed.ready, false);
  assert.equal((failed as { reason?: string }).reason, 'STATE_SYNC_FAILED');
  assert.equal(rebuilds, 1);
  console.log('generation gate acceptance passed');
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
