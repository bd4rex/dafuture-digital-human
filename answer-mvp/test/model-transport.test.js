import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildApp } from '../server.js';

// Both hops use real loopback HTTP and the native fetch implementation.
// No external provider, real credentials, browser, or user data are involved.
const PLACEHOLDER_KEY = 'transport-test-placeholder-key';
const FALLBACK = '连接暂时不太顺畅，您可以稍后再问我一次。';
const ANSWER = '活动免费，欢迎您来参加。';
const QUESTION = '活动门票多少钱？';
const completion = (content = ANSWER, finishReason = 'stop') => JSON.stringify({
  model: 'loopback-resolved-model',
  choices: [{ message: { content }, finish_reason: finishReason }],
});

async function fixture(t, upstreamHandler) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'answer-model-transport-'));
  let app;
  const calls = [];
  const upstream = createServer(async (request, response) => {
    try {
      const buffers = [];
      for await (const chunk of request) buffers.push(chunk);
      calls.push({
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: JSON.parse(Buffer.concat(buffers).toString('utf8')),
      });
      upstreamHandler(request, response);
    } catch (error) {
      response.destroy(error);
    }
  });
  t.after(async () => {
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    if (app) await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const modelConfigPath = path.join(directory, 'model-config.json');
  await writeFile(modelConfigPath, JSON.stringify({
    baseUrl: `${upstreamUrl}/v1`,
    apiKey: PLACEHOLDER_KEY,
    model: 'loopback-requested-model',
    timeoutMs: 1_000,
    maxTokens: 256,
    temperature: 0.2,
    serviceErrorText: FALLBACK,
  }), { mode: 0o600 });
  app = await buildApp({
    contentPath: path.join(directory, 'content.json'),
    modelConfigPath,
    knowledgePath: path.join(directory, 'knowledge.json'),
    knowledgeFilesDirectory: path.join(directory, 'knowledge-files'),
    liveControlPath: path.join(directory, 'host-scripts.json'),
    adminAuthPath: path.join(directory, 'admin-auth.json'),
    opsLogPath: path.join(directory, 'operations.jsonl'),
    adminPassword: 'transport-test-admin-password',
    adminApiKey: '',
    bundledKnowledgeEnabled: false,
    pollIntervalMs: 60_000,
    logger: false,
  });
  await app.knowledgeStore.importFiles([
    { filename: '票务.txt', buffer: Buffer.from('活动门票免费。') },
  ], 'append');
  await app.listen({ host: '127.0.0.1', port: 0 });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const ask = async () => {
    const response = await fetch(`${url}/answer`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: QUESTION }),
      signal: AbortSignal.timeout(5_000),
    });
    return { response, body: await response.json() };
  };
  const dialogueLogs = async (turnId) => {
    const result = await app.opsLogStore.query({ search: turnId });
    const received = result.entries.filter((entry) => entry.action === 'question.received');
    const answered = result.entries.filter((entry) => entry.action === 'question.answer');
    assert.equal(received.length, 1, 'one received record per turn');
    assert.equal(answered.length, 1, 'one final result record per turn');
    assert.equal(answered[0].dialogue.question, QUESTION);
    assert.equal(JSON.stringify(result).includes(PLACEHOLDER_KEY), false);
    return answered[0];
  };
  return { app, ask, calls, dialogueLogs };
}

async function assertFailure(t, handler, { error, status = 502, stage = 'response', upstreamStatus }) {
  const { app, ask, dialogueLogs } = await fixture(t, handler);
  const { response, body } = await ask();
  const entry = await dialogueLogs(body.turnId);
  if (body.error !== error) {
    t.diagnostic(JSON.stringify({ error: body.error,
      loggedError: entry.details.errorCode, loggedStage: entry.details.failureStage }));
  }
  assert.equal(response.status, status);
  assert.equal(body.error, error);
  assert.equal(body.answerStatus, 'error');
  assert.equal(body.answered, false);
  assert.equal(body.answer, FALLBACK);
  assert.equal(body.speechText, FALLBACK);
  assert.equal(typeof body.turnId, 'string');
  assert.equal(JSON.stringify(body).includes(PLACEHOLDER_KEY), false);
  assert.equal(entry.outcome, 'failure');
  assert.equal(entry.details.errorCode, error);
  assert.equal(entry.details.failureStage, stage);
  assert.equal(entry.dialogue.answer, FALLBACK);
  if (upstreamStatus) assert.equal(entry.details.upstreamStatus, upstreamStatus);
  const ready = await app.inject({ url: '/ready' });
  assert.equal(ready.statusCode, 503, 'failed provider must not report ready');
}

