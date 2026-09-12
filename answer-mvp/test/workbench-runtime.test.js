import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8'))
  .replace(/void start\(\);\s*$/, '');
const flush = () => new Promise(setImmediate);

function fixture({ ignoreAbort = false, mode = 'hosting' } = {}) {
  const element = () => ({ textContent: '', value: '', hidden: false, disabled: false, dataset: {},
    listeners: {},
    classList: { add() {}, remove() {}, toggle() {} }, style: {},
    addEventListener(name, handler) { this.listeners[name] = handler; },
    click() { if (!this.disabled) this.listeners.click?.({ target: this }); },
    setAttribute() {}, querySelectorAll() { return []; },
    querySelector() { return element(); }, closest() { return element(); },
    append() {}, replaceChildren() {}, focus() {}, select() {}, scrollIntoView() {},
  });
  const calls = [];
  const timers = new Map();
  const redirects = [];
  const tabs = ['dialogue', 'hosting'].map((mode) => ({ ...element(), dataset: { workbenchMode: mode } }));
  let timerId = 0;
  const scheduleTimer = (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; };
  const context = vm.createContext({ console, Headers, FormData, Date, AbortController,
    setTimeout: scheduleTimer,
    clearTimeout: (id) => timers.delete(id), setInterval() {},
    document: { querySelector: element, querySelectorAll: (selector) => selector === '[data-workbench-mode]' ? tabs : [], addEventListener() {}, createElement: element },
    window: { addEventListener() {}, confirm: () => true, setTimeout: scheduleTimer, location: { replace: (url) => redirects.push(url) } },
    fetch: (url, options) => new Promise((resolve, reject) => {
      calls.push({ url, options,
        body: options.body ? JSON.parse(options.body) : undefined,
        respond: (payload, status = 200) => resolve({ ok: status < 400, status, text: async () => JSON.stringify(payload) }),
        respondPendingBody: () => {
          const pendingBody = new Promise((_resolveBody, rejectBody) => {
            options.signal.addEventListener('abort', () => rejectBody(options.signal.reason), { once: true });
          });
          resolve({ ok: true, status: 200, text: () => pendingBody });
        },
        reject,
      });
      if (!ignoreAbort) options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    }),
  });
  vm.runInContext(source + '\nglobalThis.api = {state,elements,broadcastSelectedHostScript,stopHostBroadcast,saveHostScripts,syncHostEditorToState,switchWorkbenchMode,loadLiveControl,applyLiveSnapshot,renderHostControl};', context);
  const api = context.api;
  const script = { id: 'opening', title: '开场', text: '已保存的主持词。' };
  const snapshot = (overrides = {}) => ({
    instanceId: 'demo-instance', mode, sequence: 1, commandSequence: mode === 'hosting' ? 1 : null,
    scripts: [{ ...script }], revision: 'revision-1', connectedClients: 1,
    lastCommand: mode === 'hosting' ? { title: script.title, issuedAt: '2026-09-12T00:00:00Z', sequence: 1 } : null,
    ...overrides,
  });
  Object.assign(api.state, { hostScripts: [{ ...script }], hostRevision: 'revision-1', selectedHostIndex: 0, liveControl: snapshot(), workbenchMode: mode });
  api.renderHostControl();
  const edit = (text) => {
    api.elements.hostScriptText.value = text;
    api.syncHostEditorToState({ target: api.elements.hostScriptText });
  };
  const expireRequests = () => {
    for (const [id, timer] of [...timers]) {
      if (timer.ms === 10_000) { timers.delete(id); timer.fn(); }
    }
  };
  const runTimers = (ms) => {
    for (const [id, timer] of [...timers]) {
      if (timer.ms <= ms) { timers.delete(id); timer.fn(); }
    }
  };
  return { ...api, calls, snapshot, edit, expireRequests, timers, runTimers, redirects, tabs };
}

