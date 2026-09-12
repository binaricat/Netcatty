# Background terminal rendering (#3278)

Inactive panes retain their live terminal and measured dimensions, but move
outside the viewport. This lets xterm's IntersectionObserver stop painting
without stopping output parsing or rebuilding the terminal on every tab switch.
The existing reveal, resize and WebGL recovery paths remain responsible for
restoring the current screen. No new output queue or lossy truncation is added.

## Regression coverage

Run `npm run test:terminal-background-rendering` with a graphical Electron
session (Linux CI uses xvfb). It bundles the production runtime and inactive
pane style helper, creates five real terminals, and verifies:

- The visible terminal paints while all four background terminals do not.
- Output is already parsed in each hidden terminal and dimensions stay valid.
- Twelve hide/reveal cycles repaint newly received output.
- A window-area resize does not collapse the hidden terminal's measured width.
- Cursor-addressed alternate-screen output survives hiding and a reveal resize.
- Two visible split panes paint while the remaining hidden panes do not.

Before this change, the first visibility assertion fails: each background pane
paints 12 frames instead of zero. The test does not claim to reproduce the
reporter's delayed high-CPU condition, and direct writes in this harness do not
exercise the complete SSH/output transport path.

## Local application validation

A separate Netcatty development instance with an isolated profile was tested on
macOS (M2 Max, 32GB), using five real local shell sessions. Four sessions emitted
continuous logs. The UI was exercised through tab switching, split creation,
focus mode, detaching back to a tab, closing the extra split, and window resizing.
Actual screen captures were checked for restored content. CPU comparisons use
that instance's renderer and GPU process metrics, not other applications.

This is a CPU optimization for invisible panes. It does not promise lower
history/GPU memory usage, nor establish the root cause of every #3278 report.
Remote SSH, Windows/Linux interactive recovery and the reporter's M4 environment
still require separate validation; this PR should reference rather than close
that issue automatically.
