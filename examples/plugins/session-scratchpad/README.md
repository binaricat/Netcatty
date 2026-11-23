# Session Scratchpad

Fixture ID: `com.netcatty.session-scratchpad`, version `0.1.1`.
Required permission: **views**, for this plugin's own pages only. Required
feature: `views.terminal-sidebar`. No terminal/session read, clipboard, network,
Vault, filesystem, credential or shell permission is requested.

```sh
node packages/plugin-cli/dist/cli.js pack examples/plugins/session-scratchpad/.package --out /tmp/session-scratchpad.ncpkg
```

Import disabled through normal Settings, inspect and enable. Parent native QA
must obtain a fixture-specific own-views approval; no previous plugin's grant
applies. Use only an explicitly approved synthetic terminal target, without
entering commands or connecting to real hosts for this page check.

In an open terminal, choose **Extension pages** in its toolbar, then **Session
scratchpad**. This is a real existing side-panel pane. Save synthetic text,
split beside a built-in tool, resize/move/magnify, return and reopen. The host
keeps this page's state in a placement/session bucket; the page never receives
the session ID, endpoint, cwd, title, history, selection or terminal output.
This is plugin-owned text, not a Vault Note, and is not automatically synced.

For a separately approved second synthetic terminal/workspace focus target,
verify that navigation closes the old native view and uses a separate draft
bucket. Switch back to verify the saved first draft. Clear it to verify
deletion. Close the pane, press Escape, disable/revoke, and verify cleanup.
Settings/permission dialogs and overlapping menus must stay above native
content. No new native target or persistent grant should be inferred from this
README; parent coordinates the exact test and records source SHA/package hash.


## Current UI build

The page now uses the host-rendered contract. Run `node build.mjs` in this
example directory, then package `.package/` with the plugin CLI. `host.js`
registers ordinary DOM views; `view.html` and `view.css` are bundled source
templates. Theme values are inherited from Netcatty. There is no separate page
preload or `window.netcattyView` API. See `docs/plugin-platform/host-rendered-ui.md`.
