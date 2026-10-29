# Hello React: host-rendered plugin UI

This example uses ordinary React and custom CSS. Netcatty draws its visible UI;
the script runs in the isolated runtime and requests `views` and `settings.read` (its own settings only).

Build: `npm run build --workspace @netcatty/example-hello-react-host`.
Package this folder with the plugin CLI and install the `.ncpkg` from Settings.
No development environment flag is needed for this browser example.

It declares Vault, terminal sidebar, tab, aside, panel and modal views.
Its Settings entry is a standard Netcatty form with greeting, appearance and
content groups. Name, greeting enabled, accent color and default note are saved
by the host and applied to new pages and already-open pages. Demo edits inside
a page remain local; use Settings to change persistent defaults.
Try text/Chinese input, reset, checkbox, select, a package image and the custom
menu. Close and reopen a sidebar: its registered tool remains available. Hidden
views retain their own state within the host's five-minute/16-instance cache.

The view permission grants no host data. User-entered text is handled by the
plugin. Unsafe elements, external resources and escaping styles are rejected;
ordinary React support does not guarantee every third-party browser library.
See `docs/plugin-platform/host-rendered-ui.md` for the supported contract.
