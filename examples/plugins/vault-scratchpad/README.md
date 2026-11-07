# Vault Scratchpad

Browser-only example of an actual Vault extension page. It needs only `views`
and the required `views.vault-pages` feature. No host/session/Vault data,
clipboard, network, filesystem, credentials or shell permission is requested.
Text explicitly typed here is stored in this plugin's own bounded view state;
it is not a Netcatty Note and is not automatically cloud-synced.

```sh
node packages/plugin-cli/dist/cli.js pack examples/plugins/vault-scratchpad/.package --out /tmp/vault-scratchpad.ncpkg
```

Import disabled through normal Settings, inspect and enable it. Under Vault's
**Extensions** group choose **Scratchpad**. The sandbox must fill Vault's main
content area, retaining the built-in sidebar and top tabs. Opening its detail
entry must navigate to this same Vault page, without creating a top plugin tab.

For native QA, a separate explicit approval for this fixture's own `views`
permission is required; earlier fixtures' grants do not cover this ID. With
synthetic text, save, return to Hosts and reopen; verify the draft. Clear and
reopen to verify deletion. Cancel the first permission prompt to verify that no
page attaches. Switch away during opening, then disable/revoke and verify the
page/entry disappear. Closing or withdrawing a page returns to Hosts. A host
modal or overlapping menu must hide the native view while it is present.

This source example is not independent/native acceptance evidence. Parent QA
records the precise tested commit and package hash separately.


## Current UI build

The page now uses the host-rendered contract. Run `node build.mjs` in this
example directory, then package `.package/` with the plugin CLI. `host.js`
registers ordinary DOM views; `view.html` and `view.css` are bundled source
templates. Theme values are inherited from Netcatty. There is no separate page
preload or `window.netcattyView` API. See `docs/plugin-platform/host-rendered-ui.md`.
