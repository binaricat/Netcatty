# Session Restore

Session restore brings Netcatty back to the user's previous workspace shape on startup without reviving terminal processes or replaying terminal content.

## Current Scope

Implemented behavior:

- Restores terminal tabs, tab order, active tab, workspace split layout, and pane focus metadata.
- Restores terminal sessions and reconnects them automatically.
- Allows the user to manually reconnect if the automatic reconnect fails.
- Optionally restores the last known working directory when a restored terminal reconnects.
- Flushes the lightweight restore payload on page hide / unload using the same sanitizer as normal persistence.

Out of scope:

- Restoring terminal output, scrollback, command history, logs, snapshots, or process state.
- Persisting passwords, passphrases, private keys, or other secret material.
- Restoring mosh / ET / telnet / serial / network-device working directories.
- Probing remote filesystems during startup.

## User-Visible Behavior

### Startup Restore

When "Restore previous terminal tabs and workspace layout" is enabled, Netcatty restores the prior terminal workspace on launch. Restored terminals are marked with `restoreState: "restored-disconnected"` while they reconnect.

After a restored terminal reconnects, it runs the startup command currently configured on its host. Per-session startup commands are not persisted or replayed by session restore.

### Manual Reconnect

If an automatic reconnect fails, the user can reconnect the restored terminal manually through the normal connection flow.

If "Restore terminal working directory on reconnect" is enabled and the restored session has an eligible `lastCwd`, Netcatty sends an automated `cd -- ...` after backend attach. The command is shell-quoted, is not added to application command history, and is attempted at most once for that reconnect.

If the directory is missing, inaccessible, or rejected by the shell, the connection remains open. Netcatty does not clear `lastCwd`, does not retry in a loop, and only shows a non-blocking progress note.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| Restore previous terminal tabs and workspace layout | On | Enables startup restore for tabs, workspaces, layout, and lightweight session metadata. |
| Restore terminal working directory on reconnect | Off | Attempts a one-shot cwd restore when an eligible restored terminal reconnects. |

The cwd setting is intentionally separate because it sends a command after reconnect. Keeping it off by default avoids surprising remote-side behavior.

## Architecture

The implementation follows the project layering from `AGENTS.md`.

### Domain

`domain/sessionRestore.ts` owns pure restore logic:

- Payload sanitization.
- Restore payload construction.
- Workspace tree pruning and allowlisting.
- Session allowlisting.
- Cwd restore eligibility.
- Shell-safe cwd command formatting.

Domain helpers do not read or write storage and do not start terminal runtime work.

### Application State

`application/state/sessionRestoreState.ts` and `application/state/sessionRestoreStorage.ts` own restore state lifecycle and localStorage persistence boundaries.

`application/state/sessionRestoreSettings.ts` and the settings sync modules own restore-related settings defaults, storage, and cross-window sync.

`application/state/useSessionState.ts` wires restore initialization, debounced persistence, pagehide / beforeunload flush, and restored-session reconnect transitions.

### UI And Runtime Glue

UI components display reconnect progress and manual reconnect actions after failures. Terminal runtime helpers start restored sessions through the normal connection flow.

Runtime code may consume a one-shot cwd restore intent after backend attach. A restored connection may run the startup command currently configured on its host, but it must never replay a per-session startup command from persisted restore data.

## Restore Payload Allowlist

The persisted payload is a single allowlisted JSON object. Invalid or stale payloads are sanitized or cleared on read.

### Payload Fields

| Field | Purpose |
| --- | --- |
| `version` | Restore schema version. |
| `savedAt` | Timestamp used for diagnostics and future expiry decisions. |
| `sessions` | Lightweight restored terminal session records. |
| `activeTabId` | Startup tab to select after restore, sanitized against restored tabs. |
| `tabOrder` | Restored top-level tab order. |
| `workspaces` | Restored workspace split layout metadata. |

### Session Fields

Allowed session metadata includes identifiers, display metadata, safe connection descriptors, terminal type, status placeholder state, `lastCwd`, and other lightweight fields needed to render and manually reconnect a session.

The session allowlist may include non-secret metadata such as `serialConfig`, `localShellArgs`, and `localShellIcon` when those fields are needed to rebuild the reconnect entry point. Nested objects must be rebuilt field-by-field. For `serialConfig`, only `path`, `baudRate`, `dataBits`, `stopBits`, `parity`, `flowControl`, `localEcho`, and `lineMode` are restorable.

Enum-like fields such as `protocol` and `shellType` are restored only when they match known supported values.

Always forbidden:

- Terminal output or scrollback.
- Command history.
- SFTP as the active startup tab.
- Startup command payloads copied from live runtime state.
- Process ids, bridge handles, reuse pointers, subscriptions, timers, or runtime object references.
- Passwords, passphrases, private key contents, tokens, or secret environment values.

### Workspace Fields

Workspace restoration allowlists only structural UI metadata:

- Workspace id and label metadata.
- View mode.
- Focused session id.
- Focus session order.
- Snippet id.
- Root split / pane tree fields required to reconstruct layout.

Workspace panes are pruned if they reference sessions outside the same workspace or sessions missing from the restored payload.

## Cwd Restore Eligibility

Eligible by default:

- Local terminal sessions.
- SSH sessions to Unix-like hosts that are not classified as network devices.

Skipped by default:

- Missing or empty `lastCwd`.
- Disabled cwd restore setting.
- Non-restored or already-live sessions.
- Network devices.
- Mosh and Eternal Terminal.
- Telnet and serial sessions.
- Windows-like paths.
- Paths outside the accepted `/...`, `~`, and `~/...` forms.
- `~user/...` paths.

The path check is best-effort. The remote filesystem may have changed, so reconnect must continue even when `cd` fails.

## Safety Boundaries

Startup restore is side-effect free with respect to terminal backends. It may create React UI and visible xterm surfaces for mounted components, but it must not start hidden backend work, network connections, polling loops, or cwd probes.

Persistence uses the same sanitizer for debounced writes and unload flushes. New restore fields must be added through the domain allowlist and covered by tests.

Automatic reconnect remains a separate product decision and requires a new risk review. It would introduce startup-side network activity, authentication prompts, server audit events, connection storms, and retry behavior that this implementation intentionally avoids.

## Verification

The implementation was verified with:

- `npm run lint`
- `npm run build`
- Broad affected test runs covering `application/state`, `domain`, settings components, terminal components, terminal runtime, and terminal layer tests.

Important review finding already fixed:

- Workspace node allowlisting now reconstructs allowed pane / split fields instead of spreading arbitrary node data into the restore payload.
