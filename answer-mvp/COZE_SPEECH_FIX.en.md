[中文](COZE_SPEECH_FIX.md) · [Project overview](README.en.md)

# Coze platform speech playback fix

Date: September 15, 2026. Scope: frontend playback and interaction only. Preserve platform-provided TTS/ASR, the configured male voice, backend routes and private settings. The user redeploys in Coze.

## Instruction for Coze

> Preserve the project's existing platform TTS/ASR, male voice, `/api/tts`, `/api/asr` and configuration. Only repair frontend playback: allow drafting during an answer without submission, interruption or browser-voice fallback. Merge the tested lifecycle, server provider and interaction bindings. Do not recreate global keydown audio priming or fallbackToBrowserSpeech, and do not replace Coze's server settings with repository browser defaults.

## Why a targeted update is necessary

Coze adds `ServerVoiceInput` and platform ASR/TTS adapters to the repository. Both deployed providers are `server`; repository defaults remain `browser` and no platform speech backend is included locally.

The deployed failure was reproduced with one ordinary letter and no second answer/TTS request: document `keydown` invokes audio unlock, replacing the active clip with `data:` silence. The deployed `media-src 'self' blob:` blocks it, and the error handler switches to browser speech. Submission locks alone cannot fix player ownership. Do not solve this by allowing unrestricted or data-scheme media.

## Files and boundaries

- Repository `public/avatar.js` now includes safe server playback while keeping browser defaults.
- Repository `server.js` allows `media-src 'self' blob:` without adding data-scheme audio.
- Coze needs a patched copy of its own `public/avatar.js`, retaining ASR, configuration loading and other platform code.
- The verified Coze CSP already allows Blob media. Do not overwrite its backend; adjust only that directive if a future deployment lacks it.

Never replace the complete Coze frontend/backend with repository defaults: that would remove platform-only adapters. Preserve `avatar-config.json`, knowledge, model settings, authentication and hosting scripts.

## Generate from the current Coze frontend

Export the current Coze `public/avatar.js`, then run from this repository's `answer-mvp/` directory:

```bash
node scripts/patch-coze-speech.mjs /path/to/coze-avatar.js /path/to/avatar.fixed.js
node --check /path/to/avatar.fixed.js
```

The script copies only three tested reference regions:

1. `BEGIN SERVER SPEECH LIFECYCLE` through the section before `normalizedVoiceName`: player ownership, priming and lifecycle cleanup.
2. `BEGIN SERVER SPEECH PROVIDER` through the section before `requestAnswer`: existing `/api/tts` contract, without browser fallback.
3. `bindEvents`: editable drafts and submission guards, idle pointer/explicit-submit priming, no global keydown audio handler.

Input is never overwritten; output must not exist. Missing/duplicate anchors or remaining legacy fallback are rejected. This targets the frontend structure verified for this fix. Review any later Coze edits in the replaced regions instead of blindly overwriting new behavior.

Confirm `ServerVoiceInput`, `/api/asr` and configuration loading remain intact, replace only Coze's `public/avatar.js`, then rebuild and redeploy. The supplied generated file may be used if Coze still matches the inspected version; otherwise regenerate from its latest source, including undeployed changes.

## Playback invariants

- Prime only on idle user gestures, never during synthesis, playback preparation, real playback or another prime attempt. Ordinary typing has no global audio side effect.
- Use 50 ms Blob/WAV silence and invalidate attempt ownership before cleanup. Late promises cannot pause/load newer audio. Actual `playing` also marks the persistent element unlocked.
- Preserve `POST /api/tts`, JSON `{text}`, returning nonempty binary `audio/*`. The 30-second synthesis deadline includes body reading; the separate eight-second start deadline begins after audio is ready.
- Only `playing` changes the speaking pose. Buffering/resume cannot duplicate start reports. Only `ended` means completion; a duration-aware watchdog has a minimum 60-second budget.
- Failures, blocked autoplay and timeouts retain text and restore controls without browser speech or automatic draft submission. `play()` can reject or resolve late. [Browser playback contract](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/play)
- Explicit mute, operator stop/takeover and control disconnection still cancel. Abort requests, detach listeners, stop audio and release URLs. Late bodies, promises and media callbacks cannot affect a newer turn.

## Acceptance and limits

Run `npm test` and `npm run test:review`: this change passes 254/254 with no skips/TODOs, including nine new server playback groups and two patch preservation/rejection tests. Existing browser speech and recognition regressions remain active.

Browser checks use a separate session with only `/avatar.js` replaced in that session. The page, CSP, real `/answer` and real `/api/tts` remain Coze-hosted. This does not mutate or redeploy production. Native audio playback is used; no real microphone is enabled.

After redeployment:

1. Open a fresh page, send one question and wait for real male-voice playback.
2. Type a second draft character by character, without submitting; focus/clicks must not interrupt playback.
3. Enter adds no answer/TTS request and preserves the draft; microphone and pose tests cannot take over.
4. Completion restores sending; the draft is submitted only by deliberate user action.
5. TTS 500, bad audio and rejected playback retain text with zero `speechSynthesis.speak` calls; stale cancelled audio cannot resume.
6. Verify existing platform ASR and male voice, then test Xiaomi 15 WeChat and Chrome. Mobile viewport emulation is not device acceptance.

GitHub publication and Coze redeployment are separate actions. This handoff supplies code and instructions without automatically deploying.
