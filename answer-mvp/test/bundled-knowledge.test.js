import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { KnowledgeStore } from '../knowledge-store.js';
import { buildApp, selectKnowledgeContext } from '../server.js';

const bundleDirectory = fileURLToPath(new URL('../bundled-knowledge/future-teacher-2026/', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(bundleDirectory, 'manifest.json'), 'utf8'));
const logger = { info() {}, warn() {} };

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'future-teacher-seed-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function storeAt(directory, bundledKnowledgeDirectory = bundleDirectory) {
  return new KnowledgeStore({
    knowledgePath: path.join(directory, 'knowledge.json'),
    filesDirectory: path.join(directory, 'knowledge-files'),
    bundledKnowledgeDirectory,
    logger,
  });
}

test('空数据目录首次启动自动载入 7 份知识；索引、原文件与导入记录一起持久化', async (t) => {
  const directory = await temporaryDirectory(t);
  const store = storeAt(directory);
  await store.start();
  assert.equal(store.documents.length, 7);
  assert.equal(store.chunkCount(), 14);
  assert.equal(store.appliedBundles.length, 1);
  assert.equal(store.appliedBundles[0].id, manifest.id);
  for (const document of store.documents) {
    const expected = manifest.files.find((file) => file.filename === document.filename);
    assert.equal(document.sha256, expected.sha256);
    assert.deepEqual(await readFile(store.originalPath(document)), await readFile(path.join(bundleDirectory, document.filename)));
  }
  assert.equal((await stat(store.knowledgePath)).mode & 0o777, 0o600);
  const originalIndex = await readFile(store.knowledgePath, 'utf8');
  const reloaded = storeAt(directory);
  await reloaded.start();
  assert.equal(reloaded.documents.length, 7);
  assert.equal(await readFile(store.knowledgePath, 'utf8'), originalIndex, '重启不重新写入或重复导入');
});

test('兼容旧空索引；保留已有资料且对预先导入的相同内容去重', async (t) => {
  const directory = await temporaryDirectory(t);
  await writeFile(path.join(directory, 'knowledge.json'), JSON.stringify({ version: 1, documents: [] }));
  const oldStore = storeAt(directory, null);
  await oldStore.start();
  await oldStore.importFiles([
    { filename: '已有资料.txt', buffer: Buffer.from('已有的学校资料必须保留。') },
    { filename: '已人工导入的项目概况.md', buffer: await readFile(path.join(bundleDirectory, manifest.files[0].filename)) },
  ]);
  const previousIds = oldStore.documents.map((document) => document.id);
  const upgraded = storeAt(directory);
  await upgraded.start();
  assert.equal(upgraded.documents.length, 8);
  assert.ok(previousIds.every((id) => upgraded.findDocument(id)));
  assert.equal(upgraded.appliedBundles.length, 1);
});

test('后台删除、替换和清空知识后，重启不会恢复预置内容', async (t) => {
  const directory = await temporaryDirectory(t);
  let store = storeAt(directory);
  await store.start();
  const deleted = store.documents[0].id;
  await store.deleteDocument(deleted);
  store = storeAt(directory);
  await store.start();
  assert.equal(store.documents.length, 6);
  assert.equal(store.findDocument(deleted), null);
  await store.importFiles([{ filename: '更新后的资料.md', buffer: Buffer.from('管理员重新确认后的资料。') }], 'replace');
  store = storeAt(directory);
  await store.start();
  assert.equal(store.documents.length, 1);
  assert.equal(store.documents[0].filename, '更新后的资料.md');
  await store.deleteDocument(store.documents[0].id);
  store = storeAt(directory);
  await store.start();
  assert.equal(store.documents.length, 0);
  assert.equal(store.appliedBundles.length, 1);
  assert.deepEqual(await readdir(store.filesDirectory), []);
});

test('已有全部 7 份相同资料时只登记关联；之后删除仍然有效', async (t) => {
  const directory = await temporaryDirectory(t);
  const oldStore = storeAt(directory, null);
  await oldStore.start();
  await oldStore.importFiles(await Promise.all(manifest.files.map(async ({ filename }) => ({
    filename, buffer: await readFile(path.join(bundleDirectory, filename)),
  }))));
  const upgraded = storeAt(directory);
  await upgraded.start();
  assert.equal(upgraded.documents.length, 7);
  assert.equal(upgraded.appliedBundles.length, 1);
  await upgraded.deleteDocument(upgraded.documents[0].id);
  const reloaded = storeAt(directory);
  await reloaded.start();
  assert.equal(reloaded.documents.length, 6);
});

