import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8'))
  .replace(/void start\(\);\s*$/, '');
const flush = () => new Promise(setImmediate);

function fixture({ ignoreAbort = false, mode = 'hosting' } = {}) {
  const element = () => ({ textContent: '', value: '', hidden: false, disabled: false, dataset: {}, files: [],
    listeners: {},
    classList: { add() {}, remove() {}, toggle() {} }, style: {},
    addEventListener(name, handler) { this.listeners[name] = handler; },
    click() { if (!this.disabled) this.listeners.click?.({ target: this }); },
    setAttribute() {}, querySelectorAll() { return []; },
    querySelector() { return element(); }, closest() { return element(); },
    append() {}, replaceChildren() {}, focus() {}, select() {}, scrollIntoView() {},
    reportValidity() { return true; }, close() { this.open = false; }, showModal() { this.open = true; },
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
        body: options.body instanceof FormData ? options.body : options.body ? JSON.parse(options.body) : undefined,
        respond: (payload, status = 200) => resolve({ ok: status < 400, status, text: async () => JSON.stringify(payload) }),
        respondRaw: (raw, status = 200) => resolve({ ok: status < 400, status, text: async () => raw }),
        respondPendingBody: () => {
          let resolveBody;
          const pendingBody = new Promise((resolve, rejectBody) => {
            resolveBody = resolve;
            if (!ignoreAbort) options.signal.addEventListener('abort', () => rejectBody(options.signal.reason), { once: true });
          });
          resolve({ ok: true, status: 200, text: () => pendingBody });
          return (payload) => resolveBody(JSON.stringify(payload));
        },
        reject,
      });
      if (!ignoreAbort) options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    }),
  });
  vm.runInContext(source + '\nglobalThis.api = {state,elements,broadcastSelectedHostScript,stopHostBroadcast,saveHostScripts,syncHostEditorToState,switchWorkbenchMode,loadLiveControl,applyLiveSnapshot,renderHostControl,populateModelForm,saveModelConfig,loadModelConfig,loadKnowledge,setKnowledgeSnapshot,importKnowledgeFiles,deleteKnowledgeDocument,refreshHealth};', context);
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

function modelFixture(options) {
  const app = fixture(options);
  const config = {
    configured: true, hasApiKey: true, baseUrl: 'https://mock.invalid/v1', model: 'demo-model',
    answerMode: 'grounded', temperature: 0.2, maxTokens: 800, timeoutMs: 30_000,
    answerStyle: '已保存的回答风格。', noAnswerText: '请咨询工作人员。', serviceErrorText: '请稍后再试。', systemPrompt: '仅用给定资料回答。',
  };
  app.state.modelConfig = config;
  app.populateModelForm(config);
  app.elements.modelDialog.open = true;
  const editModel = (field, value) => {
    app.elements[field].value = value;
    app.elements.modelForm.listeners.input?.({ target: app.elements[field] });
  };
  return { ...app, config, editModel };
}

function knowledgeFixture(options) {
  const app = fixture(options);
  const document = { id: 'kb-original', filename: '活动资料.txt', extension: '.txt', size: 18, textLength: 9, chunkCount: 1, importedAt: '2026-09-13T00:00:00Z', preview: '活动门票免费。' };
  const knowledgeSnapshot = (revision, documents) => ({ revision, documentCount: documents.length, chunkCount: documents.length, documents });
  const original = knowledgeSnapshot('knowledge-r1', [document]);
  app.setKnowledgeSnapshot(original);
  app.elements.knowledgeFiles.files = [new File(['活动地址为测试园区。'], '新资料.txt', { type: 'text/plain' })];
  return { ...app, document, original, knowledgeSnapshot };
}

