import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildApp, prepareModelConfig, selectKnowledgeContext } from '../server.js';

const ticket = { id: 'doc-ticket-chunk-1', text: '票价：免费。' };
const noise = Array.from({ length: 40 }, (_, i) => ({
  id: `doc-noise-${i}-chunk-1`, text: '春季活动。'.repeat(160),
}));
const largeLibrary = [...noise, ticket];
const modelResponse = (answer, status = 'answered') => new Response(JSON.stringify({
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ status, answer }) } }],
}), { headers: { 'content-type': 'application/json' } });

async function fixture(t, fetchModel) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'retrieval-control-test-'));
  await writeFile(path.join(directory, 'content.json'), '[]');
  const app = await buildApp({
    contentPath: path.join(directory, 'content.json'),
    modelConfigPath: path.join(directory, 'model-config.json'),
    knowledgePath: path.join(directory, 'knowledge.json'),
    knowledgeFilesDirectory: path.join(directory, 'files'),
    adminAuthPath: path.join(directory, 'admin.json'),
    liveControlPath: path.join(directory, 'host.json'),
    opsLogPath: path.join(directory, 'ops.jsonl'),
    bundledKnowledgeEnabled: false, adminPassword: 'isolated-test-password', adminApiKey: '',
    logger: false, llmFetch: fetchModel ?? (async () => modelResponse('测试回答。')),
  });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  app.modelConfigStore.config = prepareModelConfig({
    baseUrl: 'http://mock.invalid/v1', apiKey: 'isolated-test-key', model: 'mock',
    noAnswerText: '这个问题暂时没有可靠资料，请工作人员帮您确认。',
  });
  const login = await app.inject({ method: 'POST', url: '/api/admin/login',
    payload: { password: 'isolated-test-password' } });
  return { app, directory, cookie: login.headers['set-cookie'].split(';')[0] };
}
const ask = (app, question = '入场要花银子吗？') => app.inject({
  method: 'POST', url: '/answer', payload: { question },
});

test('同义改写只扩展大库召回，不把生成文本当作知识', () => {
  const context = selectKnowledgeContext([], '入场要花银子吗？', {
    importedChunks: largeLibrary,
    searchQueries: ['门票多少钱；票价；收费；虚构金额一千元'],
  });
  assert.ok(context.contextIds.includes(ticket.id));
  assert.match(context.text, /票价：免费/);
  assert.doesNotMatch(context.text, /虚构金额一千元/);
  assert.ok(context.contextIds.length <= 12);
  assert.ok(context.contextCharacters <= 24_000);
});

