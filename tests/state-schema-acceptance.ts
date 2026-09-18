import assert from 'node:assert/strict';
import {
  normalizeStateAnalysisResponse,
  normalizeStateSnapshot,
  resolveCharacterIdentity,
  STATE_ANALYSIS_RESPONSE_JSON_SCHEMA,
  STATE_SCHEMA_VERSION,
  type StateAnalysisCandidate,
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
  expectSchemaError(() => normalizeStateAnalysisResponse({ profiles: { alice: { basic: 123 } } }));
  expectSchemaError(() => normalizeStateAnalysisResponse({ traces: { alice: { affinity: { inner: 3 } } } }));
  expectSchemaError(() => normalizeStateAnalysisResponse({ story: { plotPlans: 'invalid' } }));
  expectSchemaError(() => normalizeStateAnalysisResponse({ story: { now: { upcoming: [{ id: 'event', title: 'Event', expectedTime: 123 }] } } }));
  assert.throws(() => normalizeStateAnalysisResponse({ story: { now: { ongoing: [{ id: 'event', title: 'Event', relatedCharacterIds: 'alice' }] } } }), { name: 'StateSchemaError', message: 'response.story.now.ongoing[0].relatedCharacterIds: must be an array' });
  expectSchemaError(() => normalizeStateAnalysisResponse({ profiles: { alice: { basic: { unknownField: true } } } }));
  expectSchemaError(() => normalizeStateAnalysisResponse({ profiles: { alice: { basic: { age: '31' } } } }, ['profiles.alice.basic.age']));
  const candidate = normalizeStateAnalysisResponse({ profiles: { alice: { aliases: [] } }, touchedCharacterIds: ['alice'], notes: [] });
  assert.deepEqual(candidate.profiles?.alice.aliases, []);
  const affinityInner: StateAnalysisCandidate = { traces: { alice: { affinity: { inner: 1 } } } };
  const affinityOuter: StateAnalysisCandidate = { traces: { alice: { affinity: { outer: -1 } } } };
  const currentTime: StateAnalysisCandidate = { story: { now: { currentTime: 'Day 2' } } };
  assert.equal(normalizeStateAnalysisResponse(affinityInner).traces?.alice.affinity?.inner, 1);
  assert.equal(normalizeStateAnalysisResponse(affinityOuter).traces?.alice.affinity?.outer, -1);
  assert.equal(normalizeStateAnalysisResponse(currentTime).story?.now?.currentTime, 'Day 2');
  assert.equal('required' in STATE_ANALYSIS_RESPONSE_JSON_SCHEMA.$defs.trace.properties.affinity, false);
  assert.equal('required' in STATE_ANALYSIS_RESPONSE_JSON_SCHEMA.$defs.story.properties.now, false);
  assert.equal(resolveCharacterIdentity('ally', [{ characterId: 'alice', canonicalName: 'Alice', aliases: ['Ally'] }]), 'alice');
  validateManualStateEdit({ branchId: 'branch-A', target: 'profile', entityId: 'alice', path: 'basic.age', value: '30', source: { ...source, sourceType: 'manual', sourceFloorIds: [], sourceHostChatIds: ['host-A'] }, updatedAt: '2026-09-19T00:00:00.000Z' }, { branchId: 'branch-A' });
  expectSchemaError(() => validateManualStateEdit({ branchId: 'branch-A', target: 'profile', entityId: 'alice', path: 'basic.age', value: '30', source, updatedAt: '2026-09-19T00:00:00.000Z' }));
  expectSchemaError(() => validateManualStateEdit({ branchId: 'branch-A', target: 'profile', entityId: 'alice', path: 'basic.notAField', value: '30', source: { ...source, sourceType: 'manual' }, updatedAt: '2026-09-19T00:00:00.000Z' }));
  expectSchemaError(() => validateManualStateEdit({ branchId: 'branch-A', target: 'trace', entityId: 'alice', path: 'affinity.inner', value: 3, source: { ...source, sourceType: 'manual' }, updatedAt: '2026-09-19T00:00:00.000Z' }));
  expectSchemaError(() => validateManualStateEdit({ branchId: 'branch-A', target: 'story', path: 'plotPlans', value: 'invalid', source: { ...source, sourceType: 'manual' }, updatedAt: '2026-09-19T00:00:00.000Z' }));
  expectSchemaError(() => validateManualStateEdit({ branchId: 'branch-A', target: 'profile', entityId: 'alice', path: 'basic.age', value: '31', source: { ...source, sourceType: 'manual' }, updatedAt: '2026-09-19T00:00:00.000Z' }, { branchId: 'branch-A' }, ['profiles.alice.basic.age']));
  console.log('Phase 3 state schema acceptance passed');
}

main();
