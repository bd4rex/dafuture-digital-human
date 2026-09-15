import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { AvatarFlow, AVATAR_STATES, LiveStateTracker } from '../public/avatar-flow.js';
import { LiveControlStore } from '../live-control-store.js';

const source = (await readFile(new URL('../public/avatar.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '').replace(/void start\(\);\s*$/, '');

function fixture(t, fetchOverride, { clockStep = 600, manualTimers = false, eventFetch } = {}) {
  const element = () => ({ textContent: '', value: '', hidden: false, disabled: false, dataset: {}, listeners: {}, attributes: {},
    classList: { add() {}, remove() {}, toggle() {} }, style: {},
    addEventListener(name, handler) { this.listeners[name] = handler; },
    setAttribute(name, value) { this.attributes[name] = value; }, focus() {}, querySelectorAll() { return []; }, append() {}, remove() { this.removed = true; }, scrollTo() {},
  });
  const events = [];
  const utterances = [];
  const spoken = [];
  const voiceListeners = new Set();
  let cancels = 0;
  let now = 0;
  const timerCalls = [];
  const timers = new Map();
  const storage = new Map();
  const connections = [];
  const fetchCalls = [];
  let nextTimer = 0;
  const clockEpoch = Date.parse('2026-09-12T00:00:00Z');
  class ManualDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clockEpoch + now])); }
    static now() { return clockEpoch + now; }
  }
  class EventSourceMock {
    constructor(url) { this.url = url; this.handlers = {}; connections.push(this); }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    close() { this.closed = true; }
    emit(name, event = {}) { this.handlers[name]?.(event); }
  }
  class Utterance {
    constructor(text) { this.text = text; this.handlers = {}; utterances.push(this); }
    addEventListener(name, handler) { this.handlers[name] = handler; }
  }
  const scheduleTimer = (fn, ms = 0) => {
    timerCalls.push(ms);
    if (manualTimers) {
      const id = ++nextTimer;
      timers.set(id, { fn, due: now + Math.max(0, Number(ms) || 0) });
      return id;
    }
    const timer = setTimeout(fn, ms); if (ms > 520) timer.unref(); return timer;
  };
  const cancelTimer = (id) => { if (manualTimers) timers.delete(id); else clearTimeout(id); };
  const performanceClock = { now: () => manualTimers ? now : (now += clockStep) };
  const dateClock = manualTimers ? ManualDate : Date;
  const signalApi = manualTimers ? {
    abort: (reason) => AbortSignal.abort(reason),
    any: (signals) => AbortSignal.any(signals),
    timeout: (ms) => {
      const controller = new AbortController();
      scheduleTimer(() => controller.abort(Object.assign(new Error('request deadline'), { name: 'TimeoutError' })), ms);
      return controller.signal;
    },
  } : AbortSignal;
  const browser = {
    EventSource: EventSourceMock, speechSynthesis: {
      cancel() { cancels++; }, speak(utterance) { spoken.push(utterance); },
      getVoices: () => [{ name: 'Microsoft Kangkang', voiceURI: 'kangkang', lang: 'zh-CN', localService: true }],
      addEventListener(name, handler) { if (name === 'voiceschanged') voiceListeners.add(handler); },
      removeEventListener(name, handler) { if (name === 'voiceschanged') voiceListeners.delete(handler); },
    }, SpeechSynthesisUtterance: Utterance,
    setTimeout: scheduleTimer, clearTimeout: cancelTimer, performance: performanceClock,
    Date: dateClock, AbortController, AbortSignal: signalApi, addEventListener() {}, innerHeight: 800,
  };
  const context = vm.createContext({
    AvatarFlow, AVATAR_STATES, LiveStateTracker, console, AbortController, AbortSignal: signalApi,
    SpeechSynthesisUtterance: Utterance,
    setTimeout: scheduleTimer,
    clearTimeout: cancelTimer,
    setInterval() {},
    Date: dateClock,
    performance: performanceClock,
    sessionStorage: { setItem(key, value) { storage.set(key, value); }, getItem(key) { return storage.get(key) ?? null; } },
    document: { querySelector: element, querySelectorAll: () => [], createElement: element,
      addEventListener() {}, documentElement: { style: { setProperty() {} } }, body: { dataset: {}, classList: { toggle() {} } } },
    window: browser, EventSource: EventSourceMock,
    fetch: async (url, options) => {
      fetchCalls.push({ url, options });
      if (url === '/api/client-events') {
        events.push(JSON.parse(options.body));
        return eventFetch ? eventFetch(url, options) : { ok: true };
      }
      if (fetchOverride) return fetchOverride(url, options);
      throw new Error('offline');
    },
  });
  vm.runInContext(source + '\nglobalThis.api = {runtime,elements,handleLiveEvent,refreshHealth,speakText,askQuestion,stopSpeech,connectLiveEvents,loadLiveState,flushClientEvents,reportClientEvent,bindEvents,updateStateUI};', context);
  const api = context.api;
  api.runtime.flow = new AvatarFlow(({ state, reason }) => api.updateStateUI(state, reason));
  api.runtime.videoSwitcher = { show() {} };
  t.after(() => { api.runtime.requestController?.abort(); api.stopSpeech(); });
  const runTimers = async (ms) => {
    assert.ok(manualTimers, 'runTimers requires the manual clock');
    assert.ok(Number.isFinite(ms) && ms >= 0);
    const target = now + ms;
    let executed = 0;
    // Drain promise continuations as well as timers: an async callback may
    // schedule another timeout inside the same interval being advanced.
    await new Promise(setImmediate);
    while (true) {
      let next = [...timers].filter(([, timer]) => timer.due <= target)
        .sort(([leftId, left], [rightId, right]) => left.due - right.due || leftId - rightId)[0];
      if (!next) {
        now = target;
        await new Promise(setImmediate);
        next = [...timers].filter(([, timer]) => timer.due <= target)
          .sort(([leftId, left], [rightId, right]) => left.due - right.due || leftId - rightId)[0];
        if (!next) break;
      }
      assert.ok(++executed <= 10_000, 'manual timer loop did not settle');
      const [id, timer] = next;
      timers.delete(id);
      now = Math.max(now, timer.due);
      timer.fn();
      await new Promise(setImmediate);
    }
  };
  const evaluate = (code) => vm.runInContext(code, context);
  return { ...api, events, utterances, spoken, voiceListeners, timerCalls, timers, runTimers, evaluate, storage, connections, fetchCalls, browser,
    voicesChanged() { for (const handler of [...voiceListeners]) handler(); }, get cancels() { return cancels; } };
}

function store() {
  const value = new LiveControlStore({ configPath: '/unused', logger: {} });
  value.scripts = [{ id: 'opening', title: '开场', text: '欢迎来到现场。' }];
  return value;
}

test('测试时钟正对照：直接截止、Date 轮询与异步递归计时都按绝对到期时间触发', async (t) => {
  const app = fixture(t, undefined, { manualTimers: true });
  app.evaluate(`
    globalThis.clockProbe = { start: Date.now(), events: [] };
    const record = (name) => clockProbe.events.push({
      name, elapsed: performance.now(), wallElapsed: Date.now() - clockProbe.start,
      constructorElapsed: new Date().getTime() - clockProbe.start,
    });
    const cancelled = setTimeout(() => record('cancelled'), 500);
    clearTimeout(cancelled);
    setTimeout(() => record('direct'), 10_000);
    const deadline = Date.now() + 10_000;
    function pollDeadline() {
      if (Date.now() >= deadline) record('polled');
      else window.setTimeout(pollDeadline, 1_000);
    }
    pollDeadline();
    AbortSignal.timeout(10_000).addEventListener('abort', () => record('signal'));
    setTimeout(async () => {
      await Promise.resolve();
      setTimeout(() => record('nested'), 500);
    }, 2_000);
  `);
  const events = () => JSON.parse(app.evaluate('JSON.stringify(clockProbe.events)'));
  await app.runTimers(2_500);
  assert.deepEqual(events(), [{ name: 'nested', elapsed: 2_500, wallElapsed: 2_500, constructorElapsed: 2_500 }]);
  await app.runTimers(7_499);
  assert.equal(events().length, 1, 'the 10-second deadline must not fire at 9.999 seconds');
  await app.runTimers(1);
  assert.deepEqual(events().slice(1).map(({ name }) => name).sort(), ['direct', 'polled', 'signal']);
  for (const event of events().slice(1)) {
    assert.equal(event.elapsed, 10_000);
    assert.equal(event.wallElapsed, 10_000);
    assert.equal(event.constructorElapsed, 10_000);
  }
});

