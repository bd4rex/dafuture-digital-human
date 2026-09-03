[中文](README.md)

# “Da Future” LLM Digital Human Q&A MVP

This repository contains a locally runnable digital-human Q&A prototype. Content editors maintain business knowledge and model settings in a web workbench. Visitors ask questions through the digital-human page, the service uses an OpenAI-compatible large language model to generate answers, and the browser handles speech playback and avatar state transitions.

## Current Status

- Application version: `0.3.0`.
- The content workbench, model configuration, Q&A API, four-state transparent-video frontend, and browser speech playback are implemented.
- The model API key is stored only in a server-side configuration file ignored by Git. Neither the API nor the UI returns the plaintext key.
- No real model configuration is included. Users must enter their own settings in the workbench after the first launch.
- This is an MVP prototype. It has not been deployed to a production server, and real-person avatar media and production-grade TTS still need to be integrated.

## Quick Start

Node.js 20 or later is required.

```bash
cd answer-mvp
npm ci
npm start
```

By default, the service listens only on the local machine:

- `http://127.0.0.1:8080/`: content and model configuration workbench.
- `http://127.0.0.1:8080/avatar`: visitor-facing digital-human Q&A page.
- `http://127.0.0.1:8080/health`: service diagnostics and dependency state.
- `http://127.0.0.1:8080/ready`: Q&A readiness check.

See [`answer-mvp/README.en.md`](answer-mvp/README.en.md) for complete runtime, API, Docker, and security instructions.

## Core Capabilities

- Maintain question phrasings, keywords, and confirmed business knowledge in `content.json`.
- Configure an OpenAI-compatible API URL, API key, model name, prompt, and answer scope in the web workbench.
- Send a user question and managed content to the model through `POST /answer`.
- Present interactions with four video states: `idle`, `thinking`, `speaking`, and `presenting`.
- Support content hot reload, atomic saves, revision conflict detection, same-origin local restrictions, and an optional administration key.
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

The current suite contains 25 automated tests covering candidate rollback, Q&A readiness, response-contract semantics, quick-question synchronization, model-configuration security, content hot reload, access control, error sanitization, the avatar state machine, and video range requests.

## Security Boundary for the Public Repository

- Do not commit `answer-mvp/model-config.json`, `.env` files, private keys, certificate private keys, or real API keys.
- Before exposing administration endpoints remotely, set a strong random `ADMIN_API_KEY` and place the service behind a reverse proxy that provides HTTPS, rate limiting, and an appropriate logging policy.
- The included avatar videos are technical demo assets and do not represent the final real-person avatar.
- Public visibility only makes the repository contents viewable. No open-source license is currently included, so no permission to copy, modify, or distribute is granted automatically.
