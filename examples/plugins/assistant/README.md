# Selected Note Assistant

A minimal browser plugin that uses Netcatty's selected configured model and one
explicitly selected reference. It provides Send, streamed text, Stop, and usage.
It has no tools, terminal commands, direct network access, Node runtime, or storage.

The page follows light/dark mode and accent updates through the existing
host-inherited public HSL theme tokens.
Missing tokens fall back to the standard sample palettes. Its theme subscription
is disposed on page hide and restored on page show.

An expired chat is reopened before the next explicit Send. If the configured
model changes or a request fails, use **Refresh model** to reopen the session,
then click **Send** yourself. Refresh keeps your draft and never retries model
inference. If a request failed after reaching the provider, check its outcome
before choosing to send it again.

Selected references expire too. If a selected Note expires or changes, click
**Choose reference**, confirm the Note in Netcatty, and select its fresh reference
in the dropdown before clicking **Send**. Refresh model does not share a Note
again. Re-selection keeps your draft and does not read content or run inference;
the new reference still requires its own content permission and text review.

The host must support `ai.model-invocation` and `context.selected-read`, with the
trusted renderer adapter connected. AI invocation, selected-summary enumeration,
and selected-content reading have separate optional permissions. The host shows
the exact selected text for review before the plugin or model receives it.
A menu or command ID grants no authority over a resource.

Build the six-file staging directory with `node build.mjs`, then pack `.package`
with Netcatty's plugin CLI. Build scripts are not included in the installed package.
The plugin uses only the canonical `context.ai` and `context.selectedContext` SDK
methods through its own declared view commands. No chat history is persisted.

For isolated QA, use the deterministic loopback provider and synthetic Note recipe
in `docs/plugin-platform/assistant-native-qa.md` in the Netcatty repository. Fixture
QA performs no model inference or paid API call. Native acceptance and the remaining
independent review are separate requirements.

## Current UI build

The page now uses the host-rendered contract. Run `node build.mjs` in this
example directory, then package `.package/` with the plugin CLI. `host.js`
registers ordinary DOM views; `view.html` and `view.css` are bundled source
templates. Theme values are inherited from Netcatty. There is no separate page
preload or `window.netcattyView` API. See `docs/plugin-platform/host-rendered-ui.md`.