test('模型保存：配置最大超时仍有余量，响应头或正文悬挂均解除忙碌并保留新增草稿', async () => {
  for (const stage of ['headers', 'body']) {
    const app = modelFixture({ ignoreAbort: true });
    app.editModel('modelTimeout', '120');
    app.editModel('modelApiKey', 'submitted-placeholder-key');
    const saving = app.saveModelConfig({ preventDefault() {}, submitter: { dataset: { action: 'test' } } });
    const finishOldBody = stage === 'body' ? app.calls[0].respondPendingBody() : null;
    await flush();
    app.editModel('modelAnswerStyle', '等待期间新增的草稿。');
    app.editModel('modelApiKey', 'new-unsaved-placeholder-key');
    app.elements.modelClearKey.checked = true;
    app.elements.modelForm.listeners.change({});
    const deadlines = [...app.timers.values()].map(timer => timer.ms).filter(ms => ms > 3_200);
    assert.ok(deadlines.some(ms => ms > 120_000 && ms <= 150_000), 'deadline covers configured model time plus transport margin');
    app.runTimers(120_000);
    await flush();
    assert.equal(app.state.modelSaving, true);
    app.runTimers(150_000);
    await flush();
    assert.equal(app.state.modelSaving, false, 'even an adapter ignoring abort must release the form');
    await saving;
    assert.equal(app.calls[0].options.signal.aborted, true);
    assert.equal(app.elements.saveModelSettings.disabled, false);
    assert.equal(app.elements.closeModelDialog.disabled, false);
    let prevented = false;
    app.elements.modelDialog.listeners.cancel({ preventDefault() { prevented = true; } });
    assert.equal(prevented, false);
    assert.equal(app.elements.modelDialog.open, true);
    assert.equal(app.elements.modelAnswerStyle.value, '等待期间新增的草稿。');
    assert.equal(app.elements.modelApiKey.value, 'new-unsaved-placeholder-key');
    assert.equal(app.elements.modelClearKey.checked, true);
    assert.match(app.elements.modelMessage.textContent, /结果未知/);
    assert.doesNotMatch(app.elements.modelMessage.textContent, /保存失败|连接成功|已生效/);
    const recovery = app.calls[1];
    assert.equal(recovery.url, '/api/model-config');
    assert.equal(recovery.options.method, 'GET');
    recovery.respond(app.config);
    await flush();
    assert.match(app.elements.modelMessage.textContent, /结果未知/, 'public metadata cannot prove a hidden key or connection test was saved');
    if (finishOldBody) finishOldBody({ ...app.config, model: 'late-model' });
    else app.calls[0].respond({ ...app.config, model: 'late-model' });
    await flush();
    assert.equal(app.state.modelConfig.model, app.config.model);
    assert.equal(app.elements.modelApiKey.value, 'new-unsaved-placeholder-key');
    assert.equal(app.calls.filter(call => call.options.method === 'PUT').length, 1);
  }
});

test('模型保存：未知结果核对只读且有界，代理页或缺字段不覆盖配置、Key与提示', async () => {
  for (const recoveryKind of ['timeout', 'proxy', 'incomplete']) {
    const app = modelFixture({ ignoreAbort: true });
    app.editModel('modelApiKey', 'kept-placeholder-key');
    const saving = app.saveModelConfig({ preventDefault() {}, submitter: { dataset: { action: 'test' } } });
    app.runTimers(150_000);
    await flush();
    assert.equal(app.state.modelSaving, false);
    await saving;
    assert.equal(app.calls.length, 2, 'one bounded read, no blind write retry');
    const message = app.elements.modelMessage.textContent;
    if (recoveryKind === 'timeout') app.runTimers(10_000);
    else if (recoveryKind === 'proxy') app.calls[1].respondRaw('<html>proxy unavailable</html>');
    else app.calls[1].respond({ configured: true });
    await flush();
    assert.equal(app.state.modelConfig, app.config);
    assert.equal(app.elements.modelApiKey.value, 'kept-placeholder-key');
    assert.equal(app.elements.modelMessage.textContent, message);
    assert.match(message, /结果未知/);
    if (recoveryKind === 'timeout') {
      assert.equal(app.calls[1].options.signal.aborted, true);
      app.calls[1].respond({ ...app.config, model: 'late-recovery-model' });
      await flush();
      assert.equal(app.state.modelConfig, app.config);
    }
    app.calls[0].respond(app.config);
    await flush();
    assert.equal(app.calls.length, 2);
  }
});

test('模型保存：超时后的旧写入或旧核对不覆盖用户显式保存的新版本', async () => {
  const app = modelFixture({ ignoreAbort: true });
  const first = app.saveModelConfig({ preventDefault() {}, submitter: { dataset: { action: 'save' } } });
  app.runTimers(150_000); await flush();
  assert.equal(app.state.modelSaving, false);
  await first;
  app.editModel('modelAnswerStyle', '用户核对后显式保存的新风格。');
  const next = app.saveModelConfig({ preventDefault() {}, submitter: { dataset: { action: 'save' } } });
  app.calls[2].respond({ ...app.config, answerStyle: '用户核对后显式保存的新风格。' });
  await next;
  app.calls[0].respond(app.config);
  app.calls[1].respond(app.config);
  await flush();
  assert.equal(app.state.modelConfig.answerStyle, '用户核对后显式保存的新风格。');
  assert.equal(app.elements.modelAnswerStyle.value, '用户核对后显式保存的新风格。');
});

