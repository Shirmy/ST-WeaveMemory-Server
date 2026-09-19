import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AiRequestError, OpenAiCompatibleClient, type ChatCompletionInput } from '../src/ai/openai-compatible-client';
import { draftChannel } from '../src/storage/ai-config-store';

type Scripted = (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void | Promise<void>;

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function expectAiError(work: () => Promise<unknown>, code: string, retryable: boolean): Promise<AiRequestError> {
  let caught: unknown;
  try {
    await work();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof AiRequestError, `expected AiRequestError ${code}, got ${String(caught)}`);
  assert.equal(caught.code, code, `unexpected code for ${caught.message}`);
  assert.equal(caught.retryable, retryable, `unexpected retryable flag for ${caught.message}`);
  return caught;
}

async function main(): Promise<void> {
  const completions: Scripted[] = [];
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const url = req.url ?? '';
    const auth = req.headers.authorization;
    if (auth !== 'Bearer sk-test') {
      json(res, 401, { error: { message: `bad key ${auth ?? 'none'}` } });
      return;
    }
    if (req.method === 'GET' && url === '/v1/models') {
      json(res, 200, { data: [{ id: 'b-model' }, { id: 'a-model' }, { id: 'a-model' }] });
      return;
    }
    if (req.method === 'GET' && url === '/api/v1/models') {
      json(res, 200, { data: [{ id: 'nested' }] });
      return;
    }
    if (req.method === 'POST' && url === '/v1/embeddings') {
      json(res, 200, { data: [{ embedding: [0.1, 0.2, 0.3] }] });
      return;
    }
    if (req.method === 'POST' && url === '/v1/rerank') {
      json(res, 200, { results: [{ index: 0, relevance_score: 0.9 }] });
      return;
    }
    if (req.method === 'POST' && url === '/v1/chat/completions') {
      const handler = completions.shift();
      if (!handler) {
        json(res, 500, { error: { message: 'no scripted response' } });
        return;
      }
      await handler(req, body, res);
      return;
    }
    json(res, 404, { error: { message: 'not found' } });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;

  try {
    const client = new OpenAiCompatibleClient();
    const channel = draftChannel({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'sk-test', headers: { 'X-Trace': 'wm' } });
    assert.equal(channel.baseUrl, `http://127.0.0.1:${port}/v1`);
    const base: ChatCompletionInput = { model: 'test-model', messages: [{ role: 'user', content: 'hi' }], temperature: 0, maxTokens: 64, timeoutMs: 2000 };
    const chat = (): Promise<unknown> => client.chatCompletion(channel, base);

    // model list is deduplicated and sorted
    assert.deepEqual(await client.listModels(channel, 2000), ['a-model', 'b-model']);

    // a base URL without the version segment falls back to /v1 on 404
    const nested = draftChannel({ baseUrl: `http://127.0.0.1:${port}/api`, apiKey: 'sk-test' });
    assert.equal(nested.baseUrl, `http://127.0.0.1:${port}/api`);
    assert.deepEqual(await client.listModels(nested, 2000), ['nested']);

    // authentication failures are final and the key never appears in the message
    const wrongKey = draftChannel({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'sk-wrong-key' });
    const authError = await expectAiError(() => client.listModels(wrongKey, 2000), 'WM_AI_CHANNEL_UNAVAILABLE', false);
    assert.equal(authError.status, 401);
    assert.equal(authError.message.includes('sk-wrong-key'), false);

    // successful completion: custom headers, request body shape, array content parts, usage
    let seenHeaders: http.IncomingHttpHeaders = {};
    let seenBody: Record<string, unknown> = {};
    completions.push((req, body, res) => {
      seenHeaders = req.headers;
      seenBody = JSON.parse(body) as Record<string, unknown>;
      json(res, 200, {
        model: 'served-model',
        choices: [{ message: { content: [{ type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }] }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 3 }
      });
    });
    const result = await client.chatCompletion(channel, base);
    assert.equal(result.text, '{"a":1}');
    assert.equal(result.finishReason, 'stop');
    assert.equal(result.model, 'served-model');
    assert.deepEqual(result.usage, { promptTokens: 12, completionTokens: 3 });
    assert.equal(seenHeaders['x-trace'], 'wm');
    assert.equal(seenHeaders.authorization, 'Bearer sk-test');
    assert.equal(seenBody.model, 'test-model');
    assert.equal(seenBody.stream, false);
    assert.equal(seenBody.max_tokens, 64);
    assert.equal(seenBody.temperature, 0);

    // error classification
    completions.push((_req, _body, res) => json(res, 429, { error: { message: 'slow down' } }));
    await expectAiError(chat, 'WM_AI_RATE_LIMITED', true);
    completions.push((_req, _body, res) => json(res, 503, { error: { message: 'upstream' } }));
    await expectAiError(chat, 'WM_AI_REQUEST_FAILED', true);
    completions.push((_req, _body, res) => json(res, 400, { error: { message: 'bad request' } }));
    await expectAiError(chat, 'WM_AI_REQUEST_FAILED', false);
    completions.push((_req, _body, res) => json(res, 200, { error: { message: 'gateway error with HTTP 200' } }));
    await expectAiError(chat, 'WM_AI_REQUEST_FAILED', false);
    completions.push((_req, _body, res) => json(res, 200, { choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] }));
    await expectAiError(chat, 'WM_AI_OUTPUT_TRUNCATED', true);
    completions.push((_req, _body, res) => json(res, 200, { choices: [{ message: { content: '', reasoning_content: 'thinking' }, finish_reason: 'stop' }] }));
    await expectAiError(chat, 'WM_AI_EMPTY_OUTPUT', true);
    completions.push((_req, _body, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>timeout page</html>');
    });
    await expectAiError(chat, 'WM_INVALID_RESPONSE', true);

    // timeout and external cancellation
    completions.push((_req, _body, res) => {
      setTimeout(() => json(res, 200, { choices: [{ message: { content: 'late' } }] }), 400);
    });
    await expectAiError(() => client.chatCompletion(channel, { ...base, timeoutMs: 100 }), 'WM_AI_TIMEOUT', true);
    const controller = new AbortController();
    completions.push((_req, _body, res) => {
      setTimeout(() => json(res, 200, { choices: [{ message: { content: 'late' } }] }), 400);
    });
    const pending = client.chatCompletion(channel, { ...base, timeoutMs: 2000, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expectAiError(() => pending, 'WM_TASK_CANCELLED', false);

    // unreachable endpoint
    const unreachable = draftChannel({ baseUrl: 'http://127.0.0.1:9', apiKey: 'sk-test' });
    await expectAiError(() => client.listModels(unreachable, 2000), 'WM_AI_CHANNEL_UNAVAILABLE', true);

    // role probes
    completions.push((_req, _body, res) => json(res, 200, { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }));
    assert.equal((await client.testModel(channel, 'test-model', 'state', 2000)).detail, 'OK');
    completions.push((_req, _body, res) => json(res, 200, { choices: [{ message: { content: '' }, finish_reason: 'length' }] }));
    assert.match((await client.testModel(channel, 'reasoner', 'summary', 2000)).detail, /reachable/);
    assert.equal((await client.testModel(channel, 'embed', 'embedding', 2000)).detail, 'dimensions=3');
    assert.deepEqual((await client.createEmbedding(channel, 'embed', 'hello', 2000)).vector, [0.1, 0.2, 0.3]);
    assert.equal((await client.testModel(channel, 'rerank', 'rerank', 2000)).detail, 'results=1');
    assert.equal(completions.length, 0);
    console.log('Phase 4 AI client acceptance passed');
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

void main();
