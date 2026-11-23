# Host-rendered plugin UI

This is the only custom-view rendering model. The platform is unpublished:
there is no HTML-entry fallback, native child view, migration, or parallel UI
contract. Browser plugins can use it without `NETCATTY_PLUGIN_DEV`. Advanced
Node runtimes retain their separate development admission policy.

## Authoring

Declare `id`, `title`, and `location` in `contributes.views`, plus the `views`
permission and an `onView:<id>` activation event. The six custom-page locations are
`vault-page`, `terminal-sidebar`, `tab`, `aside`, `panel`, and `modal`.
Settings use host-owned forms described in [plugin-settings.md](plugin-settings.md);
`settings` is not a custom view location.
The view declaration has no `entry`, `rendering`, or retention flag.

Use ordinary React and a stylesheet:

```tsx
import { registerHostReactView, PluginPopover } from '@netcatty/plugin-sdk/host-react';

export default {
  activate(context) {
    context.subscriptions.add(registerHostReactView(
      context.views, 'com.example.plugin.page', () => <MyPage />, css,
    ));
  },
};
```

Bundle the `host-react` subpath, React, and React DOM into the browser entry.
The root SDK may be bundled or resolved by the runtime's SDK mapping. For plain
JavaScript, `registerHostDomView(views, id, (root, stateScope) => cleanup, css)`
accepts ordinary DOM authoring. The root exists in the isolated runtime;
Netcatty receives validated data and creates the visible elements itself.
Never hand a function, live DOM node, or Electron object to the host.

There is no required component catalogue. Use Grid/Flex, container queries,
custom colors, typography, borders, gradients, transforms and animation.
Seven optional semantic HSL variables follow the host theme: `--background`,
`--foreground`, `--muted`, `--muted-foreground`, `--border`, `--primary`, and
`--primary-foreground`. Author-defined variables use the `--plugin-` prefix.

Controls support text, textarea, checkbox/radio, select/multiselect, buttons,
forms, focus, keys and composition events. Host values stay local while an
interaction awaits its ordered acknowledgement, preventing older updates from
overwriting newer typing. Only events inside the owning surface are forwarded.
Forms cannot navigate or send requests. Clipboard reads are not exposed by this
UI interface; a normal paste into the plugin's own input is user-provided data.

`<img src="asset:images/mark.svg" alt="Mark" />` loads an image only from that
installed plugin's verified package. The host checks path containment, size and
format, rejects SVG resource references, and converts the image to PNG in an
isolated decoder. Raw SVG never enters the host document. Source limit: 512 KiB;
output edge: 2048 pixels; output size: 4 MiB. Per instance: 32 resource paths and
8 MiB of returned data. Network URLs, arbitrary data URLs and CSS URL loads are
rejected. Use installed system fonts; packaged font files and canvas are not
part of the current supported surface.

For a menu that extends beyond a pane, use `PluginPopover` with an anchor element
ID, `open`, and `onClose`. Its children are freely authored UI. Netcatty positions
and clips it, handles outside click and Escape, restores anchor focus, and keeps
it below trusted host dialogs. Only the originating view's anchor can be used.
Nested popovers are not supported. Ordinary menus contained inside the surface
can be styled without this helper. Libraries that depend on real host DOM
measurements, arbitrary portals, browser navigation, canvas or active elements
need adaptation; ordinary React support does not mean every browser library works.

## Lifecycle and navigation

Enabled contributions remain registered independently of visible panes.
Terminal sidebar pages participate in built-in ordering, overflow, customization,
focus and splits. Closing the whole sidebar does not delete their entries.
Vault and tabs use the same rounded content surface as built-in pages.

Each window retains at most 16 UI instances. Hiding or switching a page reuses
its instance and React state for up to five idle minutes; unused instances may
be evicted sooner to admit a new view. Explicit tab/overlay close disposes its
instance. Persistent state uses `context.views.getState/setState(viewId,
stateScope, ...)`, with the opaque `stateScope` supplied to a DOM mount. This
stores only the plugin's own data, not host records or credentials. State scopes
separate placements and terminal sessions but are not an authorization boundary
against other code in the same plugin.

