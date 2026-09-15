import { AvatarFlow, AVATAR_STATES, LiveStateTracker } from './avatar-flow.js';
import { AvatarVideoSwitcher } from './avatar-media.js';

const DEFAULT_CONFIG = Object.freeze({
  characterName: '大未来',
  presentationText: '大家好，欢迎来到大未来数字人问答体验。',
  speech: {
    provider: 'browser',
    gender: 'male',
    preferredVoiceNames: [
      'Reed',
      'Eddy',
      'Rocko',
      'Yunxi',
      '云希',
      'Yunjian',
      '云健',
      'Yunyang',
      '云扬',
      'Kangkang',
      '康康',
      'Grandpa',
    ],
    rate: 0.98,
    pitch: 0.98,
  },
  speechInput: {
    provider: 'browser',
    language: 'zh-CN',
    interimResults: true,
    autoSubmit: true,
  },
  quickQuestions: [],
  contentRevision: null,
  serviceErrorText: '抱歉，我现在暂时无法完成查询。请稍后再试，或者请工作人员帮您进一步确认。',
  states: {
    idle: { label: '随时可以开始', hint: '等待你的问题', sources: [] },
    thinking: { label: '正在思考', hint: '正在调用大语言模型', sources: [] },
    speaking: { label: '正在回答', hint: '答案播报中', sources: [] },
    presenting: { label: '主持模式', hint: '正在进行开场介绍', sources: [] },
  },
});

const DEFAULT_COMPOSER_HINT =
  '输入文字或点击麦克风提问 · AI 回答仅供参考';
const CONTROL_INTERRUPTED_HINT =
  '控制连接中断，已暂停提问与播报；同步完成后可继续';
const SPEECH_FAILURE_HINT = '语音未能播放，请阅读屏幕上的回答。';
const MALE_VOICE_UNAVAILABLE_HINT = '当前设备的指定男声不可用，已保留文字回答；不会自动切换其他声音。';
const VOICE_READY_TIMEOUT_MS = 1_500;

// Final transport deadline: maximum model budget (120 s), query rewrite (5 s)
// and 15 s for transport. Keep it independent of cached configuration so a
// newly increased server timeout cannot make a valid request expire early.
const ANSWER_REQUEST_TIMEOUT_MS = 140_000;

const elements = {
  servicePill: document.querySelector('#service-pill'),
  serviceLabel: document.querySelector('#service-label'),
  liveModePill: document.querySelector('#live-mode-pill'),
  liveModeLabel: document.querySelector('#live-mode-label'),
  soundToggle: document.querySelector('#sound-toggle'),
  soundLabel: document.querySelector('#sound-label'),
  stateLabel: document.querySelector('#avatar-state-label'),
  stateHint: document.querySelector('#avatar-state-hint'),
  stage: document.querySelector('#avatar-stage'),
  videos: [...document.querySelectorAll('[data-avatar-video]')],
  poster: document.querySelector('#avatar-poster'),
  mediaNote: document.querySelector('#media-note'),
  mediaNoteCopy: document.querySelector('#media-note-copy'),
  mediaRetry: document.querySelector('#media-retry'),
  mediaDebug: document.querySelector('#media-debug'),
  avatarName: document.querySelector('#avatar-name'),
  conversationLog: document.querySelector('#conversation-log'),
  quickQuestions: document.querySelector('#quick-question-list'),
  questionForm: document.querySelector('#question-form'),
  questionInput: document.querySelector('#question-input'),
  voiceInputButton: document.querySelector('#voice-input-button'),
  sendButton: document.querySelector('#send-button'),
  composerHint: document.querySelector('#composer-hint'),
  conversationTitle: document.querySelector('#conversation-title'),
  hostingBanner: document.querySelector('#hosting-banner'),
  hostingScriptTitle: document.querySelector('#hosting-script-title'),
  hostingScriptPreview: document.querySelector('#hosting-script-preview'),
  previewPanel: document.querySelector('#preview-panel'),
};

const runtime = {
  config: DEFAULT_CONFIG,
  flow: null,
  videoSwitcher: null,
  requestController: null,
  speechUtterance: null,
  activeSpeechSequence: null,
  preferredSpeechVoice: null,
  voiceInput: null,
  previewTimer: null,
  soundEnabled: true,
  liveMode: 'dialogue',
  liveSequence: -1,
  liveEventSource: null,
  liveConnected: false,
  liveControlInterrupted: false,
  lastHostedScriptTitle: '',
  liveTracker: new LiveStateTracker(),
  hostingCommandSequence: null,
  speechContext: null,
  speechStartTimer: null,
  speechEndTimer: null,
  voiceReadyTimer: null,
  pendingSpeechStart: null,
  speechErrorCode: '',
  composingQuestion: false,
  clientId: createClientId(),
  eventQueue: [],
  eventsSending: false,
};

