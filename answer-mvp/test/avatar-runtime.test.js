import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { AvatarFlow, AVATAR_STATES, LiveStateTracker } from '../public/avatar-flow.js';
import { LiveControlStore } from '../live-control-store.js';

const source = (await readFile(new URL('../public/avatar.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/, '').replace(/void start\(\);\s*$/, '');

function fixture(t, fetchOverride) {
  const element = () => ({ textContent: '', hidden: false, disabled: false, dataset: {},
    classList: { add() {}, remove() {}, toggle() {} }, style: {},
    setAttribute() {}, querySelectorAll() { return []; }, append() {}, remove() { this.removed = true; }, scrollTo() {},
  });
  const events = [];
  const utterances = [];
  let cancels = 0;
  let now = 0;
  class Utterance {
    constructor(text) { this.text = text; this.handlers = {}; utterances.push(this); }
    addEventListener(name, handler) { this.handlers[name] = handler; }
  }
  const context = vm.createContext({
    AvatarFlow, AVATAR_STATES, LiveStateTracker, console, AbortController, AbortSignal,
    SpeechSynthesisUtterance: Utterance,
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; }, clearTimeout,
    performance: { now: () => (now += 600) },
    sessionStorage: { setItem() {}, getItem() { return null; } },
    document: { querySelector: element, querySelectorAll: () => [], createElement: element, body: { dataset: {} } },
    window: { EventSource: class {}, speechSynthesis: { cancel() { cancels++; }, speak() {}, getVoices: () => [] }, SpeechSynthesisUtterance: Utterance },
    fetch: async (url, options) => {
      if (url === '/api/client-events') { events.push(JSON.parse(options.body)); return { ok: true }; }
      if (fetchOverride) return fetchOverride(url, options);
      throw new Error('offline');
    },
  });
  vm.runInContext(source + '\nglobalThis.api = {runtime,elements,handleLiveEvent,refreshHealth,speakText,askQuestion,stopSpeech};', context);
  const api = context.api;
  api.runtime.flow = new AvatarFlow();
  api.runtime.videoSwitcher = { show() {} };
  t.after(() => api.stopSpeech());
  return { ...api, events, utterances, get cancels() { return cancels; } };
}

function store() {
  const value = new LiveControlStore({ configPath: '/unused', logger: {} });
  value.scripts = [{ id: 'opening', title: '开场', text: '欢迎来到现场。' }];
  return value;
}

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
