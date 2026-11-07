# Test the selected Note assistant on an isolated desktop

For the permission-policy/AI acceptance candidate, first use
[its integration record](policy-ai-integration.md) and exact package manifest.
The older permission-dialog sequence below is historical baseline evidence;
apply the current Allow/Ask/Deny semantics when testing the new candidate.

This recipe tests a sandbox plugin against a deterministic loopback provider.
The provider does not run a model or contact a paid service. The profile contains
only synthetic data. The parent owns native screenshots and video on the working
cloud GUI machine. The local executor's sandbox-helper failure remains a separate
failed launch record.

## Prepare the integrated head

Use a head containing the market source API, #3985's malformed-context repair,
#3986, and the transport task's canonical AI/context registration. Record the exact
commit and artifact hashes. Keep all PRs Draft. Do not merge or release them.

Run the build and tests with the repository's supported Node version:

```sh
git rev-parse HEAD
npm run build
npm run build:plugin-runtime-deps
node examples/plugins/assistant/build.mjs
node packages/plugin-cli/dist/cli.js pack examples/plugins/assistant/.package --out /tmp/assistant-example.ncpkg
node packages/plugin-cli/dist/cli.js validate /tmp/assistant-example.ncpkg
sha256sum /tmp/assistant-example.ncpkg
```

The package contains six files: its manifest, README, three panel files, and one
browser runtime entry. It has no Node entry, networking, filesystem, secrets,
storage, terminal, or command-execution permission. Its `commands` permission
registers its own view callbacks. It cannot execute terminal commands.
The six-file artifact at this checkpoint has SHA-256
`7943d4c3800914fe0acd3d0f3a3d7f7c1910c212a5dc58a044871a6a82485274`.
This replaces the earlier `c7d784d5...` artifact with the sample-only appearance
update. The host provider cold-start correction remains a separate app change.

## Start the deterministic fixture

Start `node scripts/plugin-assistant-provider-fixture.mjs` from the repository.
The server prints its loopback URL. It listens only on `127.0.0.1`; use a fresh
unused port. Its response is fixed synthetic text, split into delayed SSE chunks.
The response includes fixed usage metadata. It accepts no request tools or system
messages. It keeps only request counts and prints no request content or headers.

Launch the exact integrated app on the working desktop with a fresh disposable
user-data directory. Preserve Chromium sandboxing. Do not use a real app profile,
cloud account, credential, host, Note, or chat history.

On that working desktop, use a separate shell for each long-running process:

```sh
node scripts/plugin-assistant-provider-fixture.mjs --port 9217
```

```sh
netcattyAssistantQaProfile=$(mktemp -d /tmp/netcatty-assistant-qa.XXXXXX)
env -u ELECTRON_RUN_AS_NODE node node_modules/electron/cli.js . --user-data-dir="$netcattyAssistantQaProfile"
```

The fixture's counts are available from `http://127.0.0.1:9217/fixture/status`.
Use a different unused loopback port if 9217 is occupied and update the provider
URL accordingly. These launch commands are for the working GUI machine; they do
not override this executor's failed sandbox-helper check.

In AI Settings, create a custom OpenAI-compatible provider with the fixture's
`/v1` URL, model `deterministic-fixture`, and the literal synthetic credential marker
`fixture-only`. This marker exercises the existing credential injection path
without a real API credential. Select that
provider and model through the host UI. Do not enable an external Agent or tools.

Create one Note named `Synthetic retry plan` containing:

```text
Synthetic retry plan: add a retry button and show a connection status label.
```

## Record the installed-plugin path

1. Import the package. Record its ID `com.netcatty.assistant`, version `0.1.0`,
   source, SHA-256, browser runtime, required permissions, and optional permissions.
   Installation must not grant optional access. Source labels do not imply that
   an author or package is officially maintained.
2. Enable the plugin and open its `Selected Note Assistant` modal from the plugin
   view catalog. Allow only its required view and command registration permissions.
