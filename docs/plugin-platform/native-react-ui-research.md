# Host-rendered React plugin UI: research and direction

## Goal

Render plugin UI inside Netcatty's own interface, with React authoring and
flexible layout and styling. Plugin code must not execute in the host renderer
or obtain host state or user data merely by rendering a view. Only data entered
in the plugin's own UI, explicitly granted capabilities, and host-provided
non-sensitive environment information may reach a plugin.

## Design status and continuity

This is an unpublished feature. There are no released plugin UI contracts to
preserve. Design one host-drawn UI model: no legacy view fallback, migration
scheme, or dual rendering mode is required. The existing prototype, examples,
and test evidence are retained as the starting point. The replacement is now implemented as a single
host-drawn path. The attached native view, its preload, geometry/focus bridge,
and renderer-selection fields have been removed. Current authoring and limits
are documented in [host-rendered UI](./host-rendered-ui.md).

Existing evidence from the preceding implementation work:

- React state, a controlled text input, custom styles and clicks passed through
  the isolated plugin runtime into a host-owned UI. A test overlay remained above
  the plugin, with no iframe or native child view in the visible host window.
- Seven declared views were exercised through the shared rendering fixture.
  This is not full product verification of seven navigation/lifecycle flows.
- Focused policy tests covered unsafe content, URLs, CSS escapes, bounded data,
  ownership and update ordering. They do not constitute a complete security audit.
- Plugin runtime tests passed (764 passed, 6 skipped), the Electron smoke suite
  passed with its development mode enabled, and the directory package build passed.
- Whole-project TypeScript checking did not pass; the scoped recheck reported no
  errors in the newly introduced rendering files. Do not describe all checks as green.

The evidence above is historical. The current implementation and verification commands are in the host-rendered UI document; proposed capabilities below are not automatically shipped features.

## Prior art

- Obsidian lets plugins construct HTML in application-owned view containers.
  This gives natural stacking and broad flexibility, but plugins can access the
  file system; embedding their code directly in Netcatty's renderer would not
  retain Netcatty's existing isolation.
  https://docs.obsidian.md/Plugins/Getting%20started/Use%20React%20in%20your%20plugin
  https://docs.obsidian.md/Plugins/Vault
- Shopify's MIT-licensed Remote DOM mirrors an isolated UI tree into a host DOM.
  It supports a remote DOM environment and examples using React. Its maintainers
  explicitly explain that a direct receiver is not by itself an adequate
  boundary: untrusted mutations need a separate validation and projection layer.
  The latest core release has configurable element/member restrictions and
  security fixes; they do not remove the need for a host threat model.
  https://github.com/Shopify/remote-dom
  https://github.com/Shopify/remote-dom/discussions/587
  https://github.com/Shopify/remote-dom/releases
- VS Code web extensions use a separate worker with access to workspace files
  through explicit host APIs; their custom webviews are not equivalent to an
  application-owned native view.
  https://code.visualstudio.com/api/extension-guides/web-extensions
  https://code.visualstudio.com/api/extension-guides/webview

## Recommended architecture

1. Keep plugin React execution inside Netcatty's existing isolated, offline
   browser runtime (not an attached or visible webview). A plugin uses familiar
   React/JSX and produces a remote interface tree. The host owns the real DOM and
   controls lifecycle, sizing, focus, navigation and overlays.
2. Validate every incoming mutation against a host-owned schema and a
   per-instance capability, then project it into a dedicated host-controlled
   surface. Do not forward arbitrary element properties, methods, event handlers,
   HTML or URLs. Reject oversized trees, pathological depth, stale instances and
   high-rate updates. Do not treat a third-party receiver as the security boundary.
3. Provide ordinary layout/text/form HTML elements and scoped styling rather
   than a fixed component palette. The application must own the containing
   stacking context and clip output. Stylesheets must be parsed and scoped; deny
   unsafe URL loads, external imports, dangerous element types, navigation and
   escape from the plugin surface. Built-in theme tokens are available, not
   mandatory. Give errors for unsupported constructs instead of silently making
   a view appear successful.
4. Route explicitly supported input, focus and keyboard events back to the same
   live view instance. Events carry only that view's own interaction data; never
   forward unrelated input, terminal output, host secrets or global DOM objects.
   Race, ordering, cancellation, multi-window and cleanup must be verified.
5. Define one host-drawn view contract for every placement. Do not keep the
   attached-browser view as a compatibility path. UI registration grants no data
   capability; host-owned security dialogs must always remain above plugin UI.

## Limitations to make explicit

Fully unrestricted HTML/CSS is incompatible with a strong isolation claim in a
shared DOM: URL-bearing resources can send information out; active elements can
execute or navigate; global selectors and positioning can interfere with trusted
UI. Safe styling can be broad, but is not literally unrestricted. Ordinary React
component libraries that expect direct access to the real DOM, canvas, portals,
measurements or browser globals may need adapters. The initial support matrix must
be tested and published rather than promising full browser compatibility.

