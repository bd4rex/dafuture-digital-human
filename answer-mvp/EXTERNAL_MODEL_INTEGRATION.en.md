[中文](EXTERNAL_MODEL_INTEGRATION.md) · [Project overview](../README.en.md)

# Da Future: External Model Integration and AI Developer Handoff

Document version: 1.0. Verified against source on September 10, 2026.

Code baseline: `8741f252538153bbe2e03544b8e48ac289623bad`; `package.json` declares version `0.8.0`.

> This is an integration design and implementation handoff, not a claim that external speech is implemented. APIs, files, settings, and behaviors marked “proposed” require development. Copying an endpoint or model name into configuration does not implement an integration. No real account permissions, keys, billing allowances, or hosted deployment were verified.

## 1. One-minute summary

- Implemented: administration of an LLM connection, with text answers generated through an OpenAI-compatible chat endpoint.
- Not implemented: server-side external ASR, external TTS, pre-generated hosting audio, persistent audio storage, or audio caching.
- Current speech: browser recognition and synthesis. Replacement entry points exist, but only `browser` providers are implemented.
- Recommended sequence: TTS → pre-generated hosting audio and preview → ASR → streaming speech or semantic retrieval if measurements justify them.
- Not needed initially: real-time lip sync, full-duplex assistants, a vector database, a GPU inference cluster, or new microservices.
- Operator experience: configure and test everything in the existing web workbench. Visitors never configure keys.

The avatar uses prerecorded silent videos and posters, not real-time generated video or word-aligned lip sync. Speech models provide sound; the LLM provides content. These are separate configurations.

## 2. Implemented versus proposed

| Component | Actual baseline | Proposal |
| --- | --- | --- |
| LLM | `POST /answer` → server-side `/chat/completions` | Preserve the answer contract and natural fallbacks |
| ASR | `SpeechRecognition` / `webkitSpeechRecognition` | Add recording upload and a server recognition adapter |
| TTS | `SpeechSynthesisUtterance` | Add server synthesis and browser audio playback |
| Hosting | Operator selects exact text; SSE delivers it for browser speech | Generate, preview, approve, and dispatch prepared audio |
| Retrieval | Full small-library context within 24,000 characters; synonyms and lexical matching for larger libraries | Leave retrieval unchanged initially; no Embedding dependency |
| Logs | Full Q&A bodies, turn IDs, model outcomes, and browser speech events | Add ASR/TTS stages, provider request IDs, and cache diagnostics |
| Avatar | Four video states: `idle`, `thinking`, `speaking`, `presenting` | Preserve the current player and mobile/WeChat adaptations |

Caution: some version strings in `server.js` still say `0.7.0`, although `package.json` says `0.8.0`. Identify capability by the Git commit and actual code, not the `/api` version string alone. This document does not change those strings.

## 3. Recommended architecture

```text
Dialogue
Keyboard input ─────────────────────────────────────┐
Microphone → browser capture → project server → ASR → text ─┤
                                                        ↓
                                        existing /answer + knowledge + LLM
                                                        ↓
                                             validated answer text
                                                        ↓
                                          project server → TTS → audio
                                                        ↓
                                      browser playback + avatar state + logs

Hosting
Saved script → generate audio in admin → preview/approve → persist
                                                        ↓
                                       operator click → SSE → frontend playback
```

The browser calls the project server. The server uses the selected provider's HTTP or WebSocket protocol. Existing SSE remains the hosting-control channel, not the microphone-upload transport. A project HTTP endpoint does not imply that the upstream provider exposes the same HTTP endpoint.

Start with adapters inside the existing Node.js/Fastify process, not a separate Python service. Choose the provider and implement its documented protocol; do not introduce extra runtimes or deployment components merely to reuse an SDK.

## 4. Code map for the receiving AI

Paths below are relative to `answer-mvp/`. Function names are more stable than line numbers.

