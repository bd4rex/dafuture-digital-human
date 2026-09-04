import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildApp,
  MODEL_NOT_CONFIGURED_TEXT,
  NO_ANSWER_TEXT,
} from '../server.js';
import { KnowledgeStore, parseKnowledgeFile } from '../knowledge-store.js';

const ORIGINAL_CONTENT = [
  {
    id: 'training-location',
    questions: ['培训地点在哪里？', '去哪里参加培训？'],
    keywords: ['培训', '地点', '哪里'],
    answer: '培训地点为测试教室。',
  },
  {
    id: 'project-introduction',
    questions: ['什么是大未来项目？'],
    keywords: ['大未来', '项目', '介绍'],
    answer: '这是用于自动化测试的项目说明。',
  },
];

const MODEL_REQUEST = {
  provider: 'openai-compatible',
  baseUrl: 'https://model.example/v1',
  apiKey: 'test-provider-secret',
  model: 'test-chat-model',
  answerMode: 'grounded',
  temperature: 0.2,
  maxTokens: 800,
  timeoutMs: 30_000,
  systemPrompt: '你是测试数字人，请准确回答。',
};

function createMockLlm({
  answer = '这是模型生成的测试回答。',
  status = 200,
  responses = null,
} = {}) {
  const calls = [];
  const fetch = async (url, request) => {
    const responseConfig = {
      answer,
      status,
      ...(responses?.[calls.length] ?? {}),
    };
    calls.push({
      url: String(url),
      headers: new Headers(request.headers),
      body: JSON.parse(request.body),
    });
    return new Response(
      JSON.stringify(
        responseConfig.status >= 400
          ? { error: { message: '上游内部详情不应返回给前台' } }
          : {
              model: responseConfig.model ?? 'mock-model-resolved',
              choices: [{ message: { content: responseConfig.answer ?? answer } }],
            },
      ),
      {
        status: responseConfig.status,
        headers: { 'content-type': 'application/json' },
      },
    );
  };
  return { fetch, calls };
}

async function createTestApp(t, content = ORIGINAL_CONTENT, options = {}) {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'answer-mvp-test-'),
  );
  const contentPath = path.join(temporaryDirectory, 'content.json');
  const modelConfigPath = path.join(temporaryDirectory, 'model-config.json');
  await writeFile(contentPath, JSON.stringify(content), 'utf8');
  const defaultMock = createMockLlm();

  const adminPassword = Object.hasOwn(options, 'adminPassword')
    ? options.adminPassword
    : 'test-admin-password';
  const app = await buildApp({
    contentPath,
    modelConfigPath,
    adminAuthPath: path.join(temporaryDirectory, 'admin-auth.json'),
    knowledgePath: path.join(temporaryDirectory, 'knowledge.json'),
    knowledgeFilesDirectory: path.join(temporaryDirectory, 'knowledge-files'),
    adminPassword,
    pollIntervalMs: 25,
    logger: false,
    llmFetch: defaultMock.fetch,
    ...options,
  });

  let adminCookie = '';
  if (adminPassword) {
    const login = await app.inject({
      method: 'POST',
      url: '/api/admin/login',
      payload: { password: adminPassword },
    });
    if (login.statusCode !== 200) {
      throw new Error(`测试管理员登录失败：${login.body}`);
    }
    adminCookie = login.headers['set-cookie'].split(';', 1)[0];
  }
  app.testAdminCookie = adminCookie;

  t.after(async () => {
    await app.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  return {
    app,
    contentPath,
    modelConfigPath,
    knowledgePath: path.join(temporaryDirectory, 'knowledge.json'),
    knowledgeFilesDirectory: path.join(temporaryDirectory, 'knowledge-files'),
    adminAuthPath: path.join(temporaryDirectory, 'admin-auth.json'),
    adminCookie,
  };
}

function adminInject(app, options) {
  return app.inject({
    ...options,
    headers: {
      ...(options.headers ?? {}),
      ...(app.testAdminCookie && !options.headers?.cookie
        ? { cookie: app.testAdminCookie }
        : {}),
    },
  });
}

function multipartRequest({ fields = {}, files = [] } = {}) {
  const boundary = `----answer-mvp-${Date.now().toString(36)}-${Math.random()
    .toString(16)
    .slice(2)}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  for (const file of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${file.filename}"\r\nContent-Type: ${file.mimetype ?? 'application/octet-stream'}\r\n\r\n`,
      ),
      Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content),
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

function minimalPdf(content) {
  const stream = `BT\n/F1 12 Tf\n72 720 Td\n(${content.replace(/[()\\]/g, '\\$&')}) Tj\nET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let source = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(source));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n`;
  source += '0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) {
    source += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(source);
}

