// Keep media failures separate from dialogue/TTS state. A failed video must not
// stop an answer, and a late play() completion must not revive an old pose.
export function supportedSources(video, sources = []) {
  return sources
    .filter((source) => source && typeof source.src === 'string' && source.src)
    .map((source, index) => ({
      source,
      index,
      score: Number(typeof source.type === 'string' && source.type.startsWith('video/mp4')) * 2
        + Number(Boolean(typeof source.type === 'string' && video.canPlayType(source.type))),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ source }) => source);
}

function failureReason(error, video) {
  if (error?.name === 'NotAllowedError') return 'blocked';
  if (error?.name === 'NotSupportedError') return 'unsupported';
  return ({ 2: 'network', 3: 'decode', 4: 'unsupported' })[video.error?.code] ?? 'playback';
}

export class AvatarVideoSwitcher {
  constructor({ stage, videos, poster, onStatus = () => {}, reduceMotion, allowPreload, allowInteractionPreload, loadTimeoutMs = 12_000 }) {
    this.stage = stage;
    this.videos = videos;
    this.poster = poster;
    this.onStatus = onStatus;
    this.videosByState = new Map(videos.map((video) => [video.dataset.avatarVideo, video]));
    this.states = {};
    this.activeVideo = null;
    this.desiredState = 'idle';
    this.renderedState = null;
    this.sequence = 0;
    this.cancelAttempt = null;
    this.switchPromise = null;
    this.suspended = globalThis.document?.hidden ?? false;
    this.loadTimeoutMs = loadTimeoutMs;
    this.reduceMotion = reduceMotion ?? globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const connection = globalThis.navigator?.connection ?? globalThis.navigator?.mozConnection ?? globalThis.navigator?.webkitConnection;
    this.allowPreload = allowPreload ?? (
      Boolean(globalThis.matchMedia?.('(min-width: 901px) and (hover: hover)').matches)
      && !connection?.saveData && !['slow-2g', '2g', '3g'].includes(connection?.effectiveType)
    );
    this.allowInteractionPreload = allowInteractionPreload ?? (
      !connection?.saveData && !['slow-2g', '2g', '3g'].includes(connection?.effectiveType)
    );
    this.errorListeners = videos.map((video) => {
      const listener = () => {
        if (this.activeVideo !== video || this.suspended) return;
        this.hideVideos();
        this.setStatus('error', failureReason(null, video));
      };
      video.addEventListener('error', listener);
      return [video, listener];
    });
  }

  configure(states) {
    this.states = states;
    this.renderedState = null;
  }

  setStatus(status, reason = '') {
    this.stage.dataset.mediaStatus = status;
    this.stage.dataset.mediaReason = reason;
    this.onStatus({ status, reason, state: this.desiredState });
  }

  show(state, { force = false } = {}) {
    this.desiredState = state;
    this.stage.dataset.state = state;
    const stateConfig = this.states[state];
    if (stateConfig?.poster && this.poster?.getAttribute('src') !== stateConfig.poster) {
      this.poster?.setAttribute('src', stateConfig.poster);
    }
    if (!force && this.renderedState === state) return this.switchPromise;

    const sequence = ++this.sequence;
    this.cancelAttempt?.();
    this.hideVideos();
    this.renderedState = state;
    if (this.suspended || this.reduceMotion) {
      this.setStatus(this.suspended ? 'suspended' : 'static');
      return Promise.resolve();
    }

    this.setStatus('loading');
    // No await before native play(): retry() must retain the click's activation.
    this.switchPromise = this.switchOnce(state, sequence);
    return this.switchPromise;
  }

  async switchOnce(state, sequence) {
    const video = this.videosByState.get(state);
    const config = this.states[state] ?? {};
    if (!video) {
      this.setStatus('error', 'missing');
      return;
    }
    const sources = supportedSources(video, config.sources);
    let reason = 'missing';
    for (const source of sources) {
      const result = await this.playSource(video, source, config.poster);
      if (sequence !== this.sequence) return;
      if (result.ok) {
        this.activeVideo = video;
        video.classList.add('is-active');
        this.stage.classList.add('media-ready');
        this.setStatus('playing');
        // On a normal phone connection, prepare speaking only after the user
        // has entered thinking, while the API / TTS is still working.
        this.preloadState({ idle: 'thinking', thinking: 'speaking' }[state], { interaction: state === 'thinking' });
        return;
      }
      reason = result.reason;
      video.pause();
      if (reason === 'blocked') break;
    }
    this.setStatus(reason === 'blocked' ? 'blocked' : 'error', reason);
  }

  playSource(video, source, poster) {
    return new Promise((resolve) => {
      let settled = false;
      let timer;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        video.removeEventListener('playing', onPlaying);
        video.removeEventListener('error', onError);
        if (this.cancelAttempt === cancel) this.cancelAttempt = null;
        resolve(result);
      };
      const cancel = () => finish({ ok: false, reason: 'cancelled' });
      const onPlaying = () => finish({ ok: true });
      const onError = () => finish({ ok: false, reason: failureReason(null, video) });
      this.cancelAttempt = cancel;
      video.addEventListener('playing', onPlaying);
      video.addEventListener('error', onError);
      timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), this.loadTimeoutMs);
      try {
        video.muted = true;
        video.defaultMuted = true;
        video.playsInline = true;
        video.preload = 'auto';
        if (poster) video.poster = poster;
        if (video.dataset.mediaSource !== source.src || video.error) {
          video.dataset.mediaSource = source.src;
          video.src = source.src;
          video.load();
        }
        // loadeddata may be delayed/suppressed in mobile data-saving modes.
        // Start loading and playing together, and trust playing / play().
        const play = video.play();
        play?.then(() => finish({ ok: true }), (error) => finish({ ok: false, reason: failureReason(error, video) }));
      } catch (error) {
        finish({ ok: false, reason: failureReason(error, video) });
      }
    });
  }

  preloadState(state, { interaction = false } = {}) {
    if (!state || (!this.allowPreload && !(interaction && this.allowInteractionPreload)) || this.reduceMotion || this.suspended) return;
    const video = this.videosByState.get(state);
    if (!video || video === this.activeVideo) return;
    const source = supportedSources(video, this.states[state]?.sources)[0];
    if (!source || video.dataset.mediaSource === source.src) return;
    video.preload = 'auto';
    video.dataset.mediaSource = source.src;
    video.src = source.src;
    video.load();
  }

  retry() {
    return this.show(this.desiredState, { force: true });
  }

  hideVideos() {
    this.activeVideo = null;
    for (const video of this.videos) {
      video.classList.remove('is-active');
      video.pause();
    }
    this.stage.classList.remove('media-ready');
  }

  suspend() {
    this.suspended = true;
    ++this.sequence;
    this.cancelAttempt?.();
    this.hideVideos();
    this.setStatus('suspended');
  }

  resume() {
    this.suspended = false;
    return this.retry();
  }

  dispose() {
    this.suspend();
    for (const [video, listener] of this.errorListeners) video.removeEventListener('error', listener);
  }
}
