# Hello Netcatty

This package is the runnable internal example for the plugin API. Package and install it to exercise native settings,
command-palette contributions, lazy command and Provider activation,
localization, terminal completion/decoration Providers, and the runtime SDK.

From the repository root:

```bash
npm run build:plugin-packages
node packages/plugin-cli/dist/cli.js validate examples/plugins/hello-netcatty
node packages/plugin-cli/dist/cli.js compatibility examples/plugins/hello-netcatty --netcatty 0.0.0
node packages/plugin-cli/dist/cli.js pack examples/plugins/hello-netcatty --out /tmp/hello-netcatty.ncpkg
```

After installation, change **Greeting** under **Settings → Plugins**, then run
**Examples: Say Hello** from the command palette. The setting is read through
the host settings broker and the command handler is registered inside the
sandboxed plugin runtime. Type `netc` at a shell prompt to exercise the bounded
completion Provider, and print `Hello from Netcatty` to exercise the declarative
decoration Provider. Neither Provider receives raw xterm objects or sensitive
terminal input/output streams.

## Import and inspect

Launch the normal browser-only plugin build using a fresh Electron
user-data directory for demonstrations. In **Settings > Plugins**, choose
**Import .ncpkg**, select the generated archive, and open its details. Review the
manifest permissions, engine ranges and SHA-256, then choose **Enable**. Native
permission prompts still mediate activation and sensitive operations.

Importing an update is a manual action and leaves it disabled, including when
the previous version was enabled. Review the new package before enabling it.
Changing unsigned package contents changes its security principal; previous
persistent grants are not transferred to different bytes.

An incompatible application/API upgrade disables installed plugins before
publishing their contributions. The reason remains in the installed list, and
package files and local data remain available. Returning to a compatible host
requires explicit re-enable. Uninstall is different: package code and local KV
are deleted; user-owned settings, secret storage and sync sidecars are retained.

For a synthetic demonstration, use only this first-party example, change the
Greeting, invoke **Examples: Say Hello**, disable/re-enable, restart the app and
inspect the package again. Do not connect real hosts or a cloud account. The
existing greeting setting is local; declaring `sync: true` on a non-secret
setting opts it into the existing encrypted settings sidecar. Generic SDK KV
storage does not sync.

For a demonstration without terminal permissions, use `examples/plugins/starter-netcatty`.
Enabling this lazy example does not grant permissions: required permissions are
requested before its first command/provider activation, and optional permissions
when used. Never treat Enabled as a security certification or grant.