async function configureModel(app, overrides = {}) {
  return adminInject(app, {
    method: 'PUT',
    url: '/api/model-config',
    payload: { ...MODEL_REQUEST, ...overrides },
  });
}

async function waitUntil(assertion, timeoutMs = 1_500) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await assertion();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError ?? new Error('等待条件超时');
}

test('管理页面需登录，登录后提供内容、知识库与模型设置', async (t) => {
  const { app } = await createTestApp(t);
  const loginPage = await app.inject({ method: 'GET', url: '/' });

  assert.equal(loginPage.statusCode, 200);
  assert.match(loginPage.body, /进入管理后台/);
  assert.doesNotMatch(loginPage.body, /保存全部更改/);

  const response = await adminInject(app, { method: 'GET', url: '/' });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /text\/html/);
  assert.match(response.body, /数字人内容工作台/);
  assert.match(response.body, /模型设置/);
  assert.match(response.body, /知识库/);
  assert.match(response.body, /API Key/);
  assert.match(response.body, /保存全部更改/);
  assert.doesNotMatch(response.body, /资料来源/);
});

test('数字人前台和四态配置可直接访问', async (t) => {
  const { app } = await createTestApp(t);
  const pageResponse = await app.inject({ method: 'GET', url: '/avatar' });

  assert.equal(pageResponse.statusCode, 200);
  assert.match(pageResponse.headers['content-type'], /text\/html/);
  assert.match(pageResponse.headers['content-security-policy'], /media-src 'self'/);
  assert.match(pageResponse.body, /主持开场/);
  assert.equal((pageResponse.body.match(/data-avatar-video=/g) ?? []).length, 4);
  assert.doesNotMatch(pageResponse.body, /资料来源/);

  const configResponse = await app.inject({
    method: 'GET',
    url: '/avatar-config.json',
  });
  assert.equal(configResponse.statusCode, 200);
  const avatarConfig = configResponse.json();
  assert.equal(avatarConfig.mediaMode, 'production');
  assert.equal(avatarConfig.speech.provider, 'browser');
  assert.equal(avatarConfig.speech.gender, 'male');
  assert.equal(avatarConfig.speech.preferredVoiceNames[0], 'Reed');
  assert.equal(avatarConfig.speech.rate, 0.98);
  assert.equal(avatarConfig.speech.pitch, 0.98);
  assert.deepEqual(avatarConfig.speechInput, {
    provider: 'browser',
    language: 'zh-CN',
    interimResults: true,
    autoSubmit: true,
  });
  assert.match(pageResponse.body, /id="voice-input-button"/);
  assert.deepEqual(Object.keys(avatarConfig.states), [
    'idle',
    'thinking',
    'speaking',
    'presenting',
  ]);
  for (const [state, stateConfig] of Object.entries(avatarConfig.states)) {
    assert.equal(stateConfig.sources.length, 2);
    assert.match(stateConfig.sources[0].src, new RegExp(`${state}\\.mov\\?v=`));
    assert.match(stateConfig.sources[1].src, new RegExp(`${state}\\.webm\\?v=`));
  }
  assert.deepEqual(avatarConfig.quickQuestions, [
    '培训地点在哪里？',
    '什么是大未来项目？',
  ]);
  assert.match(avatarConfig.contentRevision, /^[a-f0-9]{64}$/);
});

test('访客快捷问题随内容工作台保存结果和版本号更新', async (t) => {
  const { app } = await createTestApp(t);
  const loaded = (
    await adminInject(app, { method: 'GET', url: '/api/content' })
  ).json();
  loaded.items[0].questions[0] = '更新后的培训地点问题？';

  const saved = await adminInject(app, {
    method: 'PUT',
    url: '/api/content',
    payload: { revision: loaded.revision, items: loaded.items },
  });
  assert.equal(saved.statusCode, 200);

  const config = (
    await app.inject({ method: 'GET', url: '/avatar-config.json' })
  ).json();
  assert.deepEqual(config.quickQuestions, [
    '更新后的培训地点问题？',
    '什么是大未来项目？',
  ]);
  assert.equal(config.contentRevision, saved.json().revision);
  assert.notEqual(config.contentRevision, loaded.revision);
});

