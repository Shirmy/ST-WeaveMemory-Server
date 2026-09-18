import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { applyCandidate, deriveKnownCharacters, deriveLockedPaths, emptySnapshot, snapshotFingerprint, StateApplyError } from '../src/state/apply';
import { applyChanges, applyChangesInPlace, canonicalJson, diffValues, joinPointer, partitionChanges, splitPointer } from '../src/state/diff';
import { validateStateSnapshot, type StateSnapshot } from '../src/state/schema';

const context = (floorId: string, now: string) => ({ branchId: 'branch-A', floorId, hostChatId: 'host-A', now });

function main(): void {
  // pointer paths survive ids with dots and slashes
  const segments = ['profiles', 'mr.wang/jr', 'basic', 'age'];
  const pointer = joinPointer(segments);
  assert.equal(pointer, '/profiles/mr.wang~1jr/basic/age');
  assert.deepEqual(splitPointer(pointer), segments);

  // canonical JSON is key-order independent and drops undefined members
  assert.equal(canonicalJson({ b: 1, a: [1, { d: undefined, c: 2 }] }), canonicalJson({ a: [1, { c: 2 }], b: 1 }));

  // diff + apply round trip: objects recurse, arrays replace atomically
  const before = { profiles: { 'mr.wang': { aliases: ['王先生'], basic: { age: '30', race: 'human' } } }, story: { now: { ongoing: [{ id: 'e1', title: 'a' }] } } };
  const after = { profiles: { 'mr.wang': { aliases: ['王先生', '老王'], basic: { age: '31' } }, bob: { aliases: [] } }, story: { now: { ongoing: [] } } };
  const changes = diffValues(before, after);
  assert.deepEqual(changes.map(change => `${change.op} ${change.path}`), [
    'add /profiles/bob',
    'replace /profiles/mr.wang/aliases',
    'replace /profiles/mr.wang/basic/age',
    'remove /profiles/mr.wang/basic/race',
    'replace /story/now/ongoing'
  ]);
  assert.deepEqual(applyChanges(before, changes), after);
  assert.deepEqual(diffValues(after, after), []);
  const partitioned = partitionChanges(changes);
  assert.equal(partitioned.profileChanges.length, 4);
  assert.equal(partitioned.storyChanges.length, 1);
  assert.equal(partitioned.rootChanges.length, 0);

  // applying a candidate: new profile, alias resolution, partial affinity, story provenance
  const empty = emptySnapshot('branch-A');
  const first = applyCandidate(empty, {
    profiles: { Alice: { canonicalName: 'Alice', aliases: ['Ally', ' Ally ', ''], basic: { age: ' 20 ' }, personality: { coreTraits: ['brave'] } } },
    traces: { Alice: { affinity: { inner: 1 } }, bob: { currentSituations: [{ id: 's1', text: 'waiting outside' }] } },
    story: {
      now: { currentTime: 'Day 1' },
      calendar: [{ id: 'c1', dateKey: '2026-01-01', type: 'story', title: 'Arrival', confirmed: true }],
      plotlines: [{ id: 'p1', name: 'Main', stage: '起线', currentState: 'started', updatedAt: '2026-01-01T00:00:00.000Z' }]
    }
  }, context('floor-1', '2026-09-19T10:00:00.000Z'));
  assert.equal(first.changed, true);
  validateStateSnapshot(first.snapshot, { branchId: 'branch-A' });
  const alice = first.snapshot.profiles.Alice;
  assert.equal(alice.canonicalName, 'Alice');
  assert.deepEqual(alice.aliases, ['Ally']);
  assert.equal(alice.basic.age, '20');
  assert.deepEqual(alice.sourcePriority, { aliases: 'story', 'basic.age': 'story', 'personality.coreTraits': 'story' });
  assert.deepEqual(alice.source, { branchId: 'branch-A', sourceFloorIds: ['floor-1'], sourceHostChatIds: ['host-A'], sourceType: 'story' });
  assert.equal(first.snapshot.traces.Alice.affinity.inner, 1);
  assert.equal(first.snapshot.traces.Alice.affinity.outer, null);
  assert.equal(first.snapshot.profiles.bob?.canonicalName, 'bob', 'a trace for an unknown id creates a stub profile');
  assert.deepEqual(first.snapshot.story.calendar[0].sourceFloorIds, ['floor-1']);
  assert.deepEqual(first.touchedCharacterIds.sort(), ['Alice', 'bob']);
  assert.equal(first.snapshot.story.source.sourceType, 'story');

  // second floor: alias "Ally" resolves to Alice, arrays replace, unchanged calendar entry keeps provenance, changed plotline records the new floor
  const second = applyCandidate(first.snapshot, {
    profiles: { ally: { basic: { age: '21' } } },
    traces: { Ally: { affinity: { outer: -1 }, currentSituations: [] } },
    story: {
      calendar: [{ id: 'c1', dateKey: '2026-01-01', type: 'story', title: 'Arrival', confirmed: true }],
      plotlines: [{ id: 'p1', name: 'Main', stage: '延展', currentState: 'moving', updatedAt: '2026-01-02T00:00:00.000Z' }]
    }
  }, context('floor-2', '2026-09-19T11:00:00.000Z'));
  assert.equal(Object.keys(second.snapshot.profiles).sort().join(','), 'Alice,bob');
  assert.equal(second.snapshot.profiles.Alice.basic.age, '21');
  assert.deepEqual(second.snapshot.profiles.Alice.source.sourceFloorIds, ['floor-1', 'floor-2']);
  assert.equal(second.snapshot.traces.Alice.affinity.inner, 1);
  assert.equal(second.snapshot.traces.Alice.affinity.outer, -1);
  assert.deepEqual(second.snapshot.story.calendar[0].sourceFloorIds, ['floor-1']);
  assert.deepEqual(second.snapshot.story.plotlines[0].sourceFloorIds, ['floor-1', 'floor-2']);
  assert.equal(second.snapshot.profiles.bob.updatedAt, first.snapshot.profiles.bob.updatedAt, 'untouched records keep their timestamp');

  // {} means no change at all
  const unchanged = applyCandidate(second.snapshot, {}, context('floor-3', '2026-09-19T12:00:00.000Z'));
  assert.equal(unchanged.changed, false);
  assert.deepEqual(unchanged.snapshot, second.snapshot);
  assert.equal(snapshotFingerprint(unchanged.snapshot), snapshotFingerprint(second.snapshot));

  // locked paths are never overwritten
  const locked: StateSnapshot = structuredClone(second.snapshot);
  locked.profiles.Alice.lockedPaths = ['basic'];
  assert.deepEqual(deriveLockedPaths(locked), ['profiles.Alice.basic']);
  assert.throws(() => applyCandidate(locked, { profiles: { Alice: { basic: { age: '99' } } } }, context('floor-4', '2026-09-19T13:00:00.000Z')), (error: unknown) => error instanceof StateApplyError);
  const untouchedLock = applyCandidate(locked, { profiles: { Alice: { appearance: { hair: 'silver' } } } }, context('floor-4', '2026-09-19T13:00:00.000Z'));
  assert.equal(untouchedLock.snapshot.profiles.Alice.appearance.hair, 'silver');

  // fingerprints ignore timestamps but not content
  const sameLater = applyCandidate(first.snapshot, { profiles: { Alice: { basic: { age: '21' } } } }, context('floor-2', '2030-01-01T00:00:00.000Z'));
  const sameEarlier = applyCandidate(first.snapshot, { profiles: { Alice: { basic: { age: '21' } } } }, context('floor-2', '2020-01-01T00:00:00.000Z'));
  assert.notEqual(sameLater.snapshot.updatedAt, sameEarlier.snapshot.updatedAt);
  assert.equal(snapshotFingerprint(sameLater.snapshot), snapshotFingerprint(sameEarlier.snapshot));
  assert.notEqual(snapshotFingerprint(sameLater.snapshot), snapshotFingerprint(first.snapshot));
  assert.deepEqual(deriveKnownCharacters(second.snapshot).map(character => character.characterId).sort(), ['Alice', 'bob']);

  // replay performance: 1000 deltas applied in place to one working copy
  let current = emptySnapshot('branch-A');
  const deltas: ReturnType<typeof diffValues>[] = [];
  for (let index = 0; index < 1000; index += 1) {
    const id = `npc${index % 25}`;
    const next = applyCandidate(current, {
      traces: { [id]: { currentSituations: [{ id: `s${index}`, text: `situation ${index}` }], affinity: { inner: ((index % 5) - 2) as -2 | -1 | 0 | 1 | 2 } } },
      story: { now: { currentTime: `Day ${index}` } }
    }, context(`floor-${index}`, `2026-09-19T00:${String(index % 60).padStart(2, '0')}:00.000Z`));
    deltas.push(diffValues(current, next.snapshot));
    current = next.snapshot;
  }
  const started = performance.now();
  let replayed: StateSnapshot = structuredClone(emptySnapshot('branch-A'));
  for (const delta of deltas) replayed = applyChangesInPlace(replayed, delta);
  const elapsed = performance.now() - started;
  assert.deepEqual(replayed, current);
  assert.equal(snapshotFingerprint(replayed), snapshotFingerprint(current));
  assert.ok(elapsed < 500, `replaying 1000 deltas took ${elapsed.toFixed(1)} ms`);
  console.log(`Phase 5 state diff acceptance passed (1000-delta replay ${elapsed.toFixed(1)} ms)`);
}

main();
