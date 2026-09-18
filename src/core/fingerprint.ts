import { createHash } from 'node:crypto';

export function fingerprint(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

export type DependencyFingerprintParts = {
  bodyFingerprint: string;
  previousStateFingerprint: string | null;
  protocolVersion: number;
  schemaVersion: number;
  promptVersion: string;
};

/** Roadmap §13: hash(body + previous state + protocol + schema + prompt version). */
export function dependencyFingerprint(parts: DependencyFingerprintParts): string {
  return fingerprint([
    parts.bodyFingerprint,
    parts.previousStateFingerprint ?? '',
    String(parts.protocolVersion),
    String(parts.schemaVersion),
    parts.promptVersion
  ].join('\n'));
}