test('透明视频支持 Range 请求并拒绝非白名单文件', async (t) => {
  const { app } = await createTestApp(t);
  const partial = await app.inject({
    method: 'GET',
    url: '/avatar-media/idle.webm',
    headers: { range: 'bytes=0-99' },
  });

  assert.equal(partial.statusCode, 206);
  assert.match(partial.headers['content-type'], /video\/webm/);
  assert.equal(partial.headers['accept-ranges'], 'bytes');
  assert.match(partial.headers['content-range'], /^bytes 0-99\/\d+$/);
  assert.equal(partial.rawPayload.length, 100);

  const disallowed = await app.inject({
    method: 'GET',
    url: '/avatar-media/config.json',
  });
  assert.equal(disallowed.statusCode, 404);
});

test('已登录内容接口返回可编辑内容和版本号', async (t) => {
  const { app } = await createTestApp(t);
  const response = await adminInject(app, { method: 'GET', url: '/api/content' });
  const body = response.json();

  assert.equal(response.statusCode, 200);
  assert.equal(body.accessMode, 'session');
  assert.equal(body.items.length, 2);
  assert.match(body.revision, /^[a-f0-9]{64}$/);
  assert.equal(body.items[0].normalizedQuestions, undefined);
  assert.equal(body.items[0].source, undefined);
});

test('Web 保存的新内容会进入模型上下文，不再被直接作为答案返回', async (t) => {
  const mock = createMockLlm({ answer: '模型重新组织后的地点说明。' });
  const { app, contentPath } = await createTestApp(t, ORIGINAL_CONTENT, {
    llmFetch: mock.fetch,
  });
  assert.equal((await configureModel(app)).statusCode, 200);

  const loaded = (
    await adminInject(app, { method: 'GET', url: '/api/content' })
  ).json();
  loaded.items[0].answer = '通过 Web 页面更新后的测试地点。';
  const savedResponse = await adminInject(app, {
    method: 'PUT',
    url: '/api/content',
    payload: { revision: loaded.revision, items: loaded.items },
  });
  assert.equal(savedResponse.statusCode, 200);
  assert.equal(
    JSON.parse(await readFile(contentPath, 'utf8'))[0].answer,
    '通过 Web 页面更新后的测试地点。',
  );

  const answerResponse = await app.inject({
    method: 'POST',
    url: '/answer',
    payload: { question: '培训地点在哪里？' },
  });
  assert.equal(answerResponse.statusCode, 200);
  assert.equal(answerResponse.json().answer, '模型重新组织后的地点说明。');
  assert.match(
    mock.calls.at(-1).body.messages[1].content,
    /通过 Web 页面更新后的测试地点/,
  );
});

test('外部文件修改不会被 Web 保存静默覆盖', async (t) => {
  const { app, contentPath } = await createTestApp(t, ORIGINAL_CONTENT, {
    pollIntervalMs: 60_000,
  });
  const loaded = (
    await adminInject(app, { method: 'GET', url: '/api/content' })
  ).json();
  const externalContent = structuredClone(ORIGINAL_CONTENT);
  externalContent[0].answer = '页面外刚刚更新的内容。';
  await writeFile(contentPath, JSON.stringify(externalContent), 'utf8');

  const conflictingSave = await adminInject(app, {
    method: 'PUT',
    url: '/api/content',
    payload: { revision: loaded.revision, items: loaded.items },
  });
  assert.equal(conflictingSave.statusCode, 409);
  assert.equal(conflictingSave.json().error, 'CONTENT_VERSION_CONFLICT');
  assert.equal(
    JSON.parse(await readFile(contentPath, 'utf8'))[0].answer,
    '页面外刚刚更新的内容。',
  );
});

test('内容和模型配置接口均要求登录且拒绝跨源会话', async (t) => {
  const { app } = await createTestApp(t);
  for (const url of ['/api/content', '/api/knowledge', '/api/model-config']) {
    const unauthenticated = await app.inject({ method: 'GET', url });
    assert.equal(unauthenticated.statusCode, 401);
    assert.equal(unauthenticated.json().error, 'ADMIN_AUTH_REQUIRED');

    const response = await adminInject(app, {
      method: 'GET',
      url,
      headers: {
        host: '127.0.0.1',
        origin: 'https://untrusted.example',
      },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error, 'ADMIN_ORIGIN_REJECTED');
  }
});

test('设置管理密钥后后台接口仍支持 Bearer 认证', async (t) => {
  const { app } = await createTestApp(t, ORIGINAL_CONTENT, {
    adminApiKey: 'test-admin-key',
  });

  for (const url of ['/api/content', '/api/knowledge', '/api/model-config']) {
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401);
    const authorized = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: 'Bearer test-admin-key' },
    });
    assert.equal(authorized.statusCode, 200);
    assert.equal(authorized.json().accessMode, 'api-key');
  }
});