test('管理页：播报回包延迟时可立即停止，晚到回包不恢复旧播报状态', async () => {
  const app = fixture({ ignoreAbort: true });
  const present = app.broadcastSelectedHostScript();
  await flush();
  assert.equal(app.state.liveBusy, true);
  assert.equal(app.elements.stopHostBroadcast.disabled, false);
  assert.deepEqual(app.calls[0].body, { scriptId: 'opening', expectedInstanceId: 'demo-instance', expectedSequence: 1 });
  const stop = app.stopHostBroadcast();
  assert.equal(app.calls[1].url, '/api/live-control/stop');
  assert.equal(app.calls[0].options.signal.aborted, true);
  app.calls[1].respond(app.snapshot({ sequence: 3, commandSequence: null, lastCommand: null }));
  await stop;
  const stoppedMessage = app.elements.hostControlMessage.textContent;
  app.calls[0].respond(app.snapshot({ sequence: 2, commandSequence: 2 }));
  await present;
  assert.equal(app.state.liveControl.sequence, 3);
  assert.equal(app.state.liveControl.lastCommand, null);
  assert.equal(app.elements.hostControlMessage.textContent, stoppedMessage);
  assert.equal(app.state.liveBusy, false);
});

test('管理页：从对话模式直接播报时，回包前也可停止', async () => {
  const app = fixture({ mode: 'dialogue', ignoreAbort: true });
  const present = app.broadcastSelectedHostScript();
  await flush();
  assert.equal(app.elements.stopHostBroadcast.disabled, false);
  const stop = app.stopHostBroadcast();
  app.calls[1].respond(app.snapshot({ mode: 'hosting', sequence: 3, commandSequence: null, lastCommand: null }));
  await stop;
  app.calls[0].respond(app.snapshot({ mode: 'hosting', sequence: 2, commandSequence: 2 }));
  await present;
  assert.equal(app.state.liveControl.sequence, 3);
  assert.equal(app.state.liveControl.lastCommand, null);
});

test('管理页：自动保存期间停止，保存晚到只更新稿件版本、不追加播报或覆盖停止', async () => {
  const app = fixture();
  app.edit('准备播报的新主持词。');
  const present = app.broadcastSelectedHostScript();
  assert.equal(app.calls[0].url, '/api/live-control');
  const stop = app.stopHostBroadcast();
  app.calls[1].respond(app.snapshot({ sequence: 2, commandSequence: null, lastCommand: null }));
  await stop;
  const message = app.elements.hostControlMessage.textContent;
  app.calls[0].respond(app.snapshot({ scripts: app.calls[0].body.scripts, revision: 'revision-2' }));
  await present;
  assert.equal(app.calls.length, 2);
  assert.equal(app.state.hostRevision, 'revision-2');
  assert.equal(app.state.hostScripts[0].text, '准备播报的新主持词。');
  assert.equal(app.state.liveControl.sequence, 2);
  assert.equal(app.state.liveControl.lastCommand, null);
  assert.equal(app.elements.hostControlMessage.textContent, message);
});

test('管理页：保存途中继续编辑不丢稿，后续保存使用已确认的新 revision', async () => {
  const app = fixture();
  app.edit('保存时的旧正文。');
  const first = app.saveHostScripts();
  app.edit('保存中继续输入的最新正文。');
  app.calls[0].respond(app.snapshot({ scripts: app.calls[0].body.scripts, revision: 'revision-2' }));
  assert.equal(await first, false, 'still has unsaved edits');
  assert.equal(app.state.hostScripts[0].text, '保存中继续输入的最新正文。');
  assert.equal(app.elements.hostScriptText.value, '保存中继续输入的最新正文。');
  assert.equal(app.state.hostDirty, true);
  assert.equal(app.state.hostRevision, 'revision-2');
  assert.match(app.elements.hostControlMessage.textContent, /新增编辑仍未保存/);
  const second = app.saveHostScripts();
  assert.equal(app.calls[1].body.revision, 'revision-2');
  assert.equal(app.calls[1].body.scripts[0].text, '保存中继续输入的最新正文。');
  app.calls[1].respond(app.snapshot({ scripts: app.calls[1].body.scripts, revision: 'revision-3' }));
  assert.equal(await second, true);
  assert.equal(app.state.hostDirty, false);
});

