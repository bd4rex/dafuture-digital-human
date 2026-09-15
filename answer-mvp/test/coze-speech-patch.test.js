import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { patchCozeAvatar } from '../scripts/patch-coze-speech.mjs';

const reference = await readFile(new URL('../public/avatar.js', import.meta.url), 'utf8');
const platformInput = `class ServerVoiceInput { /* platform ASR must remain byte-identical */ }
const platformSettings = { speech: { provider: 'server' }, speechInput: { provider: 'server' } };
const recognize = () => fetch('/api/asr');
`;
const legacy = reference
  .replace(/\/\/ BEGIN SERVER SPEECH LIFECYCLE[\s\S]*?(?=function normalizedVoiceName\()/,
    'let serverSpeechAudio = null; // obsolete shared audio\n')
  .replace(/\/\/ BEGIN SERVER SPEECH PROVIDER[\s\S]*?(?=async function requestAnswer\()/,
    "// 服务端播报失败时降级为浏览器语音\nconst fallbackToBrowserSpeech = () => {};\nconst tts = () => fetch('/api/tts');\n")
  .replace("document.addEventListener('pointerdown', unlockServerSpeechAudio);",
    "document.addEventListener('keydown', unlockServerSpeechAudio);");

test('扣子定向补丁：完整保留平台 ASR/配置，播放逻辑与本地共用，重复应用结果不变', () => {
  const patched = patchCozeAvatar(platformInput + legacy, reference);
  assert.equal(patched, platformInput + reference);
  assert.equal(patchCozeAvatar(patched, reference), patched);
  assert.doesNotMatch(patched, /fallbackToBrowserSpeech/);
  assert.doesNotMatch(patched, /addEventListener\('keydown', unlockServerSpeechAudio/);
});

test('扣子定向补丁：未知版本、重复锚点或额外旧回退拒绝猜测，不生成部分结果', () => {
  for (const invalid of [reference, platformInput + legacy.replace('function bindEvents() {', 'function renamedBindings() {'),
    platformInput + legacy + '\nfunction bindEvents() {}', platformInput + legacy + '\nfallbackToBrowserSpeech();']) {
    assert.throws(() => patchCozeAvatar(invalid, reference));
  }
});
