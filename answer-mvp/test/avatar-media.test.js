import assert from 'node:assert/strict';
import test from 'node:test';
import { AvatarVideoSwitcher, supportedSources } from '../public/avatar-media.js';

function classList() {
  const values = new Set();
  return { add: (name) => values.add(name), remove: (name) => values.delete(name), contains: (name) => values.has(name) };
}

class Video extends EventTarget {
  constructor(state) {
    super();
    this.dataset = { avatarVideo: state };
    this.classList = classList();
    this.paused = true;
    this.readyState = 0;
    this.loads = 0;
    this.plays = 0;
    this.error = null;
  }
  canPlayType() { return 'probably'; }
  load() { this.loads++; this.error = null; }
  pause() { this.paused = true; }
  play() {
    this.plays++;
    if (this.playOverride) return this.playOverride();
    this.paused = false;
    this.readyState = 4;
    return Promise.resolve();
  }
}

function fixture(t, options = {}) {
  const names = ['idle', 'thinking', 'speaking', 'presenting'];
  const videos = names.map((name) => new Video(name));
  const byState = Object.fromEntries(videos.map((video) => [video.dataset.avatarVideo, video]));
  const stage = { dataset: {}, classList: classList() };
  const poster = { getAttribute(name) { return this[name]; }, setAttribute(name, value) { this[name] = value; } };
  const statuses = [];
  const states = Object.fromEntries(names.map((name) => [name, {
    sources: [{ src: `/${name}.mp4`, type: 'video/mp4' }], poster: `/${name}.jpg`,
  }]));
  const player = new AvatarVideoSwitcher({ stage, videos, poster, onStatus: (event) => statuses.push(event), reduceMotion: false, allowPreload: false, allowInteractionPreload: false, ...options });
  player.configure(states);
  t.after(() => player.dispose());
  return { player, stage, poster, videos, byState, states, statuses };
}

test('MP4 playback starts before loadeddata; repeated poses reuse buffers', async (t) => {
  const { player, byState, stage, poster } = fixture(t);
  const initial = player.show('idle');
  assert.equal(byState.idle.plays, 1, 'play is invoked synchronously');
  await initial;
  assert.equal(stage.dataset.mediaStatus, 'playing');
  assert.equal(poster.src, '/idle.jpg');
  await player.show('thinking');
  await player.show('idle');
  assert.equal(byState.idle.loads, 1);
  assert.equal(byState.thinking.paused, true);
  assert.equal(byState.idle.muted, true);
  assert.equal(byState.idle.playsInline, true);
  await player.show('idle');
  assert.equal(byState.idle.plays, 2, 'unchanged state does not restart');
});

test('autoplay restriction preserves the real poster and a click can retry synchronously', async (t) => {
  const { player, byState, stage, poster } = fixture(t);
  byState.idle.playOverride = () => Promise.reject(Object.assign(new Error('gesture needed'), { name: 'NotAllowedError' }));
  await player.show('idle');
  assert.equal(stage.dataset.mediaStatus, 'blocked');
  assert.equal(poster.src, '/idle.jpg');
  assert.equal(stage.classList.contains('media-ready'), false);
  byState.idle.playOverride = null;
  const retry = player.retry();
  assert.equal(byState.idle.plays, 2);
  await retry;
  assert.equal(stage.dataset.mediaStatus, 'playing');
  assert.equal(byState.idle.loads, 1, 'policy restriction does not discard the downloaded file');
});

test('late play completions cannot revive old poses or block a new state', async (t) => {
  const { player, byState, stage } = fixture(t);
  let resolveOld;
  byState.idle.playOverride = () => new Promise((resolve) => { resolveOld = resolve; });
  const old = player.show('idle');
  await player.show('thinking');
  resolveOld();
  await old;
  await Promise.resolve();
  assert.equal(stage.dataset.state, 'thinking');
  assert.equal(player.activeVideo, byState.thinking);
  assert.equal(byState.idle.classList.contains('is-active'), false);
  assert.equal(byState.idle.paused, true);
});

