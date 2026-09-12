import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildApp, parseModelAnswer, prepareModelConfig, SERVICE_ERROR_TEXT } from '../server.js';

const INITIAL_CONFIG = {
  baseUrl: 'http://model.invalid/v1',
  apiKey: 'model-reliability-placeholder-key',
  model: 'reliability-model',
};
const ADMIN_PASSWORD = 'model-reliability-admin-password';
const successfulResponse = (answer = '连接正常。') => new Response(JSON.stringify({
  choices: [{ message: { content: answer }, finish_reason: 'stop' }],
}));

async function createIsolatedApp(t, llmFetch = async () => successfulResponse()) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'answer-model-reliability-'));
  const modelConfigPath = path.join(directory, 'model-config.json');
  await writeFile(modelConfigPath, JSON.stringify(INITIAL_CONFIG), { mode: 0o600 });
  const app = await buildApp({
    contentPath: path.join(directory, 'content.json'),
    modelConfigPath,
    knowledgePath: path.join(directory, 'knowledge.json'),
    knowledgeFilesDirectory: path.join(directory, 'knowledge-files'),
    adminAuthPath: path.join(directory, 'admin-auth.json'),
    liveControlPath: path.join(directory, 'host-scripts.json'),
    opsLogPath: path.join(directory, 'operations.jsonl'),
    bundledKnowledgeEnabled: false,
    adminPassword: ADMIN_PASSWORD,
    adminApiKey: '',
    logger: false,
    pollIntervalMs: 60_000,
    llmFetch,
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  await app.knowledgeStore.importFiles([
    { filename: '演示资料.txt', buffer: Buffer.from('活动门票免费。') },
  ], 'append');
  const login = await app.inject({
    method: 'POST', url: '/api/admin/login', payload: { password: ADMIN_PASSWORD },
  });
  assert.equal(login.statusCode, 200);
  const cookie = login.headers['set-cookie'].split(';', 1)[0];
  const adminInject = (options) => app.inject({ ...options, headers: { cookie } });
  return { app, directory, modelConfigPath, adminInject };
}

const UNSPEAKABLE_ANSWERS = [
  '答复：{status: "answered", answer: "门票免费。"}',
  '答复：{status: "answered", answer: "门票免费',
  '结果如下：{"reply":"门票免费。"}',
  '结果：["门票免费。"]',
  '["门票免费。"] 以上是回答。',
  'status: answered\nanswer: 门票免费。',
  '答复：status: answered\nanswer: 门票免费。',
  '<think>先检查资料，再形成回答。</think>',
  '门票免费。<think>这里不该播报思考过程。</think>',
  '<analysis>先检查知识库。</analysis>',
  '[analysis] 需要检查资料。',
  '<|im_start|>assistant 门票免费。',
  '<html><body>502 Bad Gateway</body></html>',
  '<span>门票免费。</span>',
  '<result>门票免费。</result>',
  '<custom-answer code="ok">门票免费。</custom-answer>',
  '答复：<span>门票免费。</span>',
  '上游响应：<html><body>502 Bad Gateway</body></html>',
  '说明如下：\n```json\n{"status":"answered","answer":"门票免费。"}\n```',
  '{"status":"answered","answer":"门票免费。"}',
  JSON.stringify('{"status":"answered","answer":"门票免费。"}'),
  '[{"answer":"门票免费。"}]',
];

test('模型的结构化 answer 与纯文本分支均拒绝协议碎片、思考过程和嵌套 JSON', () => {
  const config = prepareModelConfig({});
  for (const answer of UNSPEAKABLE_ANSWERS) {
    assert.throws(() => parseModelAnswer(JSON.stringify({ status: 'answered', answer }), config),
      { code: 'MODEL_INVALID_RESPONSE' }, `结构化 answer 不应播报：${answer}`);
    // An ordinary valid envelope remains supported; here we exercise only
    // actual malformed/plain-text responses, not that valid outer contract.
    if (!answer.startsWith('{"status"')) {
      assert.throws(() => parseModelAnswer(answer, config),
        { code: 'MODEL_INVALID_RESPONSE' }, `纯文本不应播报：${answer}`);
    }
  }
  let wrapped = '{"status":"answered","answer":"门票免费。"}';
  for (let depth = 0; depth < 6; depth += 1) wrapped = JSON.stringify(wrapped);
  assert.throws(() => parseModelAnswer(JSON.stringify({ status: 'answered', answer: wrapped }), config),
    { code: 'MODEL_INVALID_RESPONSE' });
});

test('正常口语、英文、引号、括号和数字答案保持兼容', () => {
  const config = prepareModelConfig({});
  for (const answer of [
    '活动门票免费，欢迎您来参加。',
    '【温馨提醒】请在上午九点前到达。',
    '[温馨提醒] 请在上午九点前到达。',
    '[1] 请先签到，然后入场。',
    '您可以点击“开始”，也可以说“你好”。',
    'The answer is yes. The event is free.',
    'JSON 是一种文本数据格式。HTML 页面可以包含 <body> 标签。',
    '您会看到 status 和 answer 两个字段。',
    '温度低于 20°C 时，请多穿一件外套；1 < 2 是正确的。',
  ]) {
    assert.equal(parseModelAnswer(answer, config).answer, answer);
    assert.equal(parseModelAnswer(JSON.stringify({ status: 'answered', answer }), config).answer, answer);
  }
  assert.equal(parseModelAnswer('{"status":"answered","answer":"42"}', config).answer, '42');
  assert.equal(parseModelAnswer('```json\n{"status":"answered","answer":"门票免费。"}\n```', config).answer, '门票免费。');
  assert.equal(parseModelAnswer('{"status":"no_answer","answer":"<think>忽略此字段</think>"}', config).answer, config.noAnswerText);
});

test('异常模型文字统一进入自然服务兜底，并记录失败而不是成功播报正文', async (t) => {
  let content;
  const { app, adminInject } = await createIsolatedApp(t, async () => successfulResponse(content));
  for (const answer of UNSPEAKABLE_ANSWERS) {
    content = JSON.stringify({ status: 'answered', answer });
    const response = await app.inject({
      method: 'POST', url: '/answer', payload: { question: `门票收费吗？${INITIAL_CONFIG.apiKey}` },
    });
    const body = response.json();
    assert.equal(response.statusCode, 502);
    assert.equal(body.error, 'MODEL_INVALID_RESPONSE');
    assert.equal(body.answered, false);
    assert.equal(body.answer, SERVICE_ERROR_TEXT);
    assert.equal(body.speechText, SERVICE_ERROR_TEXT);
    const logs = (await adminInject({ url: `/api/ops-logs?search=${body.turnId}` })).json();
    const result = logs.entries.find((entry) => entry.action === 'question.answer');
    assert.equal(result.outcome, 'failure');
    assert.equal(result.details.errorCode, 'MODEL_INVALID_RESPONSE');
    assert.equal(result.dialogue.answer, SERVICE_ERROR_TEXT);
    assert.match(result.dialogue.question, /\[REDACTED\]/);
    assert.equal(JSON.stringify(logs).includes(INITIAL_CONFIG.apiKey), false);
  }
});

test('三个排队保存串行执行，后续留空 Key 保留最近成功配置且不丢失前序设置', async (t) => {
  const { app, directory, modelConfigPath } = await createIsolatedApp(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = app.modelConfigStore.save({ apiKey: 'replacement-placeholder-key', model: 'replacement-model' }, {
    validate: async () => { await gate; return { model: 'replacement-model', latencyMs: 1 }; },
  });
  const second = app.modelConfigStore.save({ apiKey: '', answerStyle: '请用一句自然口语回答。' });
  const third = app.modelConfigStore.save({ apiKey: '', serviceErrorText: '网络暂时不顺畅，请稍后再试。' });
  release();
  const results = await Promise.all([first, second, third]);
  assert.equal(results[2].answerStyle, '请用一句自然口语回答。');
  assert.equal(results[2].serviceErrorText, '网络暂时不顺畅，请稍后再试。');
  assert.equal(results[2].hasApiKey, true);
  assert.equal(results[2].apiKey, undefined);
  const diskConfig = JSON.parse(await readFile(modelConfigPath, 'utf8'));
  assert.deepEqual(diskConfig, app.modelConfigStore.config);
  assert.equal(diskConfig.apiKey, 'replacement-placeholder-key');
  assert.equal(diskConfig.model, 'replacement-model');
  assert.equal((await stat(modelConfigPath)).mode & 0o777, 0o600);
  assert.equal((await readdir(directory)).some((name) => name.endsWith('.tmp')), false);
});

test('多个管理页同时提交模型设置不再报 500，最终配置与落盘一致', async (t) => {
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const { app, modelConfigPath, adminInject } = await createIsolatedApp(t, async () => {
    entered();
    await gate;
    return successfulResponse();
  });
  const save = (payload) => adminInject({ method: 'PUT', url: '/api/model-config', payload });
  const first = save({ answerStyle: '第一份设置。', testConnection: true });
  await started;
  const second = save({ answerStyle: '第二份设置。', apiKey: '' });
  const third = save({ serviceErrorText: '请稍后再试。', apiKey: '' });
  await new Promise(setImmediate);
  release();
  const responses = await Promise.all([first, second, third]);
  assert.deepEqual(responses.map((response) => response.statusCode), [200, 200, 200]);
  assert.equal(app.modelConfigStore.config.answerStyle, '第二份设置。');
  assert.equal(app.modelConfigStore.config.serviceErrorText, '请稍后再试。');
  assert.equal(app.modelConfigStore.config.apiKey, INITIAL_CONFIG.apiKey);
  assert.deepEqual(JSON.parse(await readFile(modelConfigPath, 'utf8')), app.modelConfigStore.config);
});

test('候选配置测试失败不会毒化保存队列，也不会覆盖旧 Key', async (t) => {
  const { app, modelConfigPath } = await createIsolatedApp(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = app.modelConfigStore.save({ apiKey: 'rejected-placeholder-key' }, {
    validate: async () => {
      await gate;
      const error = new Error('模拟上游拒绝');
      error.code = 'MODEL_UPSTREAM_ERROR';
      throw error;
    },
  });
  const second = app.modelConfigStore.save({ apiKey: '', answerStyle: '失败后仍可保存。' });
  const resultsPromise = Promise.allSettled([first, second]);
  release();
  const [rejected, recovered] = await resultsPromise;
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reason.code, 'MODEL_UPSTREAM_ERROR');
  assert.equal(recovered.status, 'fulfilled');
  assert.equal(app.modelConfigStore.config.answerStyle, '失败后仍可保存。');
  assert.equal(app.modelConfigStore.config.apiKey, INITIAL_CONFIG.apiKey);
  assert.deepEqual(JSON.parse(await readFile(modelConfigPath, 'utf8')), app.modelConfigStore.config);
  const cleared = app.modelConfigStore.save({ clearApiKey: true });
  const afterClear = app.modelConfigStore.save({ apiKey: '', noAnswerText: '请咨询工作人员。' });
  await Promise.all([cleared, afterClear]);
  assert.equal(app.modelConfigStore.config.apiKey, '');
  assert.equal(app.modelConfigStore.isConfigured(), false);
});

test('模型内容分段可以拼成结构化答案，但独立 reasoning_content 不进入播报或日志', async (t) => {
  const reasoning = '不应该进入最终答案的内部推理。';
  const { app, adminInject } = await createIsolatedApp(t, async () => new Response(JSON.stringify({
    model: '  resolved-model  ',
    choices: [{ finish_reason: 'stop', message: {
      reasoning_content: reasoning,
      content: [
        { type: 'text', text: '{"status":"answered",' },
        '"answer":"门票',
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
        { type: 'text', text: '免费。"}' },
      ],
    } }],
  })));
  const response = await app.inject({ method: 'POST', url: '/answer', payload: { question: '门票收费吗？' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().answer, '门票免费。');
  assert.equal(response.json().speechText, '门票免费。');
  assert.equal(response.json().model, 'resolved-model');
  const logs = (await adminInject({ url: `/api/ops-logs?search=${response.json().turnId}` })).json();
  assert.equal(JSON.stringify(logs).includes(reasoning), false);
  assert.equal(logs.entries.find((entry) => entry.action === 'question.answer').dialogue.answer, '门票免费。');
});

test('没有最终文本的消息统一报空响应，包括空分段、仅图片和仅工具调用', async (t) => {
  let message;
  const { app } = await createIsolatedApp(t, async () => new Response(JSON.stringify({
    choices: [{ message, finish_reason: 'stop' }],
  })));
  for (message of [
    { content: null },
    { content: [] },
    { content: ['  ', { type: 'text', text: '\n' }] },
    { content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] },
    { content: null, tool_calls: [{ id: 'call_test', type: 'function', function: { name: 'search', arguments: '{}' } }] },
  ]) {
    const response = await app.inject({ method: 'POST', url: '/answer', payload: { question: '门票收费吗？' } });
    assert.equal(response.statusCode, 502);
    assert.equal(response.json().error, 'MODEL_EMPTY_RESPONSE');
    assert.equal(response.json().speechText, SERVICE_ERROR_TEXT);
  }
});

test('截断和内容过滤状态优先于看似完整的答案，日志保留准确结束原因', async (t) => {
  let finishReason;
  const { app, adminInject } = await createIsolatedApp(t, async () => new Response(JSON.stringify({
    choices: [{ message: { content: '{"status":"answered","answer":"门票免费。"}' }, finish_reason: finishReason }],
  })));
  for (const [reason, expectedError] of [
    ['length', 'MODEL_TRUNCATED_RESPONSE'],
    ['content_filter', 'MODEL_RESPONSE_REJECTED'],
  ]) {
    finishReason = reason;
    const response = await app.inject({ method: 'POST', url: '/answer', payload: { question: '门票收费吗？' } });
    const body = response.json();
    assert.equal(response.statusCode, 502);
    assert.equal(body.error, expectedError);
    assert.equal(body.speechText, SERVICE_ERROR_TEXT);
    const logs = (await adminInject({ url: `/api/ops-logs?search=${body.turnId}` })).json();
    const result = logs.entries.find((entry) => entry.action === 'question.answer');
    assert.equal(result.details.finishReason, reason);
    assert.equal(result.details.failureStage, 'response');
    assert.equal(result.details.errorCode, expectedError);
    assert.equal(result.outcome, 'failure');
  }
});

test('64 KiB 回答限制按 UTF-8 字节计算，边界保留全文、超限自然兜底', async (t) => {
  const atLimit = `${'答'.repeat(21_845)}A`;
  assert.equal(Buffer.byteLength(atLimit), 64 * 1024);
  let content = atLimit;
  const { app, adminInject } = await createIsolatedApp(t, async () => successfulResponse(content));
  const valid = await app.inject({ method: 'POST', url: '/answer', payload: { question: '字节边界测试。' } });
  assert.equal(valid.statusCode, 200);
  assert.equal(valid.json().answer, atLimit);
  const logs = (await adminInject({ url: `/api/ops-logs?search=${valid.json().turnId}` })).json();
  assert.equal(logs.entries.find((entry) => entry.action === 'question.answer').dialogue.answer, atLimit);
  content = `${atLimit}B`;
  const invalid = await app.inject({ method: 'POST', url: '/answer', payload: { question: '超出一个字节。' } });
  assert.equal(invalid.statusCode, 502);
  assert.equal(invalid.json().error, 'MODEL_INVALID_RESPONSE');
  assert.equal(invalid.json().speechText, SERVICE_ERROR_TEXT);
});

test('每轮日志关联服务端 requestId 与客户端 turnId，完整正文保留且匿名不可读取', async (t) => {
  const answer = '门票免费。\n请提前到场。';
  const question = '门票收费吗？\n需要提前到场吗？';
  const { app, adminInject } = await createIsolatedApp(t, async () => successfulResponse(JSON.stringify({ status: 'answered', answer })));
  for (const supplied of ['client-turn-12345678', 'invalid_id']) {
    const response = await app.inject({
      method: 'POST', url: '/answer', headers: { 'x-conversation-id': supplied }, payload: { question },
    });
    const body = response.json();
    assert.equal(response.statusCode, 200);
    if (supplied.includes('_')) assert.notEqual(body.turnId, supplied);
    else assert.equal(body.turnId, supplied);
    assert.match(body.turnId, /^[a-zA-Z0-9-]{8,80}$/);
    assert.equal(response.headers['x-conversation-id'], body.turnId);
    assert.equal(response.headers['x-request-id'], body.requestId);
    const logs = (await adminInject({ url: `/api/ops-logs?search=${body.turnId}` })).json();
    assert.equal(logs.entries.length, 2);
    const received = logs.entries.find((entry) => entry.action === 'question.received');
    const result = logs.entries.find((entry) => entry.action === 'question.answer');
    for (const entry of [received, result]) {
      assert.equal(entry.request.id, body.requestId);
      assert.equal(entry.details.turnId, body.turnId);
      assert.equal(entry.dialogue.question, question);
    }
    assert.equal(result.dialogue.answer, answer);
    assert.equal(result.details.answerStatus, 'answered');
    assert.ok(Number.isFinite(result.request.durationMs));
  }
  for (const url of ['/api/ops-logs', '/api/ops-logs/download']) {
    const response = await app.inject({ url });
    assert.equal(response.statusCode, 401);
    assert.equal(response.body.includes(question), false);
    assert.equal(response.body.includes(answer), false);
  }
});

test('问答进行中更换模型不会被旧请求覆盖连接状态，日志同时脱敏新旧 Key', async (t) => {
  const nextKey = 'rotated-placeholder-key';
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const { app, adminInject } = await createIsolatedApp(t, async (_url, request) => {
    const body = JSON.parse(request.body);
    if (body.model === INITIAL_CONFIG.model) {
      entered();
      await gate;
      return successfulResponse(JSON.stringify({ status: 'answered', answer: `模拟诊断文本 ${INITIAL_CONFIG.apiKey} ${nextKey}` }));
    }
    return new Response(JSON.stringify({ model: 'new-model-resolved', choices: [{ message: { content: '连接正常。' } }] }));
  });
  const pending = app.inject({ method: 'POST', url: '/answer', payload: { question: `门票收费吗？${INITIAL_CONFIG.apiKey}` } });
  await started;
  try {
    const saved = await adminInject({ method: 'PUT', url: '/api/model-config', payload: { model: 'new-model', apiKey: nextKey } });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().connection.model, 'new-model-resolved');
  } finally {
    release();
    await pending;
  }
  const response = await pending;
  assert.equal(response.statusCode, 200);
  const config = (await adminInject({ url: '/api/model-config' })).json();
  assert.equal(config.model, 'new-model');
  assert.equal(config.connection.status, 'available');
  assert.equal(config.connection.model, 'new-model-resolved');
  const logs = (await adminInject({ url: `/api/ops-logs?search=${response.json().turnId}` })).json();
  for (const secret of [INITIAL_CONFIG.apiKey, nextKey]) assert.equal(JSON.stringify(logs).includes(secret), false);
  const result = logs.entries.find((entry) => entry.action === 'question.answer');
  assert.match(result.dialogue.answer, /\[REDACTED\].*\[REDACTED\]/);
});

test('落盘失败不激活候选设置，修复隔离目录后后续保存仍可成功', async (t) => {
  const { app, modelConfigPath } = await createIsolatedApp(t);
  const original = app.modelConfigStore.config;
  const backup = `${modelConfigPath}.test-backup`;
  await rename(modelConfigPath, backup);
  await mkdir(modelConfigPath);
  try {
    await assert.rejects(app.modelConfigStore.save({ answerStyle: '不应激活的候选设置。' }),
      (error) => ['EISDIR', 'ENOTDIR', 'EEXIST', 'EPERM'].includes(error.code));
    assert.equal(app.modelConfigStore.config, original);
    assert.deepEqual(JSON.parse(await readFile(backup, 'utf8')), INITIAL_CONFIG);
  } finally {
    await rmdir(modelConfigPath);
    await rename(backup, modelConfigPath);
  }
  await app.modelConfigStore.save({ answerStyle: '恢复后保存成功。' });
  assert.equal(app.modelConfigStore.config.answerStyle, '恢复后保存成功。');
  assert.deepEqual(JSON.parse(await readFile(modelConfigPath, 'utf8')), app.modelConfigStore.config);
});

test('REVIEW-MODEL-001：材料不足、条件、引用与部分未知说明保留有效业务回答和日志', async (t) => {
  const answers = [
    '资料不足时，请联系工作人员补充材料，补齐后即可报名。',
    '如果信息不足，工作人员会在两个工作日内联系您补齐材料。',
    '工作人员会在资料不足时主动联系您。',
    '报名表没有提供个人直接报名入口，请由所在单位汇总提交。',
    '我不能确认录取名单，但培训日期是9月13日至15日。',
    '资料中没有交通报销额度，往返交通由所在单位承担。',
    '工作人员说“我没有找到相关信息”时，请向资料负责人进一步核对。',
    '我没有找到相关信息，但已确认培训日期为9月13日至15日。',
    '我无法回答这个问题时，会建议您联系工作人员。',
  ];
  let content;
  const { app, adminInject } = await createIsolatedApp(t, async () => successfulResponse(content));
  await app.knowledgeStore.importFiles([
    { filename: '报名说明.txt', buffer: Buffer.from(answers.join('\n')) },
  ], 'append');
  for (const answer of answers) {
    for (content of [JSON.stringify({ status: 'answered', answer }), answer]) {
      const response = await app.inject({
        method: 'POST', url: '/answer', payload: { question: '报名资料不足怎么办？' },
      });
      const body = response.json();
      assert.equal(response.statusCode, 200);
      assert.equal(body.answerStatus, 'answered', answer);
      assert.equal(body.speechText, answer);
      const logs = (await adminInject({ url: `/api/ops-logs?search=${body.turnId}` })).json();
      const result = logs.entries.find((entry) => entry.action === 'question.answer');
      assert.equal(result.details.answerStatus, 'answered');
      assert.equal(result.dialogue.answer, answer);
    }
  }
});

test('明确自述无法回答使用兜底，短话术须匹配边界，结构化状态仍优先', async (t) => {
  const fallback = '资料不足';
  const config = prepareModelConfig({ noAnswerText: fallback });
  for (const answer of [
    '对不起，我没有找到相关信息，无法回答这个问题。',
    '抱歉。我暂时没有查到相关资料，请向工作人员确认。',
    '我目前无法准确回答这个问题。',
    '暂时无法回答这个问题。',
    '目前没有找到相关信息。',
    '无法回答您的问题。',
    '我不知道该问题的答案。',
    '目前没有足够的资料回答这个问题。',
    '资料不足',
  ]) {
    assert.equal(parseModelAnswer(answer, config).answerStatus, 'no_answer', answer);
    assert.equal(parseModelAnswer(answer, config).answer, fallback);
    const structured = parseModelAnswer(JSON.stringify({ status: 'answered', answer }), config);
    assert.equal(structured.answerStatus, 'answered');
    assert.equal(structured.answer, answer);
  }
  for (const businessAnswer of [
    '资料不足时，请联系工作人员补充材料。',
    '资料不足，请在周五前补齐报名材料。',
    '资料不足。请补交报名表和单位推荐表。',
  ]) {
    assert.equal(parseModelAnswer(businessAnswer, config).answer, businessAnswer);
    assert.equal(parseModelAnswer(businessAnswer, config).answerStatus, 'answered');
  }

  const { app, adminInject } = await createIsolatedApp(t, async () => successfulResponse('抱歉，我没有找到相关信息，请向工作人员确认。'));
  await app.modelConfigStore.save({ noAnswerText: '这个问题请工作人员帮您进一步确认。' });
  const response = await app.inject({ method: 'POST', url: '/answer', payload: { question: '有没有下一年度的安排？' } });
  const body = response.json();
  assert.equal(response.statusCode, 200);
  assert.equal(body.answered, false);
  assert.equal(body.answerStatus, 'no_answer');
  assert.equal(body.speechText, '这个问题请工作人员帮您进一步确认。');
  const logs = (await adminInject({ url: `/api/ops-logs?search=${body.turnId}` })).json();
  const result = logs.entries.find((entry) => entry.action === 'question.answer');
  assert.equal(result.details.answerStatus, 'no_answer');
  assert.equal(result.details.answerStatusSource, 'inferred');
  assert.equal(result.dialogue.answer, body.speechText);
});

test('REVIEW-MODEL-002：仅明确 text 或兼容字符串分段进入最终答案及日志', async (t) => {
  const reasoning = '只供内部分析，不能当作面向访客的答案。';
  let content;
  const { app, adminInject } = await createIsolatedApp(t, async () => successfulResponse(content));
  for (const type of ['reasoning', 'analysis', 'thinking', 'image_url', 'unknown', undefined]) {
    for (const includeText of [true, false]) {
      content = [{ ...(type ? { type } : {}), text: reasoning }];
      if (includeText) content.push('门票', { type: 'text', text: '免费。' });
      const response = await app.inject({ method: 'POST', url: '/answer', payload: { question: '门票收费吗？' } });
      const body = response.json();
      assert.equal(response.statusCode, includeText ? 200 : 502);
      assert.equal(body.speechText, includeText ? '门票免费。' : SERVICE_ERROR_TEXT);
      if (!includeText) assert.equal(body.error, 'MODEL_EMPTY_RESPONSE');
      const logs = (await adminInject({ url: `/api/ops-logs?search=${body.turnId}` })).json();
      assert.equal(JSON.stringify(logs).includes(reasoning), false);
      const result = logs.entries.find((entry) => entry.action === 'question.answer');
      assert.equal(result.dialogue.answer, body.speechText);
      assert.equal(result.outcome, includeText ? 'success' : 'failure');
    }
  }
});

test('REVIEW-MODEL-003：非最终结束原因及实际工具调用不可播报，日志保留拒绝原因', async (t) => {
  const tools = [{ id: 'call_test', type: 'function', function: { name: 'search', arguments: '{}' } }];
  const functionCall = { name: 'search', arguments: '{}' };
  let choice;
  const { app, adminInject } = await createIsolatedApp(t, async () => new Response(JSON.stringify({ choices: [choice] })));
  const cases = [
    { finish_reason: 'tool_calls', tool_calls: tools },
    { finish_reason: 'function_call', function_call: functionCall },
    { finish_reason: 'stop', tool_calls: tools },
    { finish_reason: 'stop', function_call: functionCall },
    { finish_reason: 'tool_calls', tool_calls: [] },
    { finish_reason: 'provider_handoff' },
    { finish_reason: null, tool_calls: tools },
  ];
  for (const { finish_reason, ...metadata } of cases) {
    for (const content of ['我需要先查询活动信息。', '{"status":"answered","answer":"门票免费。"}']) {
      choice = { finish_reason, message: { content, ...metadata } };
      const response = await app.inject({ method: 'POST', url: '/answer', payload: { question: '门票收费吗？' } });
      const body = response.json();
      assert.equal(response.statusCode, 502);
      assert.equal(body.error, 'MODEL_RESPONSE_REJECTED');
      assert.equal(body.answered, false);
      assert.equal(body.speechText, SERVICE_ERROR_TEXT);
      const logs = (await adminInject({ url: `/api/ops-logs?search=${body.turnId}` })).json();
      const result = logs.entries.find((entry) => entry.action === 'question.answer');
      assert.equal(result.details.errorCode, 'MODEL_RESPONSE_REJECTED');
      assert.equal(result.details.finishReason, finish_reason);
      assert.equal(result.details.failureStage, 'response');
      assert.equal(result.outcome, 'failure');
      assert.equal(result.dialogue.answer, SERVICE_ERROR_TEXT);
    }
  }
});

test('最终状态缺省、null 或 stop 兼容空工具元数据，仍返回标准可播报答案', async (t) => {
  let finishReason;
  const { app, adminInject } = await createIsolatedApp(t, async () => new Response(JSON.stringify({ choices: [{
    ...(finishReason !== undefined ? { finish_reason: finishReason } : {}),
    message: { content: '{"status":"answered","answer":"门票免费。"}', tool_calls: [], function_call: null },
  }] })));
  for (finishReason of [undefined, null, 'stop']) {
    const response = await app.inject({ method: 'POST', url: '/answer', payload: { question: '门票收费吗？' } });
    const body = response.json();
    assert.equal(response.statusCode, 200);
    assert.equal(body.answered, true);
    assert.equal(body.speechText, '门票免费。');
    const logs = (await adminInject({ url: `/api/ops-logs?search=${body.turnId}` })).json();
    const result = logs.entries.find((entry) => entry.action === 'question.answer');
    assert.equal(result.details.finishReason, finishReason ?? null);
    assert.equal(result.outcome, 'success');
    assert.equal(result.dialogue.answer, '门票免费。');
  }
});
