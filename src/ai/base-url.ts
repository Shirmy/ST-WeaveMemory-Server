export class BaseUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BaseUrlError';
  }
}

/**
 * Normalizes an OpenAI-compatible base URL the same way the reference extensions do:
 * trailing slashes and a trailing `/chat/completions` are removed, and a bare host gets `/v1`.
 */
export function normalizeBaseUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new BaseUrlError('baseUrl is required');
  const text = raw.trim();
  if (!/^https?:\/\//i.test(text)) throw new BaseUrlError('baseUrl must start with http:// or https://');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new BaseUrlError('baseUrl is not a valid URL');
  }
  let pathname = url.pathname.replace(/\/+$/, '');
  pathname = pathname.replace(/\/chat\/completions$/i, '');
  if (!pathname) pathname = '/v1';
  return `${url.origin}${pathname}`;
}

export function joinUrl(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`;
}

/** Returns the alternative base URL to try when a server answers 404 (toggle the `/v1` suffix). */
export function alternateBaseUrl(baseUrl: string): string | null {
  if (/\/v1$/i.test(baseUrl)) return baseUrl.replace(/\/v1$/i, '');
  return `${baseUrl}/v1`;
}
