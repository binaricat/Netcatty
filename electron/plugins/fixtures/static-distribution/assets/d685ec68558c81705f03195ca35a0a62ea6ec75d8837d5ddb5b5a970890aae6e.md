# Plugin Starter

A minimal first-party browser plugin for learning import, settings and lifecycle.
It requests `commands`, `settings.read`, `menus` and `views`: no terminal text, host credentials,
network, files, secrets or advanced Node access. It works without OS key storage.
Permission declarations are not grants; follow the app's normal mediation.

From the repository root:

```sh
npm run build:plugin-packages
node packages/plugin-cli/dist/cli.js validate examples/plugins/starter-netcatty
node packages/plugin-cli/dist/cli.js pack examples/plugins/starter-netcatty --out /tmp/starter-netcatty.ncpkg
```

Start the actual app normally with a fresh test profile; no development flag is
needed. Open **Settings > Plugins > Open plugin manager > Installed**, import the package, inspect its
permissions and enable it. Change **Greeting**, then find **Starter: Greeting Panel** (入门：问候面板)
in the command palette. Review the normal permission prompts, then click
**Show greeting** to see the exact preference in the sandboxed panel.
**Starter: Read Greeting** is also listed and refreshes an already-open panel.
The panel inserts text using `textContent`, never HTML. It does not write to
a terminal or connect to a host. Denied permissions remain denied.

Disable, restart and re-enable to verify the preference persists. Re-importing
the same package leaves it disabled for review. Uninstall removes code and local
KV; user-owned settings remain. The greeting is local only, not cloud-synced.

The separate Hello Netcatty example demonstrates terminal providers and requests
terminal permissions. Use this Starter for the default no-sensitive-access demo.


Version 0.1.2 adds light/dark PNG brand icons in `assets/`. Displaying these
images does not activate the plugin or request permissions. This example now
requires API `>=0.1.0-internal.1 <0.2.0` and `metadata.brand-icon`.
Older Starter 0.1.1 packages remain compatible with the new host.
See [brand icon author instructions](../../../docs/plugin-platform/plugin-icons.md).