test('管理页：自动保存中产生新编辑时不播报旧稿、不声称最新版已发送', async () => {
  const app = fixture();
  app.edit('点击播报时的正文。');
  const present = app.broadcastSelectedHostScript();
  app.edit('保存中新增的正文。');
  app.calls[0].respond(app.snapshot({ scripts: app.calls[0].body.scripts, revision: 'revision-2' }));
  await present;
  assert.equal(app.calls.length, 1);
  assert.equal(app.state.hostDirty, true);
  assert.equal(app.state.hostScripts[0].text, '保存中新增的正文。');
  assert.equal(app.state.liveBusy, false);
  assert.match(app.elements.hostControlMessage.textContent, /再次保存后播报/);
});

test('管理页：播报响应期间的新编辑保留，并说明不属于本次播报', async () => {
  const app = fixture();
  const present = app.broadcastSelectedHostScript();
  await flush();
  app.edit('播报过程中新增的草稿。');
  app.calls[0].respond(app.snapshot({ sequence: 2, commandSequence: 2 }));
  await present;
  assert.equal(app.state.hostScripts[0].text, '播报过程中新增的草稿。');
  assert.equal(app.state.hostDirty, true);
  assert.match(app.elements.hostControlMessage.textContent, /不包含在本次播报/);
});

test('管理页：保存失败保留新增编辑并恢复保存与播报控件', async () => {
  const app = fixture();
  app.edit('需要保存的正文。');
  const save = app.saveHostScripts();
  app.edit('失败前继续输入的正文。');
  app.calls[0].respond({ message: '磁盘暂时不可写' }, 500);
  assert.equal(await save, false);
  assert.equal(app.state.hostScripts[0].text, '失败前继续输入的正文。');
  assert.equal(app.state.hostDirty, true);
  assert.equal(app.state.hostSaving, false);
  assert.equal(app.elements.saveHostScripts.disabled, false);
  assert.equal(app.elements.broadcastHostScript.disabled, false);
});

test('管理页：播报超时释放忙碌锁，保留独立停止能力', async () => {
  const app = fixture();
  const present = app.broadcastSelectedHostScript();
  await flush();
  app.expireRequests();
  await present;
  assert.equal(app.state.liveBusy, false);
  assert.equal(app.elements.stopHostBroadcast.disabled, false);
  assert.equal(app.elements.broadcastHostScript.disabled, false);
  assert.match(app.elements.hostControlMessage.textContent, /请求超时/);
});

test('管理页：停止超时不假报成功，可以再次停止并恢复', async () => {
  const app = fixture();
  const failed = app.stopHostBroadcast();
  app.expireRequests();
  await failed;
  assert.equal(app.state.liveBusy, false);
  assert.equal(app.state.liveStopping, false);
  assert.equal(app.elements.stopHostBroadcast.disabled, false);
  assert.match(app.elements.hostControlMessage.textContent, /停止尚未确认/);
  const retry = app.stopHostBroadcast();
  app.calls[1].respond(app.snapshot({ sequence: 2, commandSequence: null, lastCommand: null }));
  await retry;
  assert.match(app.elements.hostControlMessage.textContent, /已通知所有前台停止/);
  assert.equal(app.state.liveControl.lastCommand, null);
});

test('管理页：停止使先前的模式切换响应失效，不覆盖最新状态', async () => {
  const app = fixture({ ignoreAbort: true });
  const mode = app.switchWorkbenchMode('dialogue');
  assert.deepEqual(app.calls[0].body, { mode: 'dialogue', expectedInstanceId: 'demo-instance', expectedSequence: 1 });
  const stop = app.stopHostBroadcast();
  app.calls[1].respond(app.snapshot({ mode: 'dialogue', sequence: 3, commandSequence: null, lastCommand: null }));
  await stop;
  const message = app.elements.hostControlMessage.textContent;
  app.calls[0].respond(app.snapshot({ mode: 'dialogue', sequence: 2, commandSequence: null, lastCommand: null }));
  await mode;
  assert.equal(app.state.liveControl.sequence, 3);
  assert.equal(app.elements.hostControlMessage.textContent, message);
});