The main process binds each instance to its actual owner window and exact
plugin/runtime version. Close during activation, owner navigation/crash, plugin
disable/replacement/uninstall, runtime failure and App Lock invalidate it.
Late updates, image results and events cannot revive a closed instance.
Another window cannot send events, load resources or close it. The renderer's
cache is not the authority for these checks.

## Security boundaries

Plugin JavaScript runs only in the existing offline sandbox runtime, without
Node or the host application bridge. Its private session permits its own package
and SDK modules; browser networking, WebRTC direct UDP, navigation, downloads,
frames and device permissions are blocked. Privileged operations still pass
through the existing permission services. The `views` permission grants no
host, terminal, file, network, secret or model access.

Incoming updates pass schema, sequencing, rate, mutation and CSS checks in the
main process, then a complete data-tree validation before rendering. Limits:
1024 nodes, depth 24, 128 KiB text/attributes, 2048 mutations and 256 KiB per
batch, 64 KiB CSS, 120 updates per second. Invalid data closes the view.
Scripts, handlers, executable/custom elements, unsafe attributes, URL loads,
imports, host selectors and escaping positioning are denied. Closed Shadow DOM
separates styling; clipping and stacking contain output. Neither is relied on
as a JavaScript isolation boundary.

No system can promise that every arbitrary plugin is harmless. User-supplied
text in a plugin belongs to that plugin, and explicitly authorized capabilities
can provide additional data. Isolation and quotas reduce the available attack
surface; they do not certify third-party code or all future browser versions.

## Examples and checks

`hello-react-host` exercises all six custom-page locations, text and Chinese input,
checkbox/select/textarea updates, package images and a custom menu. Build with
`npm run build:plugin-view-examples`. Plain DOM examples, including Hello World 2,
starter, scratchpads and assistants, use the same host renderer.

- `npm run test:plugin-contract`: package and public contract.
- `npm run test:plugin-host-drawn`: tree/style policy, ownership, state retention,
  resource checks and real Vault/sidebar navigation components.
- `npm run test:plugin-runtime`: runtime, permissions, package and host services.
- `NETCATTY_PLUGIN_DEV=1 npm run test:plugin-runtime:electron`: browser and advanced
  runtime smoke tests, including local HTTP/UDP isolation probes.
- Start Vite on port 5182, then run `npm run test:plugin-host-drawn:electron` and
  `electron electron/plugins/helloWorldV2.live.test.cjs`: installed examples and
  actual host DOM interactions. These use dedicated disposable profiles.
- `npm run pack:dir`: verify runtime dependencies and production resources.

The custom-page fixture exercises the shared rendering implementation;
Vault/sidebar component tests exercise their actual routing and split logic.
This is not a claim that every manual navigation flow, third-party component
library or malicious plugin has been exhaustively verified.

## Verification record (2026-10-29)

- Installed and enabled the locally built `hello-react-host.ncpkg` through the
  actual development application's Settings UI. Vault showed the shared rounded
  surface; reset, greeting, image and theme rendering worked.
- In a local terminal, opened the contributed sidebar, filled its controls,
  closed the whole sidebar, then reopened it through the built-in shortcut.
  The tool entry and previously entered values remained. The custom menu action
  updated the greeting and closed the menu.
- The real Electron rendering fixture passed the then-seven view declarations (settings is now host-owned),
  controls and Chinese composition, package images, Escape dismissal, retained
  state after unmount/remount, trusted-dialog dismissal and a host-only input
  canary that was never forwarded. The DOM-example fixture passed 12 views.
- Runtime suite: 752 passed, 6 environment-specific tests skipped; focused
  host-rendered UI suite: 23 passed. Public-contract suite: 91 passed, generated
  contract check passed. Additional assistant command/adapter checks and the
  global-agent layout fixture passed. The real sandbox suite passed its HTTP
  and UDP probes.
- `npm run lint`: zero errors and eight existing warnings. `npm run pack:dir`
  passed; the produced archive contains the new host, validators and CSS parser,
  and excludes the removed native plugin view host.
- Whole-project `tsc --noEmit` still fails on existing unrelated errors. In the
  changed production files, the remaining reported error is the unchanged SFTP
  context assignment in `TerminalLayerSidePanelSection.tsx`; the newly added
  host-rendering modules have no reported errors. This does not turn the whole
  project check into a passing check.
