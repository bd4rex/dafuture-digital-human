import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildApp, prepareModelConfig } from '../server.js';

function modelResponse(answer, status = 'answered') {
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop',
    message: { content: JSON.stringify({ status, answer }) } }] }),
  { headers: { 'content-type': 'application/json' } });
}

// Keep the real HTTP upload/parser/store pipeline; mock only the paid provider.
async function fixture(t, fetchModel = async () => modelResponse('测试回答。')) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'knowledge-lifecycle-'));
  const options = {
    contentPath: path.join(directory, 'content.json'),
    modelConfigPath: path.join(directory, 'model.json'),
    knowledgePath: path.join(directory, 'knowledge.json'),
    knowledgeFilesDirectory: path.join(directory, 'files'),
    adminAuthPath: path.join(directory, 'admin.json'),
    liveControlPath: path.join(directory, 'host.json'),
    opsLogPath: path.join(directory, 'ops.jsonl'),
    bundledKnowledgeEnabled: false, adminPassword: 'isolated-test-password',
    adminApiKey: '', logger: false, llmFetch: fetchModel,
  };
  let app;
  let origin;
  let cookie;
  const start = async () => {
    app = await buildApp(options);
    app.modelConfigStore.config = prepareModelConfig({
      baseUrl: 'http://mock.invalid/v1', apiKey: 'isolated-mock-key', model: 'mock',
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    origin = `http://127.0.0.1:${app.server.address().port}`;
    const login = await fetch(`${origin}/api/admin/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: options.adminPassword }),
    });
    assert.equal(login.status, 200);
    await login.arrayBuffer();
    cookie = login.headers.get('set-cookie').split(';')[0];
  };
  t.after(async () => {
    if (app) await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  await start();
  const request = (route, { json, authenticated = true, ...init } = {}) => fetch(`${origin}${route}`, {
    signal: AbortSignal.timeout(10_000),
    ...init,
    headers: { ...(authenticated ? { cookie } : {}),
      ...(json === undefined ? {} : { 'content-type': 'application/json' }), ...init.headers },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
  });
  return {
    directory, options, request,
    get app() { return app; },
    async restart() { await app.close(); app = null; await start(); },
    async upload(files, mode = 'append') {
      const form = new FormData();
      form.append('mode', mode);
      for (const { filename, content } of files) {
        form.append('files', new Blob([content]), filename);
      }
      const response = await request('/api/knowledge/import', { method: 'POST', body: form });
      return { status: response.status, body: await response.json() };
    },
    async ask(question) {
      const response = await request('/answer', { method: 'POST', json: { question }, authenticated: false });
      return { status: response.status, body: await response.json() };
    },
  };
}

test('真实 multipart 导入保留中文原文件，摘要、模型证据和重启索引一致且仅后台可下载', async (t) => {
  const calls = [];
  const f = await fixture(t, async (_url, options) => {
    calls.push(JSON.parse(options.body)); return modelResponse('培训在一号报告厅。');
  });
  const original = Buffer.from('\uFEFF## 培训安排\r\n\r\n培训地点：一号报告厅。\r\n');
  const uploaded = await f.upload([{ filename: '九月 研修资料.md', content: original }]);
  assert.equal(uploaded.status, 200);
  const document = uploaded.body.documents[0];
  assert.equal(document.filename, '九月 研修资料.md');
  assert.equal(document.preview, '## 培训安排\n\n培训地点：一号报告厅。');
  for (const route of ['/api/knowledge', `/api/knowledge/${document.id}/download`]) {
    const rejected = await f.request(route, { authenticated: false });
    assert.equal(rejected.status, 401); await rejected.arrayBuffer();
  }
  const download = await f.request(`/api/knowledge/${document.id}/download`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /filename\*=UTF-8''/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), original);
  const indexBytes = await readFile(f.options.knowledgePath);
  const index = JSON.parse(indexBytes);
  const expectedIds = index.documents.flatMap((entry) => entry.chunks.map((chunk) => chunk.id));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt) await f.restart();
    const snapshot = await (await f.request('/api/knowledge')).json();
    assert.equal(snapshot.legacyActive, false);
    assert.equal(snapshot.documentCount, 1);
    assert.equal(snapshot.revision, uploaded.body.revision);
    const answer = await f.ask('培训在哪里？');
    assert.equal(answer.status, 200);
    assert.equal(answer.body.knowledgeContext.retrievalMode, 'full');
    assert.deepEqual(answer.body.knowledgeContext.contextIds, expectedIds);
    assert.match(calls.at(-1).messages[1].content, /培训地点：一号报告厅/);
  }
  assert.equal(calls.length, 2, '小库每轮仍只调用一次模型');
  assert.deepEqual(await readFile(f.options.knowledgePath), indexBytes, '重启不会重写索引');
});

test('真实上传去重不改变版本；失败替换不部分落盘；成功替换和重启均淘汰旧证据', async (t) => {
  const calls = [];
  const f = await fixture(t, async (_url, options) => {
    calls.push(JSON.parse(options.body)); return modelResponse('请到更新后的乙会场。');
  });
  const initial = await f.upload([
    { filename: '会场.txt', content: '旧会场是甲会场。' },
    { filename: '时间.txt', content: '旧时间是上午九点。' },
  ]);
  assert.equal(initial.status, 200);
  const before = await readFile(f.options.knowledgePath);
  const storedFiles = await readdir(f.options.knowledgeFilesDirectory);
  const duplicate = await f.upload([{ filename: '改了名字.txt', content: '旧会场是甲会场。' }]);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.imported.length, 0);
  assert.equal(duplicate.body.skipped.length, 1);
  assert.equal(duplicate.body.revision, initial.body.revision);
  const failed = await f.upload([
    { filename: '本不应新增.txt', content: '不能部分生效。' },
    { filename: '损坏.json', content: '{broken' },
  ], 'replace');
  assert.equal(failed.status, 400);
  assert.equal(failed.body.error, 'KNOWLEDGE_INVALID_JSON');
  assert.deepEqual(await readFile(f.options.knowledgePath), before);
  assert.deepEqual(await readdir(f.options.knowledgeFilesDirectory), storedFiles);
  const replaced = await f.upload([{ filename: '更新资料.txt', content: '更新后的会场是乙会场。' }], 'replace');
  assert.equal(replaced.status, 200);
  assert.equal(replaced.body.documentCount, 1);
  assert.notEqual(replaced.body.revision, initial.body.revision);
  for (const old of initial.body.documents) {
    const response = await f.request(`/api/knowledge/${old.id}/download`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, 'KNOWLEDGE_NOT_FOUND');
  }
  assert.equal((await readdir(f.options.knowledgeFilesDirectory)).length, 1);
  await f.restart();
  const answer = await f.ask('会场在哪里？');
  assert.equal(answer.status, 200);
  assert.match(calls.at(-1).messages[1].content, /更新后的会场是乙会场/);
  assert.doesNotMatch(calls.at(-1).messages[1].content, /甲会场|上午九点|不能部分生效/);
  assert.equal(answer.body.knowledgeContext.contextIds.length, 1);
});

test('真实大库上传触发同义改写；等待期间通过删除接口移除的知识不会再进入答案', { timeout: 10_000 }, async (t) => {
  const calls = [];
  let pauseRewrite = false;
  let notifyRewrite;
  let releaseRewrite;
  const started = new Promise((resolve) => { notifyRewrite = resolve; });
  const gate = new Promise((resolve) => { releaseRewrite = resolve; });
  const f = await fixture(t, async (_url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    if (body.messages[0].content.includes('知识库检索问法改写器')) {
      if (pauseRewrite) { notifyRewrite(); await gate; }
      return modelResponse('门票多少钱；票价；收费');
    }
    assert.match(body.messages[1].content, /票价：免费/);
    return modelResponse('不用买票，入场免费。');
  });
  const imported = await f.upload([
    { filename: '活动记录.md', content: '春季活动。'.repeat(7_000) },
    { filename: '入场说明.md', content: '票价：免费。' },
  ]);
  assert.equal(imported.status, 200);
  assert.ok(imported.body.chunkCount > 12);
  const ticket = imported.body.documents.find((entry) => entry.filename === '入场说明.md');
  const answer = await f.ask('入场要花银子吗？');
  assert.equal(answer.status, 200);
  assert.equal(answer.body.knowledgeContext.retrievalMode, 'ranked');
  assert.ok(answer.body.knowledgeContext.contextIds.some((id) => id.startsWith(`${ticket.id}-chunk-`)));
  assert.equal(calls.length, 2);
  pauseRewrite = true;
  const pendingAnswer = f.ask('入场要花银子吗？');
  let gateTimeout;
  try {
    await Promise.race([started, new Promise((_, reject) => {
      gateTimeout = setTimeout(() => reject(new Error('未在 3 秒内进入改写步骤')), 3_000);
    })]);
    const deleted = await f.request(`/api/knowledge/${ticket.id}`, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    assert.equal((await deleted.json()).documentCount, 1);
  } finally { clearTimeout(gateTimeout); pauseRewrite = false; releaseRewrite(); }
  const afterDelete = await pendingAnswer;
  assert.equal(afterDelete.status, 200);
  assert.equal(afterDelete.body.answerStatus, 'no_answer');
  assert.deepEqual(afterDelete.body.knowledgeContext.contextIds, []);
  assert.equal(calls.length, 3, '删除后不再发起答案生成调用');
  await f.restart();
  const afterRestart = await f.ask('入场要花银子吗？');
  assert.equal(afterRestart.body.answerStatus, 'no_answer');
  assert.deepEqual(afterRestart.body.knowledgeContext.contextIds, []);
  assert.equal(calls.length, 4);
});

test('原文件意外缺失时下载明确报错，已持久化的提取知识仍可回答并可删除', async (t) => {
  const calls = [];
  const f = await fixture(t, async (_url, options) => {
    calls.push(JSON.parse(options.body)); return modelResponse('入口在东门。');
  });
  const imported = await f.upload([{ filename: '入口.md', content: '访客入口在东门。' }]);
  assert.equal(imported.status, 200);
  const document = f.app.knowledgeStore.findDocument(imported.body.documents[0].id);
  await rm(f.app.knowledgeStore.originalPath(document));
  await f.restart();
  const download = await f.request(`/api/knowledge/${document.id}/download`);
  assert.equal(download.status, 404);
  assert.equal((await download.json()).error, 'KNOWLEDGE_ORIGINAL_MISSING');
  assert.equal((await f.ask('从哪进？')).status, 200);
  assert.match(calls[0].messages[1].content, /访客入口在东门/);
  const deleted = await f.request(`/api/knowledge/${document.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.equal((await deleted.json()).documentCount, 0);
  await f.restart();
  const snapshot = await (await f.request('/api/knowledge')).json();
  assert.equal(snapshot.documentCount, 0);
  assert.deepEqual(await readdir(f.options.knowledgeFilesDirectory), []);
});
