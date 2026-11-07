# Check selected terminal sharing on the native desktop

The parent owns scheduling for this acceptance pass. The native GUI slot remains
reserved. Use the Draft branch `feat/plugin-terminal-sharing-complete` only after
that slot becomes available. Record `git rev-parse HEAD` and the package hash.
Keep the platform's normal sandbox and helper permissions.

## Prepare synthetic terminals

Use a disposable app profile and two local disposable terminal sessions, A and B.
Do not use SSH credentials, remote services, paid providers, or user resources.
Manually display only `synthetic terminal A` in A and `synthetic terminal B` in B.
Run the flow once in a solo tab, once in workspace Focus mode, and once in the
selected split pane. Other visible split panes and inactive tabs must remain
ineligible. Select a small, distinct range in each terminal. Build and import the exact
[two-file sample](../../examples/plugins/terminal-selection-draft/README.md).

Its expected archive SHA-256 is
`f3b8ac268edbf616effe76110f372d2249e414675d877020a074c89f03c65950`.
Check required `commands` and `menus`, and optional `terminal.selection.read` and
`terminal.input.propose`. Enable the package only in this disposable profile.

## Check disclosure and cancellation

1. Focus A and invoke **Share selected terminal text**.
2. Cancel the permission prompt. Confirm that no preview or draft opens. If an
   unavailable command cannot start, confirm that the palette shows its bounded
   failure toast rather than silently closing.
3. Invoke it again and allow the one-time selection permission. Before Preview,
   confirm that terminal text is absent from the dialog.
4. Click **Preview terminal selection**. Confirm the A label and session ID,
   complete selected text, escaped controls, byte bound, and secrets disclosure.
5. Cancel. Confirm that the plugin does not proceed to a draft.
6. Repeat and click **Share with plugin**. Choose **Review selected terminal draft**
   and confirm its separate permission.
7. Cancel the draft permission, then repeat and allow it. Edit the draft, including
   a synthetic newline and visible control escapes. Confirm no terminal output,
   command, cursor-input change, or Enter occurs while the draft opens or closes.
8. Click **Close draft**. Confirm no terminal bytes were sent and the plugin sees
   only an acknowledgement. Do not send the draft during this acceptance check.

## Check lifecycle and input compatibility

Repeat from A and verify these outcomes:

- Switch to B before Share. A's pending request closes. A new request previews
  only B's selection, never A's text or combined history.
- Clear B's selection. Preview fails visibly. It never substitutes the viewport,
  retained history, another terminal, or an empty-but-successful disclosure.
- Hide A, close it, reconnect it, or attach it to a popup while a share or draft
  is pending. The pending interaction closes or refuses completion. Start a fresh
  selection after restoring an eligible main-window terminal.
- Disable/revoke the plugin, lock/hide the window, or replace the owner window
  during review. Old controls cannot complete the cancelled operation.
- Wait 120 seconds after issuance. A retained reference cannot open a new draft.
- With copy normalization disabled, verify exact raw selected text in the preview.
  Restore normal settings after the check.
- With the normal compose bar already holding synthetic text and broadcast enabled,
  open and close a plugin draft. Confirm the existing compose draft and broadcast
  target are unchanged, and neither A nor B receives input.
- Run the established local input-mode and attach checks from #3991. Plugin preview
  and draft review must preserve the existing terminal controls and input mode.

Capture the disclosure, selected terminal, editable draft, cancellation, and
post-review terminal state. Record native acceptance as pending until these checks
actually run. The automated Node/JSDOM tests do not establish Electron sandbox or
native GUI acceptance.
