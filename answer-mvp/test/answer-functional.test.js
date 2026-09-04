import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

test('TC-FUNC-001：问题经真实 HTTP 入口和模型上下文后返回可播报答案', async (t) => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'answer-functional-'),
  );
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));

  const contentPath = path.join(temporaryDirectory, 'content.json');
  const modelConfigPath = path.join(temporaryDirectory, 'model-config.json');
  await Promise.all([
    writeFile(contentPath, JSON.stringify(TEST_CONTENT), 'utf8'),
    writeFile(modelConfigPath, JSON.stringify(TEST_MODEL_CONFIG), 'utf8'),
  ]);

  const modelCalls = [];
  const app = await buildApp({
    contentPath,
    modelConfigPath,
    knowledgePath: path.join(temporaryDirectory, 'knowledge.json'),
    knowledgeFilesDirectory: path.join(temporaryDirectory, 'knowledge-files'),
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
  t.after(() => app.close());

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
  assert.deepEqual(body.knowledgeContext.matchedIds, ['training-location']);
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