test('实际前台：重连同步漏掉的停止指令，不重播旧稿', (t) => {
  const app = fixture(t);
  const live = store();
  app.handleLiveEvent({ data: JSON.stringify(live.present('opening')) });
  assert.equal(app.runtime.flow.state, 'presenting');
  const before = app.cancels;
  live.stop();
  app.handleLiveEvent({ data: JSON.stringify(live.syncEvent()) });
  assert.equal(app.runtime.flow.state, 'idle');
  assert.ok(app.cancels > before);
  assert.equal(app.utterances.length, 1);
});

test('实际前台：旧 health 不覆盖新 present，health 也不抢先消耗播报序号', async (t) => {
  let resolveHealth;
  const app = fixture(t, () => new Promise((resolve) => { resolveHealth = resolve; }));
  const live = store();
  const old = { ...live.publicLiveState() };
  const pending = app.refreshHealth();
  app.handleLiveEvent({ data: JSON.stringify(live.present('opening')) });
  resolveHealth({ ok: true, json: async () => ({ ready: true, liveControl: old }) });
  await pending;
  assert.equal(app.runtime.liveMode, 'hosting');
  assert.equal(app.runtime.flow.state, 'presenting');
  const ahead = app.refreshHealth();
  const next = live.present('opening');
  resolveHealth({ ok: true, json: async () => ({ ready: true, liveControl: live.publicLiveState() }) });
  await ahead;
  app.handleLiveEvent({ data: JSON.stringify(next) });
  assert.equal(app.utterances.length, 2);
});

test('实际前台：语音失败、静音和正常结束显示不同结果并上报', async (t) => {
  const app = fixture(t);
  const live = store();
  app.handleLiveEvent({ data: JSON.stringify(live.present('opening')) });
  app.utterances[0].handlers.error({ error: 'synthesis-failed' });
  assert.match(app.elements.hostingScriptTitle.textContent, /播报失败/);
  assert.equal(app.runtime.flow.reason, 'speech-failed');
  app.runtime.soundEnabled = false;
  app.handleLiveEvent({ data: JSON.stringify(live.present('opening')) });
  assert.match(app.elements.hostingScriptTitle.textContent, /已静音/);
  app.runtime.soundEnabled = true;
  app.handleLiveEvent({ data: JSON.stringify(live.present('opening')) });
  app.utterances.at(-1).handlers.start();
  app.utterances.at(-1).handlers.end();
  assert.match(app.elements.hostingScriptTitle.textContent, /播报完成/);
  await new Promise(setImmediate);
  assert.ok(app.events.some((event) => event.phase === 'speech-failed'));
  assert.ok(app.events.some((event) => event.phase === 'speech-muted'));
  assert.ok(app.events.some((event) => event.phase === 'speech-completed'));
});

test('实际前台：网络失败使用缓存的自然话术并交给语音，不显示 Failed to fetch', async (t) => {
  const app = fixture(t);
  app.runtime.config = { ...app.runtime.config, serviceErrorText: '网络暂时不可用，请稍后再试。' };
  await app.askQuestion('门票多少钱？');
  assert.equal(app.utterances[0].text, app.runtime.config.serviceErrorText);
  await new Promise(setImmediate);
  assert.ok(app.events.some((event) => event.phase === 'request-failed' && event.question === '门票多少钱？'));
});

test('实际前台：快速回答仍保留最短思考等待，音频开始前不切说话', async (t) => {
  const app = fixture(t, async () => ({ ok: true, json: async () => ({ answer: '欢迎来到大未来。' }) }), { clockStep: 500 });
  await app.askQuestion('你好');
  assert.ok(app.timerCalls.includes(20));
  assert.equal(app.utterances[0].text, '欢迎来到大未来。');
  assert.equal(app.runtime.flow.state, 'thinking');
  app.utterances[0].handlers.start();
  assert.equal(app.runtime.flow.state, 'speaking');
});

test('实际前台：后端认可的方括号提醒正常播报，不误报网络兜底', async (t) => {
  for (const answer of ['[温馨提醒] 请提前到达。', '[1] 请先签到。']) {
    const app = fixture(t, async () => ({ ok: true, json: async () => ({ answer }) }));
    await app.askQuestion('需要注意什么？');
    assert.equal(app.utterances[0].text, answer);
  }
});

test('实际前台：序列化或残缺数组仍拒绝播报', async (t) => {
  for (const answer of ['["门票免费"]', '[{"answer":"门票免费"}', '[1,2]']) {
    const app = fixture(t, async () => ({ ok: true, json: async () => ({ answer }) }));
    await app.askQuestion('门票多少钱？');
    assert.equal(app.utterances[0].text, app.runtime.config.serviceErrorText);
  }
});

test('实际前台：主持指令打断问答后，晚到的回答或兜底不播报且清理等待消息', async (t) => {
  for (const ok of [true, false]) {
    let resolvePayload;
    const app = fixture(t, async () => ({
      ok, json: () => new Promise((resolve) => { resolvePayload = resolve; }),
    }));
    const messages = [];
    app.elements.conversationLog.append = (message) => messages.push(message);
    const pending = app.askQuestion('门票多少钱？');
    await new Promise(setImmediate);
    app.handleLiveEvent({ data: JSON.stringify(store().present('opening')) });
    resolvePayload({ answer: ok ? '门票免费。' : '服务暂时不可用，请稍后再试。' });
    await pending;
    await new Promise(setImmediate);
    assert.equal(messages[1].removed, true);
    assert.equal(app.utterances.length, 1);
    assert.equal(app.utterances[0].text, '欢迎来到现场。');
    assert.ok(app.events.some((event) => event.phase === 'request-cancelled'));
  }
});

test('状态排序忽略旧序号与已退出实例，服务重启可接受归零序号', () => {
  const tracker = new LiveStateTracker();
  const state = { instanceId: 'instance-a', sequence: 5, mode: 'hosting', commandSequence: 5 };
  assert.ok(tracker.accept(state));
  assert.equal(tracker.accept({ ...state, sequence: 4, commandSequence: null }), null);
  assert.equal(tracker.accept({ ...state, instanceId: 'instance-b', sequence: 0, commandSequence: null, mode: 'dialogue' }).restarted, true);
  assert.equal(tracker.accept({ ...state, sequence: 10 }), null);
});

test('实际 SSE 回调：控制断开立即停止，重连 sync 不重播，只有新指令恢复播报', async (t) => {
  const app = fixture(t);
  const live = store();
  app.connectLiveEvents();
  const connection = app.connections[0];
  assert.equal(connection.url, '/api/live/events');
  connection.emit('open');
  assert.equal(app.runtime.liveConnected, true);
  connection.emit('present', { data: JSON.stringify(live.present('opening')) });
  app.utterances[0].handlers.start();
  const cancelsBefore = app.cancels;
  connection.emit('error');
  assert.equal(app.runtime.liveConnected, false);
  assert.equal(app.runtime.flow.state, 'idle');
  assert.equal(app.runtime.hostingCommandSequence, null);
  assert.ok(app.cancels > cancelsBefore);
  assert.match(app.elements.hostingScriptTitle.textContent, /控制连接中断/);
  connection.emit('open');
  connection.emit('sync', { data: JSON.stringify(live.syncEvent()) });
  app.utterances[0].handlers.end();
  assert.equal(app.utterances.length, 1);
  assert.equal(app.runtime.flow.state, 'idle');
  assert.doesNotMatch(app.elements.hostingScriptTitle.textContent, /播报完成/);
  connection.emit('present', { data: JSON.stringify(live.present('opening')) });
  assert.equal(app.utterances.length, 2);
  assert.equal(app.runtime.flow.state, 'presenting');
  await new Promise(setImmediate);
  assert.ok(app.events.some((event) => event.phase === 'speech-cancelled'));
});

