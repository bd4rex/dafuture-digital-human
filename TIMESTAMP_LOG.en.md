[中文](TIMESTAMP_LOG.md)

# Project Timestamp Log

## 2026-09-03 20:43 +0800

- Task: build the first runnable prototype from the “Da Future Digital Human Q&A MVP Minimal Plan V1.2.”
- Output: added `answer-mvp/` with a Fastify Q&A service, sample `content.json`, Dockerfile, automated tests, and Chinese runtime instructions.
- Scope: implemented only the deterministic Q&A API, content-file validation, and hot reload; no administration UI, database, vector store, large language model, TTS, or digital-human rendering was included.
- Verification: all 5 `npm test` cases passed; `npm audit --omit=dev` found no known vulnerabilities; real local HTTP requests passed exact-match, keyword-match, fixed-refusal, and hot-reload checks; the Docker image built successfully, and the container health check and in-container Q&A API passed.
- Status: the prototype was complete but had not been deployed to a production server, committed, or pushed to a remote repository.

## 2026-09-03 21:10 +0800

- Task: add a web interface to the deterministic Q&A MVP so content editors can configure it later.
- Output: added a responsive content workbench that can create, edit, copy, reorder, delete, and search FAQs, with immediate answer testing on the same page; added protected `GET/PUT /api/content` configuration endpoints.
- Data safety: continued using `content.json`, with atomic writes, revision conflict checks, and external-file-change checks; without an administration key, configuration is restricted to local same-origin access, while remote configuration supports `ADMIN_API_KEY`.
- Verification: all 12 Node tests passed; a real browser completed the create, edit, save, and immediate-Q&A flow; desktop and 390 px mobile viewports passed; the console reported zero errors and warnings; Docker persistence passed across an in-container save and named-volume recreation.
- Status: the web prototype was complete; browser test data was not written into the production `content.json`, and the application had not been deployed to a production server.

## 2026-09-03 22:35 +0800

- Task: implement a transparent-video-loop digital-human frontend and remove source display from the visitor experience.
- Output: added a responsive `/avatar` page that crossfades between two `<video>` elements for idle, thinking, speaking, and presenting poses; added WebM Alpha and HEVC Alpha demo media, a built-in animation fallback, browser speech integration, and a media rebuild script.
- Q&A: the workbench can configure an OpenAI-compatible model. The API key is stored only on the server with `0600` permissions and is never returned. The visitor page renders answer text only, even if the API returns a `source` field.
- Verification: all 21 `npm test` cases passed and `npm audit --omit=dev` reported zero vulnerabilities; Chromium verified the `thinking -> speaking -> idle` Q&A flow, the `presenting -> idle` host flow, playback of all four videos, non-disclosure of an intentionally supplied source field, desktop and 390 px mobile layouts, and zero console errors or warnings; WebM alpha-channel values were also verified.
- Limitation: the Docker daemon was not running during this iteration, so the image was not rebuilt. Production still requires real-person media, a real model API configuration, and production-grade TTS integration.

## 2026-09-03 22:38 +0800

- Task: replace deterministic Q&A with large-language-model generation and provide a web page for configuring the model API URL, API key, model name, and prompt.
- Output: changed `POST /answer` to call an OpenAI-compatible `/chat/completions` endpoint; repurposed `content.json` as model knowledge context; added model-configuration read, save, and connection-test endpoints; added “managed content only” and “allow general knowledge” answer scopes.
- Key safety: model settings are written atomically to an ignored `model-config.json` with `0600` permissions; the read endpoint returns only `hasApiKey`, never the key itself; saving a blank key preserves the existing key, and the user can clear it explicitly.
- Interface changes: added model status and a model-settings dialog to the workbench, synchronized model-generation status with the digital-human page, and removed source display from content editing, Q&A results, and sample content.
- Verification: all 21 Node tests passed and `npm audit --omit=dev` reported zero vulnerabilities; a real browser completed configuration saving, key non-disclosure, connection testing, and answer generation on desktop and 390 px mobile layouts with zero console errors or warnings; Docker verified model calls, `0600` permissions, and persistence across a named-volume restart.
- Status: the local prototype was running at `http://127.0.0.1:8080` with the model intentionally left unconfigured; test keys, containers, and volumes had been removed.

## 2026-09-03 23:30 +0800

- Task: publish the current digital-human project to GitHub as a public repository.
- Repository: `https://github.com/bd4rex/dafuture-digital-human`; the default branch is `main`, and the GitHub API confirmed its visibility as `PUBLIC`.
- Commit: the first public content commit is `f5c9629065ea9ebbb38b53a241bfcd013aea309c`; it contains the project plans, runnable prototype, demo media, Chinese and English documentation, and verification records.
- Pre-publication cleanup: ignored local render artifacts, dependencies, test output, environment files, private keys, and private model configuration; removed the user-specific absolute path from the document generator; no real API key was committed.
- Verification: all 21 automated tests passed, the production dependency audit reported zero vulnerabilities, all relative Markdown links resolved, and the committed content contained no detected user-specific absolute path, private-network address, or common real-secret pattern.

## 2026-09-04 06:38 +0800

