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
