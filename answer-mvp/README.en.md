[中文](README.md)

# “Da Future” LLM Digital Human Q&A MVP

This is a runnable local prototype. A visitor asks a question through the digital-human frontend, the service retrieves relevant manual Q&A entries and imported knowledge files for a configured large language model, and the generated text is displayed and spoken by the browser.

The current implementation supports OpenAI-compatible `/chat/completions` endpoints. The API URL, API key, model name, answer scope, and system prompt can all be configured in the web workbench.

## Local Setup

Node.js 20.16–20.x, or Node.js 22.3 and later, is required.

```bash
npm install
npm start
```

By default, the service listens only on `http://127.0.0.1:8080`:

- `http://127.0.0.1:8080/`: content and model configuration workbench.
- `http://127.0.0.1:8080/avatar`: visitor-facing digital-human Q&A page.
- `http://127.0.0.1:8080/health`: diagnostics, content revision, and model connection state; always returns HTTP 200.
- `http://127.0.0.1:8080/ready`: Q&A readiness; returns HTTP 503 when unavailable.

The first local visit to the administration page asks you to create an administration password of at least eight characters.

## Administrator Sign-In

- Before sign-in, `/` serves only the password page. Manual content, knowledge-library, and model-configuration APIs are all enforced by the server, not merely hidden in the browser.
- First-time password setup is allowed only from the server's loopback address. Set `ADMIN_PASSWORD` before starting a remote or Docker deployment.
- A locally created password is stored only as a salted scrypt hash in `admin-auth.json`, written atomically with `0600` permissions.
- Successful sign-in creates an HttpOnly, SameSite=Strict cookie. The session expires after eight hours by default and is invalidated by logout or service restart.
- `ADMIN_API_KEY` remains available as an optional Bearer credential for automation. When `ADMIN_PASSWORD` is absent, it also acts as the web sign-in password.

The model is initially unconfigured. Open the workbench, select “Model Settings,” and provide at least:

1. The API URL, such as the provider's `https://service-address/v1` endpoint.
2. An API key.
3. The model name, using the model ID supplied by the provider.

“Save and Test Connection” first sends a very small real request with the candidate configuration, then persists and activates it only after validation succeeds. The same protection applies when “Save Settings” changes the API URL, key, or model name; changing only answer scope, generation parameters, or the system prompt does not repeat the test. Model requests may incur a small charge.

## Model Configuration Security

Model settings are written to a separate `model-config.json` file rather than `content.json`:

- The API key is read only by the server. `GET /api/model-config` never returns the plaintext key.
- When the page is reopened, it only reports that a key is stored; the key field remains blank.
- Saving with a blank key keeps the existing key. The key is removed only when “Clear the API key stored on the server” is explicitly selected.
- A complete connection configuration is validated independently before activation whenever its connection fields change. A failed candidate leaves the active in-memory configuration, disk file, and availability state unchanged.
- The file is written atomically with `0600` permissions and is included in `.gitignore`.
- The repository contains only `model-config.example.json`, which has no real key.

For a local run, the default path is `answer-mvp/model-config.json`. Docker uses `/data/model-config.json`.

## Answer Scope

The model settings provide two modes:

- `Use managed content only`: the model may answer only from manual Q&A and imported knowledge files. When the available material is insufficient, it returns “No relevant information is currently available in the managed content.”
- `Allow general knowledge`: the model prioritizes managed content and may supplement it with general knowledge, but must not invent project-specific dates, locations, fees, people, or rules.

In both modes, manual Q&A and imported knowledge files are model context rather than final answers returned directly by the API.

## Web Workbench

The content area supports:

- Creating, editing, copying, sorting, deleting, and searching knowledge entries.
- Adding multiple user phrasings, keywords, and confirmed content to each entry.
- Saving the complete `content.json` file so later model answers use the new content immediately.
- Validating required fields, duplicate content IDs, and duplicate question phrasings.
- Using a revision and disk hash to prevent concurrent changes from being silently overwritten.
- Calling the active model from the right-hand panel to test Q&A directly.

The model area supports:

- Configuring an OpenAI-compatible API URL, API key, and model name.
- Selecting the answer scope and setting temperature, maximum output tokens, and timeout.
- Editing the system prompt.
- Testing the model connection explicitly.

### Imported Knowledge Library

Select “Knowledge Library” in the header to:

