# Chat history search responsiveness

The search introduced in #3601 ran its entire bounded-content scan inside the
history drawer render. The index cache limits retained memory, but histories
larger than that cache still rebuilt older indexes on each keystroke. A changing
streamed conversation also refreshed the session list and repeated that scan.

Search now runs in scheduled slices of at most 16 sessions or approximately
4 ms. The existing per-session text limits, matching rules, index-memory bounds
and session order remain unchanged. A query change cancels the previous scan;
streaming updates keep match decisions for unchanged sessions and recheck the
replacement objects, so ongoing output cannot repeatedly restart the search.
The drawer shows a searching status and clears obsolete-query results until the
current query finishes. While the session list changes, only still-present,
unchanged matched objects stay visible, in the current list order; removed or
replaced objects cannot remain selectable until the next slice. Clearing the
query restores the unfiltered history
immediately and releases the search's previous results.

## Verification

A separate Electron window mounted the actual before/after history drawer with
500 synthetic conversations, each containing about 64,000 retained characters.
No user conversations, terminals or provider calls were used. The same input
and ten updates to a single conversation produced:

| Work | Before | After |
| --- | ---: | ---: |
| Input handler return | 352.7 ms | 4.0 ms |
| Single conversation update | 319.4–323.3 ms | 1.49–1.90 ms |
| Final results for the fixture query | 1 matching conversation | Same conversation |

The old input/update tasks each blocked for over 300 ms; the repaired search
produced no task of 50 ms or longer in this run. These are development-fixture
measurements on one machine, not a guarantee for every device or history size.
Native input, empty results and the matching conversation were also checked in
the rendered window.

The drawer regression drives the actual input event and verifies that a queued
event-loop heartbeat runs before any retained message is indexed. It fails on
the previous implementation (720 synchronous message reads) and passes after
the repair. Further tests cover obsolete queries, live replacements/removals,
continuous-stream progress, result order and the existing matching limits.

```sh
node --test --import tsx \
  components/AIChatSessionHistoryDrawer.test.tsx \
  components/AIChatSessionHistoryDrawer.responsiveness.test.tsx \
  application/state/sessionHistorySearch.test.ts
```

## Pending-result freshness

A follow-up review found that the first repair could temporarily show results
from the previous session snapshot. A second Electron comparison used the
initial repair (`a8b291b7c`) and the reconciled version. Removing or replacing the
matching session left it selectable in the initial repair's first commit; the
reconciled version immediately removed it. Reversing the current list initially
kept session 0 first; it now immediately shows session 499 first. Unchanged
confirmed matches remain visible while changed objects are checked, so a stream
does not blank every result. This check compares object references and ordering
without rereading retained message text. Input remained about 4 ms for the same
500-conversation fixture.
