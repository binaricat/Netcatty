# Hello World 2

An isolated, theme-aware example for Vault, terminal sidebar, tabs, aside,
panel and modal views. It requests only `views` and does not read
hosts, terminals, files or user data. The button updates local page text only.

Build the SDK and CLI, then pack and import:

```
npm run build:plugin-runtime-deps
npm run build:plugin-view-examples
node packages/plugin-cli/dist/cli.js pack examples/plugins/hello-world-v2/.package --out /tmp/hello-world-v2.ncpkg
```

In Settings > Plugins import and enable the package. Use its Vault menu entry or terminal toolbar buttons. Terminal sidebar requires an open terminal. The package includes
the SDK's opt-in foundation locally and follows host theme and locale changes.

## Current UI build

The page now uses the host-rendered contract. Run `node build.mjs` in this
example directory, then package `.package/` with the plugin CLI. `host.js`
registers ordinary DOM views; `view.html` and `view.css` are bundled source
templates. Theme values are inherited from Netcatty. There is no separate page
preload or `window.netcattyView` API. See `docs/plugin-platform/host-rendered-ui.md`.