test('知识写入：导入、删除、迁移悬挂均有界解锁，保留文件且仅只读核对', async () => {
  for (const action of ['import', 'delete', 'migrate']) {
    for (const stage of ['headers', 'body']) {
      const app = knowledgeFixture({ ignoreAbort: true });
      const files = app.elements.knowledgeFiles.files;
      app.state.legacyContent = { revision: 'legacy-r1', items: [] };
      const work = action === 'import' ? app.importKnowledgeFiles({ preventDefault() {} })
        : action === 'delete' ? app.deleteKnowledgeDocument(app.document)
          : app.elements.migrateLegacy.listeners.click();
      const finishOldBody = stage === 'body' ? app.calls[0].respondPendingBody() : null;
      await flush();
      assert.ok([...app.timers.values()].some(timer => timer.ms >= 120_000 && timer.ms <= 180_000), 'large knowledge files get an explicit parsing budget');
      app.runTimers(180_000); await flush();
      assert.equal(app.state.knowledgeImporting, false);
      await work;
      assert.equal(app.elements.knowledgeFiles.files, files);
      for (const name of ['knowledgeFiles', 'refreshKnowledge', 'importKnowledge', 'migrateLegacy']) {
        assert.equal(app.elements[name].disabled, false, `${name} must unlock`);
      }
      assert.match(app.elements.knowledgeMessage.textContent, /结果未知/);
      assert.doesNotMatch(app.elements.knowledgeMessage.textContent, /已删除|已导入|失败/);
      assert.equal(app.calls.length, 2);
      assert.equal(app.calls[1].url, '/api/knowledge');
      assert.equal(app.calls[1].options.method, 'GET');
      const current = app.knowledgeSnapshot('knowledge-r2', []);
      app.calls[1].respond(current); await flush();
      assert.equal(app.state.knowledge.revision, 'knowledge-r2');
      assert.match(app.elements.knowledgeMessage.textContent, /结果未知/);
      if (finishOldBody) finishOldBody(app.original);
      else app.calls[0].respond(app.original);
      await flush();
      assert.equal(app.state.knowledge.revision, 'knowledge-r2');
      assert.equal(app.elements.knowledgeFiles.files, files);
      assert.equal(app.calls.length, 2);
    }
  }
});

test('知识写入：未知结果的读取失败或代理页不清空原列表，晚到读取也不能覆盖下一次删除', async () => {
  for (const kind of ['timeout', 'incomplete', 'proxy', 'late']) {
    const app = knowledgeFixture({ ignoreAbort: true });
    const work = app.deleteKnowledgeDocument(app.document);
    app.runTimers(180_000); await flush();
    assert.equal(app.state.knowledgeImporting, false);
    await work;
    if (kind === 'late') {
      const next = app.deleteKnowledgeDocument(app.document);
      app.calls[2].respond(app.knowledgeSnapshot('knowledge-r2', [])); await next;
      app.calls[1].respond(app.original); await flush();
      assert.equal(app.state.knowledge.revision, 'knowledge-r2');
      assert.match(app.elements.knowledgeMessage.textContent, /已删除/);
    } else {
      if (kind === 'timeout') app.runTimers(10_000);
      else if (kind === 'proxy') app.calls[1].respondRaw('<html>proxy unavailable</html>');
      else app.calls[1].respond({ documents: [] });
      await flush();
      assert.equal(app.state.knowledge, app.original);
      assert.match(app.elements.knowledgeMessage.textContent, /结果未知/);
      if (kind === 'timeout') assert.equal(app.calls[1].options.signal.aborted, true);
    }
    app.calls[0].respond(app.original); await flush();
  }
});

