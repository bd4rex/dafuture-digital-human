[中文](README.md)

# “Da Future” LLM Digital Human Q&A MVP

This repository contains a locally runnable digital-human Q&A prototype. Content editors maintain business knowledge and model settings in a web workbench. Visitors ask questions through the digital-human page, the service uses an OpenAI-compatible large language model to generate answers, and the browser handles speech playback and avatar state transitions.

## Current Status

- Application version: `0.5.0`.
- The password-protected workbench now controls two live modes: Dialogue uses the configured LLM and persistent knowledge, while Hosting broadcasts a selected prepared script verbatim from the administration page.
- Hosting scripts persist on the server. Mode, present, and stop commands synchronize to every open avatar frontend through SSE; a new command interrupts the previous script, while a service restart does not replay it.
- Persistent operations logs record key action outcomes, response codes, execution times, and safe diagnostic metadata, with authenticated filtering and download in the workbench.
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

- `http://127.0.0.1:8080/`: dual-mode control, content, knowledge, and model workbench.
- `http://127.0.0.1:8080/avatar`: visitor-facing digital-human Q&A page.
- `http://127.0.0.1:8080/health`: service diagnostics and dependency state.
- `http://127.0.0.1:8080/ready`: Q&A readiness check.

See [`answer-mvp/README.en.md`](answer-mvp/README.en.md) for complete runtime, API, Docker, and security instructions.

## Core Capabilities

- Maintain question phrasings, keywords, and confirmed business knowledge in `content.json`.
- Import TXT, Markdown, CSV, JSON, DOCX, and PDF files through the web UI, preserving originals and a persistent chunk index.
- Configure an OpenAI-compatible API URL, API key, model name, prompt, and answer scope in the web workbench.
- Send a user question and managed content to the model through `POST /answer`.
- Maintain multiple hosting scripts and broadcast one exact script to every connected frontend from the Hosting tab.
- Diagnose sign-in, content, knowledge, model, hosting-control, and Q&A actions through the operations-log viewer.
- Present interactions with four video states: `idle`, `thinking`, `speaking`, and `presenting`.
- Protect administration with server-verified passwords, HttpOnly sessions, and same-origin checks, while retaining optional Bearer access for automation.
- Activate candidate model connections only after validation succeeds, and keep visitor quick questions synchronized with the workbench content revision.
- Sanitize upstream model errors so API keys and upstream details are not exposed to the frontend.

## Repository Layout

```text
answer-mvp/                       Runnable Node.js/Fastify prototype
assets/                           Architecture diagrams used by the plans
build_content_platform_proposal.py  DOCX generator for the technical proposal
大未来数字人问答_MVP最简方案_V1.2.md  Current minimal MVP plan
大未来数字人内容中台技术方案_V1.0.md  Content-platform technical proposal
TIMESTAMP_LOG.md                  Project change and verification log
```

## Documentation

- [Runtime and deployment (中文)](answer-mvp/README.md) / [English](answer-mvp/README.en.md)
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

The committed suite contains 37 automated tests covering administration passwords and sessions, operations-log persistence/redaction/rotation, persistent hosting scripts, live mode switching, exact SSE commands, hosting/Q&A exclusion, imported-file persistence and restart recovery, DOCX/PDF extraction, candidate rollback, response semantics, model-configuration security, content hot reload, error sanitization, the avatar state machine, and video range requests.

## Security Boundary for the Public Repository

- Do not commit `answer-mvp/model-config.json`, `admin-auth.json`, `host-scripts.json`, `operations.jsonl*`, `knowledge.json`, `knowledge-files/`, `.env` files, private keys, or real API keys.
- Create the administration password on the first visit. If the service is later exposed publicly, place it behind a reverse proxy that provides HTTPS, rate limiting, and an appropriate logging policy.
- The included avatar videos are technical demo assets and do not represent the final real-person avatar.
- Public visibility only makes the repository contents viewable. No open-source license is currently included, so no permission to copy, modify, or distribute is granted automatically.