| File | Existing entry points | Integration responsibility |
| --- | --- | --- |
| [server.js](server.js) | `buildApp`, `ModelConfigStore`, `requireAdminAccess` | Routes, configuration, authentication, errors; `ModelConfigStore` is defined here, not in a separate module |
| [server.js](server.js) | `callLanguageModel`, `parseModelAnswer`, `buildModelMessages` | Preserve LLM calls, JSON validation, grounding, and fallbacks |
| [public/avatar.js](public/avatar.js) | `BrowserVoiceInput`, `voiceInputProviders` | Add recording and ASR input |
| [public/avatar.js](public/avatar.js) | `speechProviders`, `speakText`, `stopSpeech`, `finishSpeechSequence` | Add server-TTS audio playback |
| [public/avatar.js](public/avatar.js) | `askQuestion`, `beginHostedPresentation`, `applyRemoteLiveState` | Connect dialogue, hosting audio, and cancellation |
| [public/avatar-flow.js](public/avatar-flow.js) | `AvatarFlow`, `LiveStateTracker` | Preserve request/speech sequence checks and service-instance ordering |
| [public/avatar-media.js](public/avatar-media.js) | Current video player | Do not rewrite video or mobile layout to add speech |
| [public/avatar-config.json](public/avatar-config.json) | `speech`, `speechInput` | Public frontend configuration; never store keys here |
| [public/index.html](public/index.html), [public/app.js](public/app.js) | Model dialog, hosting controls, operations viewer | Compact speech settings, tests, and audio approval |
| [live-control-store.js](live-control-store.js) | `LiveControlStore.present/stop/syncEvent` | Add audio references while preserving exact text and sequence ordering |
| [ops-log-store.js](ops-log-store.js) | `OpsLogStore` | Correlated stage diagnostics, not a separate unlinked log system |
| [knowledge-store.js](knowledge-store.js) | Import, persistence, bundled knowledge | Leave unchanged; do not reactivate hidden knowledge |
| [Dockerfile](Dockerfile) | Explicit server-module `COPY` | Include new files or the container will fail |

Proposed new files; none exists in the baseline:

```text
speech-config-store.js          Private speech configuration and atomic persistence
speech-service.js               Unified ASR/TTS calls, errors, cancellation, logging
speech-providers/bailian.js     First provider adapter; name follows actual selection
speech-audio-store.js           Hosting assets, temporary audio, cache index
speech-config.example.json     Credential-free configuration example
test/speech.test.js             Mock provider and API tests
```

Modules may be combined where appropriate. Do not duplicate the entire dialogue or hosting implementation.

## 5. Preserve the existing LLM contract

The administrator uses Model Settings for the API URL, key, model, answer scope, style, and two fallback messages. These APIs already exist:

- `GET/PUT /api/model-config`
- `POST /api/model-config/test`
- `POST /answer`

Example visitor request:

```http
POST /answer
Content-Type: application/json
X-Conversation-Id: 45a07063-bc3f-47e6-950b-15955a0f5e90

{"question":"How can I join the project?"}
```

The expected raw model output is `{"status":"answered","answer":"…"}` or `{"status":"no_answer","answer":""}`. The project response includes `answer`, `speechText`, `answered`, `answerStatus`, `answerStatusSource`, `turnId`, `requestId`, and retrieval metadata. `no_answer` uses the configured knowledge-gap copy. Service failures retain non-2xx status and supply natural fallback text.

TTS must consume the final server-validated `speechText`, including normal answers and system fallbacks. Never read raw provider JSON, reasoning, tool calls, or truncated output. Do not bypass complete JSON validation and start speaking unvalidated model chunks merely to reduce latency.

LLM parameter compatibility varies. For a new provider, verify authentication, full URL, model ID, non-streaming text responses, output-length parameters, and acceptance by the existing parser. Models without this chat protocol need a server adapter, not just a different model name.

## 6. Proposed speech configuration

Add LLM / Speech Synthesis / Speech Recognition tabs within the existing model settings. Preserve the two business modes, Dialogue and Hosting, and avoid large space-consuming headings.

| Setting | Minimum fields | Actions |
| --- | --- | --- |
| TTS | Browser/server, provider, region, workspace where required, endpoint, key, model, voice, rate | Save and test, preview, stop preview |
| ASR | Browser/server, provider, region, workspace where required, endpoint, key, model, language | Save and test, recording test; hotwords can be advanced settings |

Persist an independent `speech-config.json`; do not rewrite the existing `model-config.json`. This private schema example is not an operational provider configuration:

