# Terminal Host Management Design

## Summary

Users spend most of their time on terminal and editor work tabs, but currently must return to the Vault to create or fully edit a host. This feature adds host creation and editing directly to the terminal host-tree sidebar while preserving the active terminal session.

The terminal host tree will gain these entry points while keeping the existing toolbar unchanged:

- A root-list empty-area context-menu item that creates a host at the Vault root.
- A group context-menu item that creates a host in that group.
- A host context-menu item that opens the full editor for that host.

Creating a host from an existing host's context menu is intentionally excluded. The existing duplicate action is the unambiguous way to create a host from another host's settings.

## Goals

- Create and edit hosts without navigating away from the current work tab.
- Reuse the existing host editors and Vault persistence behavior.
- Keep active terminal sessions running when their saved host definition changes.
- Make the new actions available from predictable context-menu locations.
- Preserve protocol-specific editing, including serial hosts.

## Non-goals

- Applying changed connection settings to an already-established connection.
- Automatically reconnecting or disconnecting a session after a host is edited.
- Adding a new-host action to an existing host's context menu.
- Replacing the Vault hosts page or its existing editing workflow.
- Refactoring unrelated Vault host-management behavior.

## User Experience

### Creating a host

Right-clicking unused space in the host-list content area opens a root context menu with a `New host` item. It opens the existing host details editor as a right-side overlay and creates an SSH host at the Vault root by default. This remains available when a search or tag filter has no matches.

Right-clicking a group includes an `New host in this group` item. The editor opens with that group preselected and with the group's inherited defaults available to the form.

Saving closes the panel and immediately displays the host in the appropriate visible tree location when it matches the current filters. Canceling or closing the panel discards the draft.

### Editing a host

Right-clicking a host includes an `Edit host` item, distinct from the existing inline rename action. Selecting it opens the full editor populated with the saved host definition.

The editor appears over the right side of the work area. It does not navigate to the Vault, resize the terminal, recreate the terminal, or change the active tab. Only one app-level host editor may be open at a time.

Changing the selected edit target remounts the editor using a stable key derived from the operation and host ID. Draft state from the previous host must not leak into the next form.

### Editing a connected host

Saving a host that currently has an active session updates the persisted Vault definition but leaves every established connection untouched.

- Display metadata, including label, icon, group, tags, and notes, updates in views backed by the saved host definition.
- Connection settings, including hostname, port, username, credentials, proxy settings, and jump hosts, apply only to future connections or a user-initiated reconnect.
- No save path may implicitly stop, reconnect, or replace a terminal session.
- After saving an existing host, a success notification explains that connection-setting changes take effect on the next connection.

## Architecture

### Application state

Introduce a focused application-state controller for the work-surface host editor. It owns:

- Whether the editor is open.
- The editing target, or `null` for a new host.
- The default group for a new host.
- Open-new, open-edit, save, and cancel operations.

The controller receives persistence callbacks and editor dependencies from the existing `App.tsx`/`AppView` composition boundary. UI components do not write directly to local storage.

The save path uses the existing domain-level host upsert behavior. When editing an existing host, it also preserves host fields that may have changed concurrently while the panel was open, following the same protection used by the Vault editor.

### Work-surface editor layer

Add an app-level editor layer alongside the existing terminal host-tree layer in the work-area root. The layer renders only on supported terminal/editor work surfaces and uses the established aside-panel overlay positioning.

The layer selects the existing editor by operation and protocol:

- New hosts use `HostDetailsPanel` and default to SSH.
- Existing non-serial hosts use `HostDetailsPanel`.
- Existing serial hosts use `SerialHostDetailsPanel`.

The layer receives keys, identities, proxy profiles, groups, managed sources, tags, hosts, terminal appearance settings, snippets, and import/update callbacks through the application composition boundary. It must not duplicate the host form.

### Host-tree actions

Extend the terminal host-tree props with explicit new-host and edit-host callbacks. These actions are app-level editing operations and should not depend on forcing focus to the Vault tab.

The existing shared tree-action registry continues to provide rename, duplicate, delete, copy-credentials, grouping, ordering, and managed-source actions. Shared context-menu components may accept optional new/edit handlers so the terminal tree can expose the new commands without changing unrelated consumers.

### Root empty-area menu

The host-tree content region acts as the root context-menu trigger. Nested host and group context menus remain authoritative for row clicks; the root command is shown only when the context-menu event targets unused list space. Drag-and-drop behavior and virtual-list scrolling remain unchanged.

## Data Flow

1. The user invokes a context-menu action in the terminal host tree.
2. The host tree calls the app-level editor controller with either a host or an optional default group.
3. The work-surface editor layer renders the appropriate existing details panel.
4. On save, the controller upserts the host through the existing Vault state update callback.
5. Persisted host state flows back through application props and refreshes the host tree.
6. The editor closes and the active work tab and live sessions remain unchanged.

## Error and Edge Handling

- Existing form validation remains the source of truth for invalid or incomplete host fields.
- Closing or canceling the editor does not mutate persisted hosts.
- If an edited host is deleted elsewhere while the form is open, the editor closes instead of recreating the deleted host on save.
- Creating a group from within the host editor uses the existing custom-group update callback.
- A new host created under an active search or tag filter may not remain visible if it does not match; successful persistence is still confirmed.
- If no Vault tree actions are registered, new/edit callbacks still work because they are passed explicitly from the application layer. Existing registry-backed menu actions retain their current availability behavior.

## Localization

Add translation keys for:

- Root `New host` context-menu item.
- Group `New host in this group` context-menu item.
- Host `Edit host` context-menu item if an existing suitable key is not already shared.
- The saved-host notification explaining that connection settings apply on the next connection.

All shipped locale files must contain the new keys, using an English fallback translation where a native translation is not available.

## Testing

Unit and component coverage should verify:

- The empty-area context menu opens a root-level draft, including for an empty filtered result.
- The group context menu opens a draft with the correct default group and inherited defaults.
- The host context menu opens the full editor for the selected host.
- Switching editor targets does not retain stale draft state.
- Saving creates or updates exactly one host and closes the editor.
- Canceling leaves host persistence unchanged.
- Editing a connected host never calls session close, stop, connect, or reconnect operations.
- Display metadata refreshes from updated host state while connection settings affect future connections only.
- Serial and non-serial hosts select the correct existing editor.
- Existing rename, duplicate, delete, drag/drop, search, filtering, and local-terminal toolbar behavior remain intact.
- Required localization keys exist in every shipped locale.

## Acceptance Criteria

- A user can create a root host by right-clicking unused host-list space.
- A user can create a host in a group from that group's context menu.
- A user can fully edit a host from its terminal-tree context menu.
- New and edit operations stay on the active work tab and use a right-side overlay.
- Saving immediately persists through the existing Vault state boundary.
- Editing an active host does not interrupt its live sessions.
- Connection-setting changes are described as taking effect on the next connection.
- Existing Vault host creation and editing continue to work.