- Import UTF-8 TXT, Markdown, CSV, and JSON files, plus DOCX and text-based PDFs. Scanned PDFs require OCR first.
- Review selected filenames and sizes before submission. Each request accepts up to 10 files, 10 MB per file, and 30 MB in total.
- Append while skipping identical SHA-256 content, or replace the complete imported-file collection without changing manual Q&A entries.
- Preview extracted text, download the preserved original, or delete one document and all its chunks.
- Persist extracted chunks in `knowledge.json` and originals in `knowledge-files/`; both live under Docker's `/data` volume.

At answer time, the service selects up to 12 relevant imported chunks within the overall context budget. Filenames remain administration-only and are not presented as source attribution in the visitor interface.

## Digital-Human Frontend

The frontend uses four pre-generated transparent videos for four states:

```text
Page opened -> idle
Question submitted -> thinking
Model answer ready -> speaking
Speech finished -> idle
“Host Introduction” selected -> presenting -> speech finished -> idle
```

Speech currently uses the browser's local speech synthesis and prefers Mandarin male voices. macOS/Chrome selects `Reed` first, followed by `Eddy`, `Rocko`, and common Windows male voices such as Yunxi, Yunjian, Yunyang, and Kangkang. Rate and pitch are configured in the `speech` section of `public/avatar-config.json`. If none of these voices is installed, the browser falls back to an available local Chinese voice; use server-side TTS in production when every device must use the same voice. If video is unavailable or the user has enabled reduced motion, the page falls back to lightweight animation while Q&A remains available.

In addition to typing, visitors can click the microphone beside the composer and speak a question. The current implementation uses browser `SpeechRecognition`/`webkitSpeechRecognition` for a single Mandarin turn, displays interim text, and automatically submits the final transcript. The visitor must initiate recording and grant microphone access on first use. Unsupported browsers or denied permission receive a clear message while retaining the complete text-input path. Production should use HTTPS to avoid repeated microphone permission prompts.

### External Speech Provider Boundary

Both `speech.provider` and `speechInput.provider` in `public/avatar-config.json` currently use `browser`. Playback and recognition are separated behind provider entry points so a future external model can retain these boundaries:

- An ASR provider converts one recording into the final question text, then reuses the existing form submission and Q&A flow.
- A TTS provider converts `speechText` into playable audio and drives the existing avatar state machine through start, end, and cancellation events.
- Third-party API keys remain server-side; the browser calls only same-origin proxy endpoints and never holds provider credentials.
- Browser recognition may use a vendor-operated remote service and must not be assumed to run locally. Choose and configure production ASR according to privacy requirements before handling sensitive student or visitor information.
- The browser provider can remain as a fallback, while identical voice-and-text output can be cached by hash to reduce latency and provider cost.

Preview all four states manually:

```text
http://127.0.0.1:8080/avatar?preview=1
```

See `public/avatar-media/README.en.md` for video replacement instructions. Configure the digital-human name, welcome text, host script, and media paths in `public/avatar-config.json`. Visitor quick questions come from the first phrasing of the first three `content.json` entries; the visitor page refreshes them by content revision after workbench edits or reordering.

## API Contract

### `POST /answer`

Request:

```json
{
  "question": "How should the frontend call the Q&A API?"
}
```

When the model is configured and the request succeeds:

```json
{
  "answered": true,
  "answerStatus": "answered",
  "answerStatusSource": "structured",
  "answer": "An answer generated from the managed content.",
  "speechText": "An answer generated from the managed content.",
  "model": "configured-model-id",
  "knowledgeContext": {
    "contextIds": ["frontend-integration", "project-introduction"],
    "matchedIds": ["frontend-integration"]
  }
}
```

`answerStatus` is the primary answered/refusal state, while `answered` remains as a compatibility boolean for older clients. The service prefers the model's structured status; compatible providers that cannot return structured output are marked with `answerStatusSource: "inferred"` and use robust refusal detection. `knowledgeContext.contextIds` lists the entries actually sent to the model, while `matchedIds` lists entries selected by the server's relevance heuristic. Neither field claims that the model cited or actually relied on a particular entry in its answer.

When the model is not configured, the endpoint returns HTTP `503`:

```json
{
  "error": "MODEL_NOT_CONFIGURED",
  "answered": false,
  "answer": "The large language model has not been configured. Complete the API settings in the workbench first.",
  "speechText": "The large language model has not been configured. Complete the API settings in the workbench first.",
  "message": "The large language model has not been configured. Complete the API settings in the workbench first."
}
```

Questions are limited to 500 characters. Use `CORS_ORIGIN` to restrict the permitted frontend origin in an integration environment.

### Model Configuration Endpoints

