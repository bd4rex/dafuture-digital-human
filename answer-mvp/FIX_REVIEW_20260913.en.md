[中文](FIX_REVIEW_20260913.md)

# Five review findings: fixes and verification — 2026-09-13

## Result

All five previous findings are fixed. Their `REVIEW-*` regression IDs remain, with all TODO designations removed. Both ordinary and strict review runs report **174/174 passing, zero failures and zero TODOs**. Nine tests were added to the previous 165, with additional positive/negative cases inside existing tests.

The demo configuration remains simple: no new configuration page, origin restriction, or tool-execution workflow. Actual knowledge, keys, passwords, and hosting scripts remain unchanged. Changes were uncommitted and unpushed when verification finished; consult the project timestamp log and GitHub main/PR for subsequent publication. This report does not imply deployment.

## Fixes

| Finding | Implementation | Evidence |
| --- | --- | --- |
| `REVIEW-AVATAR-001` hanging frontend request | One 140-second final deadline covers headers and body; distinguish cancellation/timeout, clean timers/listeners, and do not start reading a cancelled late response | Header/body stalls, deadline boundary, valid 125-second response, hosting takeover, replacement questions, late results, and recovery pass |
| `REVIEW-MODEL-001` business prose mistaken for refusal | Infer refusal only from explicit opening statements, not arbitrary mentions of insufficient materials; match short custom fallback text exactly; preserve structured status priority | Application-material instructions, conditionals, quotations, partly unknown answers with useful facts, genuine refusals, and logs pass |
| `REVIEW-MODEL-002` reasoning segments spoken | Extract only explicit `type: text` segments and previously supported string entries; ignore reasoning/unknown types | Mixed and missing final text, ordinary concatenation, separate reasoning fields, and log exclusion pass |
| `REVIEW-MODEL-003` tool progress mistaken for a final answer | Text requires missing/null/stop completion and no actual tool calls; unsupported continuations receive a natural `MODEL_RESPONSE_REJECTED` fallback; empty messages retain their empty-response classification | Tool/function calls, unknown continuation states, misleading stop metadata, empty tool metadata compatibility, and finish-reason logs pass |
| `REVIEW-HTTP-001` body disconnect misclassified | Inspect underlying transport codes; body disconnects become `MODEL_CONNECTION_FAILED`, deadlines remain timeouts, and complete bad JSON/invalid compression remain response errors | Native fetch with real loopback HTTP verifies disconnects, header/body timeouts, bad JSON/gzip, 401/429/503, and recovery |

The 140-second frontend deadline is a final bound for silent network hangs, not a mandatory delay after ordinary network errors. It covers the maximum 120-second model request, up to 5 seconds of rewriting, and 15 seconds of transport margin. A fixed bound prevents stale frontend settings from prematurely cancelling a newly increased server timeout. Timeout events use `CLIENT_REQUEST_TIMEOUT`, retain the turn ID, complete question/fallback answer, and elapsed time, and remain admin-only.

Implementation is in `public/avatar.js` (`requestAnswer`) and `server.js` (`extractMessageContent`, `isExplicitPlainTextRefusal`, `callLanguageModel`).

## Verification

- `npm test`: 174 pass, no failures/skips/TODOs, about 3.55 seconds.
- `npm run test:review`: 174 pass, no failures/skips/TODOs, about 3.59 seconds, exit 0.
- `npm audit --omit=dev`: zero known dependency vulnerabilities, not a comprehensive security audit.
- JavaScript syntax checks and `git diff --check`: pass.
- Independent cross-review of transport/completion handling and frontend timeout/cancellation found no blocking issues in scope. It prompted an additional guard/assertion preventing cancelled late headers from starting a body read.
- Raw regression results remain locally in the ignored `output/review-20260912/five-fixes-20260913.tap`.

## Browser acceptance and limits

Playwright exercised an isolated local service with simulated provider responses and browser speech events. The registration-material explanation remained intact; reasoning segments were absent from speech; tool progress produced only the natural fallback. Both header and body hangs restored the send button, ignored released late results, and allowed the next question to complete. The isolated log retained timeout identifiers and full dialogue text.

For browser acceptance only, the 140-second timer was accelerated to 700 milliseconds. Actual 140-second/125-second boundaries are covered by source-executing tests with a unified fake clock. No test hook was added to production code. The local service was restarted with final code and these browser flows were repeated.

No real paid provider, physical speaker, WeChat device, new capacity soak, or Docker deployment was tested. These results verify the covered contracts and fault handling, not every provider's answer quality or every device's audio behavior.

[Pre-fix review archive](TEST_REVIEW_20260912.en.md) / [Testing guide](TESTING.md)
