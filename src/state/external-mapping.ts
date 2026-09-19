export type ExternalStateMappingMode = 'equivalent' | 'related';
export type WeaveSuppression = { domain: 'profile' | 'trace' | 'story'; characterId?: string; field: string; itemId?: string; semanticKey?: string };
export type ExternalStateMapping = { id: string; source: 'mvu'; externalPath: string; weaveTarget: { domain: 'profile' | 'trace' | 'story'; path?: string; characterId?: string; field?: string; itemId?: string; semanticKey?: string }; mode: ExternalStateMappingMode; enabled: boolean };
export type ExternalStateSnapshot = { source: 'mvu'; detected: boolean; statData: unknown | null; messageIndex: number | null; swipeId: number | null; cardId: string | null; mappings: ExternalStateMapping[]; failure?: string };
export type ExternalMappingResolution = { mappingCount: number; activeEquivalentMappings: string[]; activeRelatedMappings: string[]; suppressedWeaveFields: WeaveSuppression[]; mappingFailures: string[] };
export function resolveExternalMappings(input?: ExternalStateSnapshot): ExternalMappingResolution {
  const out: ExternalMappingResolution = { mappingCount: 0, activeEquivalentMappings: [], activeRelatedMappings: [], suppressedWeaveFields: [], mappingFailures: [] };
  if (!input) return out;
  if (input.failure) out.mappingFailures.push(input.failure);
  if (!input.detected || input.statData === null || input.statData === undefined) return out;
  const mappings = Array.isArray(input.mappings) ? input.mappings : []; out.mappingCount = mappings.length;
  for (const mapping of mappings) {
    if (!mapping || mapping.source !== 'mvu' || !mapping.enabled || !mapping.id || !mapping.externalPath || (!mapping.weaveTarget?.path && !mapping.weaveTarget?.field)) { if (mapping?.id) out.mappingFailures.push(`${mapping.id}: weave target is missing`); continue; }
    if (!hasPath(input.statData, mapping.externalPath)) { out.mappingFailures.push(`${mapping.id}: external path not found`); continue; }
    const slot = semanticSlot(mapping.weaveTarget);
    if (!slot) { out.mappingFailures.push(`${mapping.id}: unsupported weave target`); continue; }
    if (mapping.mode === 'related') out.activeRelatedMappings.push(mapping.id);
    else if (mapping.mode === 'equivalent') { out.activeEquivalentMappings.push(mapping.id); out.suppressedWeaveFields.push(slot); }
    else out.mappingFailures.push(`${mapping.id}: unsupported mode`);
  }
  out.suppressedWeaveFields = out.suppressedWeaveFields.filter((slot, index, all) => all.findIndex(item => JSON.stringify(item) === JSON.stringify(slot)) === index); return out;
}
export function hasPath(value: unknown, path: string): boolean { let current: unknown = value; for (const part of path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)) { if (!current || typeof current !== 'object' || !(part in (current as Record<string, unknown>))) return false; current = (current as Record<string, unknown>)[part]; } return current !== undefined && current !== null; }
function semanticSlot(target: ExternalStateMapping['weaveTarget']): WeaveSuppression | null {
  const path = target.path ?? target.field ?? '';
  const parts = path.split('.').filter(Boolean);
  const field = parts[0];
  if (!field) return null;
  const item = target.itemId ?? target.semanticKey ?? (parts.length > 1 ? parts.slice(1).join('.') : undefined);
  if (target.domain === 'profile' && ['canonicalName', 'basic', 'identity', 'personality', 'appearance', 'lifeDetails'].includes(field)) return target.characterId ? { domain: 'profile', characterId: target.characterId, field: parts.join('.') } : null;
  if (target.domain === 'trace' && ['longTermTendencies', 'currentSituations', 'visibility', 'affinity'].includes(field)) {
    if (!target.characterId) return null;
    if (field === 'affinity' && parts.length > 1) return { domain: 'trace', characterId: target.characterId, field: parts.join('.') };
    if (['longTermTendencies', 'currentSituations', 'visibility'].includes(field) && !item) return null;
    return { domain: 'trace', characterId: target.characterId, field, ...(target.itemId ? { itemId: target.itemId } : {}), ...(target.semanticKey ? { semanticKey: target.semanticKey } : (!target.itemId && item ? { semanticKey: item } : {})) };
  }
  if (target.domain === 'story' && ['now', 'calendar', 'plotlines', 'plotPlans'].includes(field)) {
    if (field === 'now' && parts.length > 1) return { domain: 'story', field: parts.join('.') };
    if (['calendar', 'plotlines', 'plotPlans'].includes(field) && !item) return null;
    return { domain: 'story', field, ...(target.itemId ? { itemId: target.itemId } : {}), ...(target.semanticKey ? { semanticKey: target.semanticKey } : (!target.itemId && item ? { semanticKey: item } : {})) };
  }
  return null;
}
