import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildApp,
  DEFAULT_ANSWER_STYLE,
  HOSTING_MODE_TEXT,
  NO_ANSWER_TEXT,
  SERVICE_ERROR_TEXT,
  parseModelAnswer,
  prepareModelConfig,
  selectKnowledgeContext,
} from '../server.js';
import { KnowledgeStore, parseKnowledgeFile } from '../knowledge-store.js';
import { LiveControlStore } from '../live-control-store.js';
import { OpsLogStore, sanitizeOpsDetails } from '../ops-log-store.js';

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
              choices: [{ message: { content: responseConfig.answer ?? answer }, finish_reason: responseConfig.finishReason }],
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
  const liveControlPath = path.join(temporaryDirectory, 'host-scripts.json');
  const opsLogPath = path.join(temporaryDirectory, 'operations.jsonl');
  await writeFile(contentPath, JSON.stringify(content), 'utf8');
  const defaultMock = createMockLlm();

  const adminPassword = Object.hasOwn(options, 'adminPassword')
    ? options.adminPassword
    : 'test-admin-password';
  const app = await buildApp({
    contentPath,
    modelConfigPath,
    adminAuthPath: path.join(temporaryDirectory, 'admin-auth.json'),
    liveControlPath,
    opsLogPath,
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
    liveControlPath,
    opsLogPath,
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

test('管理页面需登录，登录后直接提供文件知识库、主持控制与模型设置', async (t) => {
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
  assert.match(response.body, /回答风格/);
  assert.match(response.body, /知识不足话术/);
  assert.match(response.body, /服务异常话术/);
  assert.match(response.body, /知识库管理/);
  assert.match(response.body, /导入知识文件/);
  assert.match(response.body, /知识文件/);
  assert.match(response.body, /API Key/);
  assert.match(response.body, /对话模式/);
  assert.match(response.body, /主持模式/);
  assert.match(response.body, /保存并播报到前台/);
  assert.match(response.body, /运维日志/);
  assert.doesNotMatch(response.body, /人工知识编辑/);
  assert.doesNotMatch(response.body, /适用问题/);
  assert.doesNotMatch(response.body, /问答试运行/);
  assert.doesNotMatch(response.body, /预先写好主持词，点击哪段/);
  assert.doesNotMatch(response.body, /问答条目/);
  assert.doesNotMatch(response.body, /把业务内容交给大模型/);
  assert.doesNotMatch(response.body, /资料来源/);
});

test('数字人前台和四态配置可直接访问', async (t) => {
  const { app } = await createTestApp(t);
  const pageResponse = await app.inject({ method: 'GET', url: '/avatar' });

  assert.equal(pageResponse.statusCode, 200);
  assert.match(pageResponse.headers['content-type'], /text\/html/);
  assert.match(pageResponse.headers['content-security-policy'], /media-src 'self'/);
  assert.match(pageResponse.body, /id="live-mode-pill"/);
  assert.match(pageResponse.body, /后台主持控制已接管/);
  assert.doesNotMatch(pageResponse.body, /主持开场/);
  assert.match(
    pageResponse.body,
    /<h1 id="conversation-title">有什么想了解的？<\/h1>/,
  );
  assert.match(
    pageResponse.body,
    /<div class="conversation-log" id="conversation-log"[^>]*><\/div>/,
  );
  assert.doesNotMatch(pageResponse.body, /你好，我是大未来数字助手/);
  assert.equal((pageResponse.body.match(/data-avatar-video=/g) ?? []).length, 4);
  assert.doesNotMatch(pageResponse.body, /资料来源/);

  const configResponse = await app.inject({
    method: 'GET',
    url: '/avatar-config.json',
  });
  assert.equal(configResponse.statusCode, 200);
  const avatarConfig = configResponse.json();
  assert.equal(avatarConfig.mediaMode, 'production');
  assert.equal(avatarConfig.characterName, '大未来');
  assert.equal(Object.hasOwn(avatarConfig, 'welcomeText'), false);
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
  assert.deepEqual(avatarConfig.quickQuestions, []);
  assert.equal(avatarConfig.serviceErrorText, SERVICE_ERROR_TEXT);
  assert.match(avatarConfig.contentRevision, /^[a-f0-9]{64}$/);
});

test('主持词可持久化，主持模式阻止问答且控制指令保留原文', async (t) => {
  const { app, liveControlPath } = await createTestApp(t);
  const initial = (
    await adminInject(app, { method: 'GET', url: '/api/live-control' })
  ).json();

  assert.equal(initial.mode, 'dialogue');
  assert.equal(initial.sequence, 0);
  assert.equal(initial.scripts.length, 1);
  assert.match(initial.revision, /^[a-f0-9]{64}$/);
  assert.equal((await stat(liveControlPath)).mode & 0o777, 0o600);

  const scripts = [
    {
      id: 'opening',
      title: '正式开场',
      text: '各位来宾，上午好。欢迎来到今天的活动现场。',
    },
    {
      id: 'transition',
      title: '环节过渡',
      text: '接下来，让我们进入第二个环节。',
    },
  ];
  const savedResponse = await adminInject(app, {
    method: 'PUT',
    url: '/api/live-control',
    payload: { revision: initial.revision, scripts },
  });
  assert.equal(savedResponse.statusCode, 200, savedResponse.body);
  const saved = savedResponse.json();
  assert.deepEqual(saved.scripts, scripts);
  assert.notEqual(saved.revision, initial.revision);
  assert.deepEqual(JSON.parse(await readFile(liveControlPath, 'utf8')), {
    version: 1,
    scripts,
  });

  const conflict = await adminInject(app, {
    method: 'PUT',
    url: '/api/live-control',
    payload: { revision: initial.revision, scripts },
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error, 'LIVE_CONTROL_VERSION_CONFLICT');

  const switched = await adminInject(app, {
    method: 'POST',
    url: '/api/live-control/mode',
    payload: { mode: 'hosting' },
  });
  assert.equal(switched.statusCode, 200);
  assert.equal(switched.json().mode, 'hosting');
  assert.equal(switched.json().sequence, 1);

  const hostingHealth = (
    await app.inject({ method: 'GET', url: '/health' })
  ).json();
  assert.equal(hostingHealth.ready, true);
  assert.equal(hostingHealth.liveControl.mode, 'hosting');
  assert.equal(hostingHealth.model.status, 'unconfigured');

  const blockedAnswer = await app.inject({
    method: 'POST',
    url: '/answer',
    payload: { question: '现在可以提问吗？' },
  });
  assert.equal(blockedAnswer.statusCode, 409);
  assert.equal(blockedAnswer.json().error, 'HOSTING_MODE_ACTIVE');
  assert.equal(blockedAnswer.json().answer, HOSTING_MODE_TEXT);

  const presented = await adminInject(app, {
    method: 'POST',
    url: '/api/live-control/present',
    payload: { scriptId: 'transition' },
  });
  assert.equal(presented.statusCode, 200);
  assert.equal(presented.json().command.type, 'present');
  assert.equal(presented.json().command.sequence, 2);
  assert.deepEqual(presented.json().command.script, scripts[1]);

  const stopped = await adminInject(app, {
    method: 'POST',
    url: '/api/live-control/stop',
    payload: {},
  });
  assert.equal(stopped.statusCode, 200);
  assert.equal(stopped.json().mode, 'hosting');
  assert.equal(stopped.json().sequence, 3);
  assert.equal(stopped.json().lastCommand, null);

  const logger = { info() {}, warn() {}, error() {} };
  const reloaded = new LiveControlStore({
    configPath: liveControlPath,
    logger,
  });
  await reloaded.start();
  assert.deepEqual(reloaded.publicSnapshot().scripts, scripts);
  assert.equal(reloaded.mode, 'dialogue');
  assert.equal(reloaded.sequence, 0);
  assert.equal(reloaded.lastCommand, null);
});

test('实时事件流向已连接前台发送模式、主持词和停止指令', async (t) => {
  const { app } = await createTestApp(t);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');

  const controller = new AbortController();
  t.after(() => controller.abort());
  const eventResponse = await fetch(
    `http://127.0.0.1:${address.port}/api/live/events`,
    { signal: controller.signal },
  );
  assert.equal(eventResponse.status, 200);
  assert.match(eventResponse.headers.get('content-type'), /text\/event-stream/);
  const reader = eventResponse.body.getReader();
  const decoder = new TextDecoder();
  let eventText = '';

  async function readUntil(pattern, timeoutMs = 2_000) {
    const deadline = Date.now() + timeoutMs;
    while (!pattern.test(eventText)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`等待 SSE 事件超时：${pattern}`);
      }
      const result = await Promise.race([
        reader.read(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`等待 SSE 事件超时：${pattern}`)), remaining),
        ),
      ]);
      if (result.done) {
        throw new Error('SSE 连接在目标事件到达前结束');
      }
      eventText += decoder.decode(result.value, { stream: true });
    }
  }

  await readUntil(/event: sync[\s\S]*"mode":"dialogue"/);
  await waitUntil(async () => {
    const snapshot = (
      await adminInject(app, { method: 'GET', url: '/api/live-control' })
    ).json();
    assert.equal(snapshot.connectedClients, 1);
  });

  const initial = (
    await adminInject(app, { method: 'GET', url: '/api/live-control' })
  ).json();
  const exactText = '这是必须逐字下发的主持词，不得由模型改写。';
  const saved = await adminInject(app, {
    method: 'PUT',
    url: '/api/live-control',
    payload: {
      revision: initial.revision,
      scripts: [{ id: 'exact-script', title: '原文测试', text: exactText }],
    },
  });
  assert.equal(saved.statusCode, 200, saved.body);

  const presented = await adminInject(app, {
    method: 'POST',
    url: '/api/live-control/present',
    payload: { scriptId: 'exact-script' },
  });
  assert.equal(presented.statusCode, 200, presented.body);
  await readUntil(/event: present/);
  assert.match(eventText, new RegExp(JSON.stringify(exactText).slice(1, -1)));
  assert.match(eventText, /"type":"present"/);

  const stopped = await adminInject(app, {
    method: 'POST',
    url: '/api/live-control/stop',
    payload: {},
  });
  assert.equal(stopped.statusCode, 200);
  await readUntil(/event: stop/);

  await reader.cancel();
  await waitUntil(async () => {
    const snapshot = (
      await adminInject(app, { method: 'GET', url: '/api/live-control' })
    ).json();
    assert.equal(snapshot.connectedClients, 0);
  });
});

