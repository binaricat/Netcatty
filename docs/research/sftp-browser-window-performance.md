# SFTP browser window performance

## Finding

The production file-list hook rendered every file until both row and viewport
measurements arrived. It also disabled its window when a pane became inactive.
The production tree rendered every descriptor whenever its viewport height was
zero, including the first commit and a hidden tree's ResizeObserver update.
Thus opening or leaving a large directory could mount thousands of file rows.
Both conditions are already present in v1.1.83; this is an existing bottleneck
found during the post-release performance audit, not a regression attributed to
the newer compact-list UI.

An isolated Electron renderer using the actual list/sorting/files hooks, list
component, tree component and application CSS reproduced:

| Files | Initial list mount | Hide list | Hidden list rows |
| --- | --- | --- | --- |
| 1,000 | 293 ms | 129 ms | 1,001 |
| 5,000 | 1,309 ms | 696 ms | 5,001 |

The 5,000-file tree initially took 604 ms and mounted 5,001 rows again when
hidden. The extra row is the normal parent-directory entry. These are controlled
macOS measurements, not the original Windows environment from #3155.

## Repair and regression gate

Large lists retain their window while inactive or unmeasured. A conservative
initial file-row height permits a bounded first commit; the existing real-row
measurement still corrects it for either density. Tree rows already have a fixed
height, so a zero viewport simply keeps the overscan window. Small directories
and the complete file/selection data remain unchanged.

`components/sftp/SftpPaneVirtualization.test.ts` failed on both original hooks
with 5,000 initial rows, then passed after the repair. It checks first commits,
inactive/zero-height panes, the last file, density remeasurement, small lists and
tree visibility. The separate native script exercises the actual rendered
components and records timings without machine-dependent time assertions.

## Durable native acceptance

Run `node_modules/.bin/electron scripts/sftp-browser-window-performance.live.test.cjs`.
For the red control, also set `NETCATTY_SFTP_WINDOW_BASELINE=1` and
`NETCATTY_SFTP_WINDOW_BASELINE_REF=b073162eafd39ce2a337c9acbf36da2eb7456f63`.
The control overrides only the two hooks, keeping the same inputs and current
components/CSS. It completes the interaction checks, then fails with
`SFTP_FILE_WINDOW_UNBOUNDED` (maximum 5,003 mounted rows). The repaired version
passes, retaining at most 39 rows across every recorded commit. Initially hidden
list/tree panes retain at most 22/32 rows; the small directory keeps all 22 rows.

In this Vite development-renderer fixture, initial list mount was 2,975 -> 61ms,
first hide 1,950 -> 11ms, restore 148 -> 12ms, and initial tree 715 -> 18ms.
These timings are distinct from the earlier bundled-renderer probe above.
The deterministic gate is bounded mounted rows, rather than a hardware-dependent
time threshold. Actual application CSS row heights are asserted at 44/24px.

The native script scrolls to the final file with Electron wheel events, selects
and opens files, expands a tree directory and opens its child, toggles density,
and hides/restores both views after selecting the final file. Selection and
position persist (one CSS-pixel boundary tolerance). It uses its own sandboxed
BrowserWindow/profile, dedicated port 5379 and private Vite cache, allows only
its local fixture requests, and closes its listener/profile afterward. Results
and window pixels are kept in Netcatty's dedicated temporary directory. This is
programmatic native-window input; it does not use the user's SSH or unlock the
macOS session, and is not a claim of manual CUA acceptance while macOS was locked.

## Review follow-up: shorter background listings

Review found that a retained scroll offset could outlive a shorter listing.
The browser clamps its real scroll position, but inactive-list scroll events
are ignored; the calculated start could exceed the final file and render an
empty slice. The same range issue affects tree descriptors. Clamp both windows
to the available content, and synchronize the measured scroll position when
positive viewport geometry returns. Preserve the last visible offset while
geometry is zero.

Both hook tests failed at the exact shrink scenario before this follow-up.
The native control loading all three original product files from `fa5e79c85`
also failed: list 5,000 -> 100 files and tree 100 -> 60 each recorded zero rows
during the hidden update and first restore commit. On this macOS run, later
browser scroll events automatically recovered; a permanent blank pane was not
observed. The repaired run retains 21 list rows and 6 -> 31 tree rows across
those commits, without another user scroll. It asserts nonempty bounded rows,
the last file's visibility and each rendered row's position against the actual
browser-clamped scroll offset. The previous complete native interactions also
remain passing. To replay this narrower red control, use the same baseline
environment variables with `NETCATTY_SFTP_WINDOW_BASELINE_REF=fa5e79c85`.

181 related SFTP checks, full lint (zero errors, eight existing warnings) and
production build pass locally. Full-project typechecking still reports existing
errors; there are no diagnostics in the changed product/test/fixture files.

The directory-window problem is independent of the expanded transfer-center
problem fixed in #3722. Related to #3155 only; neither observation establishes
the cause of the original Windows report, so this PR does not close it.