```json
{
  "version": 1,
  "tts": {
    "provider": "browser",
    "endpoint": "",
    "region": "",
    "workspaceId": "",
    "apiKey": "",
    "model": "",
    "voice": "",
    "rate": 1,
    "format": "mp3",
    "timeoutMs": 30000
  },
  "asr": {
    "provider": "browser",
    "endpoint": "",
    "region": "",
    "workspaceId": "",
    "apiKey": "",
    "model": "",
    "language": "zh-CN",
    "timeoutMs": 30000
  }
}
```

Requirements:

- Default to `browser`. Unconfigured speech must not block text Q&A or administration sign-in.
- Allow only implemented adapters. Missing fields or an unsupported provider must produce a clear error, not pretend that external speech is active.
- Each service may use its own key. A shared vendor does not guarantee shared permissions, regions, voices, or interchangeable keys.
- A blank key preserves the saved value; clearing requires an explicit `clearApiKey` action. GET responses expose `hasApiKey`, never the key.
- Write the private file atomically with `0600` permissions. Use `revision` for concurrent updates, and retain the previous working configuration on failure.
- Provider/key/endpoint/model changes are activated after the operator explicitly chooses Save and Test and a short test succeeds. Opening the UI, changing presentation, or polling health must not silently make billable calls.
- `GET /avatar-config.json` exposes only `browser/server`, necessary non-secret settings, and fallback-audio references. A frontend `server` provider is separate from a backend vendor name.