test('后台写入：明确 HTTP 拒绝仍显示真实错误；断网才保持结果未知且不重试写入', async () => {
  for (const operation of ['model', 'knowledge']) {
    for (const failure of ['network', '400', '401']) {
      const app = operation === 'model' ? modelFixture() : knowledgeFixture();
      if (operation === 'model') {
        app.elements.modelClearKey.checked = true;
        app.elements.modelForm.listeners.change({});
      }
      const work = operation === 'model'
        ? app.saveModelConfig({ preventDefault() {}, submitter: { dataset: { action: 'save' } } })
        : app.deleteKnowledgeDocument(app.document);
      if (failure === 'network') app.calls[0].reject(new TypeError('Failed to fetch'));
      else app.calls[0].respond({ message: '明确拒绝本次操作。' }, Number(failure));
      await work;
      const message = operation === 'model' ? app.elements.modelMessage.textContent : app.elements.knowledgeMessage.textContent;
      assert.equal(app.state.modelSaving, false);
      assert.equal(app.state.knowledgeImporting, false);
      if (failure === 'network') {
        assert.match(message, /结果未知/);
        assert.equal(app.calls.length, 2);
        assert.equal(app.calls[1].options.method, 'GET');
        app.calls[1].respond(operation === 'model' ? app.config : app.original);
        await flush();
        if (operation === 'model') assert.equal(app.elements.modelClearKey.checked, true);
      } else {
        assert.equal(message, '明确拒绝本次操作。');
        assert.equal(app.calls.length, 1);
        if (failure === '401') {
          app.runTimers(0);
          assert.deepEqual(app.redirects, ['/']);
        }
      }
    }
  }
});

test('后台写入：200 代理页或不完整 JSON 不冒充成功，不清模型字段或所选知识文件', async () => {
  for (const operation of ['model', 'knowledge']) {
    for (const invalid of ['html', 'partial']) {
      const app = operation === 'model' ? modelFixture() : knowledgeFixture();
      if (operation === 'model') app.editModel('modelApiKey', 'retained-placeholder-key');
      const files = app.elements.knowledgeFiles.files;
      const work = operation === 'model'
        ? app.saveModelConfig({ preventDefault() {}, submitter: { dataset: { action: 'test' } } })
        : app.importKnowledgeFiles({ preventDefault() {} });
      if (invalid === 'html') app.calls[0].respondRaw('<html>gateway error</html>');
      else app.calls[0].respond(operation === 'model' ? { configured: true } : { documents: [] });
      await work;
      assert.equal(app.state.modelSaving, false);
      assert.equal(app.state.knowledgeImporting, false);
      if (operation === 'model') {
        assert.equal(app.state.modelConfig, app.config);
        assert.equal(app.elements.modelApiKey.value, 'retained-placeholder-key');
        assert.match(app.elements.modelMessage.textContent, /结果未知/);
      } else {
        assert.equal(app.state.knowledge, app.original);
        assert.equal(app.elements.knowledgeFiles.files, files);
        assert.match(app.elements.knowledgeMessage.textContent, /结果未知/);
      }
      assert.equal(app.calls.length, 2);
      assert.equal(app.calls[1].options.method, 'GET');
      app.calls[1].respond(operation === 'model' ? app.config : app.original); await flush();
    }
  }
});

test('模型表单：保存或测试期间的新输入必须保留并明确提示尚未保存', async () => {
  for (const action of ['save', 'test']) {
    const app = modelFixture();
    const pending = app.saveModelConfig({ preventDefault() {}, submitter: { dataset: { action } } });
    app.editModel('modelAnswerStyle', '请求期间新输入的风格。');
    app.calls[0].respond({ ...app.config, ...(action === 'test' ? { connectionTest: { model: 'demo-model', latencyMs: 2000 } } : {}) });
    await pending;
    assert.equal(app.elements.modelAnswerStyle.value, '请求期间新输入的风格。');
    assert.equal(app.elements.modelDialog.open, true);
    assert.match(app.elements.modelMessage.textContent, /新增编辑.*未保存/);
    assert.equal(app.state.modelConfig.answerStyle, app.config.answerStyle);
    assert.equal(app.state.modelSaving, false);
  }
});

test('模型表单：保存成功清除已提交 Key，但必须保留等待期间重新输入的新 Key', async () => {
  for (const changeKey of [false, true]) {
    const app = modelFixture();
    app.editModel('modelApiKey', 'submitted-placeholder-key');
    const pending = app.saveModelConfig({ preventDefault() {}, submitter: { dataset: { action: 'test' } } });
    app.editModel('modelAnswerStyle', '提交后继续编辑风格。');
    if (changeKey) app.editModel('modelApiKey', 'new-unsaved-placeholder-key');
    app.calls[0].respond({ ...app.config, connectionTest: { model: 'demo-model', latencyMs: 2000 } });
    await pending;
    assert.equal(app.elements.modelApiKey.value, changeKey ? 'new-unsaved-placeholder-key' : '');
    assert.equal(app.elements.modelAnswerStyle.value, '提交后继续编辑风格。');
  }
});

