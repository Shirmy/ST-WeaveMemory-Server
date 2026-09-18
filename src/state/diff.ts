import { createHash } from 'node:crypto';

/**
 * Program-computed state changes (roadmap §11). Paths use JSON-pointer style segments
 * (`/profiles/alice/basic/age`) with RFC 6901 escaping so character ids may contain dots.
 * Arrays are treated as atomic values: a changed array is replaced as a whole (§8.3).
 */
export type JsonPatchLikeChange = {
  op: 'add' | 'remove' | 'replace';
  path: string;
  oldValue?: unknown;
  newValue?: unknown;
};

export class StateDiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateDiffError';
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

export function unescapePointerSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

export function joinPointer(segments: string[]): string {
  return segments.map(segment => `/${escapePointerSegment(segment)}`).join('');
}

export function splitPointer(path: string): string[] {
  if (path === '') return [];
  if (!path.startsWith('/')) throw new StateDiffError(`invalid change path: ${path}`);
  return path.slice(1).split('/').map(unescapePointerSegment);
}

/** Deterministic JSON with recursively sorted object keys; `undefined` members are dropped. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item === undefined ? null : item)).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

export function hashCanonical(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

export function deepEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function deepClone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Computes the changes that turn `before` into `after`. Plain objects are compared member by
 * member; arrays and primitives are compared as whole values.
 */
export function diffValues(before: unknown, after: unknown, basePath: string[] = []): JsonPatchLikeChange[] {
  if (isPlainObject(before) && isPlainObject(after)) {
    const changes: JsonPatchLikeChange[] = [];
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].sort()) {
      const path = [...basePath, key];
      const hasBefore = before[key] !== undefined;
      const hasAfter = after[key] !== undefined;
      if (hasBefore && !hasAfter) changes.push({ op: 'remove', path: joinPointer(path), oldValue: deepClone(before[key]) });
      else if (!hasBefore && hasAfter) changes.push({ op: 'add', path: joinPointer(path), newValue: deepClone(after[key]) });
      else if (hasBefore && hasAfter) changes.push(...diffValues(before[key], after[key], path));
    }
    return changes;
  }
  if (deepEqual(before, after)) return [];
  return [{ op: 'replace', path: joinPointer(basePath), oldValue: deepClone(before), newValue: deepClone(after) }];
}

/** Applies changes to a deep copy of `target` and returns the result; missing parents are created for `add`. */
export function applyChanges<T>(target: T, changes: JsonPatchLikeChange[]): T {
  return applyChangesInPlace(deepClone(target), changes);
}

/** Mutates `root` directly; replay uses this to apply many deltas to one working copy. */
export function applyChangesInPlace<T>(root: T, changes: JsonPatchLikeChange[]): T {
  let current: unknown = root;
  for (const change of changes) {
    const segments = splitPointer(change.path);
    if (segments.length === 0) {
      if (change.op === 'remove') throw new StateDiffError('cannot remove the document root');
      current = deepClone(change.newValue);
      continue;
    }
    const parentSegments = segments.slice(0, -1);
    const leaf = segments[segments.length - 1];
    if (!isPlainObject(current)) throw new StateDiffError(`cannot apply ${change.op} at ${change.path}: root is not an object`);
    let parent: Record<string, unknown> = current;
    for (const segment of parentSegments) {
      const next = parent[segment];
      if (next === undefined || next === null) {
        if (change.op === 'remove') throw new StateDiffError(`cannot remove missing path ${change.path}`);
        const created: Record<string, unknown> = {};
        parent[segment] = created;
        parent = created;
        continue;
      }
      if (!isPlainObject(next)) throw new StateDiffError(`cannot descend into non-object at ${change.path}`);
      parent = next;
    }
    if (change.op === 'remove') {
      if (!(leaf in parent)) throw new StateDiffError(`cannot remove missing path ${change.path}`);
      delete parent[leaf];
    } else {
      parent[leaf] = deepClone(change.newValue);
    }
  }
  return current as T;
}

/** Splits a flat change list by top-level segment (profiles / traces / story / everything else). */
export function partitionChanges(changes: JsonPatchLikeChange[]): {
  profileChanges: JsonPatchLikeChange[];
  traceChanges: JsonPatchLikeChange[];
  storyChanges: JsonPatchLikeChange[];
  rootChanges: JsonPatchLikeChange[];
} {
  const result = { profileChanges: [] as JsonPatchLikeChange[], traceChanges: [] as JsonPatchLikeChange[], storyChanges: [] as JsonPatchLikeChange[], rootChanges: [] as JsonPatchLikeChange[] };
  for (const change of changes) {
    const [head] = splitPointer(change.path);
    if (head === 'profiles') result.profileChanges.push(change);
    else if (head === 'traces') result.traceChanges.push(change);
    else if (head === 'story') result.storyChanges.push(change);
    else result.rootChanges.push(change);
  }
  return result;
}
