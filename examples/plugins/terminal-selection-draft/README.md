# Review a selected terminal draft

This sandbox browser sample asks the host to share the current terminal selection.
The host shows the selected terminal and a complete preview before disclosure.
The sample then proposes fixed synthetic text in an editable host dialog.
Closing that dialog sends no terminal input. Edits stay in the dialog and are
not returned to the plugin. The sample has no network or storage capability.

## Build the package

Run these commands from the repository root after installing dependencies:

```sh
npm run build:plugin-runtime-deps
node examples/plugins/terminal-selection-draft/prepare.mjs /tmp/terminal-selection-draft.ncpkg
sha256sum /tmp/terminal-selection-draft.ncpkg
```

The two-file package is `com.netcatty.terminal-selection-draft@0.1.0`.
Its SHA-256 is
`4c9c2388b7f891156192a0b5ab7b23291beba3555e7ec8cf24fbe2dfe1242d5e`.
Two independent builds match. Its content SHA-256 is
`99797d8679f34b96580076f922cbec067e511adc0f4ccf396ed129206acb6c4c`.
These are the unified acceptance candidate's hashes after rebuilding with its
combined SDK. The owner-head `8e7c28fe` archive had a different hash; use the
current [acceptance record](../../../docs/plugin-platform/acceptance-candidate.md)
and exact candidate commit for native preparation. Package validation is not
permission activation or native acceptance.

Required permissions are `commands` and `menus`. Optional permissions are
`terminal.selection.read` and `terminal.input.propose`, each limited to one
explicit operation on the exact selected connection and renderer. Required
features are `terminal.selection-sharing`, `terminal.input-drafts`, and
`commands.interactive`.

## Try the workflow

Use the parent-coordinated native acceptance slot and a disposable profile.
Import the package disabled, inspect its permissions, and enable it.
Select a local disposable terminal containing only synthetic text. Select a
small part of that terminal's text, then choose **Share selected terminal text**
in the command palette.

1. Allow the one-time selection permission.
2. Click **Preview terminal selection**. Inspect the terminal label, session,
   full text, and escaped controls. Terminal output can contain secrets.
3. Click **Share with plugin** to disclose exactly that snapshot, or cancel.
4. Choose **Review selected terminal draft** and allow its separate one-time
   permission. Edit the synthetic draft in the host dialog, then click **Close draft**. The terminal receives no bytes or Enter.

To send text later, copy it yourself and use the normal terminal UI. That is a
separate user action. This sample never inserts a compose-bar draft, executes a
command, reads history, or opens an Agent or MCP tool catalog. A plugin with other
separately granted capabilities can process shared text through those capabilities.
Regex redaction cannot guarantee that shared text is safe.

See [the native acceptance recipe](../../../docs/plugin-platform/terminal-sharing-native-qa.md)
for cancellation, reconnect, attach, hidden-renderer, and input-mode checks.