test('大库自然问法经真实 HTTP 先改写后回答，日志区分检索步骤', async (t) => {
  const calls = [];
  const { app, directory } = await fixture(t, async (_url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    if (calls.length === 1) {
      assert.match(body.messages[0].content, /知识库检索问法改写器/);
      assert.doesNotMatch(body.messages[1].content, /春季活动/);
      assert.equal(body.temperature, 0);
      return modelResponse('门票多少钱；票价；费用；收费');
    }
    assert.match(body.messages[1].content, /票价：免费/);
    assert.match(body.messages[1].content, /用户问题：入场要花银子吗/);
    return modelResponse('不需要买票，入场免费。');
  });
  app.knowledgeStore.importedChunks = () => largeLibrary;
  await app.listen({ host: '127.0.0.1', port: 0 });
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/answer`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: '入场要花银子吗？' }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.speechText, '不需要买票，入场免费。');
  assert.ok(body.knowledgeContext.contextIds.includes(ticket.id));
  assert.equal(calls.length, 2);
  await app.opsLogStore.flush();
  const logs = (await readFile(path.join(directory, 'ops.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const retrieval = logs.find((entry) => entry.action === 'question.retrieval');
  assert.equal(retrieval.details.turnId, body.turnId);
  assert.equal(retrieval.details.status, 'expanded');
  assert.ok(logs.some((entry) => entry.action === 'question.answer' && entry.dialogue.answer === body.answer));
});

test('小库继续单次模型调用；无须改写或新增配置', async (t) => {
  let calls = 0;
  const { app } = await fixture(t, async () => { calls += 1; return modelResponse('免费。'); });
  app.knowledgeStore.importedChunks = () => [ticket];
  const response = await ask(app);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().knowledgeContext.retrievalMode, 'full');
  assert.equal(calls, 1);
});

test('同义改写不会超过管理员配置的输出 Tokens 上限', async (t) => {
  const { app } = await fixture(t, async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.max_tokens, 64);
    return modelResponse('票价；费用');
  });
  app.modelConfigStore.config = prepareModelConfig({ ...app.modelConfigStore.config, maxTokens: 64 });
  app.knowledgeStore.importedChunks = () => noise;
  assert.equal((await ask(app)).json().answered, false);
});

test('大库改写后仍零匹配时不使用前 12 片噪声，不再请求生成答案', async (t) => {
  let calls = 0;
  const { app } = await fixture(t, async () => { calls += 1; return modelResponse('月球基地预约费用'); });
  app.knowledgeStore.importedChunks = () => noise;
  const response = await ask(app, '月球基地怎么订票？');
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().answered, false);
  assert.equal(response.json().answer, app.modelConfigStore.config.noAnswerText);
  assert.deepEqual(response.json().knowledgeContext.contextIds, []);
  assert.equal(response.json().knowledgeContext.retrievalMode, 'no-match');
  assert.equal(calls, 1);
});

test('改写失败使用自然服务兜底，并保留改写阶段和原始错误诊断', async (t) => {
  const { app, directory } = await fixture(t, async () => new Response('rate limit', { status: 429 }));
  app.knowledgeStore.importedChunks = () => largeLibrary;
  const response = await ask(app);
  assert.equal(response.statusCode, 502);
  assert.equal(response.json().speechText, app.modelConfigStore.config.serviceErrorText);
  await app.opsLogStore.flush();
  const logs = (await readFile(path.join(directory, 'ops.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const result = logs.find((entry) => entry.action === 'question.answer');
  assert.equal(result.details.modelStage, 'query-rewrite');
  assert.equal(result.details.upstreamStatus, 429);
  assert.equal(result.details.rewriteStatus, 'failed');
  assert.equal(app.modelConfigStore.connection.status, 'unavailable');
  assert.equal((await app.inject({ url: '/ready' })).statusCode, 503);
});

test('同义改写失败不阻断原问题已命中的答案，并保留降级日志', async (t) => {
  let calls = 0;
  const { app, directory } = await fixture(t, async (_url, options) => {
    calls += 1;
    if (calls === 1) return new Response(JSON.stringify({ choices: [{ message: { content: '{broken' } }] }));
    assert.match(JSON.parse(options.body).messages[1].content, /票价：免费/);
    return modelResponse('门票免费。');
  });
  app.knowledgeStore.importedChunks = () => largeLibrary;
  const response = await ask(app, '门票多少钱？');
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().answer, '门票免费。');
  assert.equal(calls, 2);
  assert.equal(app.modelConfigStore.connection.status, 'available');
  await app.opsLogStore.flush();
  const logs = (await readFile(path.join(directory, 'ops.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const result = logs.find((entry) => entry.action === 'question.retrieval');
  assert.equal(result.outcome, 'failure');
  assert.equal(result.details.originalContextUsed, true);
});

test('模型改写恢复后即使零匹配，健康检查也恢复可用', async (t) => {
  let failed = true;
  const { app } = await fixture(t, async () => failed
    ? new Response('denied', { status: 401 }) : modelResponse('门票；票价'));
  app.knowledgeStore.importedChunks = () => noise;
  assert.equal((await ask(app)).statusCode, 502);
  assert.equal(app.modelConfigStore.connection.status, 'unavailable');
  failed = false;
  assert.equal((await ask(app)).json().answered, false);
  assert.equal(app.modelConfigStore.connection.status, 'available');
  assert.equal((await app.inject({ url: '/ready' })).statusCode, 200);
});

test('改写失败时删空知识库，空 full 不能作为降级证据', async (t) => {
  let calls = 0;
  const { app } = await fixture(t, async () => {
    calls += 1; app.knowledgeStore.importedChunks = () => [];
    return new Response('unavailable', { status: 503 });
  });
  app.knowledgeStore.importedChunks = () => largeLibrary;
  const response = await ask(app, '门票多少钱？');
  assert.equal(response.statusCode, 502);
  assert.equal(calls, 1);
});

test('改写失败同时主持接管仍返回主持状态，不播服务故障兜底', async (t) => {
  const { app } = await fixture(t, async () => {
    app.liveControlStore.switchMode('hosting');
    return new Response('unavailable', { status: 503 });
  });
  app.knowledgeStore.importedChunks = () => largeLibrary;
  const response = await ask(app);
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, 'HOSTING_MODE_ACTIVE');
});

test('改写期间后台删除知识，最终回答不使用已经删除的旧快照', async (t) => {
  let calls = 0;
  const { app } = await fixture(t, async () => {
    calls += 1;
    if (calls === 1) {
      app.knowledgeStore.importedChunks = () => noise;
      return modelResponse('门票；票价；费用');
    }
    throw new Error('不应使用旧资料再次生成回答');
  });
  app.knowledgeStore.importedChunks = () => largeLibrary;
  const response = await ask(app);
  assert.equal(response.json().answered, false);
  assert.equal(calls, 1);
});

test('改写等待期间主持接管，不再开始问答模型调用', async (t) => {
  let calls = 0;
  const { app } = await fixture(t, async () => {
    calls += 1; app.liveControlStore.switchMode('hosting');
    return modelResponse('票价；费用');
  });
  app.knowledgeStore.importedChunks = () => largeLibrary;
  const response = await ask(app);
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, 'HOSTING_MODE_ACTIVE');
  assert.equal(calls, 1);
});

test('停止先到达后拒绝迟到旧播报，兼容旧 API 且接受刷新后的显式播报', async (t) => {
  const { app, cookie } = await fixture(t);
  const store = app.liveControlStore;
  store.switchMode('hosting');
  const payload = { scriptId: store.scripts[0].id,
    expectedInstanceId: store.instanceId, expectedSequence: store.sequence };
  const post = (url, body) => app.inject({ method: 'POST', url, headers: { cookie }, payload: body });
  assert.equal((await post('/api/live-control/stop', {})).statusCode, 200);
  const response = await post('/api/live-control/present', payload);
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, 'LIVE_CONTROL_STALE_COMMAND');
  assert.equal(store.lastCommand, null);
  assert.equal((await post('/api/live-control/present', {
    ...payload, expectedSequence: store.sequence,
  })).statusCode, 200);
  assert.equal((await post('/api/live-control/present', { scriptId: payload.scriptId })).statusCode, 200);
});

test('播报版本要求成对且类型正确，重启前的旧实例不能播报', async (t) => {
  const { app, cookie } = await fixture(t);
  const store = app.liveControlStore;
  for (const fields of [{ expectedSequence: 0 }, { expectedInstanceId: store.instanceId },
    { expectedInstanceId: store.instanceId, expectedSequence: '0' }]) {
    const response = await app.inject({ method: 'POST', url: '/api/live-control/present',
      headers: { cookie }, payload: { scriptId: store.scripts[0].id, ...fields } });
    assert.equal(response.statusCode, 400);
  }
  const response = await app.inject({ method: 'POST', url: '/api/live-control/present',
    headers: { cookie }, payload: { scriptId: store.scripts[0].id,
      expectedInstanceId: 'retired-instance', expectedSequence: store.sequence } });
  assert.equal(response.statusCode, 409);
  assert.equal(store.lastCommand, null);
});

test('停止之后迟到的旧模式请求被拒绝，不重新切换现场模式', async (t) => {
  const { app, cookie } = await fixture(t);
  const store = app.liveControlStore;
  const payload = { mode: 'hosting', expectedInstanceId: store.instanceId, expectedSequence: store.sequence };
  store.stop();
  const response = await app.inject({ method: 'POST', url: '/api/live-control/mode', headers: { cookie }, payload });
  assert.equal(response.statusCode, 409);
  assert.equal(store.mode, 'dialogue');
  const updated = await app.inject({ method: 'POST', url: '/api/live-control/mode', headers: { cookie },
    payload: { ...payload, expectedSequence: store.sequence } });
  assert.equal(updated.statusCode, 200);
  assert.equal(store.mode, 'hosting');
});

test('多管理页同版本保存主持词，只有一次成功，失败队列不影响后续保存', async (t) => {
  const { app } = await fixture(t);
  const store = app.liveControlStore;
  const revision = store.revision;
  const results = await Promise.allSettled(['甲', '乙', '丙'].map((text) =>
    store.saveScripts([{ ...store.scripts[0], text }], revision)));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  for (const result of results.filter((entry) => entry.status === 'rejected')) {
    assert.equal(result.reason.code, 'LIVE_CONTROL_VERSION_CONFLICT');
  }
  await store.saveScripts([{ ...store.scripts[0], text: '后续稿件' }], store.revision);
  assert.equal(store.scripts[0].text, '后续稿件');
  const saved = JSON.parse(await readFile(store.configPath, 'utf8'));
  assert.equal(saved.scripts[0].text, '后续稿件');
});
