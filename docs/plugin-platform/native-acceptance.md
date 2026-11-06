# Native Electron handoff

Repository: binaricat/Netcatty. Frozen baseline: 0256e7471d66bbbca077c361ef379d7b11ce8465.
Stack: feat/plugin-compatibility-review -> feat/plugin-settings-manager -> feat/plugin-curated-catalog.
Use the final catalog branch for all three slices. Do not merge or release.

1. Check out the branch on the approved desktop. Run npm ci and npm run build.
2. Build the first-party sample:
   npm run build:plugin-packages
   node packages/plugin-cli/dist/cli.js pack examples/plugins/starter-netcatty --out /tmp/starter-netcatty.ncpkg
   node packages/plugin-cli/dist/cli.js validate /tmp/starter-netcatty.ncpkg
3. Launch the actual Electron binary without NETCATTY_PLUGIN_DEV and with a new disposable
   --user-data-dir path, keeping Chromium sandbox enabled. Use the desktop's working
   display and safe configuration; never --no-sandbox or real profiles/accounts.
4. Settings > Plugins: record Community plugins list and Plugin Starter details.
   Open README: actual pinned first-party GitHub retrieval; HTML inert, no remote images.
   It intentionally says source-only: no downloadable artifact/release was invented.
5. Import /tmp/starter-netcatty.ncpkg. It must remain disabled. Expand the installed
   item: manifest permissions/resources, sensitive markers, Netcatty/API ranges,
   SHA-256. Enable allows lazy activation; it does not grant permissions.
   First command/view use prompts before runtime creation. Denying must not run code.
6. With approved non-advanced permissions for the first-party example, edit Greeting
   and open Starter: Greeting Panel (入门：问候面板) in the command palette.
   Click Show greeting (显示问候语) and record the preference rendered in the panel.
   No real host, cloud account, terminal credentials, runtime.advanced or third-party code.
   Use Starter 0.1.1 or later. Its menus/views permissions support only the declared
   command and sandboxed panel; do not expect terminal output.
7. Disable, re-enable, close/restart the app with the same synthetic profile. Confirm
   settings persist. Re-import same .ncpkg and verify it stops and stays disabled.
8. Uninstall only the synthetic plugin using the two-step confirmation. Code/local KV
   are removed; user-owned settings/secrets/sync sidecars have documented retention.
9. On machines without a usable OS vault, the manager shows a downgrade notice;
   secrets remain blocked but browsing and non-secret examples work.

Compatibility upgrade/downgrade, required-feature changes, integrity mismatch,
manifest mismatch, Node rejection, cleanup and traversal have automated synthetic
coverage. Do not claim the above native steps were executed on this executor.

This executor's native launch failed at Chromium's SUID sandbox configuration:
chrome-sandbox is not root-owned mode 4755. No sandbox weakening was attempted.
Native video is pending on the parent task's working desktop.

10. Use the same AI-settings-style subpages: Installed and Community. Search by
    name/author/description, open details and return. Verify README error/retry UI
    if network is unavailable; do not bypass the network restriction.
11. Inspect human-readable permission name, effect, scope, required/optional and
    risk. Enabled means eligible for lazy activation, not permissions granted.