test('首次管理密码可从远程管理页设置，落盘仅保存加盐哈希', async (t) => {
  const { app, adminAuthPath } = await createTestApp(t, ORIGINAL_CONTENT, {
    adminPassword: '',
  });
  const status = (
    await app.inject({ method: 'GET', url: '/api/admin/status' })
  ).json();
  assert.equal(status.setupRequired, true);
  assert.equal(status.setupAllowed, undefined);
  assert.equal(status.authenticated, false);

  const protectedResponse = await app.inject({
    method: 'GET',
    url: '/api/content',
  });
  assert.equal(protectedResponse.statusCode, 401);
  assert.equal(protectedResponse.json().error, 'ADMIN_SETUP_REQUIRED');

  const crossOriginSetup = await app.inject({
    method: 'POST',
    url: '/api/admin/setup',
    remoteAddress: '192.0.2.10',
    headers: {
      host: 'demo.example.test',
      origin: 'https://other.example.test',
    },
    payload: { password: 'safe-admin-password' },
  });
  assert.equal(crossOriginSetup.statusCode, 403);
  assert.equal(crossOriginSetup.json().error, 'ADMIN_ORIGIN_REJECTED');

  const shortPassword = await app.inject({
    method: 'POST',
    url: '/api/admin/setup',
    remoteAddress: '192.0.2.10',
    payload: { password: 'short' },
  });
  assert.equal(shortPassword.statusCode, 400);
  assert.equal(shortPassword.json().error, 'ADMIN_PASSWORD_INVALID');

  const setup = await app.inject({
    method: 'POST',
    url: '/api/admin/setup',
    remoteAddress: '192.0.2.10',
    payload: { password: 'safe-admin-password' },
  });
  assert.equal(setup.statusCode, 200);
  const cookie = setup.headers['set-cookie'].split(';', 1)[0];
  const diskAuth = JSON.parse(await readFile(adminAuthPath, 'utf8'));
  assert.equal(diskAuth.algorithm, 'scrypt');
  assert.equal(diskAuth.password, undefined);
  assert.doesNotMatch(JSON.stringify(diskAuth), /safe-admin-password/);
  assert.equal((await stat(adminAuthPath)).mode & 0o777, 0o600);

  const authenticated = await app.inject({
    method: 'GET',
    url: '/api/content',
    headers: { cookie },
  });
  assert.equal(authenticated.statusCode, 200);
  assert.equal(authenticated.json().accessMode, 'session');

  const logout = await app.inject({
    method: 'POST',
    url: '/api/admin/logout',
    headers: { cookie },
  });
  assert.equal(logout.statusCode, 200);
  assert.match(logout.headers['set-cookie'], /Max-Age=0/);
  assert.equal(
    (
      await app.inject({
        method: 'GET',
        url: '/api/content',
        headers: { cookie },
      })
    ).statusCode,
    401,
  );

  const wrongLogin = await app.inject({
    method: 'POST',
    url: '/api/admin/login',
    payload: { password: 'wrong-password' },
  });
  assert.equal(wrongLogin.statusCode, 401);
  assert.equal(wrongLogin.json().error, 'ADMIN_LOGIN_FAILED');
  const correctLogin = await app.inject({
    method: 'POST',
    url: '/api/admin/login',
    payload: { password: 'safe-admin-password' },
  });
  assert.equal(correctLogin.statusCode, 200);
  assert.match(correctLogin.headers['set-cookie'], /HttpOnly/);
  assert.match(correctLogin.headers['set-cookie'], /SameSite=Strict/);
});

