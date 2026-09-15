import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function uniqueIndex(source, anchor) {
  const index = source.indexOf(anchor);
  if (index === -1 || source.indexOf(anchor, index + anchor.length) !== -1) {
    throw new Error(`Expected exactly one anchor; refusing to guess: ${anchor}`);
  }
  return index;
}

function region(source, start, end) {
  const first = uniqueIndex(source, start);
  const last = uniqueIndex(source, end);
  if (last <= first) throw new Error(`Invalid section order: ${start}`);
  return { first, last, text: source.slice(first, last) };
}

function replaceRegion(target, reference, from, to, referenceFrom = from) {
  const old = region(target, from, to);
  const fixed = region(reference, referenceFrom, to);
  return target.slice(0, old.first) + fixed.text + target.slice(old.last);
}

// Touch only the known frontend playback lifecycle, provider and UI bindings.
// Keep Coze's ServerVoiceInput, /api/asr, config merge and all platform code.
export function patchCozeAvatar(target, reference) {
  if (!target.includes('class ServerVoiceInput {') || !target.includes("fetch('/api/tts'")) {
    throw new Error('Not the expected Coze frontend with platform ASR/TTS; no output written.');
  }
  const lifecycle = '// BEGIN SERVER SPEECH LIFECYCLE';
  const provider = '// BEGIN SERVER SPEECH PROVIDER';
  let patched = replaceRegion(target, reference,
    target.includes(lifecycle) ? lifecycle : 'let serverSpeechAudio = null',
    'function normalizedVoiceName(', lifecycle);
  patched = replaceRegion(patched, reference,
    patched.includes(provider) ? provider : '// 服务端播报失败时降级为浏览器语音',
    'async function requestAnswer(', provider);
  patched = replaceRegion(patched, reference, 'function bindEvents() {', 'async function start() {');
  if (patched.includes('fallbackToBrowserSpeech') || /addEventListener\(['"]keydown['"],\s*unlockServerSpeechAudio/.test(patched)) {
    throw new Error('Unexpected legacy speech handler remains; no output written.');
  }
  return patched;
}

async function main() {
  const [sourcePath, outputPath, ...extra] = process.argv.slice(2);
  if (!sourcePath || !outputPath || extra.length || path.resolve(sourcePath) === path.resolve(outputPath)) {
    throw new Error('Usage: node scripts/patch-coze-speech.mjs COZE_AVATAR_JS NEW_OUTPUT_JS (input is never overwritten)');
  }
  const [target, reference] = await Promise.all([
    readFile(sourcePath, 'utf8'), readFile(new URL('../public/avatar.js', import.meta.url), 'utf8'),
  ]);
  const patched = patchCozeAvatar(target, reference);
  // Exclusive creation: do not replace either the source or an earlier result.
  await writeFile(outputPath, patched, { encoding: 'utf8', flag: 'wx' });
  console.log(`Frontend patch written: ${outputPath}`);
  console.log('Preserved platform ASR/TTS backend and configuration. Review and replace only public/avatar.js; redeploy separately.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
