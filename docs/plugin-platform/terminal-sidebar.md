# Terminal sidebar pages

The `terminal-sidebar` view location requires `views.terminal-sidebar` and the
existing `views` permission. This adds navigation and plugin-owned content to
the existing terminal pane/split system. It is not a session-data capability,
Provider subscription, terminal history reader or command execution API.

## Host-owned navigation

Visible plugin pages also have persistent entries in the side-panel toolbar,
alongside built-in tools. They support the same ordering, overflow and
show/hide customization, and reappear after closing and reopening the panel.
Unavailable contributions are hidden without discarding their saved placement.
The Extension pages menu in the terminal toolbar remains another entry point.
Selecting a page switches the existing focused pane;
selecting an already-open tool focuses that pane. Existing split menus include
the same contributions and enforce unique tools and the eight-pane limit.
Host-generated `plugin-view:<namespaced-view-id>` keys cannot replace built-in
tools. Declared order and ID determine listing order; existing host docking,
split resizing, magnification and close controls remain authoritative.

The manager's internal Open event can select a page only when an open terminal
is already selected. Otherwise the host asks the user to select a terminal; it
does not connect or open a saved host. Launcher events target the session from
the actual host terminal toolbar and are rechecked against current selection.
These are internal host UI events, not public SDK router methods or trusted
plugin `userGesture` flags.

## Session ownership without data sharing

The renderer binds each page to the actual terminal tab/workspace and current
focused child session. It passes only `netcatty.surface: terminal-sidebar` as
the view context. Internal ownership IDs are used for host state scoping, not
returned to the page or treated as resource grants. A future selected-session
data API must establish its own live endpoint authority and permissions.

Changing terminal tabs or focused sessions releases the visible surface and
retains its own logical instance within the bounded cache. Reopening uses the
matching window/placement/session scope. Pane close changes layout; enabled
plugin entries remain available. Disable/update/uninstall or runtime loss
invalidate the affected instances immediately.

PersistentSidePanelPortal moves the host DOM surface between its actual pane,
magnification host and hidden parking host. Layout and focus follow the existing
host pane system; no native geometry or focus bridge is needed. Host dialogs
appear above the content. Plugin menus use host-owned overlay placement and
are dismissed when a trusted modal appears.

See [host-rendered UI](./host-rendered-ui.md) for authoring, state limits and
security boundaries. The `session-scratchpad`, `hello-world-v2` and
`hello-react-host` examples use this placement. Component tests exercise the
real split tree, toolbar ordering, portal relocation, session switching and
withdrawal. The Electron examples exercise visible controls through the shared
host surface. Neither registration nor state retention grants session access.