- Task: fix the four independent-review findings covering model-configuration activation, Q&A readiness, visitor quick-question configuration, and API semantics.
- Model configuration: when a complete API URL, key, or model name changes, the service tests the candidate first and atomically persists and activates it only after success. A failed candidate leaves the active in-memory configuration, disk file, and availability state unchanged. Changes limited to answer parameters or the system prompt do not repeat the connection test.
- Health state: `GET /health` now exposes an explicit `ready` value, content revision, and model connection state. A new `GET /ready` returns HTTP 200 or 503 according to Q&A availability, and Docker now uses it for health checks. Successful and failed real model calls update connection state.
- Frontend/backend integration: visitor quick questions are no longer maintained in a separate static configuration. They are generated from the first phrasing of the first three current `content.json` entries and automatically refresh by content revision on an already-open visitor page.
- API contract: `POST /answer` now exposes structured `answerStatus` and `answerStatusSource` fields while retaining the compatibility `answered` boolean. `knowledgeContext.contextIds/matchedIds` distinguishes context actually sent from heuristic matches without presenting either as a model citation.
- Verification: the Node suite grew from 21 to 25 tests and all passed. An isolated browser run verified failed-candidate rollback, continued use of the previous configuration, no-reload quick-question synchronization, structured answers, the avatar's `thinking -> speaking -> idle` flow, and no horizontal overflow at 390 px; the visitor page had zero console errors and warnings.
- Verification limits: the local Docker daemon was not running, so the image was not rebuilt. `npm audit --omit=dev` was stopped after the registry produced no result for 60 seconds; this iteration makes no new dependency-audit claim.
- Status: changes remain only in the local worktree; no commit or GitHub push was created. Browser acceptance used a temporary content directory and local mock model, so neither production `content.json` nor a real API key was modified.

## 2026-09-04 15:20 +0800

- Task: select and integrate the teacher-supplied idle, thinking, speaking, and presenting avatar media while retaining alpha quality and controlling initial-load and state-switch traffic.
- Media processing: selected four 1080×1440, 30 fps QTRLE/ARGB alpha MOV masters totaling about 1.48 GB; the originals remain in place and unmodified. Delivery media is 720×960 at 30 fps with no audio, in both VP9 Alpha WebM and HEVC Alpha MOV formats. The thinking pose uses a 3.9-second forward-plus-reverse ping-pong loop to remove the source clip's visible end-to-start jump.
- Size result: the four WebM files total 5.37 MiB, with the initial idle pose about 1.15 MiB; the four Safari MOV files total 9.75 MiB. On a normal connection, thinking preloads only after idle is ready, speaking preloads after entering thinking, and presenting loads on demand. Data-saver and 2G connections load only the current pose.
- Frontend implementation: four persistent `<video>` layers retain each pose's loaded state and crossfade during changes, preventing a previously loaded pose from restarting its download. Production media URLs include a version parameter, and the built-in animation fallback remains available. Added `scripts/build-production-avatar.sh` to reproducibly generate and validate delivery media from four alpha masters.
- Verification: all videos have valid alpha and no audio. JavaScript syntax checks, the transcoding-script syntax check, and all 25 automated tests passed. Chromium verified all four poses, desktop and 390 px mobile layouts, no new media request when repeating already loaded states, idle-only loading under data saver, and the mocked API's `idle -> thinking -> speaking -> idle` flow. An intentionally returned `source` field and source label remained hidden, and the console reported zero errors and warnings.
- Status: the production avatar media and loading strategy have been merged into `main` and synchronized to GitHub. The local service is running at `http://127.0.0.1:8080/avatar`; the model still awaits configuration in the content workbench.

## 2026-09-04 16:39 +0800

- Task: replace the browser's unspecified default Chinese voice with a Mandarin male voice that matches the male avatar and improves local playback quality.
- Implementation: added a `speech` section to `avatar-config.json` with `gender: male`. macOS/Chrome prefers `Reed`, followed by `Eddy`, `Rocko`, and cross-platform male candidates including Yunxi, Yunjian, Yunyang, and Kangkang. Rate and pitch are both set to `0.98`; the preferred voice refreshes on `voiceschanged` when browser voices become available asynchronously.
- Verification: Chrome exposed 18 Chinese voices on this machine. A real “Host Introduction” click selected `Reed (Chinese (China mainland))`, `zh-CN`, rate `0.98`, and pitch `0.98`, then returned normally to idle. JavaScript syntax checks and all 25 automated tests passed, with zero browser console errors or warnings.
- Limitation: Web Speech voices depend on what each client device has installed. This Mac now consistently uses a male voice, but a server-side streaming TTS provider is still required when production must sound identical on every device.
- Status: the male-voice change currently exists only in the local worktree and has not been committed or pushed to GitHub. The local service has been restarted with the new configuration.

## 2026-09-04 16:50 +0800

- Task: add spoken questions alongside text input while preserving a clear replacement boundary for future external ASR and TTS models.
- Implementation: added a microphone button beside the composer. Browser-native `SpeechRecognition`/`webkitSpeechRecognition` recognizes a single `zh-CN` turn with interim results and automatically submits the final transcript through the existing form. The button and status copy reflect listening state, and a second click can end input early. Starting recognition stops current playback, while starting an answer stops recognition to prevent the avatar from transcribing its own voice.
- Fallback: unsupported browsers disable only the microphone; denied permission, missing audio capture, no speech, and recognition-network failures show specific recoverable messages. `speech.provider` and `speechInput.provider` currently use `browser`; future external drivers need only return final text or playable audio, leaving the Q&A and avatar state machine unchanged. Provider credentials remain server-side.
- Verification: all 25 automated tests passed and current Chrome exposes the native recognition API. Deterministic browser testing completed interim recognition, final transcript, automatic submission, and `thinking -> speaking -> idle`, with the expected question, answer, and `Reed` male voice. Separate runs verified listening/manual-stop state and denied-permission recovery. Desktop and 390 px mobile layouts had no overflow, and all four browser runs reported zero console errors and warnings.
- Status: the male voice and spoken-question improvements have been merged into `main` and synchronized to GitHub. The local service remains running; no external ASR/TTS vendor or credential has been bound yet.