test('日志保留每轮问答正文，但不记录密码、知识正文或主持词正文', async (t) => {
  const { app, opsLogPath } = await createTestApp(t);
  const initial = (
    await adminInject(app, { method: 'GET', url: '/api/live-control' })
  ).json();
  const privateScriptText = 'PRIVATE_HOST_TEXT_MUST_NOT_ENTER_OPERATIONS_LOG';
  const wrongPassword = 'WRONG_PASSWORD_MUST_NOT_ENTER_OPERATIONS_LOG';
  const privateQuestion = 'PRIVATE_QUESTION_MUST_NOT_ENTER_OPERATIONS_LOG';

  const saved = await adminInject(app, {
    method: 'PUT',
    url: '/api/live-control',
    payload: {
      revision: initial.revision,
      scripts: [
        {
          id: 'ops-log-script',
          title: '日志验证段落',
          text: privateScriptText,
        },
      ],
    },
  });
  assert.equal(saved.statusCode, 200, saved.body);

  const presented = await adminInject(app, {
    method: 'POST',
    url: '/api/live-control/present',
    payload: { scriptId: 'ops-log-script' },
  });
  assert.equal(presented.statusCode, 200, presented.body);

  const dialogueMode = await adminInject(app, {
    method: 'POST',
    url: '/api/live-control/mode',
    payload: { mode: 'dialogue' },
  });
  assert.equal(dialogueMode.statusCode, 200, dialogueMode.body);

  const rejectedLogin = await app.inject({
    method: 'POST',
    url: '/api/admin/login',
    payload: { password: wrongPassword },
  });
  assert.equal(rejectedLogin.statusCode, 401);

  const failedQuestion = await app.inject({
    method: 'POST',
    url: '/answer',
    payload: { question: privateQuestion },
  });
  assert.equal(failedQuestion.statusCode, 503);
  assert.equal(failedQuestion.json().error, 'MODEL_NOT_CONFIGURED');

  const response = await adminInject(app, {
    method: 'GET',
    url: '/api/ops-logs?limit=100',
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  const snapshot = response.json();
  assert.equal(snapshot.status.ready, true);
  assert.ok(snapshot.storedEntries >= 4);
  assert.equal(snapshot.invalidLines, 0);

  const presentLog = snapshot.entries.find(
    (entry) => entry.action === 'hosting.present',
  );
  assert.ok(presentLog);
  assert.equal(presentLog.outcome, 'success');
  assert.equal(presentLog.request.statusCode, 200);
  assert.equal(presentLog.request.actor, 'session');
  assert.equal(presentLog.request.route, '/api/live-control/present');
  assert.ok(presentLog.request.durationMs >= 0);
  assert.equal(presentLog.details.scriptId, 'ops-log-script');
  assert.equal(
    presentLog.details.characterCount,
    [...privateScriptText].length,
  );

  const loginLog = snapshot.entries.find(
    (entry) =>
      entry.action === 'admin.login' && entry.outcome === 'rejected',
  );
  assert.ok(loginLog);
  assert.equal(loginLog.details.errorCode, 'ADMIN_LOGIN_FAILED');
  assert.equal(loginLog.request.statusCode, 401);

  const questionLog = snapshot.entries.find(
    (entry) => entry.action === 'question.answer',
  );
  assert.ok(questionLog);
  assert.equal(questionLog.details.errorCode, 'MODEL_NOT_CONFIGURED');
  assert.equal(
    questionLog.details.questionCharacters,
    [...privateQuestion].length,
  );

  const liveOnly = (
    await adminInject(app, {
      method: 'GET',
      url: '/api/ops-logs?category=live&outcome=success&limit=20',
    })
  ).json();
  assert.ok(liveOnly.entries.length >= 2);
  assert.ok(
    liveOnly.entries.every(
      (entry) => entry.category === 'live' && entry.outcome === 'success',
    ),
  );

  const invalidQuery = await adminInject(app, {
    method: 'GET',
    url: '/api/ops-logs?limit=5000',
  });
  assert.equal(invalidQuery.statusCode, 400);
  assert.equal(invalidQuery.json().error, 'OPS_LOG_QUERY_INVALID');

  const download = await adminInject(app, {
    method: 'GET',
    url: '/api/ops-logs/download',
  });
  assert.equal(download.statusCode, 200);
  assert.match(download.headers['content-type'], /application\/x-ndjson/);
  assert.match(download.headers['content-disposition'], /operations-\d{4}-\d{2}-\d{2}\.jsonl/);

  const source = await readFile(opsLogPath, 'utf8');
  assert.doesNotMatch(source, new RegExp(privateScriptText));
  assert.doesNotMatch(source, new RegExp(wrongPassword));
  assert.match(source, new RegExp(privateQuestion));
  assert.equal(questionLog.dialogue.question, privateQuestion);
  assert.equal(questionLog.dialogue.answer, SERVICE_ERROR_TEXT);
  assert.ok(questionLog.details.turnId);
  assert.equal((await stat(opsLogPath)).mode & 0o777, 0o600);

  const reloaded = new OpsLogStore({
    logPath: opsLogPath,
    logger: { info() {}, warn() {}, error() {} },
  });
  await reloaded.start();
  const persisted = await reloaded.query({ limit: 100 });
  assert.ok(
    persisted.entries.some((entry) => entry.action === 'hosting.present'),
  );
});

test('运维日志脱敏嵌套密钥并按文件大小自动轮转', async (t) => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'answer-mvp-ops-log-test-'),
  );
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const logPath = path.join(temporaryDirectory, 'operations.jsonl');
  const store = new OpsLogStore({
    logPath,
    maxFileBytes: 32 * 1024,
    maxFiles: 2,
    logger: { info() {}, warn() {}, error() {} },
  });
  await store.start();

  const sanitized = sanitizeOpsDetails({
    password: 'private-password',
    apiKey: 'private-api-key',
    contentCount: 4,
    nested: { token: 'private-token', answerStatus: 'answered' },
  });
  assert.equal(sanitized.password, '[REDACTED]');
  assert.equal(sanitized.apiKey, '[REDACTED]');
  assert.equal(sanitized.contentCount, 4);
  assert.equal(sanitized.nested.token, '[REDACTED]');
  assert.equal(sanitized.nested.answerStatus, 'answered');

  for (let index = 0; index < 140; index += 1) {
    await store.record({
      category: 'system',
      action: `rotation.${index}`,
      outcome: 'success',
      summary: `轮转测试 ${index}`,
      details: {
        diagnostic: 'x'.repeat(300),
        password: 'never-write-this-password',
      },
    });
  }

  assert.ok((await stat(`${logPath}.1`)).size > 0);
  assert.ok((await stat(logPath)).size <= 32 * 1024);
  assert.doesNotMatch(await readFile(logPath, 'utf8'), /never-write-this-password/);
  const snapshot = await store.query({ limit: 10 });
  assert.equal(snapshot.invalidLines, 0);
  assert.equal(snapshot.entries[0].action, 'rotation.139');
  assert.equal(snapshot.fileCount, 2);
});