3. Grant `ai.invoke` and `context.selected.list` when the host prompts. Record the
   host-selected model label. The host's Note chooser must show app-owned chrome.
   Verify the native plugin modal yields while this chooser is open and restores
   after dismissal; the plugin must not cover the host's selection controls.
   Select only `Synthetic retry plan` and click **Share selected summaries**.
4. Verify that the plugin reference dropdown starts at **No reference**. Select
   `Synthetic retry plan` explicitly, then click **Send**.
5. Deny `context.selected.read`. No fixture request may be sent. The optional
   model permission must not authorize Note access.
6. Retry. Allow the single selected-context read. The separate host text dialog
   must show the exact synthetic text, scope, and version, with **Cancel** selected
   by default. Cancel once and confirm that no fixture request is sent.
7. Retry and click **Share this text**. Record streamed text, completion, and token
   usage. Capture the full host window, not only the plugin iframe.
8. Click **Send** again, share the same synthetic text, and click **Stop** while
   the delayed fixture is streaming. The text must stop changing; the fixture's
   aborted-connection counter must increase. Record this sequence as video.
9. Change the Note during a pending review and attempt to share the old dialog.
   The expected-version check must reject the result. Do not send stale content.
10. Revoke the plugin's AI/context permission while a turn is active. Disable,
    re-enable, and close its view. Old handles and late results must not resume.
    Lock/unlock the app and navigate or reload the main window in the isolated
    profile. Record a fresh successful run after reauthorization.
11. Keep the fixture request counter and aborted-connection counter in the
    evidence. Do not include prompt bodies, headers, credentials, or Note content
    other than the synthetic text above in logs.
12. Type a synthetic draft and click **Refresh model** while idle. The model
    session must reopen, the draft must remain, and the fixture request count
    must not increase. Change the selected configured model in host Settings,
    refresh again, and check the displayed model before explicitly sending.
    Refresh and failed requests must never automatically resend inference.
13. Keep a selected synthetic Note until its five-minute handle expires. Send
    must explain that the reference expired without reading text or calling the
    fixture. Refresh model must not share the Note again. Click **Choose
    reference**, confirm the Note in the host chooser, select its fresh reference
    in the dropdown, and click Send yourself. Deny the fresh content permission
    once and cancel text review once before allowing a successful fixture run.
    The draft must survive all steps, and no request may be silently retried.
14. With the sample idle, switch the host between light and dark and change its
    accent. The page, controls, muted surfaces, text, focus ring, and Send button
    must follow the existing view environment tokens without model requests or
    new permission prompts. Capture both appearances on the same host window.
    This check does not change or bypass the separately owned permission policy.

The expiry regression in `scripts/plugin-assistant-panel.test.cjs` controls the
panel and actual host service/selected-context authority clocks and advances past
300,000 ms using a real selected Note handle, without network calls. It checks
fresh host selection, old-handle rejection, independent content permission and
exact-text review, and a successful explicit send. The broker budget
regression controls its clock across runtime replacement and the minute boundary.
Do not change the host clock or production limits to reproduce those cases in
native QA.

The automated suites cover source substitution, runtime identity, two-handle
revocation after malformed input, late replies, byte/token/time bounds, and
no-key serialization. Native execution must still verify the real prompts,
installed runtime, configured provider transport, and UI lifecycle.

## Record remaining limits

Independent review found the malformed-context revocation bug. The regression
reproduced and the repair passed focused tests. Further review was initially
blocked; after newer exact maintainer security-task evidence, the same worker
completed its bounded read-only review at `173ef5abb`, with no repeated restriction
or alternate route/model. Two additional P2 findings were reproduced and repaired
in `ee5a4a406` (stable source budgets) and `e1cb95ee8` (sample session recovery).
Correction review independently confirmed the stable source-budget fix, then
identified the remaining selected-Note expiry path at `07eb68c5e`. Commit
`9e7c9df58` repairs that path with explicit reference re-selection and fresh
handles after host confirmation. The real-Note panel and service regressions
failed before repair and pass afterward. Independent verification of this latest
correction remains pending. CI and native evidence do not replace it.
