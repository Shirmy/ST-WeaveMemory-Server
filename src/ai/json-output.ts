import { AiRequestError } from './openai-compatible-client';

function invalid(message: string): AiRequestError {
  return new AiRequestError('WM_INVALID_RESPONSE', message, true);
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function cleanup(text: string): string {
  return text
    .replace(/[“”]/g, '"')
    .replace(/,\s*([}\]])/g, '$1');
}

/**
 * Extracts the single JSON object a state model is expected to return. Tolerates reasoning
 * blocks, Markdown fences and surrounding prose, and repairs trailing commas / smart quotes.
 */
export function extractJsonObject(raw: string): Record<string, unknown> {
  let text = raw.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
  if (/^<think(?:ing)?>/i.test(text) && !/<\/think(?:ing)?>/i.test(text)) throw invalid('output is an unterminated reasoning block');
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  if (!text) throw invalid('output is empty');
  const candidates = [text];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start && (start > 0 || end < text.length - 1)) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    const parsed = tryParse(candidate) ?? tryParse(cleanup(candidate));
    if (parsed === undefined) continue;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid('output JSON is not an object');
    return parsed as Record<string, unknown>;
  }
  throw invalid('output is not valid JSON');
}
