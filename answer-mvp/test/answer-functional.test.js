import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildApp } from '../server.js';

const TEST_CONTENT = [
  {
    id: 'training-location',
    questions: ['培训地点在哪里？'],
    keywords: ['培训', '地点'],
    answer: '培训地点为测试教室。',
  },
];

const TEST_MODEL_CONFIG = {
  provider: 'openai-compatible',
  baseUrl: 'http://model.invalid/v1',
  apiKey: 'functional-test-placeholder-key',
  model: 'functional-test-model',
  answerMode: 'grounded',
  temperature: 0.2,
  maxTokens: 200,
  timeoutMs: 5_000,
  systemPrompt: '你是功能测试数字人。',
};

function registerAppCleanup(t, directory, getApp) {
  t.after(async () => {
    // onResponse/service.stop may still append logs after the HTTP body was
    // received. Stop and drain the application before removing its data root.
    try { await getApp()?.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
}

test('TC-FUNC-001：问题经真实 HTTP 入口和模型上下文后返回可播报答案', async (t) => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'answer-functional-'),
  );
  let app;
  registerAppCleanup(t, temporaryDirectory, () => app);

  const contentPath = path.join(temporaryDirectory, 'content.json');
  const modelConfigPath = path.join(temporaryDirectory, 'model-config.json');
  await Promise.all([
    writeFile(contentPath, JSON.stringify(TEST_CONTENT), 'utf8'),
    writeFile(modelConfigPath, JSON.stringify(TEST_MODEL_CONFIG), 'utf8'),
  ]);

  const modelCalls = [];
  app = await buildApp({
    contentPath,
    modelConfigPath,
    knowledgePath: path.join(temporaryDirectory, 'knowledge.json'),
    knowledgeFilesDirectory: path.join(temporaryDirectory, 'knowledge-files'),
    bundledKnowledgeEnabled: false,
    adminAuthPath: path.join(temporaryDirectory, 'admin-auth.json'),
    adminPassword: 'functional-test-admin-password',
    logger: false,
    pollIntervalMs: 60_000,
    llmFetch: async (url, request) => {
      modelCalls.push({
        url: String(url),
        authorization: new Headers(request.headers).get('authorization'),
        body: JSON.parse(request.body),
      });
      return new Response(
        JSON.stringify({
          model: 'functional-test-model-resolved',
          choices: [
            {
              message: {
                content: JSON.stringify({
                  status: 'answered',
                  answer: '培训地点为测试教室。',
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });
  await app.knowledgeStore.importFiles([{
    filename: '培训资料.txt', buffer: Buffer.from('培训地点为测试教室。'),
  }], 'append');

  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');

  const response = await fetch(`http://127.0.0.1:${address.port}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: '请告诉我培训地点' }),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.answered, true);
  assert.equal(body.answerStatus, 'answered');
  assert.equal(body.answerStatusSource, 'structured');
  assert.equal(body.answer, '培训地点为测试教室。');
  assert.equal(body.speechText, body.answer);
  assert.equal(body.model, 'functional-test-model-resolved');
  assert.equal(body.knowledgeContext.matchedIds.length, 1);
  assert.match(body.knowledgeContext.matchedIds[0], /^doc-.*-chunk-/);
  assert.equal(body.source, undefined);
  assert.equal(body.references, undefined);

  assert.equal(modelCalls.length, 1);
  assert.equal(modelCalls[0].url, 'http://model.invalid/v1/chat/completions');
  assert.equal(
    modelCalls[0].authorization,
    `Bearer ${TEST_MODEL_CONFIG.apiKey}`,
  );
  assert.match(
    modelCalls[0].body.messages[1].content,
    /培训地点为测试教室/,
  );
});

test('功能测试清理顺序：等待服务与日志关闭后再删除目录，避免 ENOTEMPTY 和残留监听', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'answer-cleanup-order-'));
  let release;
  let entered;
  const closing = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const app = await buildApp({
    contentPath: path.join(directory, 'content.json'),
    modelConfigPath: path.join(directory, 'model.json'),
    knowledgePath: path.join(directory, 'knowledge.json'),
    knowledgeFilesDirectory: path.join(directory, 'files'),
    adminAuthPath: path.join(directory, 'admin.json'),
    liveControlPath: path.join(directory, 'live.json'),
    opsLogPath: path.join(directory, 'operations.jsonl'),
    bundledKnowledgeEnabled: false, adminApiKey: '', adminPassword: '', logger: false,
    llmFetch: async () => { assert.fail('cleanup must not call a model'); },
  });
  const append = app.opsLogStore.appendEntry.bind(app.opsLogStore);
  app.opsLogStore.appendEntry = async entry => {
    if (entry.action === 'service.stop') { entered(); await gate; }
    return append(entry);
  };
  const hooks = [];
  registerAppCleanup({ after: hook => hooks.push(hook) }, directory, () => app);
  let cleanup;
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    cleanup = (async () => { for (const hook of hooks) await hook(); })();
    await closing;
    assert.equal((await stat(directory)).isDirectory(), true, 'pending service.stop still owns this directory');
    release();
    await cleanup;
    assert.equal(app.server.listening, false);
    await assert.rejects(stat(directory), { code: 'ENOENT' });
  } finally {
    release();
    await cleanup;
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('功能测试清理顺序：关闭失败时仍清理目录，保留关闭错误', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'answer-cleanup-failure-'));
  const hooks = [];
  registerAppCleanup({ after: hook => hooks.push(hook) }, directory, () => ({
    close: async () => { throw new Error('isolated close failure'); },
  }));
  try {
    await assert.rejects((async () => { for (const hook of hooks) await hook(); })(), /isolated close failure/);
    await assert.rejects(stat(directory), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