test('预置文件损坏会在首次导入前阻止启动，现有知识与导入记录保持不变', async (t) => {
  const directory = await temporaryDirectory(t);
  const brokenBundle = path.join(directory, 'broken-bundle');
  await cp(bundleDirectory, brokenBundle, { recursive: true });
  await writeFile(path.join(brokenBundle, manifest.files[0].filename), '已被意外替换的资料');
  const oldStore = storeAt(directory, null);
  await oldStore.start();
  await oldStore.importFiles([{ filename: '已有资料.md', buffer: Buffer.from('保留原有知识') }]);
  const before = await readFile(oldStore.knowledgePath, 'utf8');
  await assert.rejects(storeAt(directory, brokenBundle).start(), /校验失败/);
  assert.equal(await readFile(oldStore.knowledgePath, 'utf8'), before);
  assert.equal((await readdir(oldStore.filesDirectory)).length, 1);
  await storeAt(directory).start();
  assert.equal(JSON.parse(await readFile(oldStore.knowledgePath)).documents.length, 8);
});

test('7 份资料的 50 道事实题和 8 道边界题均将必要证据送入模型上下文', async (t) => {
  const store = storeAt(await temporaryDirectory(t));
  await store.start();
  const cases = (await readFile(new URL('./fixtures/future-teacher-regression.jsonl', import.meta.url), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(cases.length, 58);
  const normalize = (value) => value.normalize('NFKC').replace(/[\p{P}\p{S}\s]+/gu, '').toLowerCase();
  for (const scenario of cases) {
    const context = selectKnowledgeContext([], scenario.question, { importedChunks: store.importedChunks() });
    assert.equal(context.retrievalMode, 'full', scenario.id);
    assert.ok(context.contextCharacters <= 24_000, scenario.id);
    for (const fact of scenario.expected_facts) {
      assert.ok(normalize(context.text).includes(normalize(fact)), `${scenario.id}: ${fact}`);
    }
  }
});

test('默认应用通过真实 HTTP 使用预置知识生成可播报响应，空挂载无须手工上传', async (t) => {
  const directory = await temporaryDirectory(t);
  const calls = [];
  const options = {
    contentPath: path.join(directory, 'content.json'),
    modelConfigPath: path.join(directory, 'model-config.json'),
    knowledgePath: path.join(directory, 'knowledge.json'),
    knowledgeFilesDirectory: path.join(directory, 'knowledge-files'),
    adminAuthPath: path.join(directory, 'admin-auth.json'),
    liveControlPath: path.join(directory, 'host-scripts.json'),
    opsLogPath: path.join(directory, 'operations.jsonl'),
    logger: false,
    llmFetch: async (_url, request) => {
      const body = JSON.parse(request.body);
      calls.push(body);
      assert.match(body.messages[1].content, /2026年9月13日至15日/);
      assert.match(body.messages[1].content, /南京古南都饭店/);
      assert.match(body.messages[1].content, /南京维景国际酒店/);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        status: 'answered', answer: '局长和校长研修安排在2026年9月13日至15日，地点在南京。',
      }) } }] }), { headers: { 'content-type': 'application/json' } });
    },
  };
  const unconfigured = await buildApp(options);
  try {
    assert.equal(unconfigured.knowledgeStore.documents.length, 7);
    assert.deepEqual(JSON.parse(await readFile(options.contentPath, 'utf8')), []);
    assert.equal((await unconfigured.inject('/health')).json().content.status, 'current');
    assert.equal((await unconfigured.inject('/ready')).statusCode, 503, '知识已就绪不等于模型已配置');
  } finally {
    await unconfigured.close();
  }
  await writeFile(options.modelConfigPath, JSON.stringify({
    baseUrl: 'http://model.invalid/v1', apiKey: 'isolated-test-key', model: 'test-model',
  }));
  const app = await buildApp(options);
  t.after(() => app.close());
  await app.listen({ host: '127.0.0.1', port: 0 });
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/answer`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: '局长和校长的研修什么时候在哪里举行？' }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.answered, true);
  assert.equal(body.speechText, body.answer);
  assert.equal(body.knowledgeContext.retrievalMode, 'full');
  assert.equal(body.knowledgeContext.contextIds.length, 14);
  assert.equal(body.source, undefined);
  assert.equal(calls.length, 1);
});

test('可显式停用预置知识，保持通用部署的空库启动方式', async (t) => {
  const directory = await temporaryDirectory(t);
  const app = await buildApp({
    contentPath: path.join(directory, 'content.json'),
    bundledKnowledgeEnabled: false, logger: false,
  });
  t.after(() => app.close());
  assert.equal(app.knowledgeStore.documents.length, 0);
  assert.equal(app.knowledgeStore.appliedBundles.length, 0);
});