test('外部文本导入后持久化，并进入大模型知识上下文', async (t) => {
  const mock = createMockLlm({ answer: '模型根据导入文件生成的回答。' });
  const {
    app,
    knowledgePath,
    knowledgeFilesDirectory,
  } = await createTestApp(t, ORIGINAL_CONTENT, { llmFetch: mock.fetch });
  await configureModel(app);

  const upload = multipartRequest({
    fields: { mode: 'append' },
    files: [
      {
        filename: 'open-day.md',
        mimetype: 'text/markdown',
        content:
          '# 秋季开放日\n\n秋季开放日定于 9 月 18 日上午 9 点开始，地点为学校报告厅。',
      },
      {
        filename: 'contact.json',
        mimetype: 'application/json',
        content: JSON.stringify({ 咨询电话: '025-00000000' }),
      },
    ],
  });
  const imported = await adminInject(app, {
    method: 'POST',
    url: '/api/knowledge/import',
    ...upload,
  });
  assert.equal(imported.statusCode, 200, imported.body);
  const result = imported.json();
  assert.equal(result.documentCount, 2);
  assert.equal(result.imported.length, 2);
  assert.equal(result.skipped.length, 0);
  assert.ok(result.chunkCount >= 2);
  assert.match(result.revision, /^[a-f0-9]{64}$/);

  const diskIndex = JSON.parse(await readFile(knowledgePath, 'utf8'));
  assert.equal(diskIndex.version, 1);
  assert.equal(diskIndex.documents.length, 2);
  assert.equal((await stat(knowledgePath)).mode & 0o777, 0o600);
  const storedFiles = await readdir(knowledgeFilesDirectory);
  assert.equal(storedFiles.length, 2);
  for (const storedFile of storedFiles) {
    assert.equal(
      (await stat(path.join(knowledgeFilesDirectory, storedFile))).mode & 0o777,
      0o600,
    );
  }

  const answer = await app.inject({
    method: 'POST',
    url: '/answer',
    payload: { question: '秋季开放日几点开始？' },
  });
  assert.equal(answer.statusCode, 200);
  assert.equal(answer.json().answer, '模型根据导入文件生成的回答。');
  assert.ok(
    answer.json().knowledgeContext.matchedIds.some((id) =>
      /^doc-.*-chunk-\d+$/.test(id),
    ),
  );
  assert.match(mock.calls.at(-1).body.messages[1].content, /9 月 18 日上午 9 点/);
  assert.doesNotMatch(mock.calls.at(-1).body.messages[1].content, /open-day\.md/);

  const download = await adminInject(app, {
    method: 'GET',
    url: `/api/knowledge/${result.documents[0].id}/download`,
  });
  assert.equal(download.statusCode, 200);
  assert.match(download.body, /秋季开放日/);
});

test('知识库追加去重、替换和删除都会同步原文件', async (t) => {
  const { app, knowledgeFilesDirectory } = await createTestApp(t);
  const firstUpload = multipartRequest({
    fields: { mode: 'append' },
    files: [{ filename: 'first.txt', content: '第一份知识内容。' }],
  });
  const first = await adminInject(app, {
    method: 'POST',
    url: '/api/knowledge/import',
    ...firstUpload,
  });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().documentCount, 1);

  const duplicate = await adminInject(app, {
    method: 'POST',
    url: '/api/knowledge/import',
    ...firstUpload,
  });
  assert.equal(duplicate.statusCode, 200, duplicate.body);
  assert.equal(duplicate.json().imported.length, 0);
  assert.equal(duplicate.json().skipped.length, 1);
  assert.equal((await readdir(knowledgeFilesDirectory)).length, 1);

  const replacementUpload = multipartRequest({
    fields: { mode: 'replace' },
    files: [{ filename: 'replacement.txt', content: '替换后的新知识。' }],
  });
  const replaced = await adminInject(app, {
    method: 'POST',
    url: '/api/knowledge/import',
    ...replacementUpload,
  });
  assert.equal(replaced.statusCode, 200, replaced.body);
  assert.equal(replaced.json().documentCount, 1);
  assert.equal(replaced.json().documents[0].filename, 'replacement.txt');
  assert.equal((await readdir(knowledgeFilesDirectory)).length, 1);

  const removed = await adminInject(app, {
    method: 'DELETE',
    url: `/api/knowledge/${replaced.json().documents[0].id}`,
  });
  assert.equal(removed.statusCode, 200);
  assert.equal(removed.json().documentCount, 0);
  assert.deepEqual(await readdir(knowledgeFilesDirectory), []);
});