- `GET /api/model-config`: returns non-sensitive settings, `hasApiKey`, and the latest connection state.
- `PUT /api/model-config`: saves settings; a blank key preserves the existing key. Changed complete connection fields are validated before activation; clients may also send `testConnection: true` explicitly.
- `POST /api/model-config/test`: sends a connection test using the saved settings.

The model endpoints, `GET/PUT /api/content`, and the knowledge endpoints use the same administrator-session protection.

### Knowledge Library Endpoints

- `GET /api/knowledge`: list imported document metadata, extraction previews, and the active revision.
- `POST /api/knowledge/import`: upload `files` as `multipart/form-data`; `mode` is `append` or `replace`.
- `GET /api/knowledge/:id/download`: download the preserved original.
- `DELETE /api/knowledge/:id`: delete the original and all extracted chunks.

### Health and Readiness Endpoints

- `GET /health` always returns HTTP 200 and reports `ready`, the active content revision, and model state as `unconfigured`, `unverified`, `available`, or `unavailable`.
- `GET /ready` returns the same payload. It returns HTTP 200 only when content can be served and the model is fully configured without a known connection failure; otherwise it returns HTTP 503. Docker uses this endpoint for its health check.
- If a damaged content file leaves a previous valid version available, the service remains `ready: true` with overall state `degraded`. A known model-call failure changes it to `ready: false` and `not_ready`.

## Administration Access Protection

To use the workbench from another computer on a campus network or from a server, set both a listening address and a strong administration password:

```bash
HOST=0.0.0.0 ADMIN_PASSWORD='replace-with-a-strong-administration-password' npm start
```

Open the page and sign in with that password. It is separate from the model provider's API key. Configure `ADMIN_API_KEY` separately only when an automated client needs Bearer access.

Before exposing the service publicly, an existing gateway should also provide HTTPS, rate limiting, and an appropriate access-log policy.

## Editing `content.json`

The web workbench is recommended, but the file can also be edited directly. By default, the service checks it every two seconds:

- When a new file passes validation, the complete content set is activated atomically.
- When the new file is invalid, the previous valid content remains active and health status changes to `degraded`.
- Health status returns to `ready` after the file is corrected.

Each entry requires a unique `id`, non-empty `questions`, non-empty `keywords`, and an `answer`. Here, `answer` is confirmed material supplied to the model as context.

## Automated Tests

```bash
npm test
```

The current 32 tests cover first-time password setup, sign-in/logout, salted hashes and same-origin enforcement, knowledge import/deduplication/replacement/deletion, restart recovery, DOCX/PDF extraction and retrieval, failed candidate-model rollback, key non-disclosure, upstream-error sanitization, content hot reload, the digital-human state machine, and video range requests.

## Docker

```bash
docker build -t dafuture-answer-mvp .
docker volume create dafuture-answer-data
docker run --rm -p 8080:8080 \
  -e ADMIN_PASSWORD='replace-with-a-strong-administration-password' \
  -v dafuture-answer-data:/data \
  dafuture-answer-mvp
```

The named volume persists manual content, model configuration, the administration-password hash, the knowledge index, and imported originals. Never export a volume containing a real key to a public location.

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Local listening address; the Docker image uses `0.0.0.0` |
| `PORT` | `8080` | Listening port |
| `CONTENT_FILE` | `content.json` in the current directory | Content file; Docker uses `/data/content.json` |
| `MODEL_CONFIG_FILE` | `model-config.json` beside the content file | Private model configuration; Docker uses `/data/model-config.json` |
| `KNOWLEDGE_FILE` | `knowledge.json` beside the content file | Extracted text and chunk index |
| `KNOWLEDGE_FILES_DIR` | `knowledge-files` beside the index | Preserved imported originals |
| `ADMIN_AUTH_FILE` | `admin-auth.json` beside the content file | Salted hash created by first-time local setup |
| `ADMIN_PASSWORD` | Not set | Preset web-administration password; recommended for remote deployments |
| `ADMIN_SESSION_TTL_MS` | `28800000` | Session lifetime, from 15 minutes through seven days |
| `ADMIN_COOKIE_SECURE` | Automatic | Set `true` behind an HTTPS gateway when the service cannot detect the original protocol |
| `CONTENT_POLL_INTERVAL_MS` | `2000` | Content polling interval, from 20 to 60,000 milliseconds |
| `CORS_ORIGIN` | `*` | Allowed origin for the Q&A API |
| `LOG_LEVEL` | `info` | Fastify log level |
| `ADMIN_API_KEY` | Not set | Optional Bearer API key; also the web password when `ADMIN_PASSWORD` is absent |
