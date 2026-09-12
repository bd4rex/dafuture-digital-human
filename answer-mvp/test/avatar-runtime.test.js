import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { AvatarFlow, AVATAR_STATES, LiveStateTracker } from '../public/avatar-flow.js';
import { LiveControlStore } from '../live-control-store.js';

const source = (await readFile(new URL('../public/avatar.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '').replace(/void start\(\);\s*$/, '');

function fixture(t, fetchOverride, { clockStep = 600, manualTimers = false, eventFetch } = {}) {
  const element = () => ({ textContent: '', hidden: false, disabled: false, dataset: {},
    classList: { add() {}, remove() {}, toggle() {} }, style: {},
    setAttribute() {}, querySelectorAll() { return []; }, append() {}, remove() { this.removed = true; }, scrollTo() {},
  });
  const events = [];
  const utterances = [];
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
    EventSource: EventSourceMock, speechSynthesis: { cancel() { cancels++; }, speak() {}, getVoices: () => [] }, SpeechSynthesisUtterance: Utterance,
    setTimeout: scheduleTimer, clearTimeout: cancelTimer, performance: performanceClock,
    Date: dateClock, AbortController, AbortSignal: signalApi,
  };
  const context = vm.createContext({
    AvatarFlow, AVATAR_STATES, LiveStateTracker, console, AbortController, AbortSignal: signalApi,
    SpeechSynthesisUtterance: Utterance,
    setTimeout: scheduleTimer,
    clearTimeout: cancelTimer,
    Date: dateClock,
    performance: performanceClock,
    sessionStorage: { setItem(key, value) { storage.set(key, value); }, getItem(key) { return storage.get(key) ?? null; } },
    document: { querySelector: element, querySelectorAll: () => [], createElement: element, body: { dataset: {} } },
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
  vm.runInContext(source + '\nglobalThis.api = {runtime,elements,handleLiveEvent,refreshHealth,speakText,askQuestion,stopSpeech,connectLiveEvents,loadLiveState,flushClientEvents,reportClientEvent};', context);
  const api = context.api;
  api.runtime.flow = new AvatarFlow();
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
  return { ...api, events, utterances, timerCalls, timers, runTimers, evaluate, storage, connections, fetchCalls, browser, get cancels() { return cancels; } };
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
  assert.equal(app.elements.sendButton.disabled, false);
  const failures = app.events.filter((entry) => entry.phase === 'request-failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].errorCode, 'CLIENT_REQUEST_TIMEOUT');
  assert.equal(failures[0].question, '需要多少门票费用？');
  assert.equal(failures[0].answer, app.runtime.config.serviceErrorText);
  assert.equal(failures[0].durationMs, 140_000);
  assert.equal(failures[0].turnId, app.fetchCalls.find((call) => call.url === '/answer').options.headers['X-Conversation-Id']);
  assert.equal([...app.timers.values()].some((timer) => timer.due === 140_000), false);

  const next = app.askQuestion('现在可以回答了吗？');
  await app.runTimers(520);
  await next;
  assert.equal(app.utterances.at(-1).text, '恢复连接后的正常回答。');
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
    assert.equal(app.elements.sendButton.disabled, false);
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

test('REVIEW-AVATAR-001：新问题取消旧请求后，旧取消或截止时间不影响新回答', async (t) => {
  let releaseOld;
  let calls = 0;
  const app = fixture(t, async () => {
    calls += 1;
    return calls === 1 ? new Promise((resolve) => { releaseOld = resolve; })
      : { ok: true, json: async () => ({ answer: '只播报这条新回答。' }) };
  }, { manualTimers: true });
  const old = app.askQuestion('过时的问题。');
  await app.runTimers(1_000);
  const next = app.askQuestion('请回答这个新问题。');
  await app.runTimers(520);
  await Promise.all([old, next]);
  assert.equal(app.utterances.length, 1);
  assert.equal(app.utterances[0].text, '只播报这条新回答。');
  assert.equal(app.elements.sendButton.disabled, false);
  releaseOld({ ok: true, json: async () => ({ answer: '旧问题的迟到回答。' }) });
  await app.runTimers(180_000);
  assert.equal(app.utterances.length, 1);
  assert.equal(app.events.filter((entry) => entry.phase === 'request-cancelled').length, 1);
  assert.equal(app.events.some((entry) => entry.phase === 'request-failed'), false);
});
