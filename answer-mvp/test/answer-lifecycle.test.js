import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp, prepareModelConfig } from '../server.js';

const answerText = '活动门票免费，欢迎参加。';
const ticket = { id: 'ticket-chunk-1', text: '活动门票票价：免费。' };
const largeLibrary = [
  ...Array.from({ length: 40 }, (_, i) => ({
    id: `noise-${i}-chunk-1`, text: '春季活动。'.repeat(160),
  })), ticket,
];
const payload = (answer = answerText) => ({
  choices: [{ finish_reason: 'stop', message: {
    content: JSON.stringify({ status: 'answered', answer }),
  } }],
});
const response = (answer) => new Response(JSON.stringify(payload(answer)));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

async function fixture(t, llmFetch, beforeReady = () => {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'answer-lifecycle-test-'));
  const app = await buildApp({
    contentPath: path.join(directory, 'content.json'),
    modelConfigPath: path.join(directory, 'model.json'),
    knowledgePath: path.join(directory, 'knowledge.json'),
    knowledgeFilesDirectory: path.join(directory, 'knowledge-files'),
    adminAuthPath: path.join(directory, 'admin.json'),
    liveControlPath: path.join(directory, 'live.json'),
    opsLogPath: path.join(directory, 'ops.jsonl'),
    bundledKnowledgeEnabled: false, adminPassword: 'lifecycle-test-password',
    adminApiKey: '', logger: false, pollIntervalMs: 60_000, llmFetch,
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  app.modelConfigStore.config = prepareModelConfig({
    baseUrl: 'http://model.invalid/v1', apiKey: 'lifecycle-placeholder-key', model: 'lifecycle-model',
  });
  app.modelConfigStore.markConnectionSuccess({ model: 'lifecycle-model', latencyMs: 1 });
  app.knowledgeStore.importedChunks = () => [ticket];
  beforeReady(app);
  const login = await app.inject({ method: 'POST', url: '/api/admin/login',
    payload: { password: 'lifecycle-test-password' } });
  assert.equal(login.statusCode, 200);
  const cookie = login.headers['set-cookie'].split(';')[0];
  const switchMode = async (mode) => {
    const result = await app.inject({ method: 'POST', url: '/api/live-control/mode',
      headers: { cookie }, payload: { mode } });
    assert.equal(result.statusCode, 200);
    return result.json();
  };
  const logs = async () => {
    await app.opsLogStore.flush();
    return (await readFile(path.join(directory, 'ops.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  };
  return { app, switchMode, logs };
}

const ask = (app) => app.inject({ method: 'POST', url: '/answer',
  payload: { question: '入场要花银子吗？' } }).then((result) => result);

async function within(promise, milliseconds = 1_000) {
  let timeout;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('operation did not settle after cancellation')), milliseconds);
    })]);
  } finally { clearTimeout(timeout); }
}

function assertCancelled(result, error = 'HOSTING_MODE_ACTIVE') {
  assert.equal(result.statusCode, 409);
  const body = result.json();
  assert.equal(body.error, error);
  assert.equal(body.answered, false);
  assert.equal(body.answerStatus, 'cancelled');
  assert.equal(body.cancellationReason, 'LIVE_CONTROL_CHANGED');
  assert.equal(body.answer, '');
  assert.equal(body.speechText, '');
  return body;
}

test('主持接管使在途最终答案立即失效，忽略 abort 的上游也不能返回旧播报', async (t) => {
  const entered = deferred();
  const gate = deferred();
  let signal;
  const { app, switchMode, logs } = await fixture(t, async (_url, options) => {
    signal = options.signal; entered.resolve(); await gate.promise; return response();
  });
  const pending = ask(app);
  try {
    await entered.promise;
    const previousSequence = app.liveControlStore.sequence;
    await switchMode('hosting');
    const result = await within(pending);
    const body = assertCancelled(result);
    assert.equal(signal.aborted, true);
    assert.equal(app.modelConfigStore.connection.status, 'available');
    const cancelled = (await logs()).find((entry) => entry.action === 'question.cancelled');
    assert.ok(cancelled);
    assert.equal(cancelled.outcome, 'rejected');
    assert.equal(cancelled.details.turnId, body.turnId);
    assert.equal(cancelled.details.cancellationReason, 'LIVE_CONTROL_CHANGED');
    assert.equal(cancelled.details.modelStage, 'answer');
    assert.equal(cancelled.details.startedSequence, previousSequence);
    assert.equal(cancelled.dialogue.question, '入场要花银子吗？');
    assert.equal(cancelled.dialogue.answer, '');
  } finally { gate.resolve(); await pending; }
});

