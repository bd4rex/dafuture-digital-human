[简体中文](FIX_REVIEW_20260913_R2.md)

# Concurrency and cancellation fixes — 2026-09-13, round two

This round tracks the five findings reproduced on main `35f013c`, separately from the [previous format/transport fixes](FIX_REVIEW_20260913.en.md). This report is not a publication or deployment claim.

## Required contracts

| Finding | Required behavior | Regression location |
| --- | --- | --- |
| Old dialogue can be spoken after hosting takes over during control disconnection | Pause old interactions on control loss; only an accepted sync enables new interaction, never replay an old turn; recheck control generation after final model waits | `test/avatar-runtime.test.js`, `test/answer-lifecycle.test.js` |
| Editing while model settings are being saved/tested loses new input | Confirm only the submitted values, preserve subsequent edits, and explicitly label them unsaved | `test/workbench-runtime.test.js` |
| Stale knowledge reads overwrite completed imports/deletions | Ignore superseded reads and failures; verify adjacent read/write orderings | `test/workbench-runtime.test.js` |
| A cancelled visitor request can still start another model call | Propagate disconnect cancellation to upstream requests and check it across waits/stages; log cancellation separately from model failure | `test/answer-lifecycle.test.js` |
| Concurrent deliveries of one event produce duplicate log entries | Share one in-flight write per eventId, acknowledge only after persistence, permit retry after failure, and keep distinct events independent | `test/client-events.test.js` |

## User-visible changes

- Once control disconnection is confirmed, the visitor pauses questions/playback and retains its draft. Opening a transport or receiving health data is insufficient: a valid control sync is required before new questions resume.
- Initial connection, polling compatibility without EventSource, and natural fallback for explicit request failures remain separate supported paths. This is not a new login or origin restriction.
- An in-flight turn superseded by a control generation returns HTTP 409, `answerStatus: "cancelled"`, `answered: false`, empty `answer/speechText`, and `cancellationReason: "LIVE_CONTROL_CHANGED"`. The error is `HOSTING_MODE_ACTIVE` when currently hosting, otherwise `ANSWER_CANCELLED`. External frontends should discard the turn, not synthesize an empty-answer fallback. New requests initially received in hosting retain the existing rejection contract.
- Cancellation stops this service from waiting/starting subsequent calls and attempts to abort the upstream connection. It cannot guarantee the provider stops generation already in progress or refunds incurred charges.

## Why passing tests can still leave findings

The 174 existing regressions demonstrate covered contracts, not every possible asynchronous ordering. This round identifies gaps around stale responses overwriting newer state, incomplete cross-layer cancellation, and non-atomic deduplication plus persistence.

Keep reproductions that fail before and pass after the fix, and expand them across success/failure, stale/interleaved responses, cancellation, and recovery. Do not replace fixes with removed assertions, longer deadlines, or new configuration requirements. Cross-review and browser acceptance supplement automated tests; test counts are not proof of zero defects.

## Verification record

- `npm test`: **207/207 pass**, no failures/skips/TODOs, approximately 5.27 seconds.
- `npm run test:review`: **207/207 pass**, no failures/skips/TODOs, approximately 5.25 seconds.
- **33 additions** over the 174-test baseline: 12 request lifecycle, 11 workbench, 6 visitor runtime, and 4 event deduplication tests. Several contain header/body or success/failure branches.
- Two-hop native HTTP verifies actual closure of a hanging upstream body after visitor disconnect, one cancellation log, restored listener count, unaffected model health, and a successful subsequent turn.
- `npm audit --omit=dev`: zero known dependency vulnerabilities, not a comprehensive security audit. Changed application JavaScript syntax and `git diff --check` pass.
- Cross-review covers request lifecycle/frontend cancellation contracts, durable logging/retry, and model/knowledge health responses. Adjacent health-response races found during review were fixed and retained as regressions; no confirmed finding remains unresolved within this round's scope.

### Real browser

Playwright against an isolated local service restarted with final application code:

1. Edit while saving/testing a model: preserve the new draft with an explicit unsaved message. The server saves only the original submission; the next save persists the new draft.
2. Refresh, delete a file, and release the real GET response captured before deletion: the file stays removed and its deletion confirmation remains intact.
3. Inject an EventSource error while awaiting an answer, actually switch the backend to hosting, then release the late answer: no new speech invocation, retained draft, paused questions, and visible control-reconnection status.
4. Restore dialogue and reload a real SSE connection: the next answer displays and reaches simulated speech; zero console errors/warnings on that page.

Response delays and control-error injection reproduce browser ordering; speech and model responses are simulated. Physical audio and provider answer quality are not verified. Browser and temporary service sessions are closed. No real paid calls, real runtime-data/configuration changes, Git commit/push, Docker deployment, or capacity soak.