test('switching back while old play is pending cannot cancel the new attempt', async (t) => {
  const { player, byState } = fixture(t);
  let rejectOld;
  byState.idle.playOverride = () => new Promise((_resolve, reject) => { rejectOld = reject; });
  const old = player.show('idle');
  await player.show('thinking');
  byState.idle.playOverride = null;
  await player.show('idle');
  rejectOld(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  await old;
  assert.equal(player.activeVideo, byState.idle);
  assert.equal(byState.idle.paused, false);
});

test('reduced motion uses the matching static portrait without downloading video', async (t) => {
  const { player, videos, poster, stage } = fixture(t, { reduceMotion: true });
  await player.show('speaking');
  assert.equal(poster.src, '/speaking.jpg');
  assert.equal(stage.dataset.mediaStatus, 'static');
  assert.ok(videos.every((video) => video.loads === 0 && video.plays === 0));
});

test('phone mode loads only the active pose, desktop may preload the next pose', async (t) => {
  const phone = fixture(t);
  await phone.player.show('idle');
  assert.deepEqual(phone.videos.map((video) => video.loads), [1, 0, 0, 0]);
  const desktop = fixture(t, { allowPreload: true });
  await desktop.player.show('idle');
  assert.deepEqual(desktop.videos.map((video) => video.loads), [1, 1, 0, 0]);
  assert.equal(desktop.byState.thinking.plays, 0);
  await desktop.player.show('thinking');
  assert.equal(desktop.byState.thinking.loads, 1);
});

test('an empty canPlayType hint does not prevent an actual MP4 attempt', async (t) => {
  const { player, byState } = fixture(t);
  byState.idle.canPlayType = () => '';
  assert.equal(supportedSources(byState.idle, [{ src: '/idle.mp4', type: 'video/mp4' }]).length, 1);
  await player.show('idle');
  assert.equal(player.activeVideo, byState.idle);
});

test('normal phone connections prepare speaking during thinking, not on first load', async (t) => {
  const { player, videos, byState } = fixture(t, { allowInteractionPreload: true });
  await player.show('idle');
  assert.deepEqual(videos.map((video) => video.loads), [1, 0, 0, 0]);
  await player.show('thinking');
  assert.deepEqual(videos.map((video) => video.loads), [1, 1, 1, 0]);
  assert.equal(byState.speaking.plays, 0);
});

test('a media error falls back to a poster; retry reloads the failed file', async (t) => {
  const { player, byState, stage } = fixture(t);
  await player.show('idle');
  byState.idle.error = { code: 2 };
  byState.idle.dispatchEvent(new Event('error'));
  assert.equal(stage.dataset.mediaReason, 'network');
  assert.equal(player.activeVideo, null);
  await player.retry();
  assert.equal(byState.idle.loads, 2);
  assert.equal(stage.dataset.mediaStatus, 'playing');
  byState.thinking.error = { code: 3 };
  byState.thinking.dispatchEvent(new Event('error'));
  assert.equal(stage.dataset.mediaStatus, 'playing', 'an inactive preload error must not hide the active video');
});

test('loading timeout is recoverable and a stale failure cannot replace the active status', async (t) => {
  const { player, byState, stage } = fixture(t, { loadTimeoutMs: 10 });
  byState.idle.playOverride = () => new Promise(() => {});
  await player.show('idle');
  assert.equal(stage.dataset.mediaReason, 'timeout');
  assert.equal(byState.idle.paused, true);
  await player.show('presenting');
  assert.equal(stage.dataset.mediaStatus, 'playing');
});

test('background suspension pauses videos and resumes the latest pose', async (t) => {
  const { player, byState, poster, stage } = fixture(t);
  await player.show('idle');
  player.suspend();
  await player.show('speaking');
  assert.equal(poster.src, '/speaking.jpg');
  assert.equal(byState.speaking.plays, 0);
  assert.equal(stage.dataset.mediaStatus, 'suspended');
  await player.resume();
  assert.equal(player.activeVideo, byState.speaking);
  assert.equal(byState.idle.paused, true);
});