test('主持再切回对话也不能复活旧请求，最终 await 后按控制代次检查', async (t) => {
  const entered = deferred();
  const gate = deferred();
  const { app } = await fixture(t, async () => {
    entered.resolve(); await gate.promise; return response();
  });
  const pending = ask(app);
  try {
    await entered.promise;
    // Direct store changes intentionally bypass broadcast, covering the final guard.
    app.liveControlStore.switchMode('hosting');
    app.liveControlStore.switchMode('dialogue');
    gate.resolve();
    assertCancelled(await pending, 'ANSWER_CANCELLED');
    assert.equal(app.modelConfigStore.connection.status, 'available');
  } finally { gate.resolve(); await pending; }
});

test('控制实例更换而序号相同，旧请求仍被取消', async (t) => {
  const entered = deferred();
  const gate = deferred();
  const { app } = await fixture(t, async () => {
    entered.resolve(); await gate.promise; return response();
  });
  const pending = ask(app);
  try {
    await entered.promise;
    app.liveControlStore.instanceId = randomUUID();
    gate.resolve();
    assertCancelled(await pending, 'ANSWER_CANCELLED');
  } finally { gate.resolve(); await pending; }
});

test('主持接管可取消正在读取的响应正文，AbortError 不污染模型健康', async (t) => {
  const entered = deferred();
  const gate = deferred();
  const { app, switchMode, logs } = await fixture(t, async () => ({
    ok: true,
    json: async () => {
      entered.resolve(); await gate.promise;
      throw new DOMException('upstream aborted', 'AbortError');
    },
  }));
  const pending = ask(app);
  try {
    await entered.promise;
    await switchMode('hosting');
    assertCancelled(await within(pending));
    gate.resolve();
    await delay(0);
    assert.equal(app.modelConfigStore.connection.status, 'available');
    const entries = await logs();
    assert.equal(entries.filter((entry) => entry.action === 'question.cancelled').length, 1);
    assert.ok(!entries.some((entry) => ['MODEL_TIMEOUT', 'MODEL_CONNECTION_FAILED'].includes(entry.details?.errorCode)));
  } finally { gate.resolve(); await pending; }
});

test('真实 HTTP 访客在改写期间断开，信号传递且不再新增回答调用', async (t) => {
  const entered = deferred();
  const aborted = deferred();
  const gate = deferred();
  const calls = [];
  const { app, logs } = await fixture(t, async (_url, options) => {
    calls.push(options);
    if (calls.length === 1) {
      options.signal.addEventListener('abort', aborted.resolve, { once: true });
      entered.resolve(); await gate.promise; return response('门票；票价；费用');
    }
    return response();
  });
  app.knowledgeStore.importedChunks = () => largeLibrary;
  await app.listen({ host: '127.0.0.1', port: 0 });
  const controller = new AbortController();
  const pending = fetch(`http://127.0.0.1:${app.server.address().port}/answer`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: '入场要花银子吗？' }), signal: controller.signal,
  }).then(() => null, (error) => error);
  try {
    await entered.promise;
    controller.abort();
    assert.equal((await pending).name, 'AbortError');
    await within(aborted.promise);
    gate.resolve();
    await delay(20);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].signal.aborted, true);
    assert.equal(app.modelConfigStore.connection.status, 'available');
    const cancelled = (await logs()).find((entry) => entry.action === 'question.cancelled');
    assert.equal(cancelled.details.cancellationReason, 'CLIENT_DISCONNECTED');
    assert.equal(cancelled.details.modelStage, 'query-rewrite');
    assert.ok(!(await logs()).some((entry) => entry.action === 'question.retrieval' && entry.outcome === 'failure'));
  } finally { controller.abort(); gate.resolve(); await pending; await delay(20); }
});

