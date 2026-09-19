export type ExternalStateMappingMode = 'equivalent' | 'related';
export type ExternalStateMapping = { id: string; source: 'mvu'; externalPath: string; weaveTarget: { domain: 'profile' | 'trace' | 'story'; path: string }; mode: ExternalStateMappingMode; enabled: boolean };
export type ExternalStateSnapshot = { source: 'mvu'; detected: boolean; statData: unknown | null; messageIndex: number | null; swipeId: number | null; cardId: string | null; mappings: ExternalStateMapping[]; failure?: string };
export type ExternalMappingResolution = { mappingCount: number; activeEquivalentMappings: string[]; activeRelatedMappings: string[]; suppressedWeaveFields: string[]; mappingFailures: string[] };
export function resolveExternalMappings(input?: ExternalStateSnapshot): ExternalMappingResolution {
  const out: ExternalMappingResolution = { mappingCount: 0, activeEquivalentMappings: [], activeRelatedMappings: [], suppressedWeaveFields: [], mappingFailures: [] };
  if (!input) return out;
  if (input.failure) out.mappingFailures.push(input.failure);
  if (!input.detected || input.statData === null || input.statData === undefined) return out;
  const mappings = Array.isArray(input.mappings) ? input.mappings : []; out.mappingCount = mappings.length;
  for (const mapping of mappings) {
    if (!mapping || mapping.source !== 'mvu' || !mapping.enabled || !mapping.id || !mapping.externalPath || !mapping.weaveTarget?.path) continue;
    if (!hasPath(input.statData, mapping.externalPath)) { out.mappingFailures.push(`${mapping.id}: external path not found`); continue; }
    const slot = semanticSlot(mapping.weaveTarget.domain, mapping.weaveTarget.path);
    if (!slot) { out.mappingFailures.push(`${mapping.id}: unsupported weave target`); continue; }
    if (mapping.mode === 'related') out.activeRelatedMappings.push(mapping.id);
    else if (mapping.mode === 'equivalent') { out.activeEquivalentMappings.push(mapping.id); out.suppressedWeaveFields.push(slot); }
    else out.mappingFailures.push(`${mapping.id}: unsupported mode`);
  }
  out.suppressedWeaveFields = [...new Set(out.suppressedWeaveFields)]; return out;
}
export function hasPath(value: unknown, path: string): boolean { let current: unknown = value; for (const part of path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)) { if (!current || typeof current !== 'object' || !(part in (current as Record<string, unknown>))) return false; current = (current as Record<string, unknown>)[part]; } return current !== undefined && current !== null; }
function semanticSlot(domain: ExternalStateMapping['weaveTarget']['domain'], path: string): string | null { const field = path.split('.').filter(Boolean)[0]; if (!field) return null; if (domain === 'profile' && ['canonicalName', 'basic', 'identity', 'personality', 'appearance', 'lifeDetails'].includes(field)) return `profile:${field}`; if (domain === 'trace' && ['longTermTendencies', 'currentSituations', 'visibility', 'affinity'].includes(field)) return `trace:${field}`; if (domain === 'story' && ['now', 'calendar', 'plotlines', 'plotPlans'].includes(field)) return `story:${field}`; return null; }
