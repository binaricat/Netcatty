# Expanded SFTP folder-list responsiveness

The global transfer center already limited mounted top-level rows, but expanding
a folder rendered every retained child file. Each progress update also rebuilt
all folder groups and sorted their children. A folder with thousands of queued
files therefore stalled the renderer even when only one file's bytes changed.

The child list now mounts its visible range with a small overscan. Its existing
scroll area still reaches every retained file. The transfer center reads a stable
hierarchy snapshot between lifecycle changes; mounted parent/child rows subscribe
to their own live progress. Progress that introduces a row or changes its status
still refreshes the hierarchy. Completion retention and compact checkpoints are
unchanged.

## Controlled measurements

A separate Electron window mounted the actual before/after transfer center with
two synthetic directory transfers. No SSH connection, real file or user transfer
was involved. The same expand action, ten updates to one child and a scroll to
the final file were exercised in each version.

| Children | Work | Before | After |
| ---: | --- | ---: | ---: |
| 1,000 | Expand to next rendered frame | 298.8 ms | 10.94 ms |
| 1,000 | One child's progress to next frame | 112.6–125.6 ms | 1.18–18.18 ms |
| 5,000 | Expand to next rendered frame | 1,216.1 ms | 14.36 ms |
| 5,000 | One child's progress to next frame | 500.5–538.4 ms | 1.31–6.03 ms |
| 1,000 / 5,000 | Mounted child rows | 1,000 / 5,000 | 12 / 12 |

Both repaired lists reached their final child and retained all 1,000 / 5,000
queued records. Native scrolling, collapse/reopen and live byte display were
also checked. These are development-fixture measurements on one machine, not a
cross-device frame-rate guarantee.

The actual-component regression fails on the original implementation because
it mounts 1,000 children. It verifies bounded mounted rows, live progress without
re-sorting the folder, final-child access, completion accounting and collapse /
reopen. The existing top-level recycling test also expands a folder, scrolls it
out of view and returns to its retained expansion state.

## Issue relationship

Related to #3155. Its Windows report and subsequent comments cover multiple
possible large-transfer failures; they do not establish that this exact expanded
folder-list workload caused the reporter's freeze. This repair is independently
reproduced UI work and must not close that issue. Open #3694 and #3696 modify
file metadata / transfer connection acquisition, not this list behavior.

## Control availability follow-up

Independent review found that the initial stable snapshot did not refresh when
progress reported a transfer could no longer pause, including a child's change
propagated to its folder. Metadata-only patches and a newly available failed
transfer checkpoint could similarly leave batch buttons stale. The list now
refreshes its lightweight snapshot only when grouping/order/control eligibility
fields change; repeated identical capability metadata on byte ticks keeps the
hierarchy stable.

The actual-component regression first failed with Pause all incorrectly enabled
after the backend reported the folder could not pause. It now covers that child /
parent update, direct metadata changes, repeated unchanged metadata without a
full sort, and Resume all becoming available when a failed task gains a checkpoint.
An Electron comparison against initial repair 1b96e27b0 confirmed stale batch
buttons before and correct disabled/enabled states afterward. The final 1,000 /
5,000 file runs still mounted 12 rows and reached the final file: expand-to-frame
12.6 / 12.86 ms, child progress 1.32–15.42 / 1.06–17.90 ms.


## Hierarchy repair follow-up

A same-byte background event can repair a formerly top-level child before the
progress de-duplication guard returns. The repaired hierarchy must be published
even when the remaining event is ignored, including late events for terminal
rows. Those early exits now publish only when repair actually replaced the row;
normal progress still builds at most one hierarchy snapshot and ordinary byte
ticks keep its reference stable.

Both the store and actual-center regressions failed before this repair. The
Electron comparison against e894c9cb confirmed the old folder had no Show files
action after the same-byte event or its next byte tick. The repaired folder
immediately exposes its child, and the next byte tick keeps that grouping
without rebuilding it. A fresh 5,000-file run mounted 12 rows, reached the final
file and retained all 5,000 records: expansion 14.12 ms, progress 1.28-18.58 ms.


The repaired hierarchy also uses the existing coalesced persistence scheduler
at the structural mutation, so an ignored terminal event cannot leave the old
orphan on disk indefinitely. A restart regression first failed with zero writes
for the repair; completed, failed and cancelled cases now each save the change
once, restore under the folder (completed children through the existing compact
checkpoint), and schedule no further writes on unchanged late progress. Owner
lifecycle notifications stay at zero. An isolated actual Electron renderer
compared 744f0f8e against the repair and confirmed all three old orphan restores
and all three repaired restores. This run used synthetic in-memory persistence;
manual window input was unavailable because macOS was locked. Earlier native
folder scrolling and appearance evidence remains separate.