test('管理页：播报结果未确认时，即使缓存仍为对话模式也可以停止', async () => {
  const app = fixture({ mode: 'dialogue' });
  const present = app.broadcastSelectedHostScript();
  await flush();
  app.expireRequests();
  await present;
  assert.equal(app.state.liveBusy, false);
  assert.equal(app.state.liveUncertain, true);
  assert.equal(app.elements.stopHostBroadcast.disabled, false);
  const stop = app.stopHostBroadcast();
  assert.equal(app.calls[1].url, '/api/live-control/stop');
  app.calls[1].respond(app.snapshot({ sequence: 2, commandSequence: null, lastCommand: null }));
  await stop;
  assert.equal(app.state.liveUncertain, false);
});

test('管理页：播报回包与保存回包控制序号相同，也不能回退已保存的新稿', async () => {
  const app = fixture();
  const present = app.broadcastSelectedHostScript();
  await flush();
  app.edit('播报期间保存的下一版正文。');
  const save = app.saveHostScripts();
  app.calls[1].respond(app.snapshot({ sequence: 2, commandSequence: 2, revision: 'revision-2', scripts: app.calls[1].body.scripts }));
  await save;
  app.calls[0].respond(app.snapshot({ sequence: 2, commandSequence: 2 }));
  await present;
  assert.equal(app.state.hostScripts[0].text, '播报期间保存的下一版正文。');
  assert.equal(app.state.hostRevision, 'revision-2');
  assert.equal(app.state.hostDirty, false);
  assert.match(app.elements.hostControlMessage.textContent, /不包含在本次播报/);
});

test('管理页：保存超时保留草稿并恢复保存控件', async () => {
  const app = fixture();
  app.edit('请求超时也要保留的正文。');
  const save = app.saveHostScripts();
  app.expireRequests();
  assert.equal(await save, false);
  assert.equal(app.state.hostSaving, false);
  assert.equal(app.state.hostDirty, true);
  assert.equal(app.state.hostScripts[0].text, '请求超时也要保留的正文。');
  assert.equal(app.elements.saveHostScripts.disabled, false);
  assert.match(app.elements.hostControlMessage.textContent, /请求超时/);
});

test('管理页：保存响应超时后用实际稿件确认成功，保留新增编辑并推进 revision', async () => {
  const app = fixture();
  app.edit('服务器已保存但回包丢失的正文。');
  const save = app.saveHostScripts();
  app.edit('请求期间继续编辑的正文。');
  app.expireRequests();
  await save;
  const load = app.loadLiveControl();
  app.calls[1].respond(app.snapshot({ scripts: app.calls[0].body.scripts, revision: 'revision-2' }));
  await load;
  assert.equal(app.state.hostUnconfirmedSave, null);
  assert.equal(app.state.hostRevision, 'revision-2');
  assert.equal(app.state.hostScripts[0].text, '请求期间继续编辑的正文。');
  assert.equal(app.state.hostDirty, true);
  assert.match(app.elements.hostControlMessage.textContent, /确认上次保存成功.*新增编辑仍未保存/);
  const retry = app.saveHostScripts();
  assert.equal(app.calls[2].body.revision, 'revision-2');
  app.calls[2].respond(app.snapshot({ scripts: app.calls[2].body.scripts, revision: 'revision-3' }));
  assert.equal(await retry, true);
});

