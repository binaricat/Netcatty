# Embedded plugin UI feasibility

> Research only. The user subsequently clarified that plugin UI must be drawn
> by Netcatty, not displayed in an embedded frame. See
> [host-rendered React UI research](./native-react-ui-research.md).

## Goal

Allow ordinary React, HTML and CSS inside the application's normal stacking
order while keeping the existing plugin permissions and offline-by-default
execution boundary. The plugin must not gain access to the host document,
privileged preload, other plugins, files, the network, or navigation simply
because it can render a view.

## Evidence from the current runtime

`electron/plugins/embeddedFrameSecurity.live.test.cjs` is an isolated Electron
proof, not a product implementation. Run it with:

```
./node_modules/.bin/electron electron/plugins/embeddedFrameSecurity.live.test.cjs
```

On Electron 42.11.12 (Chromium 148.0.7778.280), a frame with `sandbox=allow-scripts`,
a restrictive CSP and no Node integration could not read its parent or local
storage. A host overlay appeared above it. Fetch and image requests were blocked,
and `will-frame-navigate` stopped an attempted navigation. The same frame could
still send UDP packets to a local STUN endpoint with `RTCPeerConnection`: in
one run three packets arrived. This proves that the prototype's CSP and frame
sandbox do not reproduce the existing offline-session boundary.

`Connection-Allowlist: (); webrtc=block` did not prevent those packets on this
Chromium build, even when the experimental `ConnectionAllowlists` switch was
supplied. Chrome's official announcement says the header is introduced in Chrome
152; it must not be assumed to protect the current Electron version. A future
upgrade still requires adversarial verification for every supported platform.

- https://developer.chrome.com/blog/connection-allowlist-announcement
- https://www.electronjs.org/docs/latest/tutorial/web-embeds
- https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe

## Required work before adoption

1. Enforce and independently test per-plugin network isolation, including
   WebRTC, WebTransport, navigation, redirects, downloads, workers, DNS and
   browser APIs. A JavaScript shim or CSP alone is not a security boundary.
2. Register packaged assets in the actual owner session without exposing host
   assets or another plugin's package. Test opaque-origin module loading, CSS,
   local images and fonts, and reject navigation away from the registered view.
3. Ensure no child frame receives privileged preloads or can call trusted IPC;
   validate both the actual sender frame and ownership on every operation.
4. Use a dedicated bounded message channel tied to a live instance and owner;
   reject cross-window, stale, replayed and unauthorized requests, and close on
   lock, disable, unload, crash, navigation and window shutdown.
5. Preserve view state, themes, accessibility, focus, shortcuts and layout
   across Vault, terminal sidebar, tab, modal, panel, aside and settings.
6. Add a real React example and verify host menus and dialogs overlap it without
   hiding the page. Run isolation tests and interaction tests on all supported OSes.

Do not enable this as a general plugin surface until these conditions pass.
The current `WebContentsView` path remains active meanwhile. Alternative designs
include a host-rendered protocol with isolated React logic; that can retain the
existing offline runtime, but needs a substantial compatibility layer for
ordinary React DOM libraries and truly free-form CSS.