function createClientId() {
  return globalThis.crypto?.randomUUID?.() ?? `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function persistClientEvents() {
  try { sessionStorage.setItem('digital-human-pending-events', JSON.stringify(runtime.eventQueue)); } catch { /* Private mode or quota. */ }
}

function reportClientEvent(context, phase, extra = {}) {
  if (!context) return;
  const { kind, turnId, instanceId, commandSequence } = context;
  runtime.eventQueue.push({
    eventId: createClientId(), clientId: runtime.clientId, kind, phase,
    ...(kind === 'dialogue' ? { turnId } : { instanceId, commandSequence }),
    ...extra,
  });
  if (runtime.eventQueue.length > 200) runtime.eventQueue.shift();
  persistClientEvents();
  void flushClientEvents();
}

async function flushClientEvents() {
  if (runtime.eventsSending) return;
  runtime.eventsSending = true;
  try {
    while (runtime.eventQueue.length) {
      const event = runtime.eventQueue[0];
      const response = await fetch('/api/client-events', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event), keepalive: true,
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok && response.status !== 400) break;
      // New reports can evict an in-flight head at the capacity limit. Its
      // late acknowledgement must not remove a different, unsent event.
      const acknowledgedIndex = runtime.eventQueue.findIndex(queued => queued.eventId === event.eventId);
      if (acknowledgedIndex !== -1) runtime.eventQueue.splice(acknowledgedIndex, 1);
      persistClientEvents();
    }
  } catch { /* Keep events in this tab and retry when connectivity returns. */ }
  finally { runtime.eventsSending = false; }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function dialogueComposerHint() {
  if (interactionBusy()) {
    if (runtime.flow?.reason === 'audio-preparing') return '正在准备语音，可先输入下一题，播报结束后再发送';
    if (runtime.flow?.state === 'speaking') return '正在播报，可先输入下一题，播报结束后再发送';
    return '正在生成回答，可先输入下一题，当前回答结束后再发送';
  }
  if (runtime.flow?.reason === 'speech-unavailable' && runtime.speechErrorCode === 'MALE_VOICE_UNAVAILABLE') {
    return MALE_VOICE_UNAVAILABLE_HINT;
  }
  return ['speech-failed', 'speech-unavailable'].includes(runtime.flow?.reason)
    ? SPEECH_FAILURE_HINT : DEFAULT_COMPOSER_HINT;
}

function interactionBusy() {
  return Boolean(runtime.requestController || runtime.activeSpeechSequence !== null ||
    (runtime.flow && runtime.flow.state !== 'idle' && runtime.flow.reason !== 'manual-preview'));
}

function canStartQuestion() {
  return runtime.liveMode === 'dialogue' && !runtime.liveControlInterrupted && !interactionBusy();
}

class BrowserVoiceInput {
  constructor({ button, input, form, hint, config, onBeforeStart, onTranscript }) {
    this.button = button;
    this.input = input;
    this.form = form;
    this.hint = hint;
    this.onBeforeStart = onBeforeStart;
    this.onTranscript = onTranscript;
    this.Recognition =
      window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
    this.recognition = null;
    this.config = DEFAULT_CONFIG.speechInput;
    this.active = false;
    this.cancelled = false;
    this.pendingSubmit = false;
    this.baseText = '';
    this.errorMessage = '';
    this.messageTimer = null;
    this.externallyDisabled = false;
    this.sessionSequence = 0;

    if (!this.Recognition) {
      this.setState('unsupported');
      return;
    }

    this.configure(config);
    this.createRecognition();
    this.setState('idle');
  }

  createRecognition() {
    const recognition = new this.Recognition();
    const sessionSequence = this.sessionSequence;
    this.recognition = recognition;
    const current = () => this.recognition === recognition && this.sessionSequence === sessionSequence;
    recognition.onstart = () => { if (current()) this.handleStart(); };
    recognition.onresult = event => { if (current()) this.handleResult(event); };
    recognition.onerror = event => { if (current()) this.handleError(event); };
    recognition.onend = () => { if (current()) this.handleEnd(); };
    this.configure(this.config);
  }

  configure(config) {
    this.config = {
      ...DEFAULT_CONFIG.speechInput,
      ...(config && typeof config === 'object' ? config : {}),
    };
    if (!this.recognition) {
      return;
    }
    this.recognition.lang = this.config.language || 'zh-CN';
    this.recognition.continuous = false;
    this.recognition.interimResults = this.config.interimResults !== false;
    this.recognition.maxAlternatives = 1;
  }

  toggle() {
    if (this.active) {
      this.stop();
      return;
    }
    this.start();
  }

  start() {
    if (this.active) return;
    if (this.externallyDisabled) {
      this.setState('disabled');
      return;
    }
    if (!this.recognition) {
      this.setState('unsupported');
      return;
    }
    if (this.onBeforeStart?.() === false) return;

    clearTimeout(this.messageTimer);
    this.sessionSequence += 1;
    this.cancelled = false;
    this.pendingSubmit = false;
    this.errorMessage = '';
    this.baseText = this.input.value.trim();
    this.active = true;
    this.setState('starting');

    try {
      // A fresh recognizer identifies the recording session. Late events from
      // an aborted session must not be mistaken for the next recording.
      this.createRecognition();
      this.recognition.start();
    } catch {
      this.active = false;
      this.setState('error', '麦克风暂时无法启动，请稍后重试');
    }
  }

  stop() {
    if (!this.recognition || !this.active) {
      return;
    }
    this.pendingSubmit =
      this.config.autoSubmit !== false &&
      this.input.value.trim() !== '' &&
      this.input.value.trim() !== this.baseText;
    try {
      this.recognition.stop();
    } catch {
      this.active = false;
      this.setState('idle');
    }
  }

  abort() {
    this.sessionSequence += 1;
    this.pendingSubmit = false;
    this.cancelled = true;
    if (this.recognition && this.active) {
      try {
        this.recognition.abort();
      } catch {
        // Recognition may already be ending; the UI still needs to reset.
      }
    }
    this.active = false;
    this.setState(this.externallyDisabled ? 'disabled' : 'idle');
  }

  setEnabled(enabled) {
    const nextDisabled = !enabled;
    if (this.externallyDisabled === nextDisabled) {
      return;
    }
    this.externallyDisabled = nextDisabled;
    if (nextDisabled) {
      this.abort();
    } else {
      this.setState(this.recognition ? 'idle' : 'unsupported');
    }
  }

  handleStart() {
    if (this.externallyDisabled || this.cancelled || !this.active) {
      this.active = false;
      try {
        this.recognition?.abort();
      } catch {
        // The recognizer may already be ending after the mode switch.
      }
      this.setState(this.externallyDisabled ? 'disabled' : 'idle');
      return;
    }
    this.active = true;
    this.setState('listening');
  }

  handleResult(event) {
    if (!this.active || this.cancelled || this.externallyDisabled) return;
    const finalSegments = [];
    const interimSegments = [];
    for (let index = 0; index < event.results.length; index += 1) {
      const result = event.results[index];
      const transcript = result?.[0]?.transcript?.trim();
      if (!transcript) {
        continue;
      }
      (result.isFinal ? finalSegments : interimSegments).push(transcript);
    }

    const finalTranscript = finalSegments.join('');
    const liveTranscript = [...finalSegments, ...interimSegments].join('');
    this.input.value = [this.baseText, liveTranscript].filter(Boolean).join(' ');
    this.onTranscript?.();

    if (finalTranscript && this.config.autoSubmit !== false) {
      this.pendingSubmit = true;
      try {
        this.recognition.stop();
      } catch {
        // A single-result recognizer may already be stopping itself.
      }
    }
  }

  handleError(event) {
    if (!this.active || this.cancelled || this.externallyDisabled) {
      return;
    }

    this.pendingSubmit = false;
    this.errorMessage = {
      'not-allowed': '麦克风权限未开启，请在浏览器地址栏允许后重试',
      'service-not-allowed': '浏览器未允许使用语音识别服务',
      'audio-capture': '未检测到可用的麦克风',
      'no-speech': '没有听清，请再说一次',
      network: '语音识别网络服务暂不可用',
    }[event.error] ?? '语音识别失败，请再试一次';
    this.setState('error', this.errorMessage);
  }

  handleEnd() {
    const shouldSubmit =
      !this.externallyDisabled &&
      !this.cancelled &&
      !this.errorMessage &&
      this.pendingSubmit &&
      Boolean(this.input.value.trim());
    this.active = false;
    this.pendingSubmit = false;
    this.setState(
      this.externallyDisabled
        ? 'disabled'
        : this.errorMessage
          ? 'error'
          : 'idle',
      this.errorMessage,
    );

    if (shouldSubmit) {
      const sessionSequence = this.sessionSequence;
      const transcript = this.input.value;
      setTimeout(() => {
        if (this.sessionSequence === sessionSequence && !this.externallyDisabled && !this.cancelled &&
            !this.active && !this.errorMessage && this.input.value === transcript) this.form.requestSubmit();
      }, 0);
    }
  }

  setState(state, message = '') {
    clearTimeout(this.messageTimer);
    const listening = state === 'starting' || state === 'listening';
    const unsupported = state === 'unsupported';
    const disabled = state === 'disabled' || this.externallyDisabled;
    const controlInterrupted = disabled && runtime.liveControlInterrupted;
    const label = controlInterrupted
      ? '控制连接中断，暂停语音输入'
      : disabled
      ? runtime.liveMode === 'hosting' ? '主持模式下暂停语音输入' : '当前回答结束后可使用麦克风'
      : unsupported
      ? '当前浏览器不支持语音输入'
      : listening
        ? '停止并发送语音'
        : '开始语音输入';

    this.button.disabled = unsupported || disabled;
    this.button.classList.toggle('is-listening', listening);
    this.button.dataset.state = state;
    this.button.setAttribute('aria-pressed', String(listening));
    this.button.setAttribute('aria-label', label);
    this.button.title = label;

    this.hint.textContent =
      controlInterrupted ? CONTROL_INTERRUPTED_HINT : message ||
      ({
        starting: '正在打开麦克风…',
        listening: '正在聆听，说完后会自动发送；再次点击可提前结束',
        disabled: runtime.liveMode === 'hosting'
          ? '主持模式由后台控制播报，现场提问已暂停' : dialogueComposerHint(),
        unsupported: '当前浏览器不支持语音输入，仍可使用文字提问',
      }[state] ?? dialogueComposerHint());

    if (state === 'error') {
      this.messageTimer = setTimeout(() => this.setState('idle'), 4_500);
    }
  }
}

const voiceInputProviders = Object.freeze({
  browser: (options) => new BrowserVoiceInput(options),
});

function createVoiceInputController(options) {
  const providerName =
    options.config?.provider ?? DEFAULT_CONFIG.speechInput.provider;
  const factory = voiceInputProviders[providerName] ?? voiceInputProviders.browser;
  return factory(options);
}

async function loadConfig(fallback = DEFAULT_CONFIG) {
  try {
    const response = await fetch('/avatar-config.json', {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new Error(`配置请求失败（${response.status}）`);
    }
    const config = await response.json();
    for (const state of AVATAR_STATES) {
      if (!config.states?.[state]) {
        throw new Error(`缺少 ${state} 姿态配置`);
      }
    }
    return config;
  } catch (error) {
    console.warn('数字人配置加载失败，使用内置降级配置。', error);
    return fallback;
  }
}

function applyConfig(config) {
  runtime.config = config;
  elements.avatarName.textContent = config.characterName;
  runtime.videoSwitcher?.configure(config.states);
  runtime.voiceInput?.configure(config.speechInput);
  setMediaNote();
  renderQuickQuestions();
  if (runtime.flow) {
    updateStateUI(runtime.flow.state, runtime.flow.reason);
  }
}

function setServiceStatus(status, label) {
  elements.servicePill.classList.remove('online', 'offline');
  if (status) {
    elements.servicePill.classList.add(status);
  }
  elements.serviceLabel.textContent = label;
}

function cancelActiveInteraction(reason = 'live-control-interrupted') {
  runtime.voiceInput?.abort();
  runtime.requestController?.abort();
  runtime.requestController = null;
  stopSpeech();
  clearTimeout(runtime.previewTimer);
  runtime.previewTimer = null;
  runtime.flow?.reset(reason);
}

function updateInteractionAvailability() {
  const hosting = runtime.liveMode === 'hosting';
  const paused = hosting || runtime.liveControlInterrupted;
  const busy = interactionBusy();
  const actionsDisabled = paused || busy;
  document.body.dataset.liveMode = runtime.liveMode;
  elements.liveModePill.dataset.mode = runtime.liveMode;
  elements.liveModeLabel.textContent = hosting ? '主持模式' : '对话模式';
  elements.hostingBanner.hidden = !hosting;
  elements.questionForm.setAttribute('aria-disabled', String(paused));
  elements.questionForm.setAttribute('aria-busy', String(busy));
  elements.questionInput.disabled = paused;
  elements.questionInput.placeholder = runtime.liveControlInterrupted
    ? '控制连接中断，重连同步后可继续提问'
    : hosting
    ? '主持模式下，现场提问已暂停'
    : busy
    ? '可先输入下一题，播报结束后再发送…'
    : '输入你想问的问题…';
  elements.sendButton.disabled = actionsDisabled;
  elements.sendButton.title = paused ? elements.questionInput.placeholder : busy ? '当前回答结束后可发送' : '发送问题';
  runtime.voiceInput?.setEnabled(!actionsDisabled);

  for (const button of elements.quickQuestions.querySelectorAll('button')) {
    button.disabled = actionsDisabled;
  }
  for (const button of elements.previewPanel.querySelectorAll('[data-preview-state]')) {
    button.disabled = actionsDisabled;
    button.title = actionsDisabled ? '当前回答或主持结束后可测试姿态' : '测试人物姿态';
  }

  if (runtime.liveControlInterrupted) {
    elements.conversationTitle.textContent = '正在恢复控制连接';
    elements.composerHint.textContent = CONTROL_INTERRUPTED_HINT;
  } else if (hosting) {
    elements.conversationTitle.textContent = '主持模式已开启';
    elements.composerHint.textContent =
      '主持模式由后台控制播报，现场提问已暂停';
  } else {
    elements.conversationTitle.textContent = '有什么想了解的？';
    if (!runtime.voiceInput?.active) {
      elements.composerHint.textContent = dialogueComposerHint();
    }
  }
}

function setLiveMode(mode, reason = 'live-mode-changed') {
  if (!['dialogue', 'hosting'].includes(mode)) {
    return false;
  }
  const changed = runtime.liveMode !== mode;
  runtime.liveMode = mode;
  if (changed) {
    cancelActiveInteraction(reason);
    if (mode === 'dialogue') {
      runtime.lastHostedScriptTitle = '';
      elements.hostingScriptTitle.textContent = '等待主持人选择文稿';
      elements.hostingScriptPreview.textContent =
        '主持模式下暂不接受现场提问。';
    }
  }
  updateInteractionAvailability();
  if (runtime.flow) {
    updateStateUI(runtime.flow.state, runtime.flow.reason);
  }
  return changed;
}

function beginHostedPresentation(script, event) {
  if (
    !script ||
    typeof script.title !== 'string' ||
    typeof script.text !== 'string' ||
    !script.text.trim()
  ) {
    return;
  }

  const modeChanged = setLiveMode('hosting', 'hosting-mode-started');
  if (!modeChanged) {
    cancelActiveInteraction('hosting-command-interrupted');
  }
  runtime.lastHostedScriptTitle = script.title;
  runtime.hostingCommandSequence = event.sequence;
  elements.hostingScriptTitle.textContent = `正在播报：${script.title}`;
  elements.hostingScriptPreview.textContent = script.text;
  const speechSequence = runtime.flow.beginPresentation();
  appendMessage('assistant', script.text, { hosting: true });
  speakText(script.text, speechSequence, {
    kind: 'hosting', instanceId: event.instanceId, commandSequence: event.sequence,
  });
}

function stopHostedPresentation() {
  setLiveMode('hosting', 'hosting-mode-synchronized');
  cancelActiveInteraction('hosting-command-stopped');
  runtime.hostingCommandSequence = null;
  elements.hostingScriptTitle.textContent = '当前播报已停止';
  elements.hostingScriptPreview.textContent = '等待后台选择下一段主持词。';
  updateInteractionAvailability();
}

function applyRemoteLiveState(snapshot) {
  const accepted = runtime.liveTracker.accept(snapshot);
  if (!accepted) return null;
  runtime.liveSequence = snapshot.sequence;
  if (accepted.restarted) cancelActiveInteraction('live-service-restarted');
  setLiveMode(snapshot.mode, 'live-control-synchronized');
  if (runtime.hostingCommandSequence !== null &&
      (snapshot.commandSequence !== runtime.hostingCommandSequence || accepted.restarted)) {
    cancelActiveInteraction('hosting-command-synchronized');
    runtime.hostingCommandSequence = null;
    elements.hostingScriptTitle.textContent = '已同步当前指令，旧播报已停止';
    elements.hostingScriptPreview.textContent = '等待后台下发下一段主持词。';
  }
  return accepted;
}

function handleLiveEvent(messageEvent) {
  let event;
  try {
    event = JSON.parse(messageEvent.data);
  } catch {
    return;
  }
  if (
    !event ||
    typeof event !== 'object' ||
    !Number.isInteger(event.sequence) ||
    event.sequence < 0 ||
    typeof event.type !== 'string'
  ) {
    return;
  }

  const accepted = applyRemoteLiveState(event);
  if (!accepted) return;
  if (event.type === 'sync') {
    // Opening the transport is not enough: a fresh accepted snapshot tells us
    // whether a hosting takeover happened while this client was disconnected.
    runtime.liveControlInterrupted = false;
    updateInteractionAvailability();
    if (runtime.flow) updateStateUI(runtime.flow.state, runtime.flow.reason);
    void refreshHealth();
    return;
  }
  if (accepted.duplicate) return;

  if (event.type === 'mode') {
    setLiveMode(event.mode, 'live-mode-command');
    void refreshHealth();
  } else if (event.type === 'present') {
    beginHostedPresentation(event.script, event);
  } else if (event.type === 'stop') {
    if (event.mode === 'hosting') {
      stopHostedPresentation();
    } else {
      setLiveMode(event.mode, 'live-stop-command');
      void refreshHealth();
    }
  }
}

async function loadLiveState() {
  try {
    const response = await fetch('/api/live/state', {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const snapshot = await response.json();
    applyRemoteLiveState(snapshot);
  } catch {
    setServiceStatus('offline', '实时控制状态不可用');
  }
}

function connectLiveEvents() {
  if (!('EventSource' in window)) {
    setServiceStatus('offline', '当前浏览器不支持实时主持控制');
    setInterval(() => void loadLiveState(), 3_000);
    return;
  }

  runtime.liveEventSource?.close();
  const eventSource = new EventSource('/api/live/events');
  runtime.liveEventSource = eventSource;
  for (const type of ['sync', 'mode', 'present', 'stop']) {
    eventSource.addEventListener(type, (event) => {
      if (runtime.liveEventSource === eventSource) handleLiveEvent(event);
    });
  }
  eventSource.addEventListener('open', () => {
    if (runtime.liveEventSource !== eventSource) return;
    runtime.liveConnected = true;
    void refreshHealth();
  });
  eventSource.addEventListener('error', () => {
    if (runtime.liveEventSource !== eventSource) return;
    runtime.liveConnected = false;
    runtime.liveControlInterrupted = true;
    // A missed command may have taken over from dialogue to hosting. Stop any
    // old interaction, not only speech that was already known to be hosting.
    cancelActiveInteraction('live-connection-lost');
    if (runtime.liveMode === 'hosting' && runtime.hostingCommandSequence !== null) {
      runtime.hostingCommandSequence = null;
      elements.hostingScriptTitle.textContent = '控制连接中断，已暂停播报';
      elements.hostingScriptPreview.textContent = '重连后请由后台重新下发，旧主持词不会自动重播。';
    }
    updateInteractionAvailability();
    setServiceStatus('offline', '实时控制正在重新连接');
  });
}

async function refreshHealth() {
  try {
    const response = await fetch('/health', {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const health = await response.json();
    // Health responses must never advance the control sequence ahead of an SSE
    // present event (otherwise the actual command could be mistaken for a duplicate).
    if (!('EventSource' in window) && health.liveControl?.mode) applyRemoteLiveState(health.liveControl);
    if (runtime.liveControlInterrupted) {
      setServiceStatus('offline', '实时控制正在重新连接');
    } else if (runtime.liveMode === 'hosting') {
      setServiceStatus(
        'online',
        runtime.liveConnected
          ? '主持控制已连接'
          : '主持模式运行中，控制通道连接中',
      );
    } else if (!health.ready) {
      setServiceStatus('offline', '问答模型待配置');
      if (health.model?.status === 'unavailable') {
        setServiceStatus('offline', '问答模型连接异常');
      }
    } else if (health.content?.status === 'stale') {
      setServiceStatus('online', '问答可用，内容为上一有效版本');
    } else if (health.model?.status === 'unverified') {
      setServiceStatus('online', '问答可用，模型连接待验证');
    } else {
      setServiceStatus('online', '模型与内容服务正常');
    }

    if (
      health.knowledge?.revision
    ) {
      const nextConfig = await loadConfig(runtime.config);
      if (nextConfig.contentRevision !== runtime.config.contentRevision) {
        applyConfig(nextConfig);
      }
    }
  } catch {
    setServiceStatus('offline', runtime.liveControlInterrupted ? '实时控制正在重新连接' : '内容服务不可用');
  }
}

function updateStateUI(state, reason = runtime.flow?.reason) {
  const stateConfig = runtime.config.states[state] ?? DEFAULT_CONFIG.states[state];
  if (runtime.liveControlInterrupted && state === 'idle') {
    elements.stateLabel.textContent = '控制连接中断';
    elements.stateHint.textContent = '提问与播报已暂停，正在重新同步';
  } else if (runtime.liveMode === 'hosting' && state === 'idle') {
    elements.stateLabel.textContent = '主持模式';
    elements.stateHint.textContent = '等待后台下一条播报指令';
  } else if (runtime.liveMode === 'hosting' && state === 'presenting') {
    elements.stateLabel.textContent = '正在主持播报';
    elements.stateHint.textContent = runtime.lastHostedScriptTitle
      ? `当前文稿：${runtime.lastHostedScriptTitle}`
      : stateConfig.hint;
  } else if (state === 'thinking' && reason === 'audio-preparing') {
    elements.stateLabel.textContent = '正在准备语音';
    elements.stateHint.textContent = '答案已生成，等待音频开始播放';
  } else {
    elements.stateLabel.textContent = stateConfig.label;
    elements.stateHint.textContent = stateConfig.hint;
  }
  elements.stage.dataset.state = state;
  document.body.dataset.avatarState = state;

  for (const button of elements.previewPanel.querySelectorAll(
    '[data-preview-state]',
  )) {
    button.classList.toggle('active', button.dataset.previewState === state);
  }

  runtime.videoSwitcher.show(state);
  updateInteractionAvailability();
}

function setMediaNote({ status = 'loading', reason = '', state = 'idle' } = {}) {
  const needsRetry = status === 'blocked' || status === 'error';
  elements.mediaNote.hidden = !needsRetry;
  elements.mediaRetry.hidden = !needsRetry;
  elements.mediaNoteCopy.textContent = status === 'blocked'
    ? '点击启用人物动态'
    : '人物暂以静态显示，对话仍可使用';
  elements.mediaRetry.textContent = status === 'blocked' ? '播放人物' : '重新加载';
  const labels = { loading: '加载中', playing: '播放正常', blocked: '自动播放受限', error: '加载失败', static: '减少动态：静态显示', suspended: '后台已暂停' };
  elements.mediaDebug.textContent = `视频：${labels[status] ?? status} · ${state}${reason ? ` · ${reason}` : ''}`;
}

function appendMessage(role, text, options = {}) {
  const article = document.createElement('article');
  article.className = `message message-${role}`;
  if (options.pending) {
    article.classList.add('message-pending');
  }
  if (options.error) {
    article.classList.add('message-error');
  }
  if (options.hosting) {
    article.classList.add('message-hosting');
  }

  if (role === 'assistant') {
    const avatar = document.createElement('span');
    avatar.className = 'message-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = runtime.config.characterName.slice(0, 1) || '大';
    article.append(avatar);
  }

  const content = document.createElement('div');
  if (role === 'assistant') {
    const name = document.createElement('p');
    name.className = 'message-name';
    name.textContent = runtime.config.characterName;
    content.append(name);
  }

  const message = document.createElement('p');
  message.textContent = text;
  content.append(message);

  article.append(content);
  elements.conversationLog.append(article);
  elements.conversationLog.scrollTo({
    top: elements.conversationLog.scrollHeight,
    behavior: 'smooth',
  });
  return article;
}

function renderQuickQuestions() {
  elements.quickQuestions.replaceChildren();
  for (const question of runtime.config.quickQuestions ?? []) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = question;
    button.disabled = !canStartQuestion();
    button.addEventListener('click', () => {
      if (!canStartQuestion()) {
        updateInteractionAvailability();
        return;
      }
      elements.questionInput.value = question;
      resizeComposer();
      elements.questionForm.requestSubmit();
    });
    elements.quickQuestions.append(button);
  }
}

function resizeComposer() {
  elements.questionInput.style.height = 'auto';
  elements.questionInput.style.height = `${Math.min(
    elements.questionInput.scrollHeight,
    124,
  )}px`;
}

// BEGIN SERVER SPEECH LIFECYCLE (also used by the Coze frontend patch).
let serverSpeechAudio = null;
let serverSpeechAudioUnlocked = false;
let serverSpeechUnlockAttempt = null;
let serverSpeechPlayback = null;

function getServerSpeechAudio() {
  if (!serverSpeechAudio) {
    serverSpeechAudio = new Audio();
    serverSpeechAudio.preload = 'auto';
    serverSpeechAudio.setAttribute('playsinline', '');
  }
  return serverSpeechAudio;
}

function resetServerSpeechAudio(audio) {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
}

function clearServerSpeechUnlock(unlocked = false) {
  const attempt = serverSpeechUnlockAttempt;
  if (!attempt) return;
  // Invalidate ownership before pause/load can reject an earlier play promise.
  serverSpeechUnlockAttempt = null;
  clearTimeout(attempt.timer);
  if (unlocked) serverSpeechAudioUnlocked = true;
  resetServerSpeechAudio(attempt.audio);
  URL.revokeObjectURL(attempt.url);
}

function silentSpeechBlob() {
  // 50 ms of PCM silence. Use a Blob, not data:, under media-src 'self' blob:.
  const samples = 800;
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const write = (offset, text) => {
    for (let index = 0; index < text.length; index++) view.setUint8(offset + index, text.charCodeAt(index));
  };
  write(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true);
  write(8, 'WAVE'); write(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true); view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, 'data'); view.setUint32(40, samples * 2, true);
  return new Blob([buffer], { type: 'audio/wav' });
}

function unlockServerSpeechAudio() {
  // A user gesture may prime the persistent element ONLY while idle. Never
  // let focus, typing, synthesis or a second gesture replace a real clip.
  if (runtime.config.speech?.provider !== 'server' || !runtime.soundEnabled ||
      interactionBusy() || serverSpeechPlayback || serverSpeechAudioUnlocked || serverSpeechUnlockAttempt) return;
  try {
    const audio = getServerSpeechAudio();
    const attempt = { audio, url: URL.createObjectURL(silentSpeechBlob()), timer: null };
    serverSpeechUnlockAttempt = attempt;
    const settle = (success) => {
      // A late unlock result must not pause/load a newer real speech session.
      if (serverSpeechUnlockAttempt === attempt) clearServerSpeechUnlock(success);
    };
    attempt.timer = setTimeout(() => settle(false), 2_000);
    audio.volume = 1;
    audio.src = attempt.url;
    Promise.resolve(audio.play()).then(() => settle(true), () => settle(false));
  } catch {
    clearServerSpeechUnlock();
  }
}

function clearServerSpeechPlayback() {
  clearServerSpeechUnlock();
  const playback = serverSpeechPlayback;
  if (!playback) return;
  serverSpeechPlayback = null;
  clearTimeout(playback.requestTimer);
  playback.controller.abort();
  if (playback.audio) {
    for (const [name, handler] of Object.entries(playback.handlers)) {
      playback.audio.removeEventListener(name, handler);
    }
    resetServerSpeechAudio(playback.audio);
  }
  if (playback.url) URL.revokeObjectURL(playback.url);
}

function stopSpeech(outcome = 'cancelled') {
  clearServerSpeechPlayback();
  clearTimeout(runtime.speechStartTimer);
  clearTimeout(runtime.speechEndTimer);
  clearTimeout(runtime.voiceReadyTimer);
  runtime.pendingSpeechStart = null;
  if (runtime.speechContext) {
    reportClientEvent(runtime.speechContext, `speech-${outcome}`);
    runtime.speechContext = null;
  }
  runtime.speechUtterance = null;
  runtime.activeSpeechSequence = null;
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
}

function finishSpeechSequence(speechSequence, outcome = 'completed', errorCode) {
  if (speechSequence !== runtime.flow.speechSequence) return false;
  if (serverSpeechPlayback?.speechSequence === speechSequence) clearServerSpeechPlayback();
  runtime.speechErrorCode = errorCode ?? '';
  if (runtime.activeSpeechSequence === speechSequence) {
    runtime.activeSpeechSequence = null;
    runtime.speechUtterance = null;
  }
  clearTimeout(runtime.voiceReadyTimer);
  runtime.pendingSpeechStart = null;
  const finished = runtime.flow.finishSpeech(speechSequence, outcome);
  if (!finished) return false;
  clearTimeout(runtime.speechStartTimer);
  clearTimeout(runtime.speechEndTimer);
  if (runtime.speechContext?.speechSequence === speechSequence) {
    reportClientEvent(runtime.speechContext, `speech-${outcome}`, {
      durationMs: Math.round(performance.now() - runtime.speechContext.startedAt),
      ...(errorCode ? { errorCode } : {}),
    });
    runtime.speechContext = null;
  }
  if (finished && runtime.liveMode === 'hosting') {
    const labels = { completed: '播报完成', failed: '播报失败', cancelled: '播报已取消', muted: '已静音，未播报', unavailable: '浏览器语音不可用' };
    elements.hostingScriptTitle.textContent = `${labels[outcome] ?? '播报已结束'}：${runtime.lastHostedScriptTitle}`;
    elements.hostingScriptPreview.textContent = outcome === 'completed'
      ? '等待后台选择下一段主持词。' : '请检查声音开关或浏览器语音，再由后台重新播报。';
  } else if (outcome === 'failed' || outcome === 'unavailable') {
    updateInteractionAvailability();
  }
  return finished;
}

function startSpeechSequence(speechSequence) {
  // Server-backed providers should call this from the audio `playing` event,
  // not when answer text or synthesized bytes merely become available.
  return runtime.flow.startSpeech(speechSequence);
}
// END SERVER SPEECH LIFECYCLE

function normalizedVoiceName(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase();
}

function preferredChineseVoice() {
  let voices;
  try { voices = window.speechSynthesis?.getVoices?.() ?? []; }
  catch { return null; }
  const chineseVoices = voices.filter((voice) => /^zh(?:[-_]|$)/i.test(voice.lang));
  const mainlandVoices = chineseVoices.filter(
    (voice) => voice.lang.replace('_', '-').toLowerCase() === 'zh-cn',
  );
  const candidates = [
    ...mainlandVoices,
    ...chineseVoices.filter((voice) => !mainlandVoices.includes(voice)),
  ];
  const configuredPreferences = runtime.config.speech?.preferredVoiceNames;
  const preferences =
    Array.isArray(configuredPreferences) && configuredPreferences.length > 0
      ? configuredPreferences
      : DEFAULT_CONFIG.speech.preferredVoiceNames;

  // Web Speech exposes no gender field. This is an operator-maintained list
  // of approved male voice names, never a permission to use an arbitrary voice.
  const matchesPreference = (voice, preference) => {
    const name = normalizedVoiceName(voice.name);
    const desired = normalizedVoiceName(preference).trim();
    if (!desired) return false;
    if (/^[a-z0-9]+$/.test(desired)) return name.split(/[^a-z0-9]+/).includes(desired);
    return name.includes(desired);
  };
  const approved = candidates.filter(voice => preferences.some(preference => matchesPreference(voice, preference)));
  const selected = runtime.preferredSpeechVoice;
  if (selected) {
    // Obtain a current browser object, but pin the identity for this page.
    // A missing voice must not silently become another (possibly female) one.
    return approved.find(voice => voice.voiceURI === selected.voiceURI &&
      voice.name === selected.name && voice.lang === selected.lang) ?? null;
  }

  for (const preference of preferences) {
    const matchedVoice = approved.find(voice => matchesPreference(voice, preference));
    if (matchedVoice) {
      return matchedVoice;
    }
  }

  return null;
}

function prepareSpeechVoices() {
  if (!('speechSynthesis' in window)) {
    return;
  }

  const refreshPreferredVoice = () => {
    const voice = preferredChineseVoice();
    if (voice) runtime.preferredSpeechVoice = voice;
    runtime.pendingSpeechStart?.();
  };
  refreshPreferredVoice();
  window.speechSynthesis.addEventListener?.(
    'voiceschanged',
    refreshPreferredVoice,
  );
}

function speechNumber(name, fallback, minimum, maximum) {
  const configured = Number(runtime.config.speech?.[name]);
  if (!Number.isFinite(configured)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, configured));
}

function speakWithBrowser(text, speechSequence) {
  runtime.activeSpeechSequence = speechSequence;

  if (!runtime.soundEnabled) {
    runtime.activeSpeechSequence = null;
    finishSpeechSequence(speechSequence, 'muted');
    return;
  }

  if (
    !('speechSynthesis' in window) ||
    !('SpeechSynthesisUtterance' in window)
  ) {
    runtime.activeSpeechSequence = null;
    finishSpeechSequence(speechSequence, 'unavailable', 'SPEECH_UNSUPPORTED');
    return;
  }

  const beginWhenReady = () => {
    if (runtime.activeSpeechSequence !== speechSequence) return false;
    const voice = preferredChineseVoice();
    if (!voice) return false;
    clearTimeout(runtime.voiceReadyTimer);
    runtime.pendingSpeechStart = null;
    runtime.preferredSpeechVoice = voice;
    try {
      enqueueBrowserSpeech(text, speechSequence, voice);
    } catch {
      finishSpeechSequence(speechSequence, 'failed', 'SPEECH_EXCEPTION');
    }
    return true;
  };
  if (beginWhenReady()) return;
  runtime.pendingSpeechStart = beginWhenReady;
  runtime.voiceReadyTimer = setTimeout(() => {
    if (runtime.activeSpeechSequence !== speechSequence || beginWhenReady()) return;
    finishSpeechSequence(speechSequence, 'unavailable', 'MALE_VOICE_UNAVAILABLE');
  }, VOICE_READY_TIMEOUT_MS);
}

function enqueueBrowserSpeech(text, speechSequence, voice) {
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.voice = voice;
  utterance.lang = voice.lang;
  utterance.rate = speechNumber('rate', DEFAULT_CONFIG.speech.rate, 0.75, 1.25);
  utterance.pitch = speechNumber('pitch', DEFAULT_CONFIG.speech.pitch, 0.8, 1.2);
  utterance.volume = 1;
  let started = false;

  utterance.addEventListener('start', () => {
    if (runtime.activeSpeechSequence !== speechSequence || started) {
      return;
    }
    started = true;
    clearTimeout(runtime.speechStartTimer);
    // Some engines lose end/error events. Give long text a generous budget
    // while ensuring that a stuck engine cannot lock the composer forever.
    runtime.speechEndTimer = setTimeout(() => {
      if (runtime.activeSpeechSequence !== speechSequence) return;
      finishSpeechSequence(speechSequence, 'failed', 'SPEECH_PLAYBACK_TIMEOUT');
      window.speechSynthesis.cancel();
    }, Math.max(60_000, text.length * 1_000 / utterance.rate + 15_000));
    reportClientEvent(runtime.speechContext, 'speech-started');
    startSpeechSequence(speechSequence);
  });
  utterance.addEventListener('end', () => {
    if (runtime.activeSpeechSequence !== speechSequence) {
      return;
    }
    runtime.activeSpeechSequence = null;
    runtime.speechUtterance = null;
    finishSpeechSequence(speechSequence);
  });
  utterance.addEventListener('error', (event) => {
    if (runtime.activeSpeechSequence !== speechSequence) {
      return;
    }
    runtime.activeSpeechSequence = null;
    runtime.speechUtterance = null;
    const errorCode = String(event.error || 'SPEECH_FAILED').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 80);
    finishSpeechSequence(speechSequence, 'failed', errorCode);
  });

  runtime.speechUtterance = utterance;
  runtime.speechStartTimer = setTimeout(() => {
    if (runtime.activeSpeechSequence !== speechSequence) return;
    runtime.activeSpeechSequence = null;
    runtime.speechUtterance = null;
    finishSpeechSequence(speechSequence, 'failed', 'SPEECH_START_TIMEOUT');
    window.speechSynthesis.cancel();
  }, 8_000);
  try {
    window.speechSynthesis.speak(utterance);
  } catch {
    runtime.activeSpeechSequence = null;
    runtime.speechUtterance = null;
    finishSpeechSequence(speechSequence, 'failed', 'SPEECH_EXCEPTION');
  }
}

// BEGIN SERVER SPEECH PROVIDER
async function speakWithServer(text, speechSequence) {
  runtime.activeSpeechSequence = speechSequence;
  if (!runtime.soundEnabled) {
    finishSpeechSequence(speechSequence, 'muted');
    return;
  }

  const playback = {
    speechSequence, controller: new AbortController(), requestTimer: null,
    audio: null, url: '', handlers: {}, started: false,
  };
  serverSpeechPlayback = playback;
  const current = () => serverSpeechPlayback === playback && runtime.activeSpeechSequence === speechSequence;
  // Stay with the configured provider. In particular, NEVER replay the answer
  // in a different browser voice after a server clip fails or is interrupted.
  const fail = (code) => { if (current()) finishSpeechSequence(speechSequence, 'failed', code); };
  // Covers response headers AND body. Cleanup/timeout also releases the UI if
  // a transport ignores abort or returns a late response from an older turn.
  playback.requestTimer = setTimeout(() => fail('TTS_REQUEST_TIMEOUT'), 30_000);
  try {
    const response = await fetch('/api/tts', {
      method: 'POST',
      headers: { Accept: 'audio/*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }), signal: playback.controller.signal,
    });
    if (!current()) return;
    if (!response.ok) { fail('TTS_REQUEST_FAILED'); return; }
    const blob = await response.blob();
    if (!current()) return;
    if (!blob.size || !/^audio\//i.test(blob.type)) { fail('TTS_INVALID_AUDIO'); return; }
    clearTimeout(playback.requestTimer);
    clearServerSpeechUnlock();
    const audio = getServerSpeechAudio();
    playback.audio = audio;
    playback.url = URL.createObjectURL(blob);
    playback.handlers = {
      playing: () => {
        if (!current() || playback.started) return;
        playback.started = true;
        serverSpeechAudioUnlocked = true;
        clearTimeout(runtime.speechStartTimer);
        const durationMs = Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration * 1_000 : text.length * 1_000;
        runtime.speechEndTimer = setTimeout(() => fail('SPEECH_PLAYBACK_TIMEOUT'), Math.max(60_000, durationMs + 15_000));
        reportClientEvent(runtime.speechContext, 'speech-started');
        startSpeechSequence(speechSequence);
      },
      ended: () => { if (current() && playback.started) finishSpeechSequence(speechSequence); },
      error: () => fail('SPEECH_AUDIO_ERROR'),
    };
    for (const [name, handler] of Object.entries(playback.handlers)) audio.addEventListener(name, handler);
    audio.volume = 1;
    audio.src = playback.url;
    runtime.speechStartTimer = setTimeout(() => fail('SPEECH_START_TIMEOUT'), 8_000);
    await audio.play();
  } catch (error) {
    fail(error?.name === 'NotAllowedError' ? 'SPEECH_AUTOPLAY_BLOCKED' : 'TTS_PLAYBACK_FAILED');
  }
}

const speechProviders = Object.freeze({
  browser: speakWithBrowser,
  server: speakWithServer,
});

function speakText(text, speechSequence, context) {
  stopSpeech();
  runtime.speechErrorCode = '';
  runtime.speechContext = { ...context, speechSequence, startedAt: performance.now() };
  reportClientEvent(runtime.speechContext, 'speech-preparing');
  runtime.voiceInput?.abort();
  const providerName =
    runtime.config.speech?.provider ?? DEFAULT_CONFIG.speech.provider;
  const provider = speechProviders[providerName];
  if (!provider) {
    finishSpeechSequence(speechSequence, 'unavailable', 'SPEECH_PROVIDER_UNSUPPORTED');
    return;
  }
  provider(text, speechSequence);
}
// END SERVER SPEECH PROVIDER

async function requestAnswer(question, signal, turnId) {
  const controller = new AbortController();
  let rejectInterruption;
  let interruptionError = null;
  const interruption = new Promise((_resolve, reject) => { rejectInterruption = reject; });
  const interrupt = (error) => {
    if (interruptionError) return;
    interruptionError = error;
    controller.abort(error);
    rejectInterruption(error);
  };
  const cancel = () => {
    const error = new Error('问答请求已取消。');
    error.name = 'AbortError';
    interrupt(error);
  };
  const timer = setTimeout(() => {
    const error = new Error('问答请求等待超时。');
    error.name = 'TimeoutError';
    error.code = 'CLIENT_REQUEST_TIMEOUT';
    interrupt(error);
  }, ANSWER_REQUEST_TIMEOUT_MS);
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();

  const receiveAnswer = async () => {
    if (controller.signal.aborted) throw interruptionError;
    const response = await fetch('/answer', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Conversation-Id': turnId,
      },
      body: JSON.stringify({ question }),
      signal: controller.signal,
    });
    if (controller.signal.aborted) throw interruptionError;
    const payload = await response.json().catch(() => {
      if (controller.signal.aborted) throw interruptionError;
      return {};
    });
    if (controller.signal.aborted) throw interruptionError;
    if (!response.ok) {
      const error = new Error(payload.message || `请求失败（${response.status}）`);
      error.code = payload.error;
      if (response.status === 409 && payload.answerStatus === 'cancelled' &&
          payload.answered === false && payload.cancellationReason === 'LIVE_CONTROL_CHANGED' &&
          ['HOSTING_MODE_ACTIVE', 'ANSWER_CANCELLED'].includes(payload.error)) {
        error.name = 'AbortError';
        throw error;
      }
      error.fallbackText = typeof payload.answer === 'string'
        ? payload.answer.trim()
        : '';
      error.speechText = typeof payload.speechText === 'string'
        ? payload.speechText.trim()
        : error.fallbackText;
      throw error;
    }
    // The server validates speakable text. Preserve ordinary bracketed labels,
    // while rejecting serialized/truncated arrays rather than treating every [ as JSON.
    const answer = typeof payload.answer === 'string' ? payload.answer.trim() : '';
    const invalidBracketPrefix = /^\[/.test(answer) &&
      !/^\[(?:\d+|[\p{L} ]+)\]\s*\S/u.test(answer);
    if (!answer || /^[`{]/.test(answer) || invalidBracketPrefix) {
      throw new Error('INVALID_ANSWER_RESPONSE');
    }
    return payload;
  };
  try {
    // Race the entire response, including body parsing. A late transport that
    // ignores abort must neither retain the UI wait nor revive an old answer.
    return await Promise.race([receiveAnswer(), interruption]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
}

async function askQuestion(question) {
  if (!canStartQuestion()) {
    updateInteractionAvailability();
    return;
  }
  stopSpeech();
  clearTimeout(runtime.previewTimer);

  const controller = new AbortController();
  runtime.requestController = controller;
  const requestSequence = runtime.flow.beginQuestion();
  const startedAt = performance.now();
  const context = { kind: 'dialogue', turnId: createClientId() };
  reportClientEvent(context, 'request-started');

  appendMessage('user', question);
  const pendingMessage = appendMessage('assistant', '正在调用大语言模型生成回答…', {
    pending: true,
  });
  updateInteractionAvailability();

  try {
    const result = await requestAnswer(question, controller.signal, context.turnId);
    const remainingThinkingTime = 520 - (performance.now() - startedAt);
    if (remainingThinkingTime > 0) {
      await wait(remainingThinkingTime);
    }

    const speechSequence = runtime.flow.answerReady(requestSequence);
    if (speechSequence === null) {
      reportClientEvent(context, 'request-cancelled');
      return;
    }

    pendingMessage.remove();
    appendMessage('assistant', result.answer);
    speakText(result.speechText || result.answer, speechSequence, context);
  } catch (error) {
    if (error.name === 'AbortError') {
      reportClientEvent(context, 'request-cancelled');
      pendingMessage.remove();
      if (runtime.requestController === controller) runtime.flow.reset('question-cancelled');
      return;
    }

    if (!error.fallbackText) {
      error.fallbackText = runtime.config.serviceErrorText || DEFAULT_CONFIG.serviceErrorText;
      error.speechText = error.fallbackText;
      reportClientEvent(context, 'request-failed', {
        errorCode: error.code || 'CLIENT_CONNECTION_FAILED', question,
        answer: error.fallbackText, durationMs: Math.round(performance.now() - startedAt),
      });
    }
    if (error.fallbackText) {
      const remainingThinkingTime = 520 - (performance.now() - startedAt);
      if (remainingThinkingTime > 0) {
        await wait(remainingThinkingTime);
      }
      const speechSequence = runtime.flow.answerReady(requestSequence);
      if (speechSequence === null) {
        reportClientEvent(context, 'request-cancelled');
        return;
      }
      pendingMessage.remove();
      appendMessage('assistant', error.fallbackText, { error: true });
      speakText(error.speechText || error.fallbackText, speechSequence, context);
      return;
    }

    if (runtime.flow.failQuestion(requestSequence)) {
      pendingMessage.remove();
      appendMessage('assistant', `暂时无法获取答案：${error.message}`, {
        error: true,
      });
    }
  } finally {
    // A hosting command can arrive after HTTP completes but before audio is
    // prepared. Discard that stale answer and its pending message together.
    pendingMessage.remove();
    if (runtime.requestController === controller) {
      runtime.requestController = null;
      updateInteractionAvailability();
    }
  }
}

function previewState(state) {
  if (!canStartQuestion()) {
    updateInteractionAvailability();
    return;
  }
  runtime.voiceInput?.abort();
  stopSpeech();
  clearTimeout(runtime.previewTimer);

  runtime.flow.preview(state);
  if (state !== 'idle') {
    runtime.previewTimer = setTimeout(() => {
      runtime.flow.reset('preview-finished');
    }, 4_000);
  }
}

function prepareForVoiceInput() {
  if (!canStartQuestion()) {
    updateInteractionAvailability();
    return false;
  }
  clearTimeout(runtime.previewTimer);
  runtime.flow?.reset('voice-input-started');
  return true;
}

function syncViewport() {
  const viewport = window.visualViewport;
  // Do not resize the app during pinch zoom; keep the page zoomable.
  if (viewport && Math.abs(viewport.scale - 1) > 0.05) return;
  document.documentElement.style.setProperty('--app-height', `${Math.round(viewport?.height ?? window.innerHeight)}px`);
  document.body.classList.toggle('composer-focused', document.activeElement === elements.questionInput);
}

function bindEvents() {
  elements.questionForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!canStartQuestion() || runtime.composingQuestion) {
      updateInteractionAvailability();
      return;
    }
    runtime.voiceInput?.abort();
    const question = elements.questionInput.value.trim();
    if (!question) {
      elements.questionInput.focus();
      return;
    }

    // Keyboard submission is a deliberate gesture too; ordinary typing is not.
    unlockServerSpeechAudio();
    elements.questionInput.value = '';
    resizeComposer();
    void askQuestion(question);
  });

  elements.questionInput.addEventListener('input', resizeComposer);
  elements.questionInput.addEventListener('compositionstart', () => { runtime.composingQuestion = true; });
  elements.questionInput.addEventListener('compositionend', () => { runtime.composingQuestion = false; });
  elements.questionInput.addEventListener('focus', syncViewport);
  elements.questionInput.addEventListener('blur', () => requestAnimationFrame(syncViewport));
  window.addEventListener('resize', syncViewport);
  window.visualViewport?.addEventListener('resize', syncViewport);
  syncViewport();
  elements.mediaRetry.addEventListener('click', () => { void runtime.videoSwitcher.retry(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) runtime.videoSwitcher.suspend();
    else void runtime.videoSwitcher.resume();
  });
  elements.questionInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing &&
        event.keyCode !== 229 && !runtime.composingQuestion) {
      event.preventDefault();
      elements.questionForm.requestSubmit();
    }
  });

  elements.voiceInputButton.addEventListener('click', () => {
    runtime.voiceInput?.toggle();
  });

  elements.soundToggle.addEventListener('click', () => {
    runtime.soundEnabled = !runtime.soundEnabled;
    elements.soundToggle.setAttribute(
      'aria-pressed',
      String(runtime.soundEnabled),
    );
    elements.soundLabel.textContent = runtime.soundEnabled
      ? '语音已开启'
      : '语音已关闭';
    elements.soundToggle.setAttribute('aria-label', runtime.soundEnabled ? '关闭语音播报' : '开启语音播报');

    if (!runtime.soundEnabled && runtime.activeSpeechSequence !== null) {
      const activeSequence = runtime.activeSpeechSequence;
      finishSpeechSequence(activeSequence, 'muted');
      stopSpeech('muted');
    }
    if (!runtime.soundEnabled) clearServerSpeechUnlock();
    else unlockServerSpeechAudio();
  });

  for (const button of elements.previewPanel.querySelectorAll(
    '[data-preview-state]',
  )) {
    button.addEventListener('click', () => previewState(button.dataset.previewState));
  }

  window.addEventListener('beforeunload', () => {
    runtime.requestController?.abort();
    runtime.voiceInput?.abort();
    runtime.liveEventSource?.close();
    runtime.videoSwitcher.dispose();
    stopSpeech();
  });

  // No global keydown audio handler. Pointer gestures are guarded by idle and
  // exclusive ownership checks, including while an earlier play is pending.
  document.addEventListener('pointerdown', unlockServerSpeechAudio);
}

