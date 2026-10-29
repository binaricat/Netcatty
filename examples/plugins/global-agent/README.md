# Global Agent Chat example (work in progress)

This browser sandbox plugin provides a custom Chat view using the existing
host-owned Agent runtime. Choose a configured Catty or Claude Code backend,
explicitly choose connected terminal targets, open a new or owned conversation,
then Send. Stop cancels the exact turn. Refresh and reselection are explicit;
expired authority never silently re-shares targets or retries inference.

The command runtime remembers this sample's current opaque chat handle across
modal closes. A later explicit Open releases that exact lease before opening
the selected conversation. View pagehide cleanup is best effort; core source,
expiry and duplicate-open checks still apply. No handle is stored persistently.

Core stores source-isolated conversation history. The plugin receives text,
usage and safe activity summaries, never native session IDs, credentials, raw
tool arguments/results or executable/MCP configuration. Tool actions use the
plugin's `ai.agent.actions` Allow / Ask / Deny setting. Other backends report
unsupported/unavailable until their native tool boundaries are verified.

Build with `node examples/plugins/global-agent/build.mjs`, then package the
`.package` directory using `@netcatty/plugin-cli`. Install the resulting `.ncpkg`
through Settings → Plugins. This is a minimal example, not a background service.
Real provider/Claude usage requires a user's already configured backend and
separate approval for paid acceptance testing. Automated tests use synthetic
fixtures and do not establish authenticated Claude service/native acceptance.

## Current UI build

The page now uses the host-rendered contract. Run `node build.mjs` in this
example directory, then package `.package/` with the plugin CLI. `host.js`
registers ordinary DOM views; `view.html` and `view.css` are bundled source
templates. Theme values are inherited from Netcatty. There is no separate page
preload or `window.netcattyView` API. See `docs/plugin-platform/host-rendered-ui.md`.
