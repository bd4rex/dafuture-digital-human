[中文](README.md)

# “Da Future” LLM Digital Human Q&A MVP

This repository contains a locally runnable digital-human Q&A prototype. Content editors maintain business knowledge and model settings in a web workbench. Visitors ask questions through the digital-human page, the service uses an OpenAI-compatible large language model to generate answers, and the browser handles speech playback and avatar state transitions.

## Current Status

- Application version: `0.8.0`.
- The Future Teacher public-benefit project library is bundled: 27 source documents become 7 topic files and 89 Q&A cards, automatically linked at first startup, including with an empty data volume.
- The password-protected workbench now controls two live modes: Dialogue uses the configured LLM and persistent knowledge, while Hosting broadcasts a selected prepared script verbatim from the administration page.
- Dialogue now opens file-based Knowledge Management directly. Manual question-entry and administration-side Q&A trial panels are no longer shown; the existing `content.json` remains read-compatible.
- Model settings now separate answer style, insufficient-knowledge copy, and service-error copy. The model composes normal answers, while the server returns predictable, speech-ready fallback text.
- Hosting scripts persist on the server. Mode, present, and stop commands synchronize to every open avatar frontend through SSE; a new command interrupts the previous script, while a service restart does not replay it.
- Authenticated logs retain full questions and answers, conversation IDs, upstream status, retrieval details, and browser-reported playback results. Credentials remain redacted.
- Small libraries are sent in full within a 24,000-character budget; larger libraries use synonym-expanded retrieval and a no-match fallback. Legacy content is inactive until explicitly imported through Knowledge Management.
- Hosting uses instance IDs and sequence ordering. Disconnects pause old playback; reconnection never replays it. Failed, muted, cancelled, and completed audio have distinct outcomes.
- The model API key is stored only in a server-side configuration file ignored by Git. Neither the API nor the UI returns the plaintext key.
- No real model configuration is included. Users must enter their own settings in the workbench after the first launch.
- This is an MVP prototype and has not been deployed to a production server. Production male-avatar media is integrated, and browser playback now prefers Mandarin male voices; cross-device production-grade TTS still needs to be integrated.

## Quick Start

Node.js 20.16–20.x, or Node.js 22.3 and later, is required.

```bash
cd answer-mvp
npm ci
npm start
```

By default, the service listens only on the local machine:

- `http://127.0.0.1:8080/`: dual-mode control, file-based knowledge management, and model settings.
- `http://127.0.0.1:8080/avatar`: visitor-facing digital-human Q&A page.
- `http://127.0.0.1:8080/health`: service diagnostics and dependency state.
- `http://127.0.0.1:8080/ready`: Q&A readiness check.

See [`answer-mvp/README.en.md`](answer-mvp/README.en.md) for complete runtime, API, Docker, and security instructions.

## Bundled Project Knowledge

The default is **one Future Teacher project library with seven topics**: project and policy, training, laboratory and expert guidance, Nanjing, Haidian, Changsha, and historical milestones and statistical definitions. The 27 inputs comprise 10 PDFs and 17 DOCX files. Knowledge was prepared on September 6, 2026; training arrangements follow the formal August 24 notice. Conflicting figures, plans versus actual progress, and drafts versus formal notices remain explicitly distinguished.

Start containers from the repository root:

```bash
docker compose up -d --build
```

The image keeps the source bundle at `/app/bundled-knowledge` and automatically imports it into persistent storage under `/data` on first startup. The workbench immediately lists seven topic files; no upload is required. Existing documents are retained and identical content is deduplicated. A receipt persists with the index, so deleting or replacing documents in the workbench remains effective after a restart. Existing model settings and the administration password are retained in the data volume; first-time users still need to configure their own model API.

See [knowledge scope, provenance, and maintenance](answer-mvp/bundled-knowledge/README.en.md). These seven files alone fit in the existing 24,000-character full-context budget. Re-evaluate retrieval after adding substantial material. The 58 regression questions check evidence reaching the context, not real-model answer accuracy.

## Core Capabilities

- Open Knowledge Management directly from Dialogue mode and import TXT, Markdown, CSV, JSON, DOCX, and PDF files while preserving originals and a persistent chunk index.
- Configure an OpenAI-compatible API URL, API key, model name, answer scope, natural-response guidance, and two fallback messages in the web workbench.
- Send a user question and managed content to the model through `POST /answer`.
- Maintain multiple hosting scripts and broadcast one exact script to every connected frontend from the Hosting tab.
- Diagnose sign-in, knowledge-file, model, hosting-control, and Q&A actions through the operations-log viewer.
- Present interactions with four video states: `idle`, `thinking`, `speaking`, and `presenting`.
- Allow first-time setup, sign-in, and all authenticated administration APIs from any page origin while retaining server-verified passwords, HttpOnly sessions, and optional Bearer access for automation.
- Activate candidate model connections only after validation succeeds while retaining read compatibility for existing `content.json` data and APIs.
- Sanitize upstream model errors and replace technical details with speech-ready service fallback copy, without exposing API keys or upstream details.

## Repository Layout

```text
answer-mvp/                       Runnable Node.js/Fastify prototype
answer-mvp/bundled-knowledge/     Default project knowledge and source catalog
compose.yaml                     Container startup and persistent data volume
assets/                           Architecture diagrams used by the plans
build_content_platform_proposal.py  DOCX generator for the technical proposal
大未来数字人问答_MVP最简方案_V1.2.md  Current minimal MVP plan
大未来数字人内容中台技术方案_V1.0.md  Content-platform technical proposal
TIMESTAMP_LOG.md                  Project change and verification log
```

## Documentation

- [Runtime and deployment (中文)](answer-mvp/README.md) / [English](answer-mvp/README.en.md)
- [Bundled knowledge (中文)](answer-mvp/bundled-knowledge/README.md) / [English](answer-mvp/bundled-knowledge/README.en.md)
- [Avatar video media (中文)](answer-mvp/public/avatar-media/README.md) / [English](answer-mvp/public/avatar-media/README.en.md)
- [Project timestamp log (中文)](TIMESTAMP_LOG.md) / [English](TIMESTAMP_LOG.en.md)
- [Minimal Q&A MVP Plan V1.2 (Chinese)](大未来数字人问答_MVP最简方案_V1.2.md)
- [Lightweight Content Q&A MVP Plan V1.1 (Chinese)](大未来数字人内容问答_MVP极简方案_V1.1.md)
- [Content Platform MVP Implementation Plan V1.0 (Chinese)](大未来数字人内容中台_MVP实施方案_V1.0.md)
- [Content Platform Technical Proposal V1.0 (Chinese)](大未来数字人内容中台技术方案_V1.0.md)

## Verification

```bash
cd answer-mvp
npm test
npm audit --omit=dev
```

Tests cover administration sessions, full dialogue and execution logs, upstream failure classification, synonym retrieval, legacy migration, hosting reconnect/stale-state regressions, speech outcomes, natural fallbacks, file persistence, model settings, and video range requests. Run `npm test` for the current count and results.

## Security Boundary for the Public Repository

- Do not commit `answer-mvp/model-config.json`, `admin-auth.json`, `host-scripts.json`, `operations.jsonl*`, `knowledge.json`, `knowledge-files/`, `.env` files, private keys, or real API keys.
- Create the administration password on the first visit. If the service is later exposed publicly, place it behind a reverse proxy that provides HTTPS, rate limiting, and an appropriate logging policy.
- The included avatar videos are technical demo assets and do not represent the final real-person avatar.
- Public visibility only makes the repository contents viewable. No open-source license is currently included, so no permission to copy, modify, or distribute is granted automatically.
