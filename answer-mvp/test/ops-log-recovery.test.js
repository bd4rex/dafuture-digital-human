import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { OpsLogStore } from '../ops-log-store.js';
import { buildApp } from '../server.js';

const run = promisify(execFile);
const entry = (id, answer = '完整回答。') => ({
  category: 'question', action: 'client.request-failed', outcome: 'failure',
  details: { eventId: id }, dialogue: { question: '问题包含中文与🙂。', answer },
});

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ops-log-recovery-'));
  const cleanups = [];
  t.after(async () => {
    try { for (const cleanup of cleanups) await cleanup(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  const logPath = path.join(directory, 'ops.jsonl');
  const store = new OpsLogStore({ logPath, ...options });
  return { directory, logPath, store, beforeCleanup: (cleanup) => cleanups.push(cleanup) };
}

async function apiFixture(t) {
  const f = await fixture(t);
  const app = await buildApp({
    contentPath: path.join(f.directory, 'content.json'),
    modelConfigPath: path.join(f.directory, 'model.json'),
    knowledgePath: path.join(f.directory, 'knowledge.json'),
    knowledgeFilesDirectory: path.join(f.directory, 'files'),
    liveControlPath: path.join(f.directory, 'live.json'),
    adminAuthPath: path.join(f.directory, 'auth.json'),
    opsLogPath: f.logPath, bundledKnowledgeEnabled: false,
    adminPassword: 'isolated-recovery-password', adminApiKey: '', logger: false,
    llmFetch() { throw new Error('Recovery tests must not call a model'); },
  });
  f.beforeCleanup(() => app.close());
  const event = {
    eventId: 'recovery-event-0001', clientId: 'recovery-client-0001', turnId: 'recovery-turn-0001',
    kind: 'dialogue', phase: 'request-failed', errorCode: 'CLIENT_CONNECTION_FAILED',
    question: '原始问题包含中文与🙂。', answer: '临时测试回答。'.repeat(250),
  };
  const post = () => app.inject({ method: 'POST', url: '/api/client-events', payload: event });
  return { ...f, app, event, post };
}

test('日志恢复：启动删除未完成尾行，按字节保护已有中文、换行和 emoji 完整记录', async (t) => {
  const f = await fixture(t);
  const complete = `${JSON.stringify({ id: 'complete', dialogue: { question: '中文🙂', answer: '第一行\n第二行。' } })}\n`;
  const partial = Buffer.from('{"id":"unfinished","answer":"尾部🙂');
  // Stop in the middle of the final four-byte code point, not at a JS string offset.
  await writeFile(f.logPath, Buffer.concat([Buffer.from(complete), partial.subarray(0, partial.length - 2)]), { mode: 0o644 });
  await f.store.start();
  assert.deepEqual(await readFile(f.logPath), Buffer.from(complete));
  assert.equal((await stat(f.logPath)).mode & 0o777, 0o600);
  await f.store.record(entry('next-event-0001'));
  const result = await f.store.query({});
  assert.equal(result.invalidLines, 0);
  assert.equal(result.storedEntries, 2);
  assert.equal(result.entries.find(item => item.id === 'complete').dialogue.answer, '第一行\n第二行。');
});

test('日志恢复：完整 JSON 只缺末尾换行时保留原记录，不能作为残尾删除', async (t) => {
  const f = await fixture(t);
  const complete = JSON.stringify({ id: 'complete-without-newline', dialogue: { answer: '中文🙂与完整正文。' } });
  await writeFile(f.logPath, complete);
  await f.store.start();
  assert.equal(await readFile(f.logPath, 'utf8'), `${complete}\n`);
  await f.store.record(entry('following-event-0001'));
  const result = await f.store.query({});
  assert.equal(result.storedEntries, 2);
  assert.equal(result.invalidLines, 0);
  assert.equal(result.entries.find(item => item.id === 'complete-without-newline').dialogue.answer, '中文🙂与完整正文。');
});

test('日志恢复：运行期间留下的半行在下一次串行追加前修复，已完成的旧行逐字保留', async (t) => {
  const f = await fixture(t);
  await f.store.start();
  await f.store.record(entry('old-event-0001', '已有完整正文🙂。'));
  const original = await readFile(f.logPath);
  await appendFile(f.logPath, '{"id":"interrupted');
  await Promise.all([
    f.store.record(entry('new-event-0001', '第一条新记录。')),
    f.store.record(entry('new-event-0002', '第二条新记录。')),
  ]);
  const bytes = await readFile(f.logPath);
  assert.deepEqual(bytes.subarray(0, original.length), original);
  const result = await f.store.query({});
  assert.equal(result.invalidLines, 0);
  assert.equal(result.storedEntries, 3);
  assert.deepEqual(result.entries.map(item => item.details.eventId), ['new-event-0002', 'new-event-0001', 'old-event-0001']);
});

test('日志恢复：修复发生在轮转前，完整记录、归档数量与文件权限保持正确', async (t) => {
  const f = await fixture(t, { maxFileBytes: 32 * 1024, maxFiles: 3 });
  await f.store.start();
  await f.store.record(entry('rotation-old-0001', '旧'.repeat(8000)));
  const original = await readFile(f.logPath);
  await appendFile(f.logPath, '{"unfinished":"残尾');
  await f.store.record(entry('rotation-new-0001', '新'.repeat(8000)));
  assert.deepEqual(await readFile(`${f.logPath}.1`), original);
  for (const filePath of [f.logPath, `${f.logPath}.1`]) {
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  }
  const result = await f.store.query({});
  assert.equal(result.fileCount, 2);
  assert.equal(result.storedEntries, 2);
  assert.equal(result.invalidLines, 0);
});

test('日志恢复：真实 OS 部分追加失败回退旧边界，同一事件 500 后重试 200 可查询且只确认一次', {
  skip: process.platform === 'win32', timeout: 10_000,
}, async (t) => {
  const f = await apiFixture(t);
  const original = await readFile(f.logPath);
  const worker = path.join(f.directory, 'limited-writer.mjs');
  await writeFile(worker, `
import { stat } from 'node:fs/promises';
import { OpsLogStore } from ${JSON.stringify(new URL('../ops-log-store.js', import.meta.url).href)};
process.on('SIGXFSZ', () => {});
const store = new OpsLogStore({ logPath: process.argv[2] });
await store.start();
try {
  await store.record(JSON.parse(process.argv[3]));
  console.log(JSON.stringify({ unexpectedSuccess: true }));
} catch (error) {
  console.log(JSON.stringify({ errorCode: error.code, size: (await stat(process.argv[2])).size, ready: store.publicStatus().ready }));
}
`);
  const record = f.app.opsLogStore.record.bind(f.app.opsLogStore);
  let failure;
  f.app.opsLogStore.record = async rawEntry => {
    if (!rawEntry.action.startsWith('client.')) return record(rawEntry);
    // The file-size limit belongs only to this child shell/Node process.
    // No caller shell limit, repository file, real log or provider is touched.
    const child = await run('/bin/sh', ['-c', 'ulimit -f 4\nexec "$1" "$2" "$3" "$4"',
      'isolated-log-limit', process.execPath, worker, f.logPath, JSON.stringify(rawEntry)], { timeout: 5_000 });
    failure = JSON.parse(child.stdout.trim());
    const error = new Error('Isolated OS partial write failed'); error.code = failure.errorCode;
    throw error;
  };
  try {
    assert.equal((await f.post()).statusCode, 500);
    assert.equal(failure.errorCode, 'EFBIG');
    assert.equal(failure.ready, false);
    assert.deepEqual(await readFile(f.logPath), original, 'failed append rolls back only its own bytes');
  } finally { f.app.opsLogStore.record = record; }
  const retried = await f.post();
  assert.equal(retried.statusCode, 200);
  assert.equal(retried.json().duplicate, undefined);
  assert.equal((await f.post()).json().duplicate, true);
  const result = await f.app.opsLogStore.query({});
  const matches = result.entries.filter(item => item.details.eventId === f.event.eventId);
  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0].dialogue, { question: f.event.question, answer: f.event.answer });
  assert.equal(result.invalidLines, 0);
});

test('日志恢复：恢复边界失败继续报错且保持 degraded，不提前确认事件，解除故障后可重试', async (t) => {
  const f = await apiFixture(t);
  const original = await readFile(f.logPath);
  await appendFile(f.logPath, '{"incomplete');
  const ensureCurrentFile = f.app.opsLogStore.ensureCurrentFile.bind(f.app.opsLogStore);
  f.app.opsLogStore.ensureCurrentFile = async () => { const error = new Error('Isolated repair denied'); error.code = 'EACCES'; throw error; };
  try {
    assert.equal((await f.post()).statusCode, 500);
    assert.equal((await f.post()).statusCode, 500);
    assert.equal(f.app.opsLogStore.publicStatus().ready, false);
  } finally { f.app.opsLogStore.ensureCurrentFile = ensureCurrentFile; }
  const retried = await f.post();
  assert.equal(retried.statusCode, 200);
  assert.equal(retried.json().duplicate, undefined);
  const bytes = await readFile(f.logPath);
  assert.deepEqual(bytes.subarray(0, original.length), original);
  const result = await f.app.opsLogStore.query({});
  assert.equal(result.invalidLines, 0);
  assert.equal(result.status.ready, true);
  assert.equal(result.entries.filter(item => item.details.eventId === f.event.eventId).length, 1);
});

test('日志恢复：轮转后的真实部分写入失败只回滚新 current，不截断旧归档', {
  skip: process.platform === 'win32', timeout: 10_000,
}, async (t) => {
  const f = await fixture(t, { maxFileBytes: 32 * 1024, maxFiles: 3 });
  await f.store.start();
  await f.store.record(entry('archived-event-0001', '旧'.repeat(10_000)));
  const archivedBytes = await readFile(f.logPath);
  const worker = path.join(f.directory, 'limited-rotating-writer.mjs');
  await writeFile(worker, `
import { OpsLogStore } from ${JSON.stringify(new URL('../ops-log-store.js', import.meta.url).href)};
process.on('SIGXFSZ', () => {});
const store = new OpsLogStore({ logPath: process.argv[2], maxFileBytes: 32 * 1024, maxFiles: 3 });
await store.start();
try {
  await store.record(JSON.parse(process.argv[3]));
  console.log(JSON.stringify({ unexpectedSuccess: true }));
} catch (error) { console.log(JSON.stringify({ errorCode: error.code, ready: store.publicStatus().ready })); }
`);
  const nextEntry = entry('rotation-retry-0001', '新'.repeat(4000));
  const child = await run('/bin/sh', ['-c', 'ulimit -f 4\nexec "$1" "$2" "$3" "$4"',
    'isolated-rotation-limit', process.execPath, worker, f.logPath, JSON.stringify(nextEntry)], { timeout: 5_000 });
  const result = JSON.parse(child.stdout.trim());
  assert.equal(result.errorCode, 'EFBIG');
  assert.equal(result.ready, false);
  assert.equal((await stat(f.logPath)).size, 0);
  assert.deepEqual(await readFile(`${f.logPath}.1`), archivedBytes);
  await f.store.record(nextEntry);
  const recovered = await f.store.query({});
  assert.equal(recovered.storedEntries, 2);
  assert.equal(recovered.invalidLines, 0);
  assert.deepEqual(await readFile(`${f.logPath}.1`), archivedBytes);
});