test('模型表单：保存失败不丢新输入，保存前发出的配置读取也不能回退新配置', async () => {
  for (const oldStatus of [200, 503]) {
    const app = modelFixture();
    const oldLoad = app.loadModelConfig();
    app.editModel('modelAnswerStyle', '本次保存的风格。');
    const save = app.saveModelConfig({ preventDefault() {}, submitter: { dataset: { action: 'save' } } });
    app.calls[1].respond({ ...app.config, answerStyle: '本次保存的风格。' });
    await save;
    app.calls[0].respond(oldStatus === 200 ? app.config : { message: '旧配置读取失败。' }, oldStatus);
    await oldLoad;
    assert.equal(app.state.modelConfig.answerStyle, '本次保存的风格。');
    app.editModel('modelAnswerStyle', '重试前的草稿。');
    const failed = app.saveModelConfig({ preventDefault() {}, submitter: { dataset: { action: 'save' } } });
    app.editModel('modelAnswerStyle', '失败等待期间继续输入的草稿。');
    app.calls[2].respond({ message: '暂时无法保存。' }, 500);
    await failed;
    assert.equal(app.elements.modelAnswerStyle.value, '失败等待期间继续输入的草稿。');
    assert.match(app.elements.modelMessage.textContent, /新增编辑.*未保存/);
    assert.equal(app.state.modelSaving, false);
  }
});

test('知识库：删除成功后迟到的旧刷新成功回包不能恢复已删除文档', async () => {
  const app = knowledgeFixture();
  const oldLoad = app.loadKnowledge();
  const deletion = app.deleteKnowledgeDocument(app.document);
  app.calls[1].respond(app.knowledgeSnapshot('knowledge-r2', []));
  await deletion;
  app.calls[0].respond(app.original);
  await oldLoad;
  assert.equal(app.state.knowledge.revision, 'knowledge-r2');
  assert.equal(app.state.knowledge.documentCount, 0);
  assert.match(app.elements.knowledgeMessage.textContent, /已删除/);
});

test('知识库：导入成功后迟到的旧刷新错误回包不能清空新知识状态', async () => {
  const app = knowledgeFixture();
  const oldLoad = app.loadKnowledge();
  const importing = app.importKnowledgeFiles({ preventDefault() {} });
  const added = { ...app.document, id: 'kb-new', filename: '新资料.txt' };
  app.calls[1].respond({ ...app.knowledgeSnapshot('knowledge-r2', [app.document, added]), imported: [added], skipped: [] });
  await importing;
  app.calls[0].respond({ message: '旧读取失败。' }, 503);
  await oldLoad;
  assert.equal(app.state.knowledge?.revision, 'knowledge-r2');
  assert.equal(app.state.knowledge?.documentCount, 2);
  assert.equal(app.elements.knowledgeStorageState.textContent, '已持久化');
});

test('知识库：多个刷新只接受最新请求的结果，忽略较早成功或失败回包', async () => {
  for (const oldStatus of [200, 503]) {
    const app = knowledgeFixture();
    const oldLoad = app.loadKnowledge();
    const newestLoad = app.loadKnowledge();
    app.calls[1].respond(app.knowledgeSnapshot('knowledge-r2', []));
    await newestLoad;
    app.calls[0].respond(oldStatus === 200 ? app.original : { message: '旧请求失败。' }, oldStatus);
    await oldLoad;
    assert.equal(app.state.knowledge?.revision, 'knowledge-r2');
    assert.equal(app.state.knowledge?.documentCount, 0);
  }
});

test('知识库：导入与删除不能在同一页面并发写入，失败后解锁并允许最新刷新', async () => {
  const app = knowledgeFixture();
  const importing = app.importKnowledgeFiles({ preventDefault() {} });
  const deletion = app.deleteKnowledgeDocument(app.document);
  assert.equal(app.calls.length, 1);
  assert.equal(await app.loadKnowledge(), false);
  app.calls[0].respond({ message: '导入失败，请重试。' }, 500);
  await Promise.all([importing, deletion]);
  assert.equal(app.state.knowledgeImporting, false);
  assert.equal(app.elements.importKnowledge.disabled, false);
  const refresh = app.loadKnowledge();
  app.calls[1].respond(app.knowledgeSnapshot('knowledge-r3', []));
  await refresh;
  assert.equal(app.state.knowledge.revision, 'knowledge-r3');
});