test('历史内容 API 不再生成访客快捷问题或影响文件知识版本', async (t) => {
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
  assert.deepEqual(config.quickQuestions, []);
  assert.notEqual(config.contentRevision, saved.json().revision);
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

test('历史内容仅在显式迁入可见知识文件后生效，删除迁移文件后不再生效', async (t) => {
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
  assert.doesNotMatch(
    mock.calls.at(-1).body.messages[1].content,
    /通过 Web 页面更新后的测试地点/,
  );
  const migrated = await adminInject(app, {
    method: 'POST', url: '/api/knowledge/migrate-legacy',
    payload: { revision: savedResponse.json().revision },
  });
  assert.equal(migrated.statusCode, 200, migrated.body);
  assert.equal(migrated.json().documents[0].filename, '历史问答迁移.md');
  await app.inject({ method: 'POST', url: '/answer', payload: { question: '培训地点在哪里？' } });
  assert.match(mock.calls.at(-1).body.messages[1].content, /通过 Web 页面更新后的测试地点/);
  await adminInject(app, { method: 'DELETE', url: `/api/knowledge/${migrated.json().documents[0].id}` });
  await app.inject({ method: 'POST', url: '/answer', payload: { question: '培训地点在哪里？' } });
  assert.doesNotMatch(mock.calls.at(-1).body.messages[1].content, /通过 Web 页面更新后的测试地点/);
  assert.equal(JSON.parse(await readFile(contentPath, 'utf8')).length, ORIGINAL_CONTENT.length);
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

test('后台接口要求登录，但已登录会话不限制页面来源', async (t) => {
  const { app } = await createTestApp(t);
  for (const url of [
    '/api/content',
    '/api/knowledge',
    '/api/model-config',
    '/api/live-control',
    '/api/ops-logs',
  ]) {
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
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().accessMode, 'session');
  }

  const modeChange = await adminInject(app, {
    method: 'POST',
    url: '/api/live-control/mode',
    headers: {
      host: '127.0.0.1',
      origin: 'https://untrusted.example',
    },
    payload: { mode: 'hosting' },
  });
  assert.equal(modeChange.statusCode, 200, modeChange.body);
  assert.equal(modeChange.json().mode, 'hosting');
  assert.equal(modeChange.json().accessMode, 'session');
});

test('设置管理密钥后后台接口仍支持 Bearer 认证', async (t) => {
  const { app } = await createTestApp(t, ORIGINAL_CONTENT, {
    adminApiKey: 'test-admin-key',
  });

  for (const url of [
    '/api/content',
    '/api/knowledge',
    '/api/model-config',
    '/api/live-control',
    '/api/ops-logs',
  ]) {
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

test('首次设置和管理登录不限制页面来源，落盘仅保存加盐哈希', async (t) => {
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
    headers: {
      host: 'demo.example.test',
      origin: 'https://other.example.test',
    },
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
    headers: {
      host: 'demo.example.test',
      origin: 'https://other.example.test',
    },
    payload: { password: 'wrong-password' },
  });
  assert.equal(wrongLogin.statusCode, 401);
  assert.equal(wrongLogin.json().error, 'ADMIN_LOGIN_FAILED');
  const correctLogin = await app.inject({
    method: 'POST',
    url: '/api/admin/login',
    headers: {
      host: 'demo.example.test',
      origin: 'https://other.example.test',
    },
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
  assert.equal(response.json().answerStatus, 'error');
  assert.equal(response.json().answerStatusSource, 'system');
  assert.equal(response.json().answer, SERVICE_ERROR_TEXT);
  assert.equal(response.json().speechText, SERVICE_ERROR_TEXT);
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
  assert.equal(savedResponse.json().answerStyle, DEFAULT_ANSWER_STYLE);
  assert.equal(savedResponse.json().noAnswerText, NO_ANSWER_TEXT);
  assert.equal(savedResponse.json().serviceErrorText, SERVICE_ERROR_TEXT);

  const diskConfig = JSON.parse(await readFile(modelConfigPath, 'utf8'));
  assert.equal(diskConfig.apiKey, MODEL_REQUEST.apiKey);
  assert.equal(diskConfig.answerStyle, DEFAULT_ANSWER_STYLE);
  assert.equal(diskConfig.noAnswerText, NO_ANSWER_TEXT);
  assert.equal(diskConfig.serviceErrorText, SERVICE_ERROR_TEXT);
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
  const answerStyle = '像现场工作人员一样自然回答，使用两句简短口语。';
  await configureModel(app, { answerStyle });
  await app.knowledgeStore.importFiles([{ filename: '地点.txt', buffer: Buffer.from('培训地点为测试教室。') }], 'append');

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
  assert.equal(body.knowledgeContext.contextIds.length, 1);
  assert.equal(body.knowledgeContext.matchedIds.length, 1);
  assert.equal(body.knowledgeContext.retrievalMode, 'full');
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
  assert.match(mock.calls.at(-1).body.messages[0].content, new RegExp(answerStyle));
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
  const customNoAnswerText = '这个问题我还没有准确资料，请换一种问法。';
  const mock = createMockLlm({
    answer: JSON.stringify({
      status: 'no_answer',
      answer: '',
    }),
  });
  const { app } = await createTestApp(t, ORIGINAL_CONTENT, {
    llmFetch: mock.fetch,
  });
  await configureModel(app);
  const saved = await configureModel(app, {
    apiKey: '',
    noAnswerText: customNoAnswerText,
  });
  assert.equal(saved.json().noAnswerText, customNoAnswerText);
  assert.equal(mock.calls.length, 1, '只修改兜底话术不应发起模型请求');

  const response = await app.inject({
    method: 'POST',
    url: '/answer',
    payload: { question: '今天食堂吃什么？' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().answered, false);
  assert.equal(response.json().answerStatus, 'no_answer');
  assert.equal(response.json().answerStatusSource, 'structured');
  assert.equal(response.json().answer, customNoAnswerText);
  assert.equal(response.json().speechText, customNoAnswerText);
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
  const customServiceErrorText = '服务暂时有点忙，请稍后再问我。';
  const mock = createMockLlm({
    responses: [
      { answer: '连接成功。', status: 200 },
      { status: 401 },
    ],
  });
  const { app } = await createTestApp(t, ORIGINAL_CONTENT, {
    llmFetch: mock.fetch,
  });
  await configureModel(app, { serviceErrorText: customServiceErrorText });

  const response = await app.inject({
    method: 'POST',
    url: '/answer',
    payload: { question: '培训地点在哪里？' },
  });
  assert.equal(response.statusCode, 502);
  assert.equal(response.json().error, 'MODEL_UPSTREAM_ERROR');
  assert.equal(response.json().answered, false);
  assert.equal(response.json().answerStatus, 'error');
  assert.equal(response.json().answerStatusSource, 'system');
  assert.equal(response.json().answer, customServiceErrorText);
  assert.equal(response.json().speechText, customServiceErrorText);
  assert.equal(response.json().message, customServiceErrorText);
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

  const emptyFallback = await configureModel(app, { noAnswerText: '   ' });
  assert.equal(emptyFallback.statusCode, 400);
  assert.equal(emptyFallback.json().error, 'INVALID_MODEL_CONFIG');
});

test('历史备份损坏保留上一有效备份，恢复后仍不隐式进入模型上下文', async (t) => {
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
  assert.doesNotMatch(
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
    assert.doesNotMatch(
      mock.calls.at(-1).body.messages[1].content,
      /培训地点已更新为测试报告厅/,
    );
    assert.equal(app.contentStore.items[0].answer, '培训地点已更新为测试报告厅。');
  });
});

test('小知识库全量上下文覆盖同义问法，大知识库有同义匹配与未命中回退', () => {
  const importedChunks = [{ id: 'doc-ticket-chunk-1', text: '票价：免费。地址：南京市测试路 88 号。' }];
  for (const question of ['门票多少钱？', '位置在哪？', '入场要花银子吗？']) {
    const selected = selectKnowledgeContext([], question, { importedChunks });
    assert.match(selected.text, /票价：免费/);
    assert.equal(selected.retrievalMode, 'full');
  }
  const large = [
    ...Array.from({ length: 40 }, (_, i) => ({ id: `doc-noise-${i}-chunk-1`, text: '春季活动。'.repeat(160) })),
    ...importedChunks,
  ];
  const matched = selectKnowledgeContext([], '门票多少钱？', { importedChunks: large });
  assert.equal(matched.retrievalMode, 'ranked');
  assert.match(matched.text, /票价：免费/);
  const fallback = selectKnowledgeContext([], '穿梭飞行器？', { importedChunks: large });
  assert.equal(fallback.retrievalMode, 'fallback');
  assert.ok(fallback.contextIds.length > 0);
  assert.ok(fallback.text.length <= 24_000);
  assert.ok(fallback.contextIds.length <= 12);
});

test('缺少 answer 的 no_answer 使用话术，结构异常和 JSON 碎片绝不作为回答', () => {
  const config = prepareModelConfig({ noAnswerText: '请向工作人员确认。' });
  assert.equal(parseModelAnswer('{"status":"no_answer"}', config).answer, config.noAnswerText);
  assert.equal(parseModelAnswer('对不起，我没有找到相关信息，无法回答这个问题。', config).answerStatus, 'no_answer');
  assert.equal(parseModelAnswer('门票免费。', config).answer, '门票免费。');
  for (const text of ['{"status":"answered","answer":"未完', '{"answer":"缺少状态"}', '[]', 'null', '```json\nnot json\n```', '结果如下：{"status":"answered"}']) {
    assert.throws(() => parseModelAnswer(text, config), { code: 'MODEL_INVALID_RESPONSE' });
  }
});

test('截断模型输出转入服务兜底，日志保留截断原因和完整兜底答案', async (t) => {
  const mock = createMockLlm({ responses: [
    { answer: '连接正常。' },
    { answer: '{"status":"answered","answer":"未完', finishReason: 'length' },
  ] });
  const { app } = await createTestApp(t, ORIGINAL_CONTENT, { llmFetch: mock.fetch });
  await configureModel(app);
  const response = await app.inject({ method: 'POST', url: '/answer', payload: { question: '问答正文测试？' } });
  assert.equal(response.statusCode, 502);
  assert.equal(response.json().error, 'MODEL_TRUNCATED_RESPONSE');
  assert.equal(response.json().speechText, SERVICE_ERROR_TEXT);
  const logs = (await adminInject(app, { method: 'GET', url: '/api/ops-logs?category=question' })).json();
  const entry = logs.entries.find((item) => item.action === 'question.answer');
  assert.equal(entry.details.finishReason, 'length');
  assert.equal(entry.dialogue.question, '问答正文测试？');
  assert.equal(entry.dialogue.answer, SERVICE_ERROR_TEXT);
  assert.equal(entry.details.turnId, response.json().turnId);
});

test('模型 401、429、500 在日志中可区分且失败也保留本轮正文与检索诊断', async (t) => {
  const mock = createMockLlm({ responses: [{ answer: '连接正常' }, { status: 401 }, { status: 429 }, { status: 500 }] });
  const { app } = await createTestApp(t, ORIGINAL_CONTENT, { llmFetch: mock.fetch });
  await configureModel(app);
  for (const upstreamStatus of [401, 429, 500]) {
    const response = await app.inject({ method: 'POST', url: '/answer', payload: { question: `第 ${upstreamStatus} 次测试 ${MODEL_REQUEST.apiKey}` } });
    assert.equal(response.statusCode, 502);
    const logs = (await adminInject(app, { method: 'GET', url: `/api/ops-logs?search=${response.json().turnId}` })).json();
    const entry = logs.entries.find((item) => item.action === 'question.answer');
    assert.equal(entry.details.upstreamStatus, upstreamStatus);
    assert.equal(entry.details.failureStage, 'upstream');
    assert.equal(entry.details.model, MODEL_REQUEST.model);
    assert.equal(entry.details.retrievalMode, 'full');
    assert.match(entry.dialogue.question, /\[REDACTED\]/);
    assert.equal(entry.dialogue.answer, SERVICE_ERROR_TEXT);
    assert.doesNotMatch(JSON.stringify(logs), new RegExp(MODEL_REQUEST.apiKey));
  }
  assert.equal((await app.inject({ method: 'GET', url: '/api/ops-logs' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/ops-logs/download' })).statusCode, 401);
});

test('前台执行结果关联对话或主持指令，重复上报不重复记账，正文不公开', async (t) => {
  const { app } = await createTestApp(t);
  const event = { eventId: 'event-12345678', clientId: 'client-12345678', kind: 'dialogue', turnId: 'turn-12345678', phase: 'request-failed', question: '断网提问', answer: SERVICE_ERROR_TEXT, errorCode: 'CLIENT_CONNECTION_FAILED' };
  for (let i = 0; i < 2; i++) assert.equal((await app.inject({ method: 'POST', url: '/api/client-events', payload: event })).statusCode, 200);
  const logs = (await adminInject(app, { method: 'GET', url: '/api/ops-logs?search=turn-12345678' })).json();
  assert.equal(logs.entries.length, 1);
  assert.equal(logs.entries[0].dialogue.question, '断网提问');
  assert.equal(logs.entries[0].outcome, 'failure');
  const command = app.liveControlStore.present(app.liveControlStore.scripts[0].id);
  await app.inject({ method: 'POST', url: '/api/client-events', payload: {
    eventId: 'event-host1234', clientId: event.clientId, kind: 'hosting', phase: 'speech-failed',
    instanceId: command.instanceId, commandSequence: command.sequence, errorCode: 'SYNTHESIS-FAILED',
  } });
  const admin = (await adminInject(app, { method: 'GET', url: '/api/live-control' })).json();
  assert.equal(admin.playbackReports[0].phase, 'speech-failed');
  const publicState = (await app.inject({ method: 'GET', url: '/api/live/state' })).json();
  assert.equal(publicState.playbackReports, undefined);
  assert.equal((await app.inject({ method: 'POST', url: '/api/client-events', payload: { ...event, password: 'invalid' } })).statusCode, 400);
});
