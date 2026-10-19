# Host-routed browser for issue #2972

Status: terminal sidebar integration in `codex/issue-2972-host-browser`, 2026-10-16.
The macOS sidebar and workspace focus switching have been exercised in the real
app. Electron fixtures verify two independent SSH routes, retained pages,
panel resizing, bookmarks, downloads, and closing without closing the terminal.
Windows/Linux and the remaining network acceptance cases below are not yet
runtime-verified.

## Goal and completion criteria

From a connected SSH terminal, the user opens the Browser tool in the terminal sidebar, alongside SFTP
and Notes. Its context follows the focused terminal in a workspace. All supported page traffic, including access to that host's
`127.0.0.1`, must use the selected host's network path. Loss of that path
stops browsing without switching to a local direct connection. Bookmarks sync
through the existing encrypted cloud-sync payload.

The feature is complete only after a packaged desktop build demonstrates:

1. Remote `127.0.0.1`, remote-only LAN DNS, a public exit-IP endpoint, and
   HTTPS all behave as seen from the selected SSH host.
2. HTTP, HTTPS, WebSocket, redirects, popups, downloads, and background tab
   requests remain on the same route. Requests using an unsupported transport
   are denied rather than sent directly.
3. Disconnect, proxy setup failure, reconnection, host deletion, browser close,
   and app quit leave no direct fallback or orphaned listener.
4. Tabs on two different hosts cannot share network state, cookies, local
   storage, service workers, or `127.0.0.1` data.
5. Bookmarks survive restart and encrypted multi-device sync, including
   simultaneous additions, edits, and deletions on two devices. Browsing
   history, cookies, passwords, open tabs, and local tunnel ports do not sync.
6. The real UI is checked on macOS, Windows, and Linux: opening from a terminal,
   navigation, tabs, focus, resizing, loading/errors, reconnect, and bookmarks.

## Product behavior

### Entry and terminal ownership

- Browser is a normal terminal side-panel tool, alongside SFTP and Notes. It
  participates in the existing nested split layout, position chooser, and
  saved layout presets. Terminal toolbar and host-menu actions open this tool.
- Each terminal keeps its own browser tabs and route. Within a workspace,
  focusing another terminal reveals that terminal's browser context. Returning
  restores its earlier tabs and pages without retargeting their network route.
- Do not show a permanent `Via <host>` badge in the address toolbar. A workspace
  uses the same focused-host heading pattern as other side-panel tools.
- Switching tools or terminal tabs hides the native views and retains pages.
  Closing the whole side panel or its terminal releases its browser views and
  dedicated SSH connections. Renderer menus, dialogs, and magnified panes must
  never be covered by a hidden browser view.

### Terminal links

HTTP(S) links in SSH/Mosh and local terminals open in the Netcatty sidebar by
default. Settings > Terminal > Behavior > Open terminal links in can select the
system default browser instead; the choice applies immediately to existing
terminals. SSH contexts keep the host route; local terminal contexts use an
explicit direct session. A failed SSH route never becomes a local route.
Detached terminal windows forward browser requests to the main window's sidebar.
Other terminal protocols keep their existing system-browser behavior.

### Browsing surface

- The sidebar can be resized or magnified. The trusted top chrome has a tab
  strip, new/close/reorder tab controls, back, forward, reload/stop, one address
  bar and a bookmarks menu. Page title and favicon appear on
  tabs. The start tab is a plain app-icon grid with no duplicate address field.
  It follows the main window's flat tab styling and normal desktop shortcuts.
- Website favicons are fetched through the host route and stored locally by
  host and website. Users can right-click a tab to set an icon image or glyph;
  that override persists until they restore the website icon. Bookmark app
  icons can also use a custom image, which is included in bookmark sync.
- `127.0.0.1:80` or `localhost:80` defaults to HTTP and refers to the SSH host.
  External names default to HTTPS. The address field displays the real page URL
  and the focused terminal determines its host route.
- All page-created tabs and permitted window-open requests stay in this host's
  browser context/profile. External protocols and "open in system browser" need
  an explicit warning that the destination will use the local computer's route.
- While disconnected, show a full-panel error state and a Retry action. Do not
  load cached pages as though the route were connected; stale content, if ever
  shown, needs a separate offline label.

### Bookmarks

- Each item has an id, title, URL, scope (`host` or `all-hosts`), optional
  hostId, display order, and timestamps. The default scope is the current host,
  especially for `localhost` and private addresses. Users can explicitly make
  a public bookmark available from every host.
- The menu has `This host` and `All hosts`, add/edit/delete, and a quick search.
  Bookmark opening always uses the current terminal's host route. A missing host
  reference is shown as unavailable; never silently attach it to another host.
