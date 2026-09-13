import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildApp } from '../server.js';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const turn = (overrides = {}) => ({
  eventId: 'review-event-0001', clientId: 'review-client-0001',
  turnId: 'review-turn-0001', kind: 'dialogue', phase: 'speech-failed',
  errorCode: 'SPEECH_FAILED', question: '测试问题', answer: '测试回答', ...overrides,
});

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'digital-human-event-test-'));
  const app = await buildApp({
    contentPath: path.join(directory, 'content.json'),
    modelConfigPath: path.join(directory, 'model.json'),
    adminAuthPath: path.join(directory, 'auth.json'),
    knowledgePath: path.join(directory, 'knowledge.json'),
    knowledgeFilesDirectory: path.join(directory, 'files'),
    liveControlPath: path.join(directory, 'live.json'),
    opsLogPath: path.join(directory, 'ops.jsonl'),
    adminPassword: '', adminApiKey: 'placeholder-event-test-token',
    bundledKnowledgeEnabled: false, logger: false,
    llmFetch: () => { throw new Error('This test must not call a model'); },
  });
  await app.ready();
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const record = app.opsLogStore.record.bind(app.opsLogStore);
  const writes = [];
  const gate = deferred();
  const entered = deferred();
  app.opsLogStore.record = async (entry) => {
    if (entry.action.startsWith('client.')) { writes.push(entry); entered.resolve(); await gate.promise; }
    return record(entry);
  };
  const post = (payload) => app.inject({ method: 'POST', url: '/api/client-events', payload });
  const entries = async () => (await app.opsLogStore.query({ limit: 1000 })).entries
    .filter(entry => entry.action.startsWith('client.'));
  const reports = async () => (await app.inject({ method: 'GET', url: '/api/live-control',
    headers: { authorization: 'Bearer placeholder-event-test-token' } })).json().playbackReports;
  // Start lazy inject calls and wait until handlers have reached the I/O gate.
  const dispatch = async (payloads) => {
    const pending = payloads.map(payload => post(payload).then(response => response));
    await entered.promise;
    await new Promise(setImmediate);
    return pending;
  };
  return { app, writes, gate, post, entries, reports, dispatch, record };
}

test('执行日志：同一 eventId 的并发重试等待一次落盘，顺序重试也不重复', async (t) => {
  const app = await fixture(t);
  const requests = await app.dispatch([turn(), turn(), turn()]);
  // Release before assertions so a failing pre-fix regression cannot hang teardown.
  app.gate.resolve();
  const responses = await Promise.all(requests);
  assert.equal(app.writes.length, 1);
  assert.ok(responses.every(response => response.statusCode === 200));
  assert.equal(responses.filter(response => response.json().duplicate).length, 2);
  assert.equal((await app.entries()).length, 1);
  assert.deepEqual((await app.entries())[0].dialogue, { question: '测试问题', answer: '测试回答' });
  assert.equal((await app.post(turn())).json().duplicate, true);
  assert.equal((await app.entries()).length, 1);
});

test('执行日志：并发落盘失败均返回失败，解除故障后允许同一事件重试', async (t) => {
  const app = await fixture(t);
  const requests = await app.dispatch([turn(), turn()]);
  app.gate.reject(new Error('isolated write failure'));
  const responses = await Promise.all(requests);
  assert.ok(responses.every(response => response.statusCode === 500));
  assert.equal(app.writes.length, 1, 'retries share the in-flight write even when it fails');
  assert.equal((await app.entries()).length, 0);
  app.app.opsLogStore.record = app.record;
  const retried = await app.post(turn());
  assert.equal(retried.statusCode, 200);
  assert.equal(retried.json().duplicate, undefined);
  assert.equal((await app.entries()).length, 1);
});

test('执行日志：不同事件并发处理，不能被同一轮编号误去重', async (t) => {
  const app = await fixture(t);
  const requests = await app.dispatch([turn(), turn({ eventId: 'review-event-0002' })]);
  app.gate.resolve();
  const responses = await Promise.all(requests);
  assert.equal(app.writes.length, 2);
  assert.ok(responses.every(response => response.statusCode === 200 && !response.json().duplicate));
  assert.equal((await app.entries()).length, 2);
});

test('主持反馈：并发重试只落盘一次，落盘前不提前声称播报已完成', async (t) => {
  const app = await fixture(t);
  const command = app.app.liveControlStore.present(app.app.liveControlStore.scripts[0].id);
  const payload = { eventId: 'review-event-host-0001', clientId: 'review-client-0001',
    kind: 'hosting', phase: 'speech-completed',
    instanceId: app.app.liveControlStore.instanceId, commandSequence: command.sequence };
  const requests = await app.dispatch([payload, payload]);
  const before = await app.reports();
  app.gate.resolve();
  const responses = await Promise.all(requests);
  assert.equal(before.length, 0);
  assert.ok(responses.every(response => response.statusCode === 200));
  assert.equal(app.writes.length, 1);
  assert.equal((await app.entries()).length, 1);
  assert.equal((await app.reports())[0].phase, 'speech-completed');
});
