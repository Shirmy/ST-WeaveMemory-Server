import assert from 'node:assert/strict';
import {
  normalizeStateAnalysisResponse,
  normalizeStateSnapshot,
  resolveCharacterIdentity,
  STATE_SCHEMA_VERSION,
  StateSchemaError,
  validateManualStateEdit,
  validateStateSnapshot
} from '../src/state/schema';

const source = { branchId: 'branch-A', sourceFloorIds: ['floor-12'], sourceHostChatIds: ['host-A'], sourceType: 'story' as const };

const snapshot = {
  schemaVersion: STATE_SCHEMA_VERSION,
  branchId: 'branch-A',
  profiles: {
    alice: {
      characterId: 'alice', canonicalName: 'Alice', aliases: [' Alice ', 'Alice'],
      basic: {}, appearance: {}, identity: {}, personality: {}, lifeDetails: [], nsfw: {},
      lockedPaths: ['basic.age'], sourcePriority: { canonicalName: 'story' }, source, updatedAt: '2026-09-19T00:00:00.000Z'
    }
  },
  traces: {
    alice: {
      characterId: 'alice', longTermTendencies: [], currentSituations: [], visibility: [],
      affinity: { inner: 2, outer: null }, source, updatedAt: '2026-09-19T00:00:00.000Z'
    }
  },
  story: { now: { ongoing: [], upcoming: [] }, calendar: [], plotlines: [], plotPlans: [], source },
  updatedAt: '2026-09-19T00:00:00.000Z'
};

function expectSchemaError(work: () => unknown): void {
  assert.throws(work, (error: unknown) => error instanceof StateSchemaError);
}

function main(): void {
  const normalized = normalizeStateSnapshot(snapshot, { branchId: 'branch-A' });
  assert.deepEqual(normalized.profiles.alice.aliases, ['Alice']);
  assert.equal(normalized.branchId, 'branch-A');
  expectSchemaError(() => validateStateSnapshot({ ...snapshot, branchId: 'branch-B' }, { branchId: 'branch-A' }));
  expectSchemaError(() => validateStateSnapshot({ ...snapshot, traces: { alice: { ...snapshot.traces.alice, affinity: { inner: 3, outer: null } } } }));
  expectSchemaError(() => normalizeStateAnalysisResponse({ branchId: 'branch-B' }));
  expectSchemaError(() => normalizeStateAnalysisResponse({ profiles: { alice: { canonicalName: 'changed' } } }, ['profiles.alice.canonicalName']));
  const candidate = normalizeStateAnalysisResponse({ profiles: { alice: { aliases: [] } }, touchedCharacterIds: ['alice'], notes: [] });
  assert.deepEqual(candidate.profiles?.alice.aliases, []);
  assert.equal(resolveCharacterIdentity('ally', [{ characterId: 'alice', canonicalName: 'Alice', aliases: ['Ally'] }]), 'alice');
  validateManualStateEdit({ branchId: 'branch-A', target: 'profile', entityId: 'alice', path: 'basic.age', value: '30', source: { ...source, sourceType: 'manual', sourceFloorIds: [], sourceHostChatIds: ['host-A'] }, updatedAt: '2026-09-19T00:00:00.000Z' }, { branchId: 'branch-A' });
  expectSchemaError(() => validateManualStateEdit({ branchId: 'branch-A', target: 'profile', entityId: 'alice', path: 'basic.age', value: '30', source, updatedAt: '2026-09-19T00:00:00.000Z' }));
  console.log('Phase 3 state schema acceptance passed');
}

main();
