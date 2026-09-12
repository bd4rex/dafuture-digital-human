[中文](TEST_REVIEW_20260912.md)

# Expanded tests and project review — 2026-09-12

Update (2026-09-13): all five findings below are fixed. Ordinary and strict runs now pass 174/174 with zero TODOs. See the [fix and verification report](FIX_REVIEW_20260913.en.md). The remainder preserves pre-fix evidence; line numbers refer to that snapshot.

## Pre-fix result (archive)

The suite grew from 123 to **165 tests: 160 pass and 5 reproduce unresolved findings**. Of 42 additions, 37 are passing regressions and 5 are known-finding assertions. This is not an all-clear result.

Reviewed the local `main` working tree at `ed4a970` plus the previous uncommitted fixes. This round changes tests, test tooling, and documentation only. No business implementation, commit, GitHub push, or deployment changed. The previous 123 tests still pass; the new tests expose previously uncovered boundaries.

## Original findings (now fixed)

All findings are P2 and have executable assertions.

1. **`REVIEW-AVATAR-001`: frontend requests have no finite deadline.** `public/avatar.js:975–987,1018–1032` awaits both headers and body with a manual-cancellation controller but no timeout. Executing the actual frontend source with an abort-aware mock fetch and timers advanced by 180 seconds reproduces indefinite waiting in both phases, without fallback speech. This exceeds the 120-second model limit plus a 5-second rewrite and transport margin. The send button remains disabled. Add a request/body deadline, distinguish timeout from intentional cancellation, restore interaction, and use the cached natural fallback. The frontend-to-app hop is separate from the app-to-model timeout.

2. **`REVIEW-MODEL-001`: valid business prose becomes a refusal.** `server.js:915–921` searches the entire answer for phrases such as “资料不足” (insufficient materials). The ordinary answer “资料不足时，请联系工作人员补充材料，补齐后即可报名。” explains how to complete registration. Through the application route and an isolated knowledge store, it succeeds in a structured `status: answered` envelope but becomes `no_answer` with the configured fallback when supplied as supported plain text. Narrow refusal inference without discarding valid business statements; keep structured status authoritative.

3. **`REVIEW-MODEL-002`: typed reasoning segments can enter speech.** `server.js:815–824` concatenates every content-array object's `text`, ignoring its type. A simulated compatible-provider response containing `{type: "reasoning", text: "…"}` followed by `{type: "text", text: "门票免费。"}` exposes the reasoning text in `speechText`. Restrict extraction to supported answer-segment types. The separate `message.reasoning_content` field is correctly excluded by passing coverage. This is a conditional compatibility finding from a mock response, not evidence that a real configured provider returns this shape.

4. **`REVIEW-MODEL-003`: tool-call progress is presented as a final answer.** `server.js:979–990` rejects truncation/filtering but accepts a response with `finish_reason: "tool_calls"`, tool calls, and content saying it first needs to search. It returns `answered: true` even though this application has no tool-execution loop. Reject unsupported non-final completions with a natural fallback and diagnostic classification; implementing tools is not required. Reproduced with a mock provider only. Tool calls without content already correctly produce an empty-response error.

5. **`REVIEW-HTTP-001`: a body-stream disconnect is classified as malformed model output.** `server.js:968–976` maps non-timeout body-read errors to `MODEL_INVALID_RESPONSE`. Two real loopback HTTP services and native fetch reproduce HTTP 200 followed by a partial JSON body and a disconnected socket; the response/log record `MODEL_INVALID_RESPONSE` and stage `response`. Disconnecting before headers correctly yields `MODEL_CONNECTION_FAILED`. Visitors still receive a natural fallback, but operations cannot distinguish this network fault from a complete yet invalid JSON document. Classify body transport failures separately without exposing upstream bodies or disturbing HTTP/timeout diagnostics.

## Tests and gate

| Added area | Added | Pass | Unresolved |
| --- | ---: | ---: | ---: |
| Real model HTTP transport | 12 | 11 | 1 |
| Model parsing, configuration, logs | 10 | 7 | 3 |
| Visitor runtime, event queue, and clock positive control | 10 | 9 | 1 |
| Workbench runtime | 5 | 5 | 0 |
| Real knowledge lifecycle and PDF upload | 5 | 5 | 0 |
| Total | 42 | 37 | 5 |

- `npm test`: 165 tests, 160 pass, 0 ordinary failures, 5 TODOs; exit 0. TODO assertions actually execute and fail. They are neither skips nor passes.
- `npm run test:review`: same assertions with TODO designations removed; 160 pass, 5 fail, 0 TODOs; exit 1. Use this strict command for acceptance.
- `npm audit --omit=dev`: zero known dependency vulnerabilities; this is not a full security audit.
- `git diff --check`: passes.
- Environment: macOS, Node.js v24.14.1. Final regression run: about 3.43 seconds; strict gate: about 3.39 seconds. Raw regression results are retained locally in the ignored `output/review-20260912/expanded-tests.tap`.
- Independent review of the tests prompted a unified fake clock and positive control covering direct deadlines, `Date.now()` polling, `AbortSignal.timeout`, and asynchronously recursive timers, reducing false failures for future correct implementations.

Run only the findings on macOS/Linux:

```bash
REVIEW_STRICT=1 node --test --test-name-pattern='REVIEW-' test/avatar-runtime.test.js test/model-reliability.test.js test/model-transport.test.js
```

Keep each regression after fixing it. Pass the strict gate before removing the TODO condition. See [TESTING.md](TESTING.md) for module coverage and other test workflows.

## Passing coverage and limits

Real multipart uploads, Chinese filename/original round trips, admin access, restart persistence, deduplication, atomic failed replacements, successful replacement cleanup, and deletion while a large-library rewrite waits pass. No new knowledge-lifecycle defect was confirmed.

SSE callbacks, the bound stop button, editing during saves, workbench body timeouts, 401/409 handling, poll recovery, speech-start timeouts/stale callbacks, event retry/deduplication, configuration write failures/key rotation, UTF-8 size limits, full dialogue logs, and credential redaction pass.

This round did not repeat real-browser layout, physical-device WeChat/audio, Docker deployment, capacity/soak, or real external-model acceptance. Frontend tests execute actual source in isolated VMs with simulated speech; HTTP tests use loopback mock providers. No billable calls or changes to actual knowledge, model keys, passwords, scripts, or logs occurred. New fixtures use temporary directories and close/clean only their own resources.