test('实际 SSE 回调：等待响应头或正文时断流立即取消旧对话，正常 health 不能掩盖断线或恢复旧答案', async (t) => {
  for (const phase of ['headers', 'body']) {
    const live = store();
    let release;
    const late = new Promise((resolve) => { release = resolve; });
    const app = fixture(t, async (url) => {
      if (url === '/health') return { ok: true, json: async () => ({ ready: true, liveControl: live.publicLiveState() }) };
      return phase === 'headers' ? late : { ok: true, json: () => late };
    }, { manualTimers: true });
    const messages = [];
    app.elements.conversationLog.append = (message) => messages.push(message);
    app.connectLiveEvents();
    const connection = app.connections[0];
    connection.emit('open');
    connection.emit('sync', { data: JSON.stringify(live.syncEvent()) });
    const pending = app.askQuestion('主持人即将接管的旧问题。');
    await new Promise(setImmediate);
    const answerCall = app.fetchCalls.find((call) => call.url === '/answer');
    connection.emit('error');
    assert.equal(answerCall.options.signal.aborted, true, `${phase}: control loss aborts the answer transport`);
    await pending;
    assert.equal(app.runtime.requestController, null);
    assert.equal(app.runtime.flow.state, 'idle');
    assert.equal(messages[1].removed, true);
    live.present('opening');
    await app.refreshHealth();
    assert.equal(app.runtime.liveMode, 'dialogue', 'health must not consume a missing hosting command');
    assert.match(app.elements.serviceLabel.textContent, /实时控制.*重新连接|控制连接.*中断/);
    assert.equal(app.elements.sendButton.disabled, true);
    release(phase === 'headers' ? { ok: true, json: async () => ({ answer: '不能复活的旧答案。' }) } : { answer: '不能复活的旧答案。' });
    await app.runTimers(180_000);
    assert.equal(app.utterances.length, 0, 'neither stale text nor fallback may talk over an unobserved takeover');
    assert.equal(app.events.filter((event) => event.phase === 'request-cancelled').length, 1);
    assert.equal(app.events.some((event) => event.phase === 'request-failed'), false);
    connection.emit('open');
    connection.emit('sync', { data: JSON.stringify(live.syncEvent()) });
    assert.equal(app.runtime.liveMode, 'hosting');
    assert.equal(app.utterances.length, 0, 'reconnect sync never replays the missed host script');
    connection.emit('present', { data: JSON.stringify(live.present('opening')) });
    assert.equal(app.utterances.at(-1).text, '欢迎来到现场。');
  }
});

test('实际 SSE 回调：控制断流停止已开始的对话语音，重连和晚到语音回调不会恢复旧交互', async (t) => {
  const live = store();
  const app = fixture(t, async (url) => ({ ok: true, json: async () => url === '/health'
    ? { ready: true, liveControl: live.publicLiveState() } : { answer: '正在播报的旧回答。' } }));
  app.connectLiveEvents();
  const connection = app.connections[0];
  connection.emit('open');
  connection.emit('sync', { data: JSON.stringify(live.syncEvent()) });
  await app.askQuestion('请介绍一下。');
  const speech = app.utterances[0];
  speech.handlers.start();
  assert.equal(app.runtime.flow.state, 'speaking');
  const previousCancels = app.cancels;
  connection.emit('error');
  assert.ok(app.cancels > previousCancels);
  assert.equal(app.runtime.flow.state, 'idle');
  assert.equal(app.runtime.activeSpeechSequence, null);
  connection.emit('open');
  connection.emit('sync', { data: JSON.stringify(live.syncEvent()) });
  speech.handlers.start();
  speech.handlers.end();
  assert.equal(app.runtime.flow.state, 'idle');
  assert.equal(app.utterances.length, 1);
  await new Promise(setImmediate);
  assert.equal(app.events.filter((event) => event.phase === 'speech-cancelled').length, 1);
  assert.equal(app.events.some((event) => event.phase === 'speech-completed'), false);
});

test('实际 SSE 回调：断线后明确暂停新问且保留草稿，仅有效 sync 恢复对话，不以 open 或 health 代替', async (t) => {
  const live = store();
  const oldSync = live.syncEvent();
  live.switchMode('hosting');
  live.switchMode('dialogue');
  const app = fixture(t, async (url) => ({ ok: true, json: async () => url === '/health'
    ? { ready: true, liveControl: live.publicLiveState() } : { answer: '重连后新问题的回答。' } }));
  app.evaluate('runtime.voiceInput = new BrowserVoiceInput({ button: elements.voiceInputButton, input: elements.questionInput, form: elements.questionForm, hint: elements.composerHint });');
  app.bindEvents();
  app.connectLiveEvents();
  const connection = app.connections[0];
  connection.emit('open');
  connection.emit('sync', { data: JSON.stringify(live.syncEvent()) });
  connection.emit('error');
  app.elements.questionInput.value = '仍然保留的问题草稿';
  app.elements.questionForm.listeners.submit({ preventDefault() {} });
  assert.equal(app.elements.questionInput.value, '仍然保留的问题草稿');
  app.runtime.voiceInput.handleEnd();
  assert.match(app.elements.composerHint.textContent, /控制.*中断.*暂停|控制.*重连.*暂停/);
  assert.equal(app.elements.questionInput.disabled, true);
  await app.askQuestion('直接调用也不能绕过暂停。');
  assert.equal(app.fetchCalls.some((call) => call.url === '/answer'), false);
  connection.emit('open');
  await app.refreshHealth();
  connection.emit('sync', { data: '{broken' });
  connection.emit('sync', { data: JSON.stringify({ ...live.syncEvent(), sequence: -1 }) });
  connection.emit('sync', { data: JSON.stringify(oldSync) });
  assert.equal(app.elements.sendButton.disabled, true);
  connection.emit('sync', { data: JSON.stringify(live.syncEvent()) });
  assert.equal(app.elements.questionInput.disabled, false);
  assert.equal(app.elements.sendButton.disabled, false);
  assert.equal(app.elements.questionInput.value, '仍然保留的问题草稿');
  await app.askQuestion('现在提出新的问题。');
  assert.equal(app.fetchCalls.filter((call) => call.url === '/answer').length, 1);
  assert.equal(app.utterances[0].text, '重连后新问题的回答。');
});

test('实际 SSE 回调：初次连接尚未报错和不支持 SSE 的轮询兼容都保留离线自然兜底', async (t) => {
  for (const unsupported of [false, true]) {
    const app = fixture(t);
    if (unsupported) delete app.browser.EventSource;
    app.connectLiveEvents();
    await app.askQuestion('网络暂时不可用时怎么办？');
    assert.equal(app.utterances[0].text, app.runtime.config.serviceErrorText);
    assert.equal(app.elements.sendButton.disabled, true);
    app.utterances[0].handlers.start();
    app.utterances[0].handlers.end();
    assert.equal(app.elements.sendButton.disabled, false);
    assert.equal(app.fetchCalls.filter((call) => call.url === '/answer').length, 1);
  }
});

