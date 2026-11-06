# Selected terminal sharing and input drafts

The `terminal.selection-sharing` feature adds
`context.terminals.shareSelection(title)`. It resolves to `undefined` on cancel,
or a frozen `{text, handle, expiresAt}` snapshot after host Preview and Share.
Text is limited to 4096 UTF-8 bytes. Only the visible, connected input owner's current xterm selection is eligible:
a solo tab, the selected Focus-mode pane, or the selected split pane. Other
visible split panes remain ineligible. Empty, oversized, sensitive-input, detached,
and unavailable selections fail closed. The user's copy-normalization setting,
including explicit `false`, remains in effect.

The trusted renderer publishes its backend session ID and renderer identity.
`TerminalSelectionAuthority` checks the worker's current connection generation and
window ownership. It also binds the host database's encoded source owner, plugin
version, runtime, and expiry. Neither raw terminal objects nor endpoint/store/PTY
objects cross plugin RPC. The host dialog identifies the terminal and previews
exact text, including escaped control characters, before the user shares it.
Raw terminal output can contain secrets. There is no redaction safety guarantee.

A handle expires after 120 seconds. A runtime can hold four handles and the host
can hold 64. Session close, reconnect, attached-owner change, renderer replacement,
selection of another terminal, loss of the selected visible target, window owner
change, plugin disable/revoke, and source replacement invalidate references.
Currency is checked again before disclosure or draft review. Late replies cannot
reuse an old phase's one-use action token. Text already explicitly disclosed to a
plugin cannot be recalled from that plugin's memory.

## Input proposal contract

The additive `terminal.input-drafts` feature adds
`context.terminals.proposeInput(handle, text, title)`. The handle identifies only
the previously selected terminal. A distinct `terminal.input.propose` permission
and host review are required. Both new permissions are optional-only manifest
declarations with one-time operation grants. The existing `ui.interact` broker
owns correlation, limits, cancellation, and renderer consent.

`proposeInput` opens an editable textarea in the existing host interaction dialog.
It resolves to `true` after **Close draft**, or `false` on cancel. Edits stay in
that dialog. The API neither returns the edits nor dispatches terminal input.
Multiline and control-containing proposals remain inert text, bounded to 4096
UTF-8 bytes. The proposal's creation, editing, and closure produce no PTY writes,
Enter, clipboard replacement, broadcast, or automatic retry.

The normal compose bar sends on Enter and can broadcast, so this slice does not
insert into that control. Users can copy text themselves and later act through
the normal host UI. No new terminal editor or recorder is introduced.

## Authority boundaries

The terminal reader uses the existing selection-normalization primitive. It has
no access to the Agent/MCP history readers or retained terminal snapshots. Source
ownership comes only from `database.privateOwner` and `database.publicPluginId`.
A missing encoded owner fails closed. No database schema or source-storage API
changes are needed.

The separate [AI selected-context interface](selected-context-authority.md) remains
text-read-only. Its handles cannot become terminal targets or authorize proposals.
This implementation consumes documented boundaries and does not review or extend
AI business logic, SSH authentication, SFTP, or the tool catalogs.

The [sample](../../examples/plugins/terminal-selection-draft/README.md) and
[native recipe](terminal-sharing-native-qa.md) identify the exact package and
remaining desktop acceptance work.
