# Hello World for Vault

A minimal browser-only example adapted from the Netcatty marketplace acceptance
example. It contributes one static Vault page and requests only `views`. It does
not access hosts, credentials, terminal, files, network, or user data.

This development example targets Netcatty `0.0.0` and API
`0.1.0-internal.1`; stable-release compatibility has not been established.
Import the package through Settings > Plugins, review it, enable it, and open
**Hello World** in the Vault Extensions group. Approve the view permission when
prompted. The page should display `Hello, world!`.

Based on the MIT-licensed [Netcatty plugin examples](https://github.com/binaricat/netcatty-plugin-examples).

The page follows the host's light, dark and accent colors. Add your own page
heading and controls as needed. See `docs/plugin-platform/vault-pages.md`.

## Current UI build

The page now uses the host-rendered contract. Run `node build.mjs` in this
example directory, then package `.package/` with the plugin CLI. `host.js`
registers ordinary DOM views; `view.html` and `view.css` are bundled source
templates. Theme values are inherited from Netcatty. There is no separate page
preload or `window.netcattyView` API. See `docs/plugin-platform/host-rendered-ui.md`.