test('实际前台：后端确认在途问答被主持控制淘汰时按取消处理，既不显示旧正文也不播报空正文兜底', async (t) => {
  for (const error of ['HOSTING_MODE_ACTIVE', 'ANSWER_CANCELLED']) {
    let calls = 0;
    const app = fixture(t, async () => ++calls === 1
      ? { ok: false, status: 409, json: async () => ({ error, answerStatus: 'cancelled', answered: false,
        cancellationReason: 'LIVE_CONTROL_CHANGED', answer: '', speechText: '' }) }
      : { ok: true, json: async () => ({ answer: '之后新问答正常工作。' }) });
    const messages = [];
    app.elements.conversationLog.append = (message) => messages.push(message);
    await app.askQuestion('已被主持接管的问题。');
    await new Promise(setImmediate);
    assert.equal(app.runtime.flow.state, 'idle');
    assert.equal(app.runtime.requestController, null);
    assert.equal(app.elements.sendButton.disabled, false);
    assert.equal(app.utterances.length, 0);
    assert.equal(messages.length, 2);
    assert.equal(messages[1].removed, true);
    assert.equal(app.events.filter((event) => event.phase === 'request-cancelled').length, 1);
    assert.equal(app.events.some((event) => event.phase === 'request-failed'), false);
    assert.equal(app.runtime.liveTracker.sequence, -1, 'HTTP cancellation never consumes an SSE control sequence');
    await app.askQuestion('现在是新的一轮。');
    assert.equal(app.utterances.at(-1).text, '之后新问答正常工作。');
  }
});

test('实际前台：原有主持模式拒绝新问提示与普通服务故障不误识别为主动取消', async (t) => {
  for (const payload of [
    { error: 'HOSTING_MODE_ACTIVE', answer: '当前处于主持模式，请稍后再提问。', speechText: '当前处于主持模式，请稍后再提问。' },
    { error: 'MODEL_UNAVAILABLE', message: '模型暂时不可用' },
  ]) {
    const app = fixture(t, async () => ({ ok: false, status: 409, json: async () => payload }));
    await app.askQuestion('当前能否提问？');
    assert.equal(app.utterances[0].text, payload.answer || app.runtime.config.serviceErrorText);
    assert.equal(app.events.some((event) => event.phase === 'request-cancelled'), false);
  }
});

