import { AvatarFlow, AVATAR_STATES } from './avatar-flow.js';

const DEFAULT_CONFIG = Object.freeze({
  characterName: '小未',
  welcomeText: '你好，我是大未来数字助手。请问有什么可以帮你？',
  presentationText: '大家好，欢迎来到大未来数字人问答体验。',
  quickQuestions: [],
  contentRevision: null,
  states: {
    idle: { label: '随时可以开始', hint: '等待你的问题', sources: [] },
    thinking: { label: '正在思考', hint: '正在调用大语言模型', sources: [] },
    speaking: { label: '正在回答', hint: '答案播报中', sources: [] },
    presenting: { label: '主持模式', hint: '正在进行开场介绍', sources: [] },
  },
});

const elements = {
  servicePill: document.querySelector('#service-pill'),
  serviceLabel: document.querySelector('#service-label'),
  soundToggle: document.querySelector('#sound-toggle'),
  soundLabel: document.querySelector('#sound-label'),
  stateLabel: document.querySelector('#avatar-state-label'),
  stateHint: document.querySelector('#avatar-state-hint'),
  stage: document.querySelector('#avatar-stage'),
  videoA: document.querySelector('#avatar-video-a'),
  videoB: document.querySelector('#avatar-video-b'),
  mediaNote: document.querySelector('#media-note'),
  avatarName: document.querySelector('#avatar-name'),
  welcomeMessage: document.querySelector('#welcome-message'),
  conversationLog: document.querySelector('#conversation-log'),
  quickQuestions: document.querySelector('#quick-question-list'),
  questionForm: document.querySelector('#question-form'),
  questionInput: document.querySelector('#question-input'),
  sendButton: document.querySelector('#send-button'),
  presentationButton: document.querySelector('#presentation-button'),
  previewPanel: document.querySelector('#preview-panel'),
};

const runtime = {
  config: DEFAULT_CONFIG,
  flow: null,
  videoSwitcher: null,
  requestController: null,
  speechTimer: null,
  speechUtterance: null,
  activeSpeechSequence: null,
  previewTimer: null,
  soundEnabled: true,
};

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isSafariBrowser() {
  return (
    navigator.vendor === 'Apple Computer, Inc.' &&
    /Safari/i.test(navigator.userAgent) &&
    !/CriOS|FxiOS|EdgiOS/i.test(navigator.userAgent)
  );
}

function supportedSources(video, sources) {
  const isSafari = isSafariBrowser();
  return [...sources]
    .filter(
      (source) =>
        source &&
        typeof source.src === 'string' &&
        (!source.type || video.canPlayType(source.type) !== ''),
    )
    .sort((left, right) => {
      const leftPreferred = isSafari
        ? left.platform === 'apple'
        : left.platform !== 'apple';
      const rightPreferred = isSafari
        ? right.platform === 'apple'
        : right.platform !== 'apple';
      return Number(rightPreferred) - Number(leftPreferred);
    });
}

class AvatarVideoSwitcher {
  constructor({ stage, videos, onFallback }) {
    this.stage = stage;
    this.videos = videos;
    this.onFallback = onFallback;
    this.activeVideo = null;
    this.renderedState = null;
    this.desiredState = 'idle';
    this.states = DEFAULT_CONFIG.states;
    this.switchPromise = null;
    this.reduceMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;
  }

  configure(states) {
    this.states = states;
  }

  show(state) {
    this.desiredState = state;
    this.stage.dataset.state = state;

    if (this.reduceMotion) {
      this.hideVideos();
      this.renderedState = state;
      this.onFallback(false);
      return;
    }

    if (!this.switchPromise) {
      this.switchPromise = this.drain().finally(() => {
        this.switchPromise = null;
        if (this.renderedState !== this.desiredState) {
          this.show(this.desiredState);
        }
      });
    }
  }

  async drain() {
    while (this.renderedState !== this.desiredState) {
      const targetState = this.desiredState;
      await this.switchOnce(targetState);
      this.renderedState = targetState;
    }
  }

  async switchOnce(state) {
    const stateConfig = this.states[state] ?? DEFAULT_CONFIG.states[state];
    const nextVideo = this.videos.find((video) => video !== this.activeVideo);
    const candidates = supportedSources(nextVideo, stateConfig.sources ?? []);

    let loaded = false;
    for (const source of candidates) {
      loaded = await this.loadSource(nextVideo, source.src);
      if (loaded) {
        break;
      }
    }

    if (state !== this.desiredState) {
      nextVideo.pause();
      return;
    }

    if (!loaded) {
      this.hideVideos();
      this.onFallback(true);
      return;
    }

    try {
      nextVideo.currentTime = 0;
      await nextVideo.play();
    } catch {
      this.hideVideos();
      this.onFallback(true);
      return;
    }

    const previousVideo = this.activeVideo;
    nextVideo.classList.add('is-active');
    this.stage.classList.add('media-ready');
    this.activeVideo = nextVideo;
    this.onFallback(false);

    if (previousVideo) {
      previousVideo.classList.remove('is-active');
      await wait(240);
      if (previousVideo !== this.activeVideo) {
        previousVideo.pause();
      }
    }
  }