test('管理页：保存超时后的核对不能把其他管理员修改当作本次提交成功', async () => {
  const app = fixture();
  app.edit('本页需要保留的草稿。');
  const save = app.saveHostScripts();
  app.expireRequests();
  await save;
  const load = app.loadLiveControl();
  app.calls[1].respond(app.snapshot({ scripts: [{ id: 'opening', title: '开场', text: '其他管理员保存的不同正文。' }], revision: 'another-revision' }));
  await load;
  assert.ok(app.state.hostUnconfirmedSave);
  assert.equal(app.state.hostRevision, 'revision-1');
  assert.equal(app.state.hostScripts[0].text, '本页需要保留的草稿。');
  assert.equal(app.state.hostDirty, true);
});

test('管理页：保存后连接断开也可核对实际稿件，保留新增草稿并恢复后续保存版本', async () => {
  const app = fixture();
  app.edit('已经落盘但网络中断的正文。');
  const save = app.saveHostScripts();
  app.edit('网络中断前继续输入的正文。');
  app.calls[0].reject(new TypeError('Failed to fetch'));
  assert.equal(await save, false);
  const load = app.loadLiveControl();
  app.calls[1].respond(app.snapshot({ scripts: app.calls[0].body.scripts, revision: 'revision-2' }));
  await load;
  assert.equal(app.state.hostRevision, 'revision-2');
  assert.equal(app.state.hostScripts[0].text, '网络中断前继续输入的正文。');
  assert.equal(app.state.hostDirty, true);
  assert.equal(app.state.hostUnconfirmedSave, null);
});

test('管理页：停止前发出的状态轮询回包不恢复旧控制状态', async () => {
  const app = fixture();
  const load = app.loadLiveControl();
  const stop = app.stopHostBroadcast();
  app.calls[1].respond(app.snapshot({ sequence: 2, commandSequence: null, lastCommand: null }));
  await stop;
  app.calls[0].respond(app.snapshot());
  assert.equal(await load, false);
  assert.equal(app.state.liveControl.lastCommand, null);
});

test('管理页：保存前发出的旧轮询回包不能回退已保存稿件和 revision', async () => {
  const app = fixture();
  const load = app.loadLiveControl();
  app.edit('本轮已确认保存的正文。');
  const save = app.saveHostScripts();
  app.calls[1].respond(app.snapshot({ scripts: app.calls[1].body.scripts, revision: 'revision-2' }));
  await save;
  app.calls[0].respond(app.snapshot());
  assert.equal(await load, false);
  assert.equal(app.state.hostRevision, 'revision-2');
  assert.equal(app.state.hostScripts[0].text, '本轮已确认保存的正文。');
});

test('管理页：旧版本播报被拒绝后提示刷新，不自动重放', async () => {
  const app = fixture();
  const present = app.broadcastSelectedHostScript();
  await flush();
  app.calls[0].respond({ message: '现场控制状态已变化' }, 409);
  await present;
  assert.equal(app.calls.length, 1);
  assert.equal(app.state.liveBusy, false);
  assert.match(app.elements.hostControlMessage.textContent, /本次未播报.*刷新状态/);
});

test('管理页：切换模式的自动保存中继续编辑，不丢草稿或发送模式命令', async () => {
  const app = fixture();
  app.edit('切换前的正文。');
  const mode = app.switchWorkbenchMode('dialogue');
  app.edit('切换保存中新增的正文。');
  app.calls[0].respond(app.snapshot({ scripts: app.calls[0].body.scripts, revision: 'revision-2' }));
  await mode;
  assert.equal(app.calls.length, 1);
  assert.equal(app.state.liveControl.mode, 'hosting');
  assert.equal(app.state.hostDirty, true);
  assert.equal(app.state.hostScripts[0].text, '切换保存中新增的正文。');
  assert.equal(app.state.liveBusy, false);
});

test('管理页：服务重启后忽略已退出实例的旧快照', () => {
  const app = fixture();
  assert.equal(app.applyLiveSnapshot(app.snapshot({ instanceId: 'new-instance', mode: 'dialogue', sequence: 0, commandSequence: null, lastCommand: null })), true);
  assert.equal(app.applyLiveSnapshot(app.snapshot({ sequence: 100 })), false);
  assert.equal(app.state.liveControl.instanceId, 'new-instance');
  assert.equal(app.state.liveControl.mode, 'dialogue');
});