test('实际前台：未开始的浏览器语音超时报失败，晚到 start/end 不翻转为完成', async (t) => {
  const app = fixture(t, undefined, { manualTimers: true });
  const live = store();
  app.handleLiveEvent({ data: JSON.stringify(live.present('opening')) });
  await app.runTimers(8_000);
  assert.equal(app.runtime.flow.state, 'idle');
  assert.equal(app.runtime.activeSpeechSequence, null);
  assert.match(app.elements.hostingScriptTitle.textContent, /播报失败/);
  app.utterances[0].handlers.start();
  app.utterances[0].handlers.end();
  assert.equal(app.runtime.flow.state, 'idle');
  assert.match(app.elements.hostingScriptTitle.textContent, /播报失败/);
  await new Promise(setImmediate);
  const failures = app.events.filter((event) => event.phase === 'speech-failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].errorCode, 'SPEECH_START_TIMEOUT');
  assert.equal(app.events.some((event) => event.phase === 'speech-completed'), false);
});

test('实际前台：语音已开始则撤销启动超时，不截断正在进行的播报', async (t) => {
  const app = fixture(t, undefined, { manualTimers: true });
  app.handleLiveEvent({ data: JSON.stringify(store().present('opening')) });
  app.utterances[0].handlers.start();
  await app.runTimers(8_000);
  assert.equal(app.runtime.flow.state, 'presenting');
  app.utterances[0].handlers.end();
  assert.match(app.elements.hostingScriptTitle.textContent, /播报完成/);
  await new Promise(setImmediate);
  assert.equal(app.events.some((event) => event.phase === 'speech-failed'), false);
});

test('实际前台：不支持语音与 speak 同步异常均如实上报，绝不记为完成', async (t) => {
  for (const failure of ['unsupported', 'exception']) {
    const app = fixture(t);
    if (failure === 'unsupported') delete app.browser.speechSynthesis;
    else app.browser.speechSynthesis.speak = () => { throw new Error('mock speech device failure'); };
    app.handleLiveEvent({ data: JSON.stringify(store().present('opening')) });
    assert.equal(app.runtime.flow.state, 'idle');
    assert.match(app.elements.hostingScriptTitle.textContent, /语音不可用|播报失败/);
    await new Promise(setImmediate);
    assert.equal(app.events.some((event) => event.phase === 'speech-completed'), false);
    assert.ok(app.events.some((event) => event.errorCode === (failure === 'unsupported' ? 'SPEECH_UNSUPPORTED' : 'SPEECH_EXCEPTION')));
  }
});

test('对话语音：不支持语音或同步抛错后保留失败提示，下一轮正常播报清除旧提示', async (t) => {
  for (const failure of ['unsupported', 'exception']) {
    const app = fixture(t, async () => ({ ok: true, json: async () => ({ answer: '活动门票免费。' }) }));
    const speech = app.browser.speechSynthesis;
    if (failure === 'unsupported') delete app.browser.speechSynthesis;
    else speech.speak = () => { throw new Error('isolated speech failure'); };
    await app.askQuestion('门票收费吗？');
    assert.equal(app.elements.composerHint.textContent, '语音未能播放，请阅读屏幕上的回答。');
    assert.equal(app.elements.sendButton.disabled, false);
    // A harmless same-generation control sync is not a new user interaction.
    app.handleLiveEvent({ data: JSON.stringify(store().syncEvent()) });
    assert.equal(app.elements.composerHint.textContent, '语音未能播放，请阅读屏幕上的回答。');
    await new Promise(setImmediate);
    assert.ok(app.events.some(event => event.errorCode === (failure === 'unsupported' ? 'SPEECH_UNSUPPORTED' : 'SPEECH_EXCEPTION')));
    assert.equal(app.events.some(event => event.phase === 'speech-completed'), false);

    app.browser.speechSynthesis = speech;
    speech.speak = () => {};
    const next = app.askQuestion('可以介绍一下活动吗？');
    assert.doesNotMatch(app.elements.composerHint.textContent, /语音未能播放/);
    await next;
    app.utterances.at(-1).handlers.start();
    app.utterances.at(-1).handlers.end();
    assert.doesNotMatch(app.elements.composerHint.textContent, /语音未能播放/);
    await new Promise(setImmediate);
    assert.equal(app.events.filter(event => event.phase === 'speech-completed').length, 1);
  }
});

test('对话语音：失败提示不掩盖主持或控制断线，恢复同步后不复活旧错误', async (t) => {
  for (const takeover of ['hosting', 'disconnect']) {
    const app = fixture(t, async () => ({ ok: true, json: async () => ({ answer: '活动门票免费。' }) }));
    delete app.browser.speechSynthesis;
    await app.askQuestion('门票收费吗？');
    assert.match(app.elements.composerHint.textContent, /语音未能播放/);
    const live = store();
    if (takeover === 'hosting') {
      app.handleLiveEvent({ data: JSON.stringify(live.switchMode('hosting')) });
      assert.match(app.elements.composerHint.textContent, /主持模式.*暂停/);
      app.handleLiveEvent({ data: JSON.stringify(live.switchMode('dialogue')) });
    } else {
      app.connectLiveEvents();
      app.connections[0].emit('error');
      assert.match(app.elements.composerHint.textContent, /控制连接中断/);
      app.handleLiveEvent({ data: JSON.stringify(live.syncEvent()) });
    }
    assert.equal(app.runtime.liveMode, 'dialogue');
    assert.equal(app.elements.questionInput.disabled, false);
    assert.doesNotMatch(app.elements.composerHint.textContent, /语音未能播放|主持模式.*暂停|控制连接中断/);
  }
});

test('实际前台：上一条语音的失败与结束回调不能结束下一段主持词', async (t) => {
  const app = fixture(t);
  const live = store();
  app.handleLiveEvent({ data: JSON.stringify(live.present('opening')) });
  const first = app.utterances[0];
  app.handleLiveEvent({ data: JSON.stringify(live.present('opening')) });
  const active = app.runtime.activeSpeechSequence;
  first.handlers.error({ error: 'interrupted' });
  first.handlers.end();
  assert.equal(app.runtime.activeSpeechSequence, active);
  assert.equal(app.runtime.flow.state, 'presenting');
  assert.match(app.elements.hostingScriptTitle.textContent, /正在播报/);
  await new Promise(setImmediate);
  assert.equal(app.events.some((event) => event.phase === 'speech-failed'), false);
  assert.equal(app.events.some((event) => event.phase === 'speech-completed'), false);
});

test('前台日志：断网保持原事件编号与完整失败问答，重试成功后清空持久队列', async (t) => {
  let connected = false;
  const app = fixture(t, undefined, { eventFetch: async () => {
    if (!connected) throw new TypeError('offline');
    return { ok: true };
  } });
  await app.askQuestion('活动门票多少钱？');
  await new Promise(setImmediate);
  const pending = JSON.parse(app.storage.get('digital-human-pending-events'));
  const failure = pending.find((entry) => entry.phase === 'request-failed');
  assert.equal(failure.question, '活动门票多少钱？');
  assert.equal(failure.answer, app.runtime.config.serviceErrorText);
  const pendingIds = pending.map((entry) => entry.eventId);
  const beforeRetry = app.events.length;
  connected = true;
  await app.flushClientEvents();
  assert.deepEqual(app.events.slice(beforeRetry).map((entry) => entry.eventId), pendingIds);
  assert.equal(app.runtime.eventQueue.length, 0);
  assert.equal(app.storage.get('digital-human-pending-events'), '[]');
});

test('前台日志：服务端暂时失败保留队列，永久格式错误丢弃单条后继续发送', async (t) => {
  const replies = [{ ok: false, status: 503 }, { ok: false, status: 400 }, { ok: true }];
  const app = fixture(t, undefined, { eventFetch: async () => replies.shift() ?? { ok: true } });
  const context = { kind: 'dialogue', turnId: 'dialogue-log-test-001' };
  app.reportClientEvent(context, 'request-started');
  await new Promise(setImmediate);
  assert.equal(app.runtime.eventQueue.length, 1);
  const firstId = app.runtime.eventQueue[0].eventId;
  app.reportClientEvent(context, 'request-failed', { question: '测试问题', answer: '请稍后重试。', errorCode: 'CLIENT_CONNECTION_FAILED' });
  await new Promise(setImmediate);
  assert.equal(app.events[0].eventId, firstId);
  assert.equal(app.events[1].eventId, firstId);
  assert.equal(app.events.at(-1).phase, 'request-failed');
  assert.equal(app.runtime.eventQueue.length, 0);
});

test('前台日志：并发触发 flush 不重复发送正在提交的同一事件', async (t) => {
  let release;
  const app = fixture(t, undefined, { eventFetch: () => new Promise((resolve) => { release = resolve; }) });
  app.reportClientEvent({ kind: 'dialogue', turnId: 'dialogue-log-test-002' }, 'request-started');
  await app.flushClientEvents();
  await app.flushClientEvents();
  assert.equal(app.events.length, 1);
  assert.equal(app.runtime.eventsSending, true);
  release({ ok: true });
  await new Promise(setImmediate);
  assert.equal(app.runtime.eventQueue.length, 0);
  assert.equal(app.runtime.eventsSending, false);
});

test('前台日志：在途队首被容量淘汰后，成功或 400 回包只能移除原事件，不能丢下一条', async (t) => {
  for (const status of [200, 400]) {
    for (const count of [201, 205]) {
      const releases = [];
      let calls = 0;
      const app = fixture(t, undefined, { eventFetch: () => {
        calls += 1;
        return calls <= 2 ? new Promise(resolve => releases.push(resolve)) : { ok: true };
      } });
      for (let index = 1; index <= count; index += 1) {
        app.reportClientEvent({ kind: 'dialogue', turnId: `capacity-turn-${index}` }, 'request-started');
      }
      assert.equal(app.runtime.eventQueue.length, 200);
      const retained = Array.from(app.runtime.eventQueue, event => event.eventId);
      const persistedIds = () => JSON.parse(app.storage.get('digital-human-pending-events')).map(event => event.eventId);
      assert.deepEqual(persistedIds(), retained);
      const firstSent = app.events[0].eventId;
      assert.ok(!retained.includes(firstSent));
      releases[0]({ ok: status === 200, status });
      await new Promise(setImmediate);
      assert.equal(app.events[1].eventId, retained[0]);
      assert.deepEqual(persistedIds(), retained, 'the new in-flight head remains durable until its own ACK');
      assert.deepEqual(Array.from(app.runtime.eventQueue, event => event.eventId), retained);
      releases[1]({ ok: true });
      await new Promise(setImmediate);
      assert.deepEqual(app.events.map(event => event.eventId), [firstSent, ...retained]);
      assert.equal(app.runtime.eventQueue.length, 0);
      assert.equal(app.storage.get('digital-human-pending-events'), '[]');
      assert.equal(app.runtime.eventsSending, false);
    }
  }
});

test('前台日志：容量淘汰后收到临时失败或断网不移除保留事件，重试与持久化保持一致', async (t) => {
  for (const failure of ['status', 'network']) {
    let release;
    let reject;
    let calls = 0;
    const app = fixture(t, undefined, { eventFetch: () => {
      calls += 1;
      return calls === 1 ? new Promise((resolve, fail) => { release = resolve; reject = fail; }) : { ok: true };
    } });
    for (let index = 1; index <= 201; index += 1) {
      app.reportClientEvent({ kind: 'dialogue', turnId: `retry-capacity-turn-${index}` }, 'request-started');
    }
    const retained = Array.from(app.runtime.eventQueue, event => event.eventId);
    if (failure === 'status') release({ ok: false, status: 503 });
    else reject(new TypeError('isolated offline'));
    await new Promise(setImmediate);
    assert.equal(app.runtime.eventsSending, false);
    assert.deepEqual(Array.from(app.runtime.eventQueue, event => event.eventId), retained);
    assert.deepEqual(JSON.parse(app.storage.get('digital-human-pending-events')).map(event => event.eventId), retained);
    await app.flushClientEvents();
    assert.deepEqual(app.events.slice(1).map(event => event.eventId), retained);
    assert.equal(app.storage.get('digital-human-pending-events'), '[]');
  }
});

test('REVIEW-AVATAR-001：响应头或响应正文悬挂时，都应在有限等待后使用自然兜底', async (t) => {
  const outcomes = [];
  for (const phase of ['headers', 'body']) {
    const app = fixture(t, async (_url, options) => {
      const hangUntilAborted = () => new Promise((_resolve, reject) => {
        if (options.signal.aborted) reject(options.signal.reason);
        else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
      return phase === 'headers' ? hangUntilAborted() : { ok: true, json: hangUntilAborted };
    }, { manualTimers: true });
    void app.askQuestion('活动门票多少钱？');
    await new Promise(setImmediate);
    // Model maximum is 120 s, rewrite maximum is 5 s. Three minutes leaves
    // ample transport/UI margin. Both ordinary timers and AbortSignal.timeout
    // use this fake clock, and the fetch mock faithfully handles cancellation.
    await app.runTimers(180_000);
    await new Promise(setImmediate);
    outcomes.push({ phase, fallbackSpoken: app.utterances[0]?.text === app.runtime.config.serviceErrorText });
  }
  assert.deepEqual(outcomes, [
    { phase: 'headers', fallbackSpoken: true },
    { phase: 'body', fallbackSpoken: true },
  ]);
});

test('REVIEW-AVATAR-001：140 秒前不提前超时，到期记录完整失败问答并恢复下一轮发送', async (t) => {
  let calls = 0;
  const app = fixture(t, async (_url, options) => {
    calls += 1;
    if (calls > 1) return { ok: true, json: async () => ({ answer: '恢复连接后的正常回答。' }) };
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  }, { manualTimers: true });
  app.runtime.config = { ...app.runtime.config, serviceErrorText: '连接暂时不顺畅，请稍后再试。' };
  const pending = app.askQuestion('需要多少门票费用？');
  await app.runTimers(139_999);
  assert.equal(app.utterances.length, 0);
  assert.equal(app.elements.sendButton.disabled, true);
  assert.equal(app.runtime.flow.state, 'thinking');
  await app.runTimers(1);
  await pending;
  assert.equal(app.utterances[0].text, app.runtime.config.serviceErrorText);
  assert.equal(app.runtime.requestController, null);
  assert.equal(app.elements.sendButton.disabled, true, 'fallback speech must finish before sending');
  const failures = app.events.filter((entry) => entry.phase === 'request-failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].errorCode, 'CLIENT_REQUEST_TIMEOUT');
  assert.equal(failures[0].question, '需要多少门票费用？');
  assert.equal(failures[0].answer, app.runtime.config.serviceErrorText);
  assert.equal(failures[0].durationMs, 140_000);
  assert.equal(failures[0].turnId, app.fetchCalls.find((call) => call.url === '/answer').options.headers['X-Conversation-Id']);
  assert.equal([...app.timers.values()].some((timer) => timer.due === 140_000), false);

  app.utterances[0].handlers.start();
  app.utterances[0].handlers.end();
  assert.equal(app.elements.sendButton.disabled, false);
  const next = app.askQuestion('现在可以回答了吗？');
  await app.runTimers(520);
  await next;
  assert.equal(app.utterances.at(-1).text, '恢复连接后的正常回答。');
  assert.equal(app.elements.sendButton.disabled, true);
  app.utterances.at(-1).handlers.start();
  app.utterances.at(-1).handlers.end();
  assert.equal(app.elements.sendButton.disabled, false);
  assert.equal([...app.timers.values()].some((timer) => timer.due === 280_000), false);
  await app.runTimers(180_000);
  assert.equal(app.events.filter((entry) => entry.phase === 'request-failed').length, 1);
});

test('REVIEW-AVATAR-001：最长模型与改写预算内返回的合法长请求仍正常播报', async (t) => {
  let release;
  const app = fixture(t, async () => new Promise((resolve) => { release = resolve; }), { manualTimers: true });
  const pending = app.askQuestion('请综合资料回答。');
  await app.runTimers(125_000);
  assert.equal(app.utterances.length, 0);
  release({ ok: true, json: async () => ({ answer: '在最长模型预算内完成的回答。' }) });
  await pending;
  assert.equal(app.utterances[0].text, '在最长模型预算内完成的回答。');
  assert.equal([...app.timers.values()].some((timer) => timer.due === 140_000), false);
  await app.runTimers(60_000);
  assert.equal(app.events.some((entry) => entry.errorCode === 'CLIENT_REQUEST_TIMEOUT'), false);
});

test('REVIEW-AVATAR-001：忽略 abort 的晚到响应头或正文都不能复活超时回答', async (t) => {
  for (const phase of ['headers', 'body']) {
    let release;
    const late = new Promise((resolve) => { release = resolve; });
    const app = fixture(t, async () => phase === 'headers'
      ? late : { ok: true, json: () => late }, { manualTimers: true });
    const messages = [];
    app.elements.conversationLog.append = (message) => messages.push(message);
    const pending = app.askQuestion('这个问题的回答不要晚到复活。');
    await app.runTimers(140_000);
    await pending;
    assert.equal(app.utterances.length, 1);
    assert.equal(app.utterances[0].text, app.runtime.config.serviceErrorText);
    assert.equal(messages[1].removed, true);
    assert.equal(app.elements.sendButton.disabled, true, 'fallback audio is still preparing');
    const result = { answer: '不应重新播报的迟到答案。' };
    let lateBodyReads = 0;
    release(phase === 'headers' ? { ok: true, json: async () => { lateBodyReads += 1; return result; } } : result);
    await new Promise(setImmediate);
    assert.equal(lateBodyReads, 0, 'cancelled late headers must not start another body read');
    assert.equal(app.utterances.length, 1);
    assert.equal(messages.length, 3, 'only question, removed pending message and fallback may be appended');
    assert.equal(app.events.filter((entry) => entry.phase === 'request-failed').length, 1);
  }
});

test('REVIEW-AVATAR-001：主持接管取消悬挂请求，不产生超时兜底或残留截止定时器', async (t) => {
  let release;
  const app = fixture(t, async () => new Promise((resolve) => { release = resolve; }), { manualTimers: true });
  const pending = app.askQuestion('主持人即将接管。');
  await app.runTimers(2_000);
  app.handleLiveEvent({ data: JSON.stringify(store().present('opening')) });
  await pending;
  assert.equal(app.runtime.liveMode, 'hosting');
  assert.equal(app.utterances.length, 1);
  assert.equal(app.utterances[0].text, '欢迎来到现场。');
  assert.equal([...app.timers.values()].some((timer) => timer.due === 140_000), false);
  await app.runTimers(180_000);
  release({ ok: true, json: async () => ({ answer: '不应再出现的问答内容。' }) });
  await new Promise(setImmediate);
  assert.equal(app.utterances.length, 1);
  assert.equal(app.events.filter((entry) => entry.phase === 'request-cancelled').length, 1);
  assert.equal(app.events.some((entry) => entry.phase === 'request-failed'), false);
});

test('REVIEW-AVATAR-001：明确取消旧请求后，旧取消或截止时间不影响新回答', async (t) => {
  let releaseOld;
  let calls = 0;
  const app = fixture(t, async () => {
    calls += 1;
    return calls === 1 ? new Promise((resolve) => { releaseOld = resolve; })
      : { ok: true, json: async () => ({ answer: '只播报这条新回答。' }) };
  }, { manualTimers: true });
  const old = app.askQuestion('过时的问题。');
  await app.runTimers(1_000);
  app.evaluate("cancelActiveInteraction('explicit-cancellation')");
  const next = app.askQuestion('请回答这个新问题。');
  await app.runTimers(520);
  await Promise.all([old, next]);
  assert.equal(app.utterances.length, 1);
  assert.equal(app.utterances[0].text, '只播报这条新回答。');
  assert.equal(app.elements.sendButton.disabled, true, 'answer audio is still preparing');
  releaseOld({ ok: true, json: async () => ({ answer: '旧问题的迟到回答。' }) });
  await app.runTimers(180_000);
  assert.equal(app.utterances.length, 1);
  assert.equal(app.events.filter((entry) => entry.phase === 'request-cancelled').length, 1);
  assert.equal(app.events.some((entry) => entry.phase === 'request-failed'), false);
});

function prepareComposer(app) {
  app.browser.SpeechRecognition = class {
    start() { this.starts = (this.starts ?? 0) + 1; }
    stop() {}
    abort() {}
  };
  app.evaluate(`runtime.voiceInput = new BrowserVoiceInput({
    button: elements.voiceInputButton, input: elements.questionInput,
    form: elements.questionForm, hint: elements.composerHint,
    onBeforeStart: prepareForVoiceInput, onTranscript: resizeComposer,
  });`);
  const previewButtons = AVATAR_STATES.map(state => ({ dataset: { previewState: state }, disabled: false,
    classList: { toggle() {} }, listeners: {}, addEventListener(name, handler) { this.listeners[name] = handler; } }));
  app.elements.previewPanel.querySelectorAll = () => previewButtons;
  app.bindEvents();
  app.elements.questionForm.requestSubmit = () => app.elements.questionForm.listeners.submit({ preventDefault() {} });
  return previewButtons;
}

const answerResponse = async () => ({ ok: true, json: async () => ({ answer: '第一题的回答继续播报。' }) });

test('播报交互：生成、准备语音和播放期间均可编辑草稿，但不能重复提交或覆盖当前轮次', async (t) => {
  let release;
  const app = fixture(t, () => new Promise(resolve => { release = resolve; }));
  const previews = prepareComposer(app);
  const pending = app.askQuestion('第一题');
  const controller = app.runtime.requestController;
  const sequence = app.runtime.flow.requestSequence;
  const cancellations = app.cancels;
  for (const phase of ['request', 'preparing', 'playing']) {
    if (phase === 'preparing') { release(await answerResponse()); await pending; }
    if (phase === 'playing') app.utterances[0].handlers.start();
    app.elements.questionInput.value = `预备第二题 ${phase}`;
    app.elements.questionInput.listeners.input();
    app.elements.questionInput.listeners.focus();
    assert.equal(app.elements.questionInput.disabled, false);
    assert.equal(app.elements.sendButton.disabled, true);
    assert.equal(app.elements.voiceInputButton.disabled, true);
    assert.ok(previews.every(button => button.disabled));
    app.elements.questionForm.requestSubmit();
    await app.askQuestion('不能绕过表单重复发送');
    assert.equal(app.elements.questionInput.value, `预备第二题 ${phase}`);
    assert.equal(app.runtime.flow.requestSequence, sequence);
    assert.equal(controller.signal.aborted, false);
    assert.equal(app.fetchCalls.filter(call => call.url === '/answer').length, 1);
  }
  // speakText itself clears old speech once; incidental input must not add cancels.
  assert.equal(app.cancels, cancellations + 1);
  assert.match(app.elements.composerHint.textContent, /正在播报.*输入下一题/);
  app.utterances[0].handlers.end();
  assert.equal(app.elements.sendButton.disabled, false);
  assert.equal(app.elements.voiceInputButton.disabled, false);
  assert.ok(previews.every(button => !button.disabled));
  assert.equal(app.elements.questionInput.value, '预备第二题 playing');
});

test('播报交互：麦克风、快捷问题和预览的直接回调也不能中止回答或丢失草稿', async (t) => {
  const app = fixture(t, answerResponse);
  const previews = prepareComposer(app);
  const quickButtons = [];
  app.runtime.config = { ...app.runtime.config, quickQuestions: ['快捷问题'] };
  app.elements.quickQuestions.replaceChildren = () => { quickButtons.length = 0; };
  app.elements.quickQuestions.append = button => quickButtons.push(button);
  app.elements.quickQuestions.querySelectorAll = () => quickButtons;
  app.evaluate('renderQuickQuestions()');
  await app.askQuestion('第一题');
  app.utterances[0].handlers.start();
  app.elements.questionInput.value = '不要丢失我的草稿';
  const cancellations = app.cancels;
  for (const button of previews) button.listeners.click();
  quickButtons[0].listeners.click();
  app.elements.voiceInputButton.listeners.click();
  app.runtime.voiceInput.start();
  assert.equal(app.evaluate('prepareForVoiceInput()'), false);
  assert.equal(app.runtime.flow.state, 'speaking');
  assert.equal(app.cancels, cancellations);
  assert.equal(app.elements.questionInput.value, '不要丢失我的草稿');
  assert.equal(app.runtime.voiceInput.recognition.starts, undefined);
  assert.equal(quickButtons[0].disabled, true);
  app.utterances[0].handlers.end();
  previews[3].listeners.click();
  assert.equal(app.runtime.flow.state, 'presenting', 'preview remains usable when idle');
  assert.ok(previews.every(button => !button.disabled), 'manual preview must not lock its own controls');
  previews[0].listeners.click();
  assert.equal(app.runtime.flow.state, 'idle');
});

test('输入法：中文组词和旧版 229 确认键不发送，播报中 Enter 保留草稿，结束后才发送', async (t) => {
  const app = fixture(t, answerResponse);
  prepareComposer(app);
  app.elements.questionInput.value = '输入法确认的草稿';
  const keydown = app.elements.questionInput.listeners.keydown;
  keydown({ key: 'Enter', isComposing: true, preventDefault() {} });
  keydown({ key: 'Enter', keyCode: 229, preventDefault() {} });
  app.elements.questionInput.listeners.compositionstart();
  keydown({ key: 'Enter', preventDefault() {} });
  app.elements.questionInput.listeners.compositionend();
  assert.equal(app.fetchCalls.filter(call => call.url === '/answer').length, 0);
  await app.askQuestion('第一题');
  app.utterances[0].handlers.start();
  keydown({ key: 'Enter', preventDefault() {} });
  assert.equal(app.elements.questionInput.value, '输入法确认的草稿');
  assert.equal(app.utterances.length, 1);
  app.utterances[0].handlers.end();
  keydown({ key: 'Enter', preventDefault() {} });
  await new Promise(setImmediate);
  assert.equal(app.elements.questionInput.value, '');
  assert.equal(app.fetchCalls.filter(call => call.url === '/answer').length, 2);
});

test('播报交互：错误、启动超时和明确静音都释放发送锁，草稿不被自动提交', async (t) => {
  for (const outcome of ['error', 'timeout', 'mute']) {
    const app = fixture(t, answerResponse, { manualTimers: true });
    prepareComposer(app);
    const pending = app.askQuestion('第一题');
    await app.runTimers(520);
    await pending;
    app.elements.questionInput.value = '下一题草稿';
    if (outcome === 'timeout') await app.runTimers(8_000);
    else if (outcome === 'error') app.utterances[0].handlers.error({ error: 'audio-busy' });
    else app.elements.soundToggle.listeners.click();
    assert.equal(app.runtime.flow.state, 'idle');
    assert.equal(app.elements.sendButton.disabled, false);
    assert.equal(app.elements.voiceInputButton.disabled, false);
    assert.equal(app.elements.questionInput.value, '下一题草稿');
    assert.equal(app.fetchCalls.filter(call => call.url === '/answer').length, 1);
  }
});

test('男声：voiceschanged 重排或增加更优先音色，不更换已选的男声', async (t) => {
  const app = fixture(t, answerResponse);
  const male = app.browser.speechSynthesis.getVoices()[0];
  app.evaluate('prepareSpeechVoices()');
  await app.askQuestion('第一题');
  app.utterances[0].handlers.start();
  app.browser.speechSynthesis.getVoices = () => [
    { name: '婷婷', voiceURI: 'tingting', lang: 'zh-CN', localService: true },
    { name: 'Reed (中文（中国大陆）)', voiceURI: 'reed', lang: 'zh-CN', localService: true },
    { ...male },
  ];
  app.voicesChanged();
  assert.equal(app.runtime.preferredSpeechVoice.voiceURI, male.voiceURI);
  assert.equal(app.utterances[0].voice.voiceURI, male.voiceURI);
  app.utterances[0].handlers.end();
  await app.askQuestion('第二题');
  assert.equal(app.utterances[1].voice.voiceURI, male.voiceURI);
});

test('播报交互：浏览器丢失结束事件时有界恢复，迟到回调不能误结束下一题', async (t) => {
  const app = fixture(t, answerResponse, { manualTimers: true });
  prepareComposer(app);
  const pending = app.askQuestion('第一题');
  await app.runTimers(520);
  await pending;
  const oldSpeech = app.spoken[0];
  oldSpeech.handlers.start();
  app.elements.questionInput.value = '下一题草稿';
  await app.runTimers(59_999);
  assert.equal(app.elements.sendButton.disabled, true);
  await app.runTimers(1);
  assert.equal(app.elements.sendButton.disabled, false);
  assert.equal(app.elements.questionInput.value, '下一题草稿');
  assert.ok(app.events.some(event => event.errorCode === 'SPEECH_PLAYBACK_TIMEOUT'));
  const next = app.askQuestion('第二题');
  await app.runTimers(520);
  await next;
  app.spoken[1].handlers.start();
  oldSpeech.handlers.end();
  oldSpeech.handlers.error({ error: 'interrupted' });
  assert.equal(app.runtime.flow.state, 'speaking');
  assert.equal(app.elements.sendButton.disabled, true);
  app.spoken[1].handlers.end();
  assert.equal(app.elements.sendButton.disabled, false);
});

test('播报交互：长文按长度延长播放预算，正常结束后清除恢复定时器', async (t) => {
  const app = fixture(t, async () => ({ ok: true, json: async () => ({ answer: '继续介绍活动详情。'.repeat(20) }) }), { manualTimers: true });
  const pending = app.askQuestion('详细介绍');
  await app.runTimers(520);
  await pending;
  app.spoken[0].handlers.start();
  await app.runTimers(60_000);
  assert.equal(app.runtime.flow.state, 'speaking');
  app.spoken[0].handlers.end();
  await app.runTimers(240_000);
  assert.equal(app.events.some(event => event.errorCode === 'SPEECH_PLAYBACK_TIMEOUT'), false);
});

test('男声：声音列表为空、只有女声或未知中文声音时不使用系统默认，超时转文字并恢复输入', async (t) => {
  for (const voices of [[], [{ name: '婷婷', lang: 'zh-CN' }], [{ name: 'Chinese', lang: 'zh-CN', default: true }]]) {
    const app = fixture(t, answerResponse, { manualTimers: true });
    prepareComposer(app);
    app.browser.speechSynthesis.getVoices = () => voices;
    app.evaluate('prepareSpeechVoices()');
    const pending = app.askQuestion('第一题');
    await app.runTimers(520);
    await pending;
    app.elements.questionInput.value = '下一题';
    assert.equal(app.spoken.length, 0);
    assert.equal(app.elements.sendButton.disabled, true);
    await app.runTimers(1_500);
    assert.equal(app.spoken.length, 0);
    assert.equal(app.runtime.flow.state, 'idle');
    assert.equal(app.elements.sendButton.disabled, false);
    assert.equal(app.elements.questionInput.value, '下一题');
    assert.match(app.elements.composerHint.textContent, /男声.*文字/);
    assert.ok(app.events.some(event => event.errorCode === 'MALE_VOICE_UNAVAILABLE'));
  }
});

test('男声：延迟加载只启动一次，已锁定音色暂时消失时等待恢复而不使用女声', async (t) => {
  const app = fixture(t, answerResponse, { manualTimers: true });
  const male = app.browser.speechSynthesis.getVoices()[0];
  app.evaluate('prepareSpeechVoices()');
  app.browser.speechSynthesis.getVoices = () => [{ name: '婷婷', lang: 'zh-CN' }];
  app.voicesChanged();
  const pending = app.askQuestion('第一题');
  await app.runTimers(520);
  await pending;
  assert.equal(app.spoken.length, 0, 'never speak with a stale voice object');
  app.browser.speechSynthesis.getVoices = () => [{ ...male }];
  app.voicesChanged();
  app.voicesChanged();
  assert.equal(app.spoken.length, 1);
  assert.equal(app.spoken[0].voice.voiceURI, male.voiceURI);
  assert.equal(app.runtime.flow.reason, 'audio-preparing');
  app.spoken[0].handlers.start();
  await app.runTimers(1_500);
  assert.equal(app.runtime.flow.state, 'speaking');
  assert.equal(app.spoken.length, 1);
});

test('男声：等待音色时被后台停止，迟到的 voiceschanged 不会复活播报', async (t) => {
  const app = fixture(t, undefined, { manualTimers: true });
  const male = app.browser.speechSynthesis.getVoices()[0];
  app.browser.speechSynthesis.getVoices = () => [];
  app.evaluate('prepareSpeechVoices()');
  const live = store();
  app.handleLiveEvent({ data: JSON.stringify(live.present('opening')) });
  assert.equal(app.spoken.length, 0);
  app.handleLiveEvent({ data: JSON.stringify(live.stop()) });
  app.browser.speechSynthesis.getVoices = () => [male];
  app.voicesChanged();
  await app.runTimers(10_000);
  assert.equal(app.spoken.length, 0);
  assert.equal(app.runtime.flow.state, 'idle');
});

test('录音竞态：中止后的迟到 start/result/error 不改变草稿或恢复录音', (t) => {
  const app = fixture(t);
  prepareComposer(app);
  app.runtime.voiceInput.start();
  app.runtime.voiceInput.abort();
  app.elements.questionInput.value = '正在准备的下一题';
  const voice = app.runtime.voiceInput;
  voice.handleStart();
  voice.handleResult({ results: [Object.assign([{ transcript: '过时的识别文本' }], { isFinal: true })] });
  voice.handleError({ error: 'network' });
  voice.handleEnd();
  assert.equal(voice.active, false);
  assert.equal(app.elements.questionInput.value, '正在准备的下一题');
  assert.equal(voice.errorMessage, '');
});

test('录音竞态：延迟自动提交前取消或修改草稿，不发送后来输入的新问题', async (t) => {
  for (const action of ['abort', 'edit']) {
    const app = fixture(t, answerResponse, { manualTimers: true });
    prepareComposer(app);
    const voice = app.runtime.voiceInput;
    voice.start();
    voice.handleStart();
    voice.handleResult({ results: [Object.assign([{ transcript: '识别结果' }], { isFinal: true })] });
    voice.handleEnd();
    if (action === 'abort') voice.abort();
    else app.elements.questionInput.value = '用户改写的草稿';
    await app.runTimers(0);
    assert.equal(app.fetchCalls.filter(call => call.url === '/answer').length, 0);
  }
});

test('录音竞态：重新录音后，旧实例的所有迟到事件都不能覆盖新会话', (t) => {
  const app = fixture(t);
  prepareComposer(app);
  const voice = app.runtime.voiceInput;
  voice.start();
  const old = voice.recognition;
  voice.abort();
  voice.start();
  const current = voice.recognition;
  assert.notEqual(current, old);
  current.onstart();
  app.elements.questionInput.value = '新会话中的文字';
  old.onstart();
  old.onresult({ results: [Object.assign([{ transcript: '旧的识别结果' }], { isFinal: true })] });
  old.onerror({ error: 'network' });
  old.onend();
  assert.equal(voice.active, true);
  assert.equal(voice.errorMessage, '');
  assert.equal(app.elements.questionInput.value, '新会话中的文字');
});

test('录音正常路径：结束后自动提交一次，播报结束后可开始下一次录音', async (t) => {
  const app = fixture(t, answerResponse, { manualTimers: true });
  prepareComposer(app);
  const voice = app.runtime.voiceInput;
  voice.start();
  voice.recognition.onstart();
  voice.recognition.onresult({ results: [Object.assign([{ transcript: '语音问题' }], { isFinal: true })] });
  voice.recognition.onend();
  await app.runTimers(520);
  assert.equal(app.fetchCalls.filter(call => call.url === '/answer').length, 1);
  assert.equal(app.elements.questionInput.value, '');
  assert.equal(app.spoken.length, 1);
  app.spoken[0].handlers.start();
  app.spoken[0].handlers.end();
  voice.start();
  assert.equal(voice.active, true);
  assert.equal(voice.recognition.starts, 1);
});

test('语音设备异常：枚举音色或创建 utterance 抛错都能恢复提问，不使用默认女声', async (t) => {
  for (const failure of ['voices', 'utterance']) {
    const app = fixture(t, answerResponse, { manualTimers: true });
    prepareComposer(app);
    if (failure === 'voices') app.browser.speechSynthesis.getVoices = () => { throw new Error('device unavailable'); };
    else app.evaluate('globalThis.SpeechSynthesisUtterance = class { constructor() { throw new Error("device unavailable"); } };');
    app.evaluate('prepareSpeechVoices()');
    const pending = app.askQuestion('第一题');
    await app.runTimers(2_020);
    await pending;
    assert.equal(app.spoken.length, 0);
    assert.equal(app.elements.sendButton.disabled, false);
    assert.equal(app.runtime.flow.state, 'idle');
  }
});