The local research package `@remote-dom/react` 1.2.2 declares React 17/18 peer
support, while Netcatty uses React 19. The prototype has since verified a core-only DOM bridge with React 19 for its
basic text input and button flow. Keep that evidence; do not restart the adapter
selection merely because the separate React adapter declares different peers.
Broader third-party component support remains a separate verification task.

## Verification gates

A working end-to-end example must use normal React state, a custom CSS layout,
controlled input and buttons, render in Vault and terminal sidebar, and survive
open/close, splits, tab switching and host dialogs. Security tests must exercise
scripts, unsafe attributes and URLs, CSS imports and escape attempts, global
positioning, host/other-plugin DOM access, network, view and window ownership,
permissions, lock/disable/uninstall, message quotas, crash and late replies.
These are requirements, not claims that the implementation is complete.

## Proposed decisions for the complete design

### Authoring freedom

Expose ordinary layout, text, form and styling primitives. Optional Netcatty
components and theme values are conveniences, never the only way to build a UI.
Do not constrain authors to a fixed collection of cards, forms or buttons.

Support flexible layout, responsive sizing, custom typography, local imagery,
icons and animation as design requirements. The prototype's element allowlist
is an initial safety boundary, not the final product scope. Package images and
fonts need host-validated, package-bound resource handles with type/size limits;
SVG needs an explicit inert subset or sanitized conversion before display.
Never permit an arbitrary resource URL as a shortcut around network permissions.
Use the mounted surface's size for responsive layouts, not just the app window.

Keep plugin CSS inside its surface. Contain positioning and stacking; sanitize
styles before insertion. Shadow DOM helps isolate styles but is not a security
boundary for JavaScript running in the same renderer. Never execute plugin code
in the host renderer or expose host DOM references to it.

### Permanent registration, independent visibility and state

Registration lasts while the plugin is enabled. Closing a sidebar changes its
visibility/layout; it does not unregister the plugin's entry. Users can discover,
select, pin, reorder and split plugin views through the same controls as built-ins.

Separate three concepts: the registered entry, an open view instance, and the
instance's current visibility. Tab switching and hiding should retain instance
state within a bounded suspension policy. Explicitly closing a pane can dispose
its instance without removing the registered entry. Persist layout and the
plugin's own declared state, not arbitrary DOM or snapshots of host user data.

Each instance is bound to its own window, placement and session context. Moving
or reopening a view must not expose another terminal's data. Disabled/uninstalled
plugins lose their entries and active capabilities; locking clears sensitive
rendered content and revokes in-flight operations.

### Dropdowns, dialogs and interaction

In-surface dropdowns can use ordinary plugin styles. For a popup that must extend
beyond its pane, offer a host-owned overlay slot bound to that instance. The plugin
still describes its own content and styling. Netcatty owns anchoring, clipping,
focus return, Escape handling, lifetime and maximum stacking order. No plugin
can overlay trusted permission prompts or supply its own permission approval UI.

Input state cannot be implemented as text-attribute mirroring alone. Define and
test value/checked/selection updates, input composition, keyboard defaults, focus,
labels, accessibility and paste. Send only the target instance's own events;
never global keystrokes, clipboard reads, terminal text or the host document.
Do not expose arbitrary synchronous DOM queries to make a component library work.
Narrow measurements may describe the plugin's own layout only.

### Data protection

Default view creation exposes theme, locale, surface size, and the plugin's own
state and interactions. It grants no access to Vault records, terminal output,
files, passwords, tokens, other plugins or the host clipboard. Gate any optional
data API independently and recheck grants at execution and delivery time.

Scope grants to concrete resources/actions. Prefer host-performed operations and
opaque handles over disclosing secrets. Network authority is separate from data
read authority: granting both can permit exfiltration. User input typed into a
plugin is already disclosed to that plugin; no sandbox can undo that disclosure.

Audit message origin and instance identity, resource loaders, protocol requests,
network egress including WebRTC, host callbacks and package replacement. Bound
CPU, memory, updates and image decoding; isolate failures and permit termination.
A hidden browser runtime is the prototype's execution container, not the visible
UI. Retain it for now rather than replacing a tested path speculatively. Its
full offline and process isolation claims must pass adversarial tests before
settling the execution-container choice. An ordinary Node utility process or
Worker alone is not a sufficient security argument.

### Next validation, without repeating completed work

1. Extend the existing Hello React sample with responsive narrow panes, local
   imagery, a dropdown, a checkbox, a select, Chinese input and focus navigation.
2. Exercise actual Vault/sidebar/tab containers: close/reopen, tab switches,
   split/reorder, restart restoration and separate windows. Verify registration
   persistence separately from live view state.
3. Add hostile-plugin cases for resource URLs, network bypass, stale identities,
   cross-instance access, app lock, disable/uninstall and resource exhaustion.
4. Finalize the public contract from these results, then remove the obsolete
   attached-browser UI path and prototype-only dual-mode routing together.

Steps above are proposed follow-on work, not completed checks. No compatibility
migration or parallel legacy renderer is part of the target design.
