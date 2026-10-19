# Pending sync indicator performance

The pending-local-sync indicator independently collected and serialized the full sync payload after every local edit. Upload debounce did not cover this path. New monitor panel and portable chat changes also trigger it. No competing open repair was found during the 2026-10-18 audit.

A production React hook in an isolated Electron renderer, with 2,000 synthetic hosts and mocked cloud network edges, received 50 monitor-name edits spaced 5 ms apart:

| Checkpoint | Before | After |
| --- | --- | --- |
| Collections during the edit burst | 50 | 0 |
| Collections for the settled indicator | 0 additional | 1 |
| Uploads after the existing upload debounce | 1 | 1 |
| Pending indicator after edits | true | true |

The indicator now waits 200 ms after the latest change before collecting. Disabling, locking, losing the provider, pausing, or unmounting cancels pending work; stale in-flight indicator results are ignored. Startup baseline collection and explicit/manual sync keep their existing timing. The change does not alter cloud payloads or conflict/merge decisions.

`application/state/useAutoSync.monitorPanels.test.ts` exercises the actual hook, adapter notifications, and sidecar collection boundary. It failed before the fix (13 collections vs 3 startup collections after ten edits), and passes after the fix. It also checks settled pending state, cancellation before collection, and cancellation while collection is in flight. Existing panel create/edit/delete upload and sync baseline tests continue to pass.

Validation: 47 related tests passed, full lint has zero errors (eight existing warnings), and production build passed. Full-platform CI must be checked at the final PR head. The fixture does not claim to reproduce the Windows long-running terminal report or to benchmark a real cloud provider.