test('改写模型错误与主持接管同时到达，取消优先于模型故障', async (t) => {
  let app;
  let calls = 0;
  const setup = await fixture(t, async () => {
    calls += 1;
    app.liveControlStore.switchMode('hosting');
    return new Response('unavailable', { status: 503 });
  });
  app = setup.app;
  app.knowledgeStore.importedChunks = () => largeLibrary;
  assertCancelled(await ask(app));
  assert.equal(calls, 1);
  assert.equal(app.modelConfigStore.connection.status, 'available');
});

test('取消请求的迟到成功不恢复旧健康状态，也不影响切回对话后的新一轮', async (t) => {
  const entered = deferred();
  const gate = deferred();
  let calls = 0;
  const { app, switchMode, logs } = await fixture(t, async () => {
    calls += 1;
    if (calls === 1) { entered.resolve(); await gate.promise; }
    return response();
  });
  app.modelConfigStore.markConnectionFailure(Object.assign(new Error('isolated prior failure'),
    { code: 'MODEL_UPSTREAM_ERROR' }));
  const previousHealth = structuredClone(app.modelConfigStore.connection);
  const pending = ask(app);
  try {
    await entered.promise;
    await switchMode('hosting');
    assertCancelled(await within(pending));
    gate.resolve();
    await delay(0);
    assert.deepEqual(app.modelConfigStore.connection, previousHealth);
    await switchMode('dialogue');
    const next = await ask(app);
    assert.equal(next.statusCode, 200);
    assert.equal(next.json().speechText, answerText);
    assert.equal(app.modelConfigStore.connection.status, 'available');
    // Disposed lifecycles must not emit another cancellation on later controls.
    await switchMode('hosting');
    assert.equal((await logs()).filter((entry) => entry.action === 'question.cancelled').length, 1);
    assert.equal(calls, 2);
  } finally { gate.resolve(); await pending; }
});

test('取消正在等待的改写后，迟到成功不能更新新配置的健康状态', async (t) => {
  const entered = deferred();
  const gate = deferred();
  let calls = 0;
  const { app, switchMode } = await fixture(t, async () => {
    calls += 1; entered.resolve(); await gate.promise; return response('门票；票价');
  });
  app.knowledgeStore.importedChunks = () => largeLibrary;
  const pending = ask(app);
  try {
    await entered.promise;
    app.modelConfigStore.config = prepareModelConfig({ ...app.modelConfigStore.config, model: 'new-model' });
    app.modelConfigStore.markConnectionFailure(Object.assign(new Error('isolated new model failure'),
      { code: 'MODEL_CONNECTION_FAILED' }));
    const newHealth = structuredClone(app.modelConfigStore.connection);
    await switchMode('hosting');
    assertCancelled(await within(pending));
    gate.resolve();
    await delay(0);
    assert.deepEqual(app.modelConfigStore.connection, newHealth);
    assert.equal(calls, 1);
  } finally { gate.resolve(); await pending; }
});

test('正常 HTTP 两阶段问答不被连接结束误取消，保留完整问答日志', async (t) => {
  let calls = 0;
  const { app, logs } = await fixture(t, async (_url, options) => {
    assert.equal(options.signal.aborted, false);
    calls += 1;
    return response(calls === 1 ? '门票；票价；费用' : answerText);
  });
  app.knowledgeStore.importedChunks = () => largeLibrary;
  await app.listen({ host: '127.0.0.1', port: 0 });
  const result = await fetch(`http://127.0.0.1:${app.server.address().port}/answer`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: '入场要花银子吗？' }),
  });
  const body = await result.json();
  assert.equal(result.status, 200);
  assert.equal(body.answer, answerText);
  assert.equal(calls, 2);
  const entries = await logs();
  assert.ok(!entries.some((entry) => entry.action === 'question.cancelled'));
  assert.ok(entries.some((entry) => entry.action === 'question.answer' && entry.dialogue.answer === answerText));
});