test('真实模型 HTTP：请求协议、知识上下文、答案和完整问答日志一致', async (t) => {
  const { ask, calls, dialogueLogs } = await fixture(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(completion(JSON.stringify({ status: 'answered', answer: ANSWER })));
  });
  const { response, body } = await ask();
  assert.equal(response.status, 200);
  assert.equal(body.answer, ANSWER);
  assert.equal(body.speechText, ANSWER);
  assert.equal(body.model, 'loopback-resolved-model');
  assert.equal(body.answerStatusSource, 'structured');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/v1/chat/completions');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.authorization, `Bearer ${PLACEHOLDER_KEY}`);
  assert.equal(calls[0].body.model, 'loopback-requested-model');
  assert.equal(calls[0].body.max_tokens, 256);
  assert.equal(calls[0].body.temperature, 0.2);
  assert.match(calls[0].body.messages[1].content, /活动门票免费/);
  const entry = await dialogueLogs(body.turnId);
  assert.equal(entry.outcome, 'success');
  assert.equal(entry.dialogue.answer, ANSWER);
  assert.equal(entry.details.model, 'loopback-resolved-model');
  assert.equal(entry.details.errorCode, undefined);
});

for (const status of [401, 429, 503]) {
  test(`真实模型 HTTP：${status} 即使返回非 JSON，仍按上游状态分类且不回显详情`, async (t) => {
    await assertFailure(t, (_request, response) => {
      response.writeHead(status, { 'content-type': 'text/html' });
      response.end(`<html>private upstream detail: ${PLACEHOLDER_KEY}</html>`);
    }, { error: 'MODEL_UPSTREAM_ERROR', stage: 'upstream', upstreamStatus: status });
  });
}

test('真实模型 HTTP：完整送达但无效的 JSON 归类为响应格式错误', async (t) => {
  await assertFailure(t, (_request, response) => response.end('{"choices": broken'), {
    error: 'MODEL_INVALID_RESPONSE',
  });
});

test('真实模型 HTTP：响应头之前断开连接归类为网络连接失败', async (t) => {
  await assertFailure(t, (request) => request.socket.destroy(), {
    error: 'MODEL_CONNECTION_FAILED', stage: 'transport',
  });
});

test('真实模型 HTTP：上游不发送响应头时按配置超时并提供自然兜底', async (t) => {
  await assertFailure(t, () => {}, { error: 'MODEL_TIMEOUT', status: 504, stage: 'transport' });
});

test('真实模型 HTTP：响应头到达但正文悬挂仍受同一超时约束', async (t) => {
  await assertFailure(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"choices":[');
  }, { error: 'MODEL_TIMEOUT', status: 504, stage: 'transport' });
});

for (const [reason, error] of [
  ['length', 'MODEL_TRUNCATED_RESPONSE'],
  ['content_filter', 'MODEL_RESPONSE_REJECTED'],
]) {
  test(`真实模型 HTTP：finish_reason=${reason} 不播报残缺正文`, async (t) => {
    await assertFailure(t, (_request, response) => response.end(completion('不完整的回答', reason)), { error });
  });
}

test('真实模型 HTTP：网络恢复后的下一轮恢复就绪且日志不继承旧故障', async (t) => {
  let fail = true;
  const { app, ask, dialogueLogs } = await fixture(t, (_request, response) => {
    response.writeHead(fail ? 503 : 200, { 'content-type': 'application/json' });
    response.end(fail ? '{"error":"temporarily unavailable"}' : completion());
  });
  const failed = await ask();
  assert.equal(failed.body.error, 'MODEL_UPSTREAM_ERROR');
  assert.equal((await app.inject({ url: '/ready' })).statusCode, 503);
  fail = false;
  const recovered = await ask();
  assert.equal(recovered.response.status, 200);
  assert.notEqual(recovered.body.turnId, failed.body.turnId);
  assert.equal((await app.inject({ url: '/ready' })).statusCode, 200);
  const entry = await dialogueLogs(recovered.body.turnId);
  assert.equal(entry.outcome, 'success');
  assert.equal(entry.details.errorCode, undefined);
  assert.equal(entry.details.upstreamStatus, undefined);
});

test('REVIEW-HTTP-001：响应正文中途断流应与完整送达的坏 JSON 区分', async (t) => {
  await assertFailure(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': '4096' });
    response.write('{"choices":[');
    const timer = setTimeout(() => response.destroy(), 50);
    t.after(() => clearTimeout(timer));
  }, { error: 'MODEL_CONNECTION_FAILED', stage: 'transport' });
});

test('真实模型 HTTP：错误 gzip 正文仍是响应错误，不能将所有 TypeError 误记为断网', async (t) => {
  await assertFailure(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
    response.end('not a gzip stream');
  }, { error: 'MODEL_INVALID_RESPONSE', stage: 'response' });
});

test('真实模型 HTTP：非最终工具调用不播过程文字，日志保留完成原因', async (t) => {
  const { ask, dialogueLogs } = await fixture(t, (_request, response) => {
    response.end(completion('我需要先查询活动信息。', 'tool_calls'));
  });
  const { response, body } = await ask();
  assert.equal(response.status, 502);
  assert.equal(body.error, 'MODEL_RESPONSE_REJECTED');
  assert.equal(body.answered, false);
  assert.equal(body.speechText, FALLBACK);
  const entry = await dialogueLogs(body.turnId);
  assert.equal(entry.details.finishReason, 'tool_calls');
  assert.equal(entry.details.failureStage, 'response');
  assert.equal(entry.dialogue.answer, FALLBACK);
});
