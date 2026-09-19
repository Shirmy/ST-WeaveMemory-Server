import assert from 'node:assert/strict';
import { emptySnapshot } from '../src/state/apply';
import { renderCurrentState } from '../src/state/current-state';

const source = { branchId: 'branch:test', sourceFloorIds: ['floor-1'], sourceHostChatIds: ['chat'] };

async function main(): Promise<void> {
  const snapshot = emptySnapshot('branch:test');
  snapshot.profiles.alice = {
    characterId: 'alice', canonicalName: 'Alice', aliases: ['爱丽丝'], basic: { age: '20' }, appearance: {}, identity: { occupation: '探员' }, personality: { coreTraits: ['冷静'] }, lifeDetails: [], lockedPaths: [], sourcePriority: {}, source, updatedAt: '2026-01-01'
  };
  snapshot.profiles.bob = { ...snapshot.profiles.alice, characterId: 'bob', canonicalName: 'Bob', aliases: [], identity: {}, personality: {} };
  snapshot.profiles.carol = { ...snapshot.profiles.alice, characterId: 'carol', canonicalName: 'Carol', aliases: [] };
  snapshot.traces.alice = { characterId: 'alice', longTermTendencies: [], currentSituations: [{ id: 's', text: '在车站' }], visibility: [], affinity: { inner: 1, outer: 0 }, source, updatedAt: '2026-01-01' };
  snapshot.traces.bob = { ...snapshot.traces.alice, characterId: 'bob' };
  snapshot.story.now.currentTime = '2026-01-10';
  snapshot.story.now.ongoing = [{ id: 'o', title: '车站调查', relatedCharacterIds: ['alice'], relatedPlotlineIds: ['p'] }];
  snapshot.story.calendar = [
    { id: 'near', dateKey: '2026-01-11', type: 'story', title: '明日会面', confirmed: true },
    { id: 'far', dateKey: '2026-02-01', type: 'story', title: '远期事件', confirmed: true }
  ];
  snapshot.story.plotlines = [{ id: 'p', name: '调查线', stage: '延展', currentState: '追查中', relatedCharacterIds: ['alice'], updatedAt: '2026-01-01' }];
  snapshot.story.plotPlans = [{ id: 'plan', type: '暗线', title: '夜间跟踪', time: '未来', status: 'planned', relatedPlotlineIds: ['p'], createdAt: '2026-01-01', updatedAt: '2026-01-01' }];

  const result = renderCurrentState({ snapshot, userText: '爱丽丝，今晚去车站。', recentFloorTexts: ['Bob 在门口等待。'], recentPositions: [] });
  assert.match(result.text, /Alice/);
  assert.match(result.text, /Bob/);
  assert.doesNotMatch(result.text, /Carol/);
  assert.match(result.text, /明日会面/);
  assert.doesNotMatch(result.text, /远期事件/);
  assert.match(result.text, /以下为未来规划，不代表已经发生/);
  assert.equal(result.tokens > 0, true);
  console.log('current state acceptance passed');
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
