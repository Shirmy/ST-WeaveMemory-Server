import assert from 'node:assert/strict';
import { normalizeStateSnapshot, StateSchemaError, STATE_SCHEMA_VERSION } from '../src/state/schema';

const source = {
  branchId: 'phase16-schema-branch',
  sourceFloorIds: [],
  sourceHostChatIds: [],
  sourceType: 'manual' as const
};

function snapshotWithStory(story: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    branchId: source.branchId,
    profiles: {},
    traces: {},
    story: { now: { ongoing: [], upcoming: [] }, calendar: [], plotlines: [], plotPlans: [], source, ...story },
    updatedAt: '2026-09-19T00:00:00.000Z'
  };
}

function rejects(value: unknown): void {
  assert.throws(() => normalizeStateSnapshot(value), (error: unknown) => error instanceof StateSchemaError);
}

function main(): void {
  const normalized = normalizeStateSnapshot(snapshotWithStory({
    calendar: [{ id: 'day-1', dateKey: '2026-09-19', type: 'custom', title: '手动事件', confirmed: true }],
    plotlines: [{ id: 'plot-1', name: '主线', stage: '起线', currentState: '刚开始', updatedAt: '2026-09-19T00:00:00.000Z' }],
    plotPlans: [{ id: 'plan-1', type: '明线', title: '下一步', time: '今天', status: 'planned', createdAt: '2026-09-19T00:00:00.000Z', updatedAt: '2026-09-19T00:00:00.000Z' }]
  }));
  assert.equal(normalized.story.calendar[0].confirmed, true, '手动日历事件默认必须确认');
  assert.equal(normalized.story.plotlines[0].currentState, '刚开始');
  assert.equal(normalized.story.plotPlans[0].status, 'planned');

  rejects(snapshotWithStory({ calendar: [{ id: 'day-1', dateKey: '2026-09-19', type: 'unknown', title: '无效', confirmed: true }] }));
  rejects(snapshotWithStory({ calendar: [{ id: 'day-1', dateKey: '2026-09-19', type: 'custom', title: '缺 confirmed' }] }));
  rejects(snapshotWithStory({ plotlines: [{ id: 'plot-1', name: '主线', stage: 'unknown', currentState: '状态', updatedAt: '2026-09-19' }] }));
  rejects(snapshotWithStory({ plotlines: [{ id: 'plot-1', name: '主线', stage: '起线', currentState: '状态', updatedAt: '2026-09-19', unexpected: true }] }));
  rejects(snapshotWithStory({ plotPlans: [{ id: 'plan-1', type: '明线', title: '安排', time: '今天', status: 'unknown', createdAt: '2026-09-19', updatedAt: '2026-09-19' }] }));
  rejects(snapshotWithStory({ plotPlans: [{ id: 'plan-1', type: '明线', title: '安排', time: '今天', status: 'planned', createdAt: '2026-09-19', updatedAt: '2026-09-19', unexpected: true }] }));
  console.log('Phase 16 state schema acceptance passed');
}

main();