  loadSource(video, source) {
    video.pause();
    video.classList.remove('is-active');
    video.removeAttribute('src');
    video.load();

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        video.removeEventListener('loadeddata', handleLoaded);
        video.removeEventListener('error', handleError);
        resolve(result);
      };
      const handleLoaded = () => finish(true);
      const handleError = () => finish(false);
      const timeout = setTimeout(() => finish(false), 5_000);

      video.addEventListener('loadeddata', handleLoaded, { once: true });
      video.addEventListener('error', handleError, { once: true });
      video.src = source;
      video.load();

      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        finish(true);
      }
    });
  }

  hideVideos() {
    for (const video of this.videos) {
      video.classList.remove('is-active');
      video.pause();
    }
    this.activeVideo = null;
    this.stage.classList.remove('media-ready');
  }
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
  elements.welcomeMessage.textContent = config.welcomeText;
  runtime.videoSwitcher?.configure(config.states);
  setMediaNote();
  renderQuickQuestions();
  if (runtime.flow) {
    updateStateUI(runtime.flow.state);
  }
}

function setServiceStatus(status, label) {
  elements.servicePill.classList.remove('online', 'offline');
  if (status) {
    elements.servicePill.classList.add(status);
  }
  elements.serviceLabel.textContent = label;
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
    if (!health.ready) {
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
      health.content?.revision &&
      health.content.revision !== runtime.config.contentRevision
    ) {
      const nextConfig = await loadConfig(runtime.config);
      if (nextConfig.contentRevision !== runtime.config.contentRevision) {
        applyConfig(nextConfig);
      }
    }
  } catch {
    setServiceStatus('offline', '内容服务不可用');
  }
}

function updateStateUI(state) {
  const stateConfig = runtime.config.states[state] ?? DEFAULT_CONFIG.states[state];
  elements.stateLabel.textContent = stateConfig.label;
  elements.stateHint.textContent = stateConfig.hint;
  elements.stage.dataset.state = state;
  document.body.dataset.avatarState = state;

  for (const button of elements.previewPanel.querySelectorAll(
    '[data-preview-state]',
  )) {
    button.classList.toggle('active', button.dataset.previewState === state);
  }

  runtime.videoSwitcher.show(state);
}

