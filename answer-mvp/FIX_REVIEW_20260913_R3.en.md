[简体中文](FIX_REVIEW_20260913_R3.md)

# Failure recovery and log integrity — 2026-09-13, round three

This round addresses four findings from the read-only review after [round two](FIX_REVIEW_20260913_R2.en.md). The pre-fix baseline is 207 passing tests; historical counts and acceptance boundaries remain historical, not a zero-defect claim. This round excludes Git commit/push and deployment.

## Implemented acceptance contracts

| Finding | Required behavior | Regression location |
| --- | --- | --- |
| Hanging model/knowledge responses leave controls locked | Bound both headers and body waits; retain drafts, credential intent, and selected files; treat timeout as unknown outcome, bound read-only reconciliation, and never automatically replay writes | `test/workbench-runtime.test.js` |
| Retried partial log writes are acknowledged but unreadable | Recover to a complete-record byte boundary; prevent a damaged tail from corrupting the next record; never acknowledge failed recovery or remove complete records | `test/ops-log-recovery.test.js` |
| A stale acknowledgment deletes an unsent retained event when the queue is full | Remove only the acknowledged eventId; distinguish configured capacity eviction from unintended deletion; keep memory/storage consistent | `test/avatar-runtime.test.js` |
| UI refresh erases a synchronous speech-failure hint | Retain the failure until an appropriate new interaction; hosting/control-loss messages take priority, and successful subsequent turns clear stale errors | `test/avatar-runtime.test.js` |

## Boundaries

- Timeout does not prove that the server did not execute a write. Public configuration cannot confirm a hidden credential change or successful connection test. Do not automatically replay an unconfirmed replacement import.
- Preserve demo login/origin decisions and runtime configuration, without new deployment prerequisites.
- The frontend event queue still has a 200-entry capacity. This fixes extra unintended deletion, not unlimited offline retention.
- Filesystem recovery must not treat a failed append as a valid log entry. It does not guarantee absolute durability under power loss, damaged media, or untested shared multiprocess writes.
- Recovery repairs an incomplete tail in the current file, not historical mixed internal lines or corrupted archives. No real runtime logs were scanned or rewritten in this round.
- Automated/browser tests use temporary data, placeholder credentials, and simulated models/speech, not paid providers or physical-device audio.

## Implementation and failure verification

- Model writes use `max(30 seconds, model timeout + 15 seconds)`, capped at 135 seconds. Knowledge import/delete/migration use 180 seconds; reads/reconciliation use 10 seconds. Deadlines cover headers and body, including abort-ignoring adapters. Unknown outcomes retain input and never replay writes. Invalid/incomplete or stale reconciliation responses cannot replace the valid current snapshot.
- Serialized log appends repair the tail first and roll failed writes back to their prior byte size using the same file handle. Complete JSON missing only a newline is preserved; incomplete JSON/UTF-8 is truncated. A real child-process file-size limit produces `EFBIG`: HTTP 500 → same-event retry 200 → duplicate acknowledgment, with exactly one readable full dialogue. Failure after rotation preserves the old archive.
- Frontend acknowledgments remove the actual sent `eventId`, tested with 201/205 reports, successful/400 acknowledgments, 503/network retries, and persistent-queue consistency. Speech-failure hints follow the current interaction state, clear on the next normal turn, and yield to hosting/control-loss messages.

### Additional test-cleanup race found during rerun

The first strict run passed 225/225, but the next ordinary run reported 224/225: `TC-FUNC-001` teardown raised `ENOTEMPTY` and left its test listener running. Directory removal was registered before application closure, racing with pending log writes; the dialogue assertions themselves did not fail.

Core HTTP and bundled-knowledge service tests now close/drain the app before deleting their temporary data. Two deterministic regressions cover a blocked real `service.stop` append and cleanup after a close error. The old ordering failed the controlled check; the fix passes. This failure was repaired, not hidden by rerunning.

## Browser acceptance

Playwright uses an isolated temporary server, random loopback port, and placeholder credentials. Management deadlines are accelerated to 1.5 seconds for browser fault injection; automated tests assert the actual 10/30–135/180-second budgets.

1. Model save: delay the reply after an actual successful server write. Timeout unlocks controls, preserves newly edited text and credential intent, sends only one PUT, and ignores late success without clearing the unknown-outcome warning.
2. Knowledge import: complete a native browser multipart upload, then hang body consumption. Timeout restores controls and retains the selected file. A read-only refresh shows the persisted document while preserving the unknown-outcome warning; there is no automatic repeat import.
3. Speech: inject a synchronous `speak()` failure. The hint survives request completion and another question remains possible. Simulated start/end events on the next turn clear the old error; backend logs distinguish failed and completed speech. The recovery page has zero console errors/warnings.

An initial multipart `route.fetch()` forwarding experiment returned an empty-file error and is not counted as successful-import evidence. Native browser uploading with delayed response consumption passed check 2. Test browser and temporary service sessions are closed.

## Final verification and review conclusion

| Check | Final result |
| --- | --- |
| `npm test` | 227/227 pass; zero failures, cancellations, skips, or TODOs; about 4.43 seconds |
| `npm run test:review` | 227/227 pass; zero failures, cancellations, skips, or TODOs; about 4.14 seconds |
| `npm audit --omit=dev` | Zero known vulnerabilities |
| Source syntax, `git diff --check`, relative documentation links | Pass |

Twenty additions over the 207-test baseline: seven workbench, four frontend, seven log-recovery, and two cleanup tests. Each implementation area was cross-reviewed by a non-author; independent log checks also exercised 8 KB/UTF-8 boundaries and real partial failure after rotation. The four findings and the cleanup defect are fixed, with no confirmed unresolved issue in this bounded review—not a universal zero-defect claim.

Real external-model quality, physical speech/WeChat, capacity soak, and deployment remain unverified. No GitHub commit/push or main merge was performed.