async function start() {
  try {
    const pending = JSON.parse(sessionStorage.getItem('digital-human-pending-events') || '[]');
    if (Array.isArray(pending)) runtime.eventQueue = pending.slice(-200);
  } catch { /* Invalid or unavailable session storage. */ }
  applyConfig(await loadConfig());

  runtime.videoSwitcher = new AvatarVideoSwitcher({
    stage: elements.stage,
    videos: elements.videos,
    poster: elements.poster,
    onStatus: setMediaNote,
  });
  runtime.videoSwitcher.configure(runtime.config.states);
  runtime.flow = new AvatarFlow(({ state, reason }) =>
    updateStateUI(state, reason),
  );
  runtime.flow.announce();
  runtime.voiceInput = createVoiceInputController({
    button: elements.voiceInputButton,
    input: elements.questionInput,
    form: elements.questionForm,
    hint: elements.composerHint,
    config: runtime.config.speechInput,
    onBeforeStart: prepareForVoiceInput,
    onTranscript: resizeComposer,
  });

  if (new URLSearchParams(window.location.search).get('preview') === '1') {
    elements.previewPanel.hidden = false;
    document.body.dataset.preview = 'true';
  }

  bindEvents();
  prepareSpeechVoices();
  resizeComposer();
  updateInteractionAvailability();
  await loadLiveState();
  connectLiveEvents();
  await refreshHealth();
  setInterval(() => void refreshHealth(), 15_000);
  setInterval(() => void flushClientEvents(), 5_000);
  window.addEventListener('online', () => void flushClientEvents());
  void flushClientEvents();
}

void start();