function setMediaNote({ fallback = false } = {}) {
  const showDemoNote = runtime.config.mediaMode === 'demo';
  elements.mediaNote.hidden = !fallback && !showDemoNote;
  const copy = elements.mediaNote.querySelector('span:last-child');
  copy.textContent = fallback
    ? '透明视频未加载，已切换为内置动画'
    : '当前为演示视频，可用同名透明真人素材直接替换';
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

  if (role === 'assistant') {
    const avatar = document.createElement('span');
    avatar.className = 'message-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = '未';
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
    button.addEventListener('click', () => {
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

function stopSpeech() {
  clearTimeout(runtime.speechTimer);
  runtime.speechTimer = null;
  runtime.speechUtterance = null;
  runtime.activeSpeechSequence = null;
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
}

function estimatedSpeechDuration(text) {
  const punctuationPauses = (text.match(/[，。！？；：,.!?;:]/g) ?? []).length;
  return Math.min(14_000, Math.max(2_200, text.length * 185 + punctuationPauses * 110));
}

function finishSpeechAfter(text, speechSequence) {
  runtime.speechTimer = setTimeout(() => {
    if (runtime.activeSpeechSequence === speechSequence) {
      runtime.activeSpeechSequence = null;
      runtime.flow.finishSpeech(speechSequence);
    }
  }, estimatedSpeechDuration(text));
}

function preferredChineseVoice() {
  const voices = window.speechSynthesis?.getVoices?.() ?? [];
  return (
    voices.find((voice) => /^zh-CN$/i.test(voice.lang)) ??
    voices.find((voice) => /^zh/i.test(voice.lang)) ??
    null
  );
}

function speakText(text, speechSequence) {
  stopSpeech();
  runtime.activeSpeechSequence = speechSequence;

  if (
    !runtime.soundEnabled ||
    !('speechSynthesis' in window) ||
    !('SpeechSynthesisUtterance' in window)
  ) {
    finishSpeechAfter(text, speechSequence);
    return;
  }

  const utterance = new SpeechSynthesisUtterance(text);
  const voice = preferredChineseVoice();
  if (voice) {
    utterance.voice = voice;
  }
  utterance.lang = voice?.lang ?? 'zh-CN';
  utterance.rate = 0.96;
  utterance.pitch = 1;
  utterance.volume = 1;

  utterance.addEventListener('end', () => {
    if (runtime.activeSpeechSequence !== speechSequence) {
      return;
    }
    runtime.activeSpeechSequence = null;
    runtime.speechUtterance = null;
    runtime.flow.finishSpeech(speechSequence);
  });
  utterance.addEventListener('error', () => {
    if (runtime.activeSpeechSequence !== speechSequence) {
      return;
    }
    runtime.speechUtterance = null;
    finishSpeechAfter(text, speechSequence);
  });

  runtime.speechUtterance = utterance;
  try {
    window.speechSynthesis.speak(utterance);
  } catch {
    runtime.speechUtterance = null;
    finishSpeechAfter(text, speechSequence);
  }
}

async function requestAnswer(question, signal) {
  const response = await fetch('/answer', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ question }),
    signal,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message || `请求失败（${response.status}）`);
  }
  return payload;
}

async function askQuestion(question) {
  runtime.requestController?.abort();
  stopSpeech();
  clearTimeout(runtime.previewTimer);

  const controller = new AbortController();
  runtime.requestController = controller;
  const requestSequence = runtime.flow.beginQuestion();
  const startedAt = performance.now();

  appendMessage('user', question);
  const pendingMessage = appendMessage('assistant', '正在调用大语言模型生成回答…', {
    pending: true,
  });
  elements.sendButton.disabled = true;

  try {
    const result = await requestAnswer(question, controller.signal);
    const remainingThinkingTime = 520 - (performance.now() - startedAt);
    if (remainingThinkingTime > 0) {
      await wait(remainingThinkingTime);
    }

    const speechSequence = runtime.flow.answerReady(requestSequence);
    if (speechSequence === null) {
      return;
    }

    pendingMessage.remove();
    appendMessage('assistant', result.answer);
    speakText(result.speechText || result.answer, speechSequence);
  } catch (error) {
    if (error.name === 'AbortError') {
      pendingMessage.remove();
      return;
    }

    if (runtime.flow.failQuestion(requestSequence)) {
      pendingMessage.remove();
      appendMessage('assistant', `暂时无法获取答案：${error.message}`, {
        error: true,
      });
    }
  } finally {
    if (runtime.requestController === controller) {
      runtime.requestController = null;
      elements.sendButton.disabled = false;
    }
  }
}

function startPresentation() {
  runtime.requestController?.abort();
  runtime.requestController = null;
  stopSpeech();
  clearTimeout(runtime.previewTimer);
  elements.sendButton.disabled = false;

  const speechSequence = runtime.flow.beginPresentation();
  appendMessage('assistant', runtime.config.presentationText);
  speakText(runtime.config.presentationText, speechSequence);
}

function previewState(state) {
  runtime.requestController?.abort();
  runtime.requestController = null;
  stopSpeech();
  clearTimeout(runtime.previewTimer);
  elements.sendButton.disabled = false;

  runtime.flow.preview(state);
  if (state !== 'idle') {
    runtime.previewTimer = setTimeout(() => {
      runtime.flow.reset('preview-finished');
    }, 4_000);
  }
}

function bindEvents() {
  elements.questionForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const question = elements.questionInput.value.trim();
    if (!question) {
      elements.questionInput.focus();
      return;
    }

    elements.questionInput.value = '';
    resizeComposer();
    void askQuestion(question);
  });

  elements.questionInput.addEventListener('input', resizeComposer);
  elements.questionInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      elements.questionForm.requestSubmit();
    }
  });

  elements.presentationButton.addEventListener('click', startPresentation);

  elements.soundToggle.addEventListener('click', () => {
    runtime.soundEnabled = !runtime.soundEnabled;
    elements.soundToggle.setAttribute(
      'aria-pressed',
      String(runtime.soundEnabled),
    );
    elements.soundLabel.textContent = runtime.soundEnabled
      ? '语音已开启'
      : '语音已关闭';

    if (!runtime.soundEnabled && runtime.activeSpeechSequence !== null) {
      const activeSequence = runtime.activeSpeechSequence;
      stopSpeech();
      runtime.flow.finishSpeech(activeSequence);
    }
  });

  for (const button of elements.previewPanel.querySelectorAll(
    '[data-preview-state]',
  )) {
    button.addEventListener('click', () => previewState(button.dataset.previewState));
  }

  window.addEventListener('beforeunload', () => {
    runtime.requestController?.abort();
    stopSpeech();
  });
}

async function start() {
  applyConfig(await loadConfig());

  runtime.videoSwitcher = new AvatarVideoSwitcher({
    stage: elements.stage,
    videos: [elements.videoA, elements.videoB],
    onFallback: (fallback) => setMediaNote({ fallback }),
  });
  runtime.videoSwitcher.configure(runtime.config.states);
  runtime.flow = new AvatarFlow(({ state }) => updateStateUI(state));
  runtime.flow.announce();

  if (new URLSearchParams(window.location.search).get('preview') === '1') {
    elements.previewPanel.hidden = false;
  }

  bindEvents();
  resizeComposer();
  await refreshHealth();
  setInterval(() => void refreshHealth(), 15_000);
}

void start();
