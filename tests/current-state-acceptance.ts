import assert from 'node:assert/strict';
import { emptySnapshot } from '../src/state/apply';
import { renderCurrentState } from '../src/state/current-state';
import { MemoryRuntime } from '../src/core/runtime';
import type { StateChainEngine } from '../src/state/chain-engine';
import type { MemoryStore } from '../src/storage/types';
import type { PerChatQueue } from '../src/queue/per-chat-queue';
import type { StateTaskRunner } from '../src/ai/state-task-runner';
import type { CharacterProfile } from '../src/state/schema';
import { resolveExternalMappings } from '../src/state/external-mapping';

const source = { branchId: 'branch:test', sourceFloorIds: ['floor-1'], sourceHostChatIds: ['chat'] };

function profile(characterId: string, canonicalName = characterId): CharacterProfile {
  return { characterId, canonicalName, aliases: [], basic: {}, appearance: {}, identity: {}, personality: {}, lifeDetails: [], lockedPaths: [], sourcePriority: {}, source, updatedAt: '2026-01-01' };
}

async function main(): Promise<void> {
  const snapshot = emptySnapshot('branch:test');
  for (let index = 0; index < 50; index += 1) {
    const id = ['alice', 'bob', 'carol', 'old', 'pinned'][index] ?? `unrelated-${index}`;
    snapshot.profiles[id] = profile(id, id[0].toUpperCase() + id.slice(1));
    snapshot.traces[id] = { characterId: id, longTermTendencies: [], currentSituations: [], visibility: [], affinity: { inner: 0, outer: 0 }, source, updatedAt: '2026-01-01' };
  }
  snapshot.traces.alice.currentSituations = [{ id: 'location', text: 'location = 书房' }, { id: 'injury', text: 'injury = 手臂受伤' }, { id: 'action', text: 'action = 正在翻阅文件' }];
  snapshot.traces.bob.currentSituations = [{ id: 'location', text: 'location = 客厅' }, { id: 'emotion', text: 'emotion = 紧张' }];
  snapshot.profiles.alice.basic = { age: '20', gender: '女', birthday: '01-01' };
  snapshot.story.now.currentTime = '2026-01-10';
  snapshot.story.now.ongoing = [{ id: 'ongoing', title: '车站调查', relatedCharacterIds: ['bob'], relatedPlotlineIds: ['active-plot'] }];
  snapshot.story.now.upcoming = [{ id: 'upcoming', title: '夜间会面', relatedCharacterIds: ['bob'] }];
  snapshot.story.calendar = [
    { id: 'near', dateKey: '2026-01-11', type: 'story', title: '明日会面', confirmed: true },
    { id: 'far', dateKey: '2026-02-01', type: 'story', title: '远期事件', confirmed: true },
    { id: 'unconfirmed', dateKey: '2026-01-10', type: 'story', title: '未确认事项', confirmed: false }
  ];
  snapshot.story.plotlines = [
    { id: 'active-plot', name: '调查线', stage: '延展', currentState: '追查中', relatedCharacterIds: ['carol'], updatedAt: '2026-01-01' },
    { id: 'faded-plot', name: '旧线', stage: '淡出', currentState: '结束', relatedCharacterIds: ['old'], updatedAt: '2026-01-01' },
    { id: 'pinned-faded', name: '钉住旧线', stage: '淡出', currentState: '仍需收尾', pinned: true, relatedCharacterIds: ['pinned'], updatedAt: '2026-01-01' },
    { id: 'stalled-plot', name: '停滞旧线', stage: '延展', currentState: '暂停', stalled: true, relatedCharacterIds: ['old'], updatedAt: '2026-01-01' }
  ];
  snapshot.story.plotPlans = [{ id: 'plan', type: '暗线', title: '夜间跟踪', time: '未来', status: 'planned', relatedPlotlineIds: ['active-plot'], createdAt: '2026-01-01', updatedAt: '2026-01-01' }];

  const rendered = renderCurrentState({ snapshot, userText: 'Alice，我们继续调查。', recentFloorTexts: [], recentPositions: [] });
  assert.deepEqual(new Set(rendered.characterIds), new Set(['alice', 'bob', 'carol', 'pinned']));
  assert.equal(rendered.text.includes('Alice'), true);
  assert.equal(rendered.text.includes('Bob'), true);
  assert.equal(rendered.text.includes('Carol'), true);
  assert.equal(rendered.text.includes('Pinned'), true);
  assert.equal(rendered.text.includes('Unrelated-49'), false);
  assert.equal(rendered.text.includes('Old'), false);
  assert.equal(rendered.text.includes('远期事件'), false);
  assert.equal(rendered.text.includes('未确认事项'), false);
  assert.equal(rendered.text.includes('以下为未来规划，不代表已经发生'), true);
  assert.equal(rendered.tokens > 0, true);

  const chain = {
    trustedPrefix: async () => ({ chatId: 'chat', branchId: 'branch:test', promptVersion: 'p', positions: [], firstInvalidIndex: null, firstLineageBreakIndex: null, head: null, lineageHead: null, nodes: [] }),
    snapshotAtFloor: async () => null,
    current: async () => ({ snapshot })
  };
  const runtime = new MemoryRuntime(
    { getOrCreateActiveBranch: async () => 'branch:test', getFloor: async () => null } as unknown as MemoryStore,
    {} as unknown as PerChatQueue,
    { listTasks: async () => [] } as unknown as StateTaskRunner,
    chain as unknown as StateChainEngine
  );
  const prepared = await runtime.prepareGeneration({ chatId: 'chat', generationType: 'normal', contextSize: 0, latestUserIndex: 2, latestUserText: 'Alice，我们继续调查。' });
  assert.equal(prepared.ready, true);
  assert.equal(prepared.diagnostics.stateTokens, rendered.tokens);
  const mapped = await runtime.prepareGeneration({ chatId: 'chat', generationType: 'normal', contextSize: 0, latestUserIndex: 2, latestUserText: 'Alice', externalState: { source: 'mvu', detected: true, statData: { role: { location: 'study' } }, messageIndex: 1, swipeId: 0, cardId: 'card-a', mappings: [{ id: 'location', source: 'mvu', externalPath: 'role.location', weaveTarget: { domain: 'trace', characterId: 'alice', path: 'currentSituations.location' }, mode: 'equivalent', enabled: true }] } });
  assert.equal(mapped.ready, true);
  const mappedDiagnostics = mapped.diagnostics as typeof mapped.diagnostics & { tokensBeforeMapping?: number; tokensAfterMapping?: number; activeEquivalentMappings?: string[] };
  assert.equal((mappedDiagnostics.tokensBeforeMapping ?? 0) >= (mappedDiagnostics.tokensAfterMapping ?? 0), true);
  assert.equal(mappedDiagnostics.stateTokens, mappedDiagnostics.tokensAfterMapping);
  assert.deepEqual(mappedDiagnostics.activeEquivalentMappings, ['location']);
  const precise = resolveExternalMappings({ source: 'mvu', detected: true, statData: { location: '书房', age: 20, now: 'today' }, messageIndex: 1, swipeId: 0, cardId: 'card-a', mappings: [
    { id: 'alice-location', source: 'mvu', externalPath: 'location', weaveTarget: { domain: 'trace', characterId: 'alice', field: 'currentSituations', semanticKey: 'location' }, mode: 'equivalent', enabled: true },
    { id: 'age', source: 'mvu', externalPath: 'age', weaveTarget: { domain: 'profile', characterId: 'alice', field: 'basic.age' }, mode: 'equivalent', enabled: true },
    { id: 'current-time', source: 'mvu', externalPath: 'now', weaveTarget: { domain: 'story', field: 'now.currentTime' }, mode: 'equivalent', enabled: true }
  ] });
  const preciseRendered = renderCurrentState({ snapshot, userText: 'Alice', recentFloorTexts: [], recentPositions: [], suppressedWeaveFields: precise.suppressedWeaveFields });
  const aliceLine = preciseRendered.text.split('\n').find(line => line.includes('"characterId":"alice"')) ?? '';
  const bobLine = preciseRendered.text.split('\n').find(line => line.includes('"characterId":"bob"')) ?? '';
  const profileLine = preciseRendered.text.split('\n').find(line => line.includes('"canonicalName":"Alice"')) ?? '';
  assert.equal(aliceLine.includes('location = 书房'), false);
  assert.equal(aliceLine.includes('injury = 手臂受伤'), true);
  assert.equal(aliceLine.includes('action = 正在翻阅文件'), true);
  assert.equal(profileLine.includes('"age"'), false);
  assert.equal(profileLine.includes('"gender"'), true);
  assert.equal(profileLine.includes('"birthday"'), true);
  assert.equal(bobLine.includes('location = 客厅'), true);
  assert.equal(preciseRendered.text.includes('currentTime'), false);
  assert.equal(preciseRendered.text.includes('ongoing'), true);
  console.log('current state acceptance passed');
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