test('知识库：修改前或修改中发起的健康检查不能回退已确认的文件数量', async () => {
  for (const startsDuringDelete of [false, true]) {
    const app = knowledgeFixture();
    let health;
    if (!startsDuringDelete) health = app.refreshHealth();
    const deletion = app.deleteKnowledgeDocument(app.document);
    if (startsDuringDelete) health = app.refreshHealth();
    const deleteCall = app.calls.find(call => call.options.method === 'DELETE');
    const healthCall = app.calls.find(call => call.url === '/health');
    deleteCall.respond(app.knowledgeSnapshot('knowledge-r2', []));
    await deletion;
    healthCall.respond({ ready: true, knowledge: { documentCount: 1 } });
    await health;
    assert.equal(app.elements.knowledgeCount.textContent, '0');
    assert.equal(app.state.knowledge.revision, 'knowledge-r2');
    const latestHealth = app.refreshHealth();
    app.calls.at(-1).respond({ ready: true, knowledge: { documentCount: 2 } });
    await latestHealth;
    assert.equal(app.elements.knowledgeCount.textContent, '2', 'fresh health still updates the count');
  }
});

test('模型状态：保存前或保存中发起的健康检查不能恢复旧模型名', async () => {
  for (const startsDuringSave of [false, true]) {
    const app = modelFixture();
    let health;
    if (!startsDuringSave) health = app.refreshHealth();
    app.editModel('modelName', 'new-model');
    const save = app.saveModelConfig({ preventDefault() {}, submitter: { dataset: { action: 'test' } } });
    if (startsDuringSave) health = app.refreshHealth();
    const saveCall = app.calls.find(call => call.options.method === 'PUT');
    const healthCall = app.calls.find(call => call.url === '/health');
    saveCall.respond({ ...app.config, model: 'new-model', connection: { status: 'available' } });
    await save;
    healthCall.respond({ ready: false, model: { configured: true, model: 'old-model', status: 'unavailable' } });
    await health;
    assert.equal(app.elements.modelStatus.textContent, 'new-model · 连接可用');
    assert.equal(app.state.modelConfig.model, 'new-model');
    const latestHealth = app.refreshHealth();
    app.calls.at(-1).respond({ ready: true, model: { configured: true, model: 'new-model', status: 'available' } });
    await latestHealth;
    assert.equal(app.elements.modelStatus.textContent, 'new-model · 连接可用');
  }
});

test('模型表单：无新增编辑保持保存关闭与测试留窗行为，忙碌期间阻止 Escape 关闭', async () => {
  for (const action of ['save', 'test']) {
    const app = modelFixture();
    const save = app.saveModelConfig({ preventDefault() {}, submitter: { dataset: { action } } });
    let prevented = false;
    app.elements.modelDialog.listeners.cancel?.({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    app.calls[0].respond({ ...app.config, ...(action === 'test' ? { connectionTest: { model: 'demo-model', latencyMs: 20 } } : {}) });
    await save;
    assert.equal(app.elements.modelDialog.open, action === 'test');
    assert.doesNotMatch(app.elements.modelMessage.textContent, /新增编辑/);
    prevented = false;
    app.elements.modelDialog.listeners.cancel?.({ preventDefault() { prevented = true; } });
    assert.equal(prevented, false);
  }
});

test('知识库：刷新按钮的迟到结果不能覆盖删除成功提示', async () => {
  for (const oldStatus of [200, 503]) {
    const app = knowledgeFixture();
    const refreshing = app.elements.refreshKnowledge.listeners.click();
    const deletion = app.deleteKnowledgeDocument(app.document);
    app.calls[1].respond(app.knowledgeSnapshot('knowledge-r2', []));
    await deletion;
    const deletionMessage = app.elements.knowledgeMessage.textContent;
    app.calls[0].respond(oldStatus === 200 ? app.original : { message: '旧读取失败。' }, oldStatus);
    await refreshing;
    assert.match(deletionMessage, /已删除/);
    assert.equal(app.elements.knowledgeMessage.textContent, deletionMessage);
  }
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