test('知识库拒绝不支持的文件和无效 JSON，不会部分落盘', async (t) => {
  const { app, knowledgePath, knowledgeFilesDirectory } = await createTestApp(t);
  for (const file of [
    { filename: 'unsafe.exe', content: 'not executable' },
    { filename: 'broken.json', content: '{ invalid' },
  ]) {
    const upload = multipartRequest({
      fields: { mode: 'append' },
      files: [file],
    });
    const response = await adminInject(app, {
      method: 'POST',
      url: '/api/knowledge/import',
      ...upload,
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.json().error, /^KNOWLEDGE_/);
  }

  assert.equal(JSON.parse(await readFile(knowledgePath, 'utf8')).documents.length, 0);
  assert.deepEqual(await readdir(knowledgeFilesDirectory), []);
});

test('新的 KnowledgeStore 实例可从磁盘恢复已导入文件和片段', async (t) => {
  const { app, knowledgePath, knowledgeFilesDirectory } = await createTestApp(t);
  const upload = multipartRequest({
    fields: { mode: 'append' },
    files: [
      {
        filename: 'persistent.md',
        content: '重启后仍然应该可以检索到这段持久化知识。',
      },
    ],
  });
  assert.equal(
    (
      await adminInject(app, {
        method: 'POST',
        url: '/api/knowledge/import',
        ...upload,
      })
    ).statusCode,
    200,
  );

  const logger = {
    info() {},
    warn() {},
    error() {},
  };
  const reloaded = new KnowledgeStore({
    knowledgePath,
    filesDirectory: knowledgeFilesDirectory,
    logger,
  });
  await reloaded.start();
  assert.equal(reloaded.publicSnapshot().documentCount, 1);
  assert.equal(reloaded.publicSnapshot().documents[0].filename, 'persistent.md');
  assert.match(reloaded.importedChunks()[0].text, /持久化知识/);
});

test('DOCX 和 PDF 解析器可提取文字并生成检索片段', async () => {
  const docxBuffer = await readFile(
    path.join(
      process.cwd(),
      'node_modules/mammoth/test/test-data/single-paragraph.docx',
    ),
  );
  const docx = await parseKnowledgeFile({
    filename: 'sample.docx',
    mimetype:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: docxBuffer,
  });
  assert.match(docx.preview, /Walking on imported air/);
  assert.ok(docx.chunkTexts.length > 0);

  const pdf = await parseKnowledgeFile({
    filename: 'sample.pdf',
    mimetype: 'application/pdf',
    buffer: minimalPdf('Persistent PDF knowledge'),
  });
  assert.match(pdf.preview, /Persistent PDF knowledge/);
  assert.ok(pdf.chunkTexts.length > 0);
});

test('模型初始为未配置，提问会返回明确的 503', async (t) => {
  const { app } = await createTestApp(t);
  const config = (
    await adminInject(app, { method: 'GET', url: '/api/model-config' })
  ).json();
  assert.equal(config.configured, false);
  assert.equal(config.hasApiKey, false);
  assert.equal(config.apiKey, undefined);

  const health = (
    await app.inject({ method: 'GET', url: '/health' })
  ).json();
  assert.equal(health.status, 'not_ready');
  assert.equal(health.ready, false);
  assert.equal(health.content.ready, true);
  assert.equal(health.model.status, 'unconfigured');
  assert.equal(
    (await app.inject({ method: 'GET', url: '/ready' })).statusCode,
    503,
  );

  const response = await app.inject({
    method: 'POST',
    url: '/answer',
    payload: { question: '培训地点在哪里？' },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error, 'MODEL_NOT_CONFIGURED');
  assert.equal(response.json().answer, MODEL_NOT_CONFIGURED_TEXT);
});

test('模型验证成功后健康检查与就绪检查共同反映问答可用', async (t) => {
  const mock = createMockLlm({ answer: '连接成功。' });
  const { app } = await createTestApp(t, ORIGINAL_CONTENT, {
    llmFetch: mock.fetch,
  });
  const saved = await configureModel(app);
  assert.equal(saved.statusCode, 200);

  const health = (
    await app.inject({ method: 'GET', url: '/health' })
  ).json();
  assert.equal(health.status, 'ready');
  assert.equal(health.ready, true);
  assert.equal(health.model.status, 'available');
  assert.equal(health.model.errorCode, null);
  assert.match(health.content.revision, /^[a-f0-9]{64}$/);

  const readiness = await app.inject({ method: 'GET', url: '/ready' });
  assert.equal(readiness.statusCode, 200);
  assert.equal(readiness.json().ready, true);
});

test('错误候选模型验证失败时保留原有内存、磁盘和可用状态', async (t) => {
  const mock = createMockLlm({
    responses: [
      { answer: '旧配置连接成功。', status: 200 },
      { status: 401 },
      { answer: '旧配置继续回答。', status: 200 },
    ],
  });
  const { app, modelConfigPath } = await createTestApp(t, ORIGINAL_CONTENT, {
    llmFetch: mock.fetch,
  });
  assert.equal((await configureModel(app)).statusCode, 200);
  const originalDiskConfig = JSON.parse(await readFile(modelConfigPath, 'utf8'));

  const rejected = await configureModel(app, {
    apiKey: 'wrong-provider-secret',
    model: 'wrong-model',
  });
  assert.equal(rejected.statusCode, 502);
  assert.equal(rejected.json().error, 'MODEL_UPSTREAM_ERROR');

  const activeConfig = (
    await adminInject(app, { method: 'GET', url: '/api/model-config' })
  ).json();
  assert.equal(activeConfig.model, MODEL_REQUEST.model);
  assert.equal(activeConfig.connection.status, 'available');
  assert.deepEqual(
    JSON.parse(await readFile(modelConfigPath, 'utf8')),
    originalDiskConfig,
  );

  const answer = await app.inject({
    method: 'POST',
    url: '/answer',
    payload: { question: '培训地点在哪里？' },
  });
  assert.equal(answer.statusCode, 200);
  assert.equal(answer.json().answer, '旧配置继续回答。');
  assert.equal(mock.calls[1].body.model, 'wrong-model');
  assert.equal(mock.calls[2].body.model, MODEL_REQUEST.model);
  assert.equal(
    mock.calls[2].headers.get('authorization'),
    `Bearer ${MODEL_REQUEST.apiKey}`,
  );
});

test('模型设置单独落盘为 0600，API Key 永不回显', async (t) => {
  const { app, modelConfigPath } = await createTestApp(t);
  const savedResponse = await configureModel(app);
  assert.equal(savedResponse.statusCode, 200);
  assert.equal(savedResponse.json().configured, true);
  assert.equal(savedResponse.json().hasApiKey, true);
  assert.equal(savedResponse.json().apiKey, undefined);
  assert.equal(savedResponse.json().connection.status, 'available');
  assert.equal(savedResponse.json().connectionTest.ok, true);

  const diskConfig = JSON.parse(await readFile(modelConfigPath, 'utf8'));
  assert.equal(diskConfig.apiKey, MODEL_REQUEST.apiKey);
  assert.equal((await stat(modelConfigPath)).mode & 0o777, 0o600);

  const loaded = (
    await adminInject(app, { method: 'GET', url: '/api/model-config' })
  ).json();
  assert.equal(loaded.hasApiKey, true);
  assert.equal(loaded.apiKey, undefined);
});

test('留空 API Key 会保留原密钥，显式清除后变为未配置', async (t) => {
  const { app, modelConfigPath } = await createTestApp(t);
  await configureModel(app);
  await configureModel(app, { apiKey: '', model: 'updated-model' });
  assert.equal(
    JSON.parse(await readFile(modelConfigPath, 'utf8')).apiKey,
    MODEL_REQUEST.apiKey,
  );

  const cleared = await configureModel(app, {
    apiKey: '',
    clearApiKey: true,
  });
  assert.equal(cleared.json().configured, false);
  assert.equal(cleared.json().hasApiKey, false);
});

test('问答通过 OpenAI 兼容接口生成，并携带知识上下文', async (t) => {
  const mock = createMockLlm();
  const { app } = await createTestApp(t, ORIGINAL_CONTENT, {
    llmFetch: mock.fetch,
  });
  await configureModel(app);

  const response = await app.inject({
    method: 'POST',
    url: '/answer',
    payload: { question: '请告诉我培训的具体地点' },
  });
  const body = response.json();

  assert.equal(response.statusCode, 200);
  assert.equal(body.answered, true);
  assert.equal(body.answer, '这是模型生成的测试回答。');
  assert.equal(body.speechText, body.answer);
  assert.equal(body.model, 'mock-model-resolved');
  assert.equal(body.answerStatus, 'answered');
  assert.equal(body.answerStatusSource, 'inferred');
  assert.deepEqual(body.knowledgeContext, {
    contextIds: ['training-location', 'project-introduction'],
    matchedIds: ['training-location'],
  });
  assert.equal(body.references, undefined);
  assert.equal(body.source, undefined);
  assert.equal(mock.calls.at(-1).url, 'https://model.example/v1/chat/completions');
  assert.equal(
    mock.calls.at(-1).headers.get('authorization'),
    `Bearer ${MODEL_REQUEST.apiKey}`,
  );
  assert.equal(mock.calls.at(-1).body.model, MODEL_REQUEST.model);
  assert.match(mock.calls.at(-1).body.messages[0].content, /只能依据后台知识内容/);
  assert.match(mock.calls.at(-1).body.messages[0].content, /只返回一个 JSON 对象/);
  assert.match(mock.calls.at(-1).body.messages[1].content, /培训地点为测试教室/);
  assert.doesNotMatch(mock.calls.at(-1).body.messages[1].content, /资料来源/);
});

test('模型拒答附带补充说明时仍稳定识别为 no_answer', async (t) => {
  const mock = createMockLlm({ answer: `${NO_ANSWER_TEXT}建议联系工作人员。` });
  const { app } = await createTestApp(t, ORIGINAL_CONTENT, {
    llmFetch: mock.fetch,
  });
  await configureModel(app);

  const response = await app.inject({
    method: 'POST',
    url: '/answer',
    payload: { question: '今天食堂吃什么？' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().answered, false);
  assert.equal(response.json().answerStatus, 'no_answer');
  assert.equal(response.json().answerStatusSource, 'inferred');
  assert.equal(response.json().answer, NO_ANSWER_TEXT);
  assert.deepEqual(response.json().knowledgeContext.matchedIds, []);
});

test('模型结构化状态作为 answered 的首要依据', async (t) => {
  const mock = createMockLlm({
    answer: JSON.stringify({
      status: 'no_answer',
      answer: '模型自行生成的不同拒答措辞。',
    }),
  });
  const { app } = await createTestApp(t, ORIGINAL_CONTENT, {
    llmFetch: mock.fetch,
  });
  await configureModel(app);

  const response = await app.inject({
    method: 'POST',
    url: '/answer',
    payload: { question: '今天食堂吃什么？' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().answered, false);
  assert.equal(response.json().answerStatus, 'no_answer');
  assert.equal(response.json().answerStatusSource, 'structured');
  assert.equal(response.json().answer, NO_ANSWER_TEXT);
});

test('保存并测试模型连接会走同一 OpenAI 兼容接口', async (t) => {
  const mock = createMockLlm({ answer: '连接成功。' });
  const { app } = await createTestApp(t, ORIGINAL_CONTENT, {
    llmFetch: mock.fetch,
  });
  await configureModel(app);

  const response = await adminInject(app, {
    method: 'POST',
    url: '/api/model-config/test',
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().ok, true);
  assert.equal(response.json().model, 'mock-model-resolved');
  assert.equal(mock.calls.length, 2);
});

test('上游错误被转换为安全提示，不泄露 API Key 或上游详情', async (t) => {
  const mock = createMockLlm({
    responses: [
      { answer: '连接成功。', status: 200 },
      { status: 401 },
    ],
  });
  const { app } = await createTestApp(t, ORIGINAL_CONTENT, {
    llmFetch: mock.fetch,
  });
  await configureModel(app);

  const response = await app.inject({
    method: 'POST',
    url: '/answer',
    payload: { question: '培训地点在哪里？' },
  });
  assert.equal(response.statusCode, 502);
  assert.equal(response.json().error, 'MODEL_UPSTREAM_ERROR');
  assert.doesNotMatch(response.body, new RegExp(MODEL_REQUEST.apiKey));
  assert.doesNotMatch(response.body, /上游内部详情/);

  const health = (
    await app.inject({ method: 'GET', url: '/health' })
  ).json();
  assert.equal(health.ready, false);
  assert.equal(health.status, 'not_ready');
  assert.equal(health.model.status, 'unavailable');
  assert.equal(
    (await app.inject({ method: 'GET', url: '/ready' })).statusCode,
    503,
  );
});

test('空问题、额外字段和无效模型配置会被拒绝', async (t) => {
  const { app } = await createTestApp(t);
  const emptyQuestion = await app.inject({
    method: 'POST',
    url: '/answer',
    payload: { question: '   ' },
  });
  assert.equal(emptyQuestion.statusCode, 400);

  const unexpectedField = await app.inject({
    method: 'POST',
    url: '/answer',
    payload: { question: '培训地点在哪里？', debug: true },
  });
  assert.equal(unexpectedField.statusCode, 400);

  const invalidConfig = await configureModel(app, {
    baseUrl: 'file:///etc/passwd',
  });
  assert.equal(invalidConfig.statusCode, 400);
  assert.equal(invalidConfig.json().error, 'INVALID_MODEL_CONFIG');
});

test('无效 content.json 不替换上一有效上下文，修复后自动恢复', async (t) => {
  const mock = createMockLlm();
  const { app, contentPath } = await createTestApp(t, ORIGINAL_CONTENT, {
    llmFetch: mock.fetch,
  });
  await configureModel(app);

  await writeFile(contentPath, '{ invalid json', 'utf8');
  await waitUntil(async () => {
    const health = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(health.json().status, 'degraded');
    assert.equal(health.json().ready, true);
  });

  await app.inject({
    method: 'POST',
    url: '/answer',
    payload: { question: '培训地点在哪里？' },
  });
  assert.match(
    mock.calls.at(-1).body.messages[1].content,
    /培训地点为测试教室/,
  );

  const updatedContent = structuredClone(ORIGINAL_CONTENT);
  updatedContent[0].answer = '培训地点已更新为测试报告厅。';
  await writeFile(contentPath, JSON.stringify(updatedContent), 'utf8');
  await waitUntil(async () => {
    const health = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(health.json().status, 'ready');
    assert.equal(health.json().ready, true);
    await app.inject({
      method: 'POST',
      url: '/answer',
      payload: { question: '培训地点在哪里？' },
    });
    assert.match(
      mock.calls.at(-1).body.messages[1].content,
      /培训地点已更新为测试报告厅/,
    );
  });
});