test('收到请求前已经处于主持模式，仍返回自然模式提示而不调用模型', async (t) => {
  const { app, switchMode, logs } = await fixture(t, async () => {
    assert.fail('hosting must not call a model');
  });
  await switchMode('hosting');
  const result = await ask(app);
  assert.equal(result.statusCode, 409);
  assert.equal(result.json().error, 'HOSTING_MODE_ACTIVE');
  assert.notEqual(result.json().answerStatus, 'cancelled');
  assert.ok(result.json().speechText);
  assert.ok(!(await logs()).some((entry) => entry.action === 'question.cancelled'));
});

test('未取消请求的真实模型超时仍归为 MODEL_TIMEOUT 并使用自然兜底', async (t) => {
  const { app } = await fixture(t, async () => { throw new DOMException('timeout', 'TimeoutError'); });
  const result = await ask(app);
  assert.equal(result.statusCode, 504);
  assert.equal(result.json().error, 'MODEL_TIMEOUT');
  assert.equal(result.json().speechText, app.modelConfigStore.config.serviceErrorText);
  assert.equal(app.modelConfigStore.connection.status, 'unavailable');
});

test('双跳原生 HTTP：访客断开会关闭挂起的上游正文、释放监听器，下一轮可恢复', async (t) => {
  const readingBody = deferred();
  const upstreamClosed = deferred();
  const rawResponses = [];
  let calls = 0;
  const upstream = createServer(async (request, reply) => {
    try {
      for await (const _chunk of request) { /* Consume only isolated request bytes. */ }
      calls += 1;
      reply.writeHead(200, { 'content-type': 'application/json' });
      if (calls === 1) {
        reply.once('close', upstreamClosed.resolve);
        reply.write('{"choices":[');
      } else {
        reply.end(JSON.stringify(payload()));
      }
    } catch { reply.destroy(); }
  });
  const controller = new AbortController();
  try {
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const { app, logs } = await fixture(t, async (...args) => {
      // Observe entry into native body parsing without replacing its transport.
      const result = await fetch(...args);
      const readJson = result.json.bind(result);
      result.json = () => { readingBody.resolve(); return readJson(); };
      return result;
    }, (app) => {
      app.addHook('onRequest', async (request, reply) => {
        if (request.url === '/answer') rawResponses.push({
          raw: reply.raw, before: reply.raw.listenerCount('close'),
        });
      });
    });
    app.modelConfigStore.config = prepareModelConfig({ ...app.modelConfigStore.config,
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, timeoutMs: 10_000 });
    const originalHealth = structuredClone(app.modelConfigStore.connection);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const url = `http://127.0.0.1:${app.server.address().port}/answer`;
    const options = { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: '活动门票多少钱？' }) };
    const pending = fetch(url, { ...options, signal: controller.signal }).then(() => null, (error) => error);
    await within(readingBody.promise, 3_000);
    controller.abort();
    assert.equal((await within(pending)).name, 'AbortError');
    await within(upstreamClosed.promise, 3_000);
    const entries = await logs();
    await delay(0);
    assert.equal(calls, 1);
    assert.deepEqual(app.modelConfigStore.connection, originalHealth);
    assert.equal(rawResponses[0].raw.listenerCount('close'), rawResponses[0].before);
    const cancellations = entries.filter((entry) => entry.action === 'question.cancelled');
    assert.equal(cancellations.length, 1);
    assert.equal(cancellations[0].details.cancellationReason, 'CLIENT_DISCONNECTED');
    assert.equal(cancellations[0].details.modelStage, 'answer');
    const next = await within(fetch(url, options));
    assert.equal(next.status, 200);
    assert.equal((await next.json()).answer, answerText);
    assert.equal(calls, 2);
    assert.equal(app.modelConfigStore.connection.status, 'available');
    assert.equal(rawResponses[1].raw.listenerCount('close'), rawResponses[1].before);
  } finally {
    controller.abort();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