Bailian is one candidate: its ASR offers HTTP file recognition and WebSocket real-time recognition; Qwen-TTS or CosyVoice can provide speech synthesis. Select and preview a concrete model/region/voice combination, then implement that protocol, not a copied chat URL. Recheck model availability and documentation on implementation day. [Official ASR selection](https://help.aliyun.com/zh/model-studio/asr-model/) · [Official TTS selection](https://help.aliyun.com/zh/model-studio/tts-model/)

## 7. Project API contracts: all proposed

These are project adapters, not upstream provider APIs. Paths may be revised before implementation if frontend, backend, tests, and documentation remain consistent.

| Method and path | Caller/access | Purpose |
| --- | --- | --- |
| `GET/PUT /api/speech-config` | Administrator | Read redacted settings; validate and save candidates |
| `POST /api/speech/test` | Administrator | Test a `tts/asr` configuration without implicitly replacing the active one |
| `POST /api/speech/transcribe` | Visitor | Upload one recording and return text; do not invoke the LLM here |
| `POST /api/speech/synthesize` | Visitor | Obtain audio for an already generated answer by `turnId` |
| `GET /api/speech/audio/:audioId` | Frontend holding an audio reference | Retrieve prepared audio, not arbitrary server paths |
| `POST /api/live-control/scripts/:id/audio` | Administrator | Generate audio for a saved hosting script |
| `PUT /api/live-control/scripts/:id/audio` | Administrator | Approve a previewed audio version |

### 7.1 Configuration and testing

Proposed `PUT /api/speech-config` body: `{revision, tts, asr, testConnection}`. Allow updating either subsection; omitted fields remain unchanged. Failed tests never activate a candidate. Return redacted settings, the new `revision`, and separate test status for each service.

`POST /api/speech/test` accepts `{kind:"tts", text:"Hello, welcome."}` and returns a temporary preview-audio reference plus a diagnostic ID. An ASR test uses multipart recording upload, identified as an administrator test through the existing session. Arbitrary preview text/recordings are administrator-only. The UI must disclose that tests consume provider allowance.

### 7.2 ASR: recording to text

Use `multipart/form-data` with one `audio` file and two string fields, `turnId` and `requestId`. Use UUIDs. Let browser `FormData` generate the multipart boundary.

Suggested first-stage format: WAV, 16 kHz, mono, 16-bit PCM, at most 60 seconds and 2 MiB. These are proposed project limits, not universal provider specifications. Adjust after selecting the model. Override Fastify/multipart limits for this route; changing the global JSON `bodyLimit` alone is insufficient. Validate actual audio headers, duration, and format rather than trusting the filename or client MIME type.

```json
{
  "turnId": "45a07063-bc3f-47e6-950b-15955a0f5e90",
  "requestId": "1b3348f1-d79f-4e03-9cf8-1d65d5d2efaa",
  "text": "How can I join the project?",
  "language": "en-US",
  "durationMs": 3200
}
```

Here `durationMs` is the input recording duration; log API latency separately. Only final text may trigger `/answer`; interim results must not. Silence or empty recognition returns `ASR_NO_SPEECH` without an LLM request. Let the visitor edit text exceeding the current question-length limit instead of silently truncating and submitting it.

### 7.3 TTS: answer to audio

```http
POST /api/speech/synthesize
Content-Type: application/json

{"turnId":"45a07063-bc3f-47e6-950b-15955a0f5e90","requestId":"aa1b5e3f-5c2d-43a9-ae77-15257b0ce06c"}
```

Add a bounded recent-answer store, for example 200 turns with a ten-minute TTL. At the final `/answer` response stage, retain validated `speechText` for both normal answers and system fallbacks, then look it up by `turnId`. Visitors must not supply arbitrary synthesis text, provider URLs, keys, or local file paths. A turn ID is not administrator authentication and grants no configuration/log access. Detect duplicate or conflicting IDs rather than overwriting other turns.

Success returns actual audio bytes, for example `Content-Type: audio/mpeg`, with `X-Speech-Request-Id` and `X-Cache-Hit`. If a cross-origin frontend needs those headers, expose them through CORS. Failure returns non-2xx JSON:

```json
{
  "error": "TTS_TIMEOUT",
  "message": "Speech is temporarily unavailable. Please read the answer on screen.",
  "turnId": "45a07063-bc3f-47e6-950b-15955a0f5e90",
  "requestId": "aa1b5e3f-5c2d-43a9-ae77-15257b0ce06c",
  "retryable": true
}
```

Unknown or expired turns return `404 SPEECH_TURN_EXPIRED`. Do not regenerate the LLM answer or speak provider error bodies. Validate audio type, nonempty content, size, and decodability. An upstream HTTP 200 containing HTML or JSON is still a failure.

### 7.4 Audio references and hosting assets

Hosting generation accepts `{revision}`; the server reads the saved script by ID and returns `{audioId, previewUrl, cacheKey, status:"prepared"}`. Approval accepts `{revision, audioId, approved:true}` and verifies that the audio still matches the current text and voice settings.

Use unpredictable `audioId` values with server-managed mappings. Expose only assets required for playback, not directory listings or arbitrary downloads. Dialogue/test audio has short retention; approved hosting audio is persisted separately. Public playback in this demo is not a confidential audio-distribution service. Treat stricter audio access control as a new requirement if requested.

Audio retrieval should provide correct MIME/length headers and support `HEAD` and valid `Range` requests. Reuse the existing video-route range approach only for assets resolved through the controlled audio index. Include mobile loading, seeking, and replay in acceptance.

## 8. Provider adapters and audio formats

Proposed internal interface, separating the UI from provider protocols:

```js
// Interface sketch, not an executable implementation.
transcribe({ audioBuffer, mimeType, language, signal, requestId });
// Promise<{ text, providerRequestId, audioDurationMs }>

synthesize({ text, voice, rate, format, signal, requestId });
// Promise<{ audioBuffer, mimeType, providerRequestId }>
```

- Initially use ordinary HTTP between browser and project server. An adapter may internally use HTTP, task polling, or WebSocket, but must handle timeouts, cancellation, and connection disposal.
- If WebSocket, audio encoding, or provider SDK dependencies are needed, update `package.json` and the lockfile and verify the declared Node.js version range. Do not assume browser APIs are available on the server.
- If a provider returns an asynchronous task ID, wait for final success. Accepted is not synthesized/transcribed. Prefer services suitable for short interactive turns.
- Do not assume `MediaRecorder` produces WAV. A WAV design needs explicit capture, resampling, and encoding. A WebM/Opus design requires verified provider support or an explicitly added transcoder.
- Prefer a browser-playable container. Raw PCM is not MP3/WAV and cannot be fixed by changing the file extension.
- Validate provider-specific text limits, audio specifications, and model/voice compatibility inside the adapter. Long hosting scripts may be synthesized in segments, but all segments must succeed and be previewed; truncated audio is not a complete script.
- Start with a provider system voice. Voice cloning, voice design, real-time voice assistants, and lip-sync generation are outside the default first-stage scope.

## 9. Playback, cancellation, and deterministic hosting

Add `speechProviders.server` and `voiceInputProviders.server`. Reuse the existing entry points rather than building another chat state machine.

### Dialogue audio

1. Preserve `askQuestion` → `answerReady`; an available answer remains in `thinking/audio-preparing`.
2. Request TTS with the same `turnId`, then prepare a Blob URL or controlled audio reference.
3. Only `<audio>` `playing` may call `startSpeechSequence`. Text receipt, audio bytes, and `canplay` are not audible playback.
4. Only `ended` means normal completion. A rejected `play()`, decoding failure, timeout, or network error must become failure or a user-action-required state, never completion. Browsers can reject script-initiated playback; retain a click-to-play control. [Playback rules](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/play)

### Cancellation across the complete pipeline

- Preserve cancellation semantics for a new question, hosting command, stop, mode switch, mute, and control disconnect.
- In addition to `speechSynthesis.cancel()`, abort the current audio request, stop `<audio>`, clear playback queues, and release Blob URLs. Stop microphone tracks when ASR is cancelled.
- Reject late results using `speechSequence`, `requestSequence`, and hosting `instanceId + commandSequence`. Even when upstream computation cannot be stopped, obsolete audio must never play.
- Separate cloud synthesis timeout from browser playback-start timeout. Do not apply the existing browser-speech eight-second start watchdog to the entire cloud synthesis operation.
- Attempt upstream cancellation, but do not promise that stopping playback reverses provider charges already incurred.

### Explicit hosting-audio policy

- Pre-generated-audio mode follows save script → generate → preview → approve → play.
- Extend the existing `present` event with optional `audio: {id, url, mimeType, cacheKey}`. Preserve `script`, `instanceId`, `sequence`, and `commandSequence`.
- The cache key includes exact text, provider, model, voice, rate, format, and every other output-affecting parameter. Text or voice-setting changes invalidate approval.
- In pre-generated mode, missing/unapproved audio returns `409 HOST_AUDIO_NOT_READY` without dispatching a new playback command. The original browser mode remains an explicit alternative.
- Generate hosting audio only from administration, not independently at each display. Live clicks use the approved asset, without LLM rewriting or last-minute voice replacement/synthesis.
- `sync` and reconnection synchronize control state only; they never replay finished or old commands. Stop and newer commands outrank late download callbacks.
- Preloaded audio is not permission to accept new commands offline. Preserve the existing stop-on-control-disconnect policy even when audio is cached.

## 10. Speech input and natural fallbacks

Initially support one recording followed by recognition, not continuous listening, wake words, echo cancellation, or simultaneous speech and interruption. Stop current playback when the microphone starts. Submit final recognized text through the existing path and retain keyboard input.

Allocate `turnId` when recording begins and reuse it for ASR, `/answer`, TTS, and playback logs. Currently `askQuestion` allocates its own ID; allow an existing one to be supplied. Generating a new ID at each stage breaks correlation.

Remote microphone capture requires HTTPS and user permission. This is a browser rule, not a new project origin restriction; local `localhost` is a development exception. WeChat still needs target-device verification. [Microphone requirements](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)

Recommended fallback behavior:

| Failure | Expected behavior |
| --- | --- |
| ASR failure or silence | No LLM call; invite another recording or keyboard input |
| LLM lacks evidence | Preserve configured knowledge-gap copy and synthesize it normally |
| LLM/network failure | Use natural service-error copy, never technical errors |
| TTS fails with a valid answer | Keep text; optionally try browser speech, then clearly report playback failure |
| Frontend cannot reach the server | Use fallback audio already cached by the page; otherwise retain text and explain honestly |
| Hosting audio is corrupt/unavailable | Report failure and await operator retry; never rewrite or substitute the script |

Pre-generate short service-error, knowledge-gap, and unclear-speech clips and prefetch them after page load. The minimal cache only supports the already-open page. Offline playback after refresh requires additional Cache Storage/Service Worker implementation and acceptance. Do not treat browser speech as guaranteed offline capability. [Browser recognition boundary](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition)

## 11. Logs, errors, and privacy

Preserve the user's requested full question/answer records, readable, searchable, and downloadable only through administration. Add stage diagnostics, but do not persist raw microphone recordings by default.

Suggested fields: `turnId`, project `requestId`, `providerRequestId`, `stage`, provider, model, voice, `durationMs`, `upstreamStatus`, `errorCode`, `cacheHit`, and `outcome`. In server logs, `durationMs` is stage latency; use `audioDurationMs` for recording duration. Never log keys, authentication headers, complete temporarily signed URLs, or sensitive raw upstream bodies. Extend existing redaction to cover new speech keys.

| Proposed code | Project HTTP status | Meaning |
| --- | --- | --- |
| `ASR_NOT_CONFIGURED` / `TTS_NOT_CONFIGURED` | 503 | Service not configured |
| `ASR_INVALID_AUDIO` / `ASR_NO_SPEECH` | 400 / 422 | Invalid audio or no usable transcript |
| `ASR_AUDIO_TOO_LARGE` / `ASR_AUDIO_TOO_LONG` | 413 / 422 | Recording exceeds project limits |
| `ASR_TIMEOUT` / `TTS_TIMEOUT` | 504 | Timeout |
| `ASR_UPSTREAM_ERROR` / `TTS_UPSTREAM_ERROR` | 502 | Preserve real upstream 401/403/429/5xx in administrator logs |
| `TTS_INVALID_AUDIO` | 502 | Empty, incorrect, or undecodable audio |
| `SPEECH_TURN_EXPIRED` | 404 | Synthesis source expired; do not rerun the LLM |
| `HOST_AUDIO_NOT_READY` | 409 | Hosting audio missing or version mismatch |

`/api/client-events` currently validates fields and phases strictly. Arbitrary `asr-*` names or audio bodies will not work. Adding `asr-started/completed/failed/cancelled` requires coordinated server allowlists, localized summaries, outcome classification, frontend emission, and tests. Retain `kind:"dialogue"` and the same `turnId`. Existing `speech-*` phases continue to describe playback results.

A cache hit is not playback completion; provider success is not proof of audible speakers. When cloud TTS fails but browser fallback succeeds, retain both upstream failure and final playback success. Existing offline event-queue size and tab-lifetime limitations still apply.

## 12. Storage, Docker, and compatibility

Propose `SPEECH_CONFIG_FILE` and `SPEECH_AUDIO_DIR`, pointing to private application storage locally and `/data/speech-config.json`, `/data/speech-audio` in Docker. Keep the audio index and approved assets together. Bound temporary files by capacity and TTL, with cleanup rather than unlimited accumulation.

Update all of the following during implementation:

1. Root `.gitignore`: exclude private speech settings, generated audio, caches, recordings, and indexes.
2. `answer-mvp/.dockerignore`: exclude local speech secrets and generated artifacts; examples remain credential-free.
3. `answer-mvp/Dockerfile`: explicitly copy new server modules/provider directories, set `/data` paths, and preserve write access for the `node` user.
4. `compose.yaml`: reuse `answer-data:/data`; do not move existing business data into a new empty location.
5. If splitting frontend JS, load and register its static route in `buildApp`. This server does not automatically expose the whole `public` directory, and some assets are read at startup. Restart the isolated acceptance instance after changes.
6. `/health` may include ASR/TTS configuration and connection status without paid checks. Optional unconfigured speech should not make text Q&A fail `/ready`.

Configuration, testing, and hosting-audio generation retain existing administration authentication. Visitor recognition, current-answer synthesis, and playback follow the public-demo frontend model. Do not restore the origin restrictions removed at the user's request or introduce local-only first-password setup. Explain audio limits, failure handling, and necessary spending controls without treating them as authorization for a production-security redesign.

## 13. Implementation order and acceptance

### Staged delivery

1. Baseline: read this document and actual code, inspect Git/configuration state, and run existing tests.
2. TTS: implement a mock adapter, private settings, preview, server synthesis, and cancellable playback before one real provider adapter.
3. Hosting audio: persistence, preview approval, invalidation, SSE references, stop, and reconnect tests.
4. ASR: short recordings, final text, shared turn IDs, submission, and keyboard fallback.
5. End to end: classified errors, cache, offline fallback, log inspection, Docker, and real devices.

Keep `browser` mode usable after each step. Do not begin with a framework for every supplier. Embedding, Rerank, and real-time lip sync need separately agreed scope.

### Acceptance matrix

| Scenario | Required evidence |
| --- | --- |
| Existing behavior | Current suite passes; knowledge, bundled import, LLM, hosting, and mobile layout do not regress |
| Configuration | Keys never echo/log; settings survive restart; failed candidates preserve working settings |
| Normal TTS | Decodable audio, speaking posture only after actual `playing`, idle after `ended` |
| TTS errors | 401/403/429/5xx, timeout, empty/fake audio are distinguishable and never falsely completed |
| Cancellation races | Stop during synthesis/download and mode/script changes prevent late playback |
| Hosting | Approved exact-script audio, approval invalidation, no per-frontend duplicate synthesis |
| Reconnect | Reconcile missed stops, reject retired instances/old sequences, never auto-replay |
| ASR | Mandarin/project terminology, silence, timeout, cancel, permission denial, and invalid formats |
| Correlation | One recording shares a `turnId` through ASR, answer, TTS, and playback |
| Fallbacks | Knowledge gap, LLM failure, TTS failure, and frontend disconnect take distinct correct paths |
| Logs | Full Q&A remains administrator-only; stage latency/upstream faults are distinguishable; no credential leakage |
| Docker | New modules exist in image; empty/existing volumes start; settings and approved audio survive restart |
| Devices | Target computer/phone/WeChat: first permission, click-to-play, stop, mute, foreground/background |

Existing commands, starting at the repository root:

```bash
cd answer-mvp
npm ci
npm test
npm run test:functional
```

Use an isolated Compose project/data volume for container acceptance, not the default project against a live instance. Use isolated models, recordings, knowledge, and credentials in fixtures. Real provider tests require user-supplied configuration and authorization.

Report mock API, real provider, real browser playback, and physical-speaker/target-device acceptance separately. Mark missing levels as unverified. Mock success is not evidence of field quality or a guaranteed latency.

## 14. Copyable task for another AI

```text
Implement external speech in the existing Da Future repository using
answer-mvp/EXTERNAL_MODEL_INTEGRATION.en.md. Inspect actual code and Git state
first; do not assume the documented baseline is the latest checkout.

Initial scope is TTS, pre-generated hosting audio, and ASR. Preserve existing
LLM /answer, knowledge, Dialogue/Hosting modes, video player, natural fallbacks,
and complete Q&A logs. Do not rewrite the application.

Provide backend speech settings, Save and Test, and audio preview. Keep keys
server-private and never echo them. Implement cancellable frontend audio and
recording. Preserve instance/sequence ordering so late audio cannot play after
stop, mode changes, or newer hosting commands. Hosting uses approved exact-text
audio, not an LLM rewrite.

Items marked proposed do not exist yet and require implementation. Verify the
selected provider protocol, region, and voice using current official docs.
ASR/TTS cannot be integrated merely by changing a chat model name. Include new
server modules in Dockerfile and persist private settings/audio under /data.

Finish isolated mock tests before short real-provider tests explicitly configured
and authorized by the user. Without real configuration, still deliver runnable
code and mock tests, and list unverified items. Do not ask the user to paste real
keys into chat, make unauthorized billable calls, or alter working business data.
Do not add vector databases, real-time lip sync, full-duplex speech, or origin
restrictions without a new request.

Deliver code, separate Chinese/English documentation, test results, remaining
items, and local run instructions. Commit/push GitHub or update hosted deployment
only when the user explicitly requests those actions.
```

## 15. Official references and future revalidation

References were checked on September 10, 2026. They describe vendor/browser capabilities, not proof of integration in this project.

- [Bailian ASR selection and specifications](https://help.aliyun.com/zh/model-studio/asr-model/)
- [Bailian TTS selection and specifications](https://help.aliyun.com/zh/model-studio/tts-model/)
- [Bailian non-real-time TTS](https://help.aliyun.com/zh/model-studio/non-realtime-tts-user-guide)
- [Bailian real-time TTS](https://help.aliyun.com/zh/model-studio/realtime-tts-user-guide)
- [Browser microphone access](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
- [Browser speech-recognition compatibility](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition)
- [Browser audio playback and rejection handling](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/play)

Model IDs, regional endpoints, workspace parameters, voice names, prices, and quotas are intentionally not hardcoded as universal defaults. Document the chosen combination and real-test date during implementation, but never record real keys.