test('管理页真实按钮回调：播放等待时能点击停止，停止执行中拒绝重复点击', async () => {
  const app = fixture();
  app.elements.broadcastHostScript.click();
  await flush();
  assert.equal(app.calls[0].url, '/api/live-control/present');
  assert.ok(app.tabs.every((tab) => tab.disabled));
  assert.equal(app.elements.stopHostBroadcast.disabled, false);
  app.elements.stopHostBroadcast.click();
  app.elements.stopHostBroadcast.click();
  assert.deepEqual(app.calls.map((call) => call.url), ['/api/live-control/present', '/api/live-control/stop']);
  app.calls[1].respond(app.snapshot({ sequence: 3, commandSequence: null, lastCommand: null }));
  await flush();
  assert.equal(app.state.liveBusy, false);
  assert.equal(app.state.liveControl.lastCommand, null);
  assert.ok(app.tabs.every((tab) => !tab.disabled));
});

test('管理页传输层：已收到 HTTP 响应头但正文悬挂，仍触发超时并保留草稿', async () => {
  const app = fixture();
  app.edit('正文传输悬挂时需要保留的主持词。');
  const save = app.saveHostScripts();
  app.calls[0].respondPendingBody();
  await flush();
  app.expireRequests();
  assert.equal(await save, false);
  assert.equal(app.calls[0].options.signal.aborted, true);
  assert.equal(app.state.hostSaving, false);
  assert.equal(app.state.hostDirty, true);
  assert.equal(app.state.hostScripts[0].text, '正文传输悬挂时需要保留的主持词。');
  assert.match(app.elements.hostControlMessage.textContent, /请求超时/);
  assert.ok(app.state.hostUnconfirmedSave);
});

test('管理页鉴权：会话失效时安排返回登录，不能把明确 401 当作保存结果未知', async () => {
  const app = fixture();
  app.edit('登录失效时需要保留的草稿。');
  const save = app.saveHostScripts();
  app.calls[0].respond({ error: 'ADMIN_AUTH_REQUIRED', message: '请重新登录。' }, 401);
  assert.equal(await save, false);
  app.runTimers(0);
  assert.deepEqual(app.redirects, ['/']);
  assert.equal(app.state.hostDirty, true);
  assert.equal(app.state.hostUnconfirmedSave, null);
  assert.equal(app.state.hostScripts[0].text, '登录失效时需要保留的草稿。');
});

test('管理页模式切换：过期版本返回 409 时保持模式，不自动补发旧操作', async () => {
  const app = fixture();
  const mode = app.switchWorkbenchMode('dialogue');
  app.calls[0].respond({ error: 'LIVE_CONTROL_STALE_COMMAND', message: '现场状态已经变化。' }, 409);
  await mode;
  assert.equal(app.calls.length, 1);
  assert.equal(app.state.liveControl.mode, 'hosting');
  assert.equal(app.state.liveBusy, false);
  assert.match(app.elements.hostControlMessage.textContent, /本次未切换.*刷新状态/);
});

test('管理页轮询：并发刷新不重叠，暂时失败释放刷新锁且下一次恢复', async () => {
  const app = fixture();
  const first = app.loadLiveControl({ silent: true });
  assert.equal(await app.loadLiveControl({ silent: true }), false);
  assert.equal(app.calls.length, 1);
  app.calls[0].respond({ message: '暂时不可用。' }, 503);
  assert.equal(await first, false);
  assert.equal(app.state.liveLoading, false);
  const next = app.loadLiveControl({ silent: true });
  app.calls[1].respond(app.snapshot({ sequence: 2, commandSequence: null, lastCommand: null }));
  assert.equal(await next, true);
  assert.equal(app.state.liveControl.sequence, 2);
  assert.equal(app.state.liveLoading, false);
});
