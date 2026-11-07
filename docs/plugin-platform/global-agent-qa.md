# Global Agent continuation: bounded QA recipe

This is a separate increment after the plugin platform foundation. The transport
review checkpoint is #4012 at `ea619555`; its isolated correction is `63f0572e0`.
The runtime continuation carries the correction through an ordinary feature-branch
merge. It is not merged to main or accepted for release.

## Reproduce the installable sample

From the exact runtime head reported in the handoff:

```sh
npm ci
npm run build:plugin-runtime-deps
node examples/plugins/global-agent/build.mjs
node packages/plugin-cli/dist/cli.js pack examples/plugins/global-agent/.package --out /tmp/netcatty-global-agent.ncpkg
sha256sum /tmp/netcatty-global-agent.ncpkg
```

The reproducible sample SHA-256 is
`f0edf43523845847d5dbb74b0c4d8cd3bfe8e0f89ca193f28140e6b47dc45ed0`.
Two independent package builds matched. Build scripts and tests are excluded
from the six-file installed package.

The sample reserves transcript space inside the actual 798-by-548-pixel plugin
viewport measured during native QA. In a scheduled native test environment, run
`npm run test:plugin-global-agent-layout` for the bounded render regression. It
loads the real sample HTML/CSS with synthetic history, including the fixture
notice, and checks transcript scrolling, reachable configuration, and visible
mouse Stop. It does not load the plugin script or start an Agent/provider. This
render check remains pending where the normal browser sandbox cannot start;
do not disable the sandbox to run it. Also verify the installed sample visually
at the 1188-by-848-pixel app window before accepting the viewport correction.

For the modal-history lifecycle regression, stop the synthetic stream, close
the modal with the host X, and reopen it without disabling/restarting the
plugin or waiting for five-minute lease expiry. Select the owned conversation,
confirm fresh empty targets, and Open. History must load without another model
request. Repeat with a new conversation. The sample command runtime retains
only its last host-issued chat handle and releases that exact lease on explicit
Open; it does not change core expiry, source ownership or duplicate-open guards.

## Native fixture acceptance (parent-scheduled GUI only)

1. Use an isolated synthetic profile, no real Notes, hosts, histories or keys.
   Start `node scripts/plugin-global-agent-provider-fixture.mjs --port 9218`.
   It performs no inference or outbound request and logs no bodies/headers.
2. Through normal host settings, configure an OpenAI-compatible Chat Completions
   provider at `http://127.0.0.1:9218/v1`, model `global-agent-fixture`, with the
   fixture-only literal `FIXTURE_ONLY_API_MARKER`. Do not use real credentials,
   paid services, allowlist edits, debugger injection or the builtin AI sidebar.
3. Install the `.ncpkg` in Settings → Plugins and open its contributed Global
   Agent Chat view. Verify light/dark/accent updates using existing theme tokens.
4. Choose Catty. Choose no targets, or only owned synthetic terminal fixtures,
   then Open conversation. The fixture's default tool is `get_environment`; it
   never requests a terminal command. Record Send → streamed result/usage and
   `GET /fixture/status` counters. This proves a deterministic pipeline, not
   real model inference.
5. Send `fixture:wait`, wait for output, press Stop. Verify aborted count rises
   once and no late text appears. Capture screenshot/video with fixture labels.
6. Exercise Actions Ask using the existing in-app policy dialog: approve and
   deny the scoped environment tool separately. Actions Deny permits model-only
   chat with no tools. Agent-use Deny prevents dispatch. A policy change revokes
   existing handles; reselect/reopen explicitly before another Send.
7. Close/reopen and disable/re-enable only this synthetic plugin. Reselect its
   targets and reopen its owned conversation. History should survive, while the
   private per-open actor ID is fresh. At five-minute expiry, the sample asks for
   explicit reselection and keeps the draft, without resending or renewing scope.
8. Revoke/disable or lock while streaming and verify cleanup/no late events.
   Disconnect/re-own a selected synthetic worker during selection and a turn;
   stale selections must fail instead of binding a replacement connection.

Do not activate a configured real Claude backend in this fixture recipe. Claude
MCP's code/handler boundary is covered with synthetic tests; authenticated service
and genuine CLI acceptance remain unverified and require separately approved
access. Other backends are explicitly unsupported/unavailable. No background
service, blanket OS/Vault access, merge or release is implied.

## Evidence and limits

- Installed Catty path uses actual `AgentRuntime`, driver, main provider admission,
  source policy and worker dispatcher, with JSDOM/in-process plugin transport and
  synthetic workers. It proves selected B dispatch, stream, Stop, revocation and
  history after runtime restart. This is not a native BrowserWindow sandbox test.
- Main/core tests cover source/session/resource substitution, scope expiry,
  approval waits, worker lifecycle, cancellation, late completion, stable source
  budgets, source-isolated history and no key serialization. Filesystem API reads
  cannot access the core history root. Explicitly granted terminal commands still
  have that terminal's native OS authority.
- No GUI ran in this executor. Native screenshots/video and independent runtime
  review remain parent-owned gates. The exact-head CI result must be reported
  separately from focused local evidence.
