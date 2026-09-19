import assert from 'node:assert/strict';
import { resolveExternalMappings } from '../src/state/external-mapping';

const base = { source: 'mvu' as const, detected: true, statData: { role: { location: 'study', affinity: 80 } }, messageIndex: 7, swipeId: 1, cardId: 'card-a' };
const equivalent = resolveExternalMappings({ ...base, mappings: [{ id: 'location', source: 'mvu', externalPath: 'role.location', weaveTarget: { domain: 'trace', path: 'currentSituations.location' }, mode: 'equivalent', enabled: true }] });
assert.deepEqual(equivalent.activeEquivalentMappings, ['location']);
assert.deepEqual(equivalent.suppressedWeaveFields, ['trace:currentSituations']);
assert.equal(resolveExternalMappings(undefined).suppressedWeaveFields.length, 0);
assert.equal(resolveExternalMappings({ ...base, mappings: [] }).mappingCount, 0);
assert.equal(resolveExternalMappings({ ...base, mappings: [{ id: 'missing', source: 'mvu', externalPath: 'role.missing', weaveTarget: { domain: 'trace', path: 'affinity' }, mode: 'equivalent', enabled: true }] }).suppressedWeaveFields.length, 0);
const related = resolveExternalMappings({ ...base, mappings: [{ id: 'affinity', source: 'mvu', externalPath: 'role.affinity', weaveTarget: { domain: 'trace', path: 'affinity' }, mode: 'related', enabled: true }] });
assert.deepEqual(related.activeRelatedMappings, ['affinity']);
assert.equal(related.suppressedWeaveFields.length, 0);
const swipeA = { ...base, swipeId: 0 };
const swipeB = { ...base, swipeId: 1 };
assert.equal(swipeA.swipeId, 0);
assert.equal(swipeB.swipeId, 1);
console.log('external mapping acceptance passed');