- Sync bookmark metadata as its own id-based payload entity with the same
  merge, deletion, backup/restore, shrink guard, and encrypted provider handling
  as other vault entities. Browser cookies, history, passwords, page content,
  and per-device settings remain local. Host-scoped bookmarks retain the synced
  host id. Old sync payloads treat a missing bookmarks array as legacy absence,
  not as a delete-all operation.

## Network and security model

- The browser chrome is trusted local UI. Each untrusted website is rendered in
  a sandboxed `WebContentsView` with no Node integration, no Netcatty preload,
  and no access to terminal, vault, or plugin bridges. Use an Electron session
  partition separate from the application and separate for each host profile.
  Tabs for one host may share website cookies; different hosts must not.
- The main process owns a `HostBrowserManager` with a small interface:
  openForHost(hostId), create/close/navigate tab, bookmark operations, and
  close host browser. The UI sends intent and receives state. The manager owns
  panel views, tabs, session partitions, route state, and cleanup.
- Use a dedicated, temporary SSH connection for the browser, honoring
  Netcatty's existing host authentication, known-host policy, jump hosts, and
  connection settings. A dynamic SOCKS5 listener binds only to `127.0.0.1` on
  an OS-assigned port. It is not a saved port-forward rule. Expose the actual
  assigned port only inside the main process; close it with the owning browser panel.
- A loopback SOCKS listener is not exclusive to this browser: another local
  process could use it while open, and Chromium does not support SOCKS5 proxy
  authentication. Keep its lifetime short, never bind a public interface,
  and describe this limitation honestly. If exclusive access becomes a product
  requirement, the local listener design must be revisited.
- Before creating any page view, create its isolated session with a dead-end
  proxy and the loopback bypass disabled. After SSH/SOCKS is ready, install a
  single SOCKS5 proxy with no `DIRECT` alternative. Chromium routes names to
  the SOCKS5 side and can proxy `localhost` only when its implicit bypass is
  explicitly removed. On route loss, first prevent new navigation and requests,
  switch to the dead-end proxy, close pooled connections, then close/replace
  the SSH route. Resume only after the new route and proxy are verified.
- The existing dynamic SOCKS implementation is a starting point, not a ready
  browser transport: it currently assumes caller-chosen local ports, parses
  SOCKS messages from single socket chunks, and rejects IPv6 targets. Extract a
  bounded, incremental SOCKS parser/listener shared with saved forwarding;
  support IPv4, hostnames, and IPv6, timeouts, cancellation, and cleanup.
- Allow HTTP(S) and WS(S). Restrict or explicitly deny page capabilities that
  can use a direct route outside the SOCKS TCP path (notably WebRTC/UDP), along
  with unexpected URL schemes and unrestricted device permissions. Downloads
  must use the isolated browser session and a reviewed destination flow.
  Browser-started operations must not call the app's normal Node `fetch`, system
  browser, DNS resolver, or default Electron session.
- SSH encrypts local-computer-to-host transport. Traffic from the SSH host to
  the destination follows that URL's HTTP or HTTPS security; SSH alone does not
  make a remote-to-website HTTP leg encrypted. The product copy must say this
  accurately and must not promise anonymity or unrestricted internet access.

## Existing code seams

- Toolbar: `components/terminal/TerminalToolbar.tsx` and its caller in
  `components/Terminal.tsx`.
- SSH forwarding: `electron/bridges/portForwardingBridge.cjs` and
  `infrastructure/services/portForwardingService.ts`. The saved rule's fixed
  port and persistence model should not own temporary browser routes.
- Isolated web content and fail-closed proxy patterns already exist in
  `electron/plugins/pluginViewHost.cjs`; reuse the principles, not the plugin
  permissions or protocol.
- Sync entity/payload: `domain/sync.ts`, `domain/syncMerge.ts`,
  `application/syncPayload.ts`, and the auto/cloud sync application hooks.
  Existing SFTP global bookmarks live inside settings, but browser bookmarks
  need host scope and per-item conflict/deletion handling.

## Delivery order

1. Network proof in the actual Electron runtime: isolated session, SSH SOCKS5,
   `localhost` through the host, remote DNS, public exit IP, WS(S), disconnect
   kill switch, and packet-capture checks for direct DNS/WebRTC/UDP leakage.
   This is a release gate, not a mock-only test.
2. Browser manager and safe window/tab lifecycle, including page isolation,
   navigation, popups, permissions, downloads, and multi-host separation.
3. Toolbar entry and full browsing UI, with real click-through QA.
4. Bookmark storage and encrypted sync migration/merge; cross-device QA.
5. Packaged smoke tests on all supported desktop platforms and resource cleanup.

Primary references: [Netcatty issue #2972](https://github.com/binaricat/Netcatty/issues/2972),
[Electron web embeds](https://www.electronjs.org/docs/latest/tutorial/web-embeds),
[Electron session proxy](https://www.electronjs.org/docs/latest/api/session),
[Chromium proxy behavior](https://chromium.googlesource.com/chromium/src/+/main/net/docs/proxy.md),
[Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security).
