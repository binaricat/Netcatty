# Plugin UI contributions

Status: unpublished plugin platform; host-rendered browser views enabled in normal Settings

Phase 4 of [#2269](https://github.com/binaricat/Netcatty/issues/2269)
connects the manifest contribution contract to Netcatty's native UI and to a
separate sandbox for fully custom views. It does not expose Electron IPC, React
components, the main document, or a browser network stack to plugin code.

## Activation and ownership

Enabled plugins are not started merely because they contribute UI. The host
starts `onStartupFinished` plugins during contribution initialization and
otherwise activates a runtime when one of its declared commands, views, or
Providers is first used. `onCommand:`, `onView:`, and `onProvider:` therefore
share one idempotent supervisor boundary. Contribution IDs must begin with the
owning plugin ID. Plugin-created Context Keys use the exact owning plugin ID
followed by one local key segment; nested dot segments are rejected so plugin
IDs that share a prefix cannot claim each other's UI state.

The Provider seam also exposes an immutable, localized enumeration independent
of database internals and returns the current runtime identity after lazy
activation. PR 5 can therefore build and retire terminal Provider registries
without importing package-storage structures or guessing which activation owns
an in-flight request.

Disabling, replacing, or uninstalling a plugin first removes its contribution
surface and closes its custom views, then stops the runtime. Background work
lives in the runtime, not in a view, so closing one view does not stop an
otherwise active plugin.

## Native settings

Settings are always host-rendered forms. Plugins cannot contribute custom HTML,
CSS or executable renderers here. Optional localized `group` labels organize
fields in declaration order. See [plugin-settings.md](plugin-settings.md).

Netcatty renders setting declarations with host-owned controls. The supported
controls are switches, radio/select/multiselect, text and password fields,
textarea, number and slider, color, font, file and directory paths, keybindings,
lists, and tables. The main process validates every write against the declared
control, options, numeric range, text pattern, and structured value schema. The
package validator applies the same constraints to declared defaults before a
plugin can install.

Plugin patterns use a deliberately restricted regular-expression subset:
lookarounds, backreferences, and quantified groups are rejected, and patterned
input has a small independent length limit. List and table values use a bounded
JSON Schema subset with explicit types, bounded arrays/strings/numbers, closed
object properties, `required`, `enum`, and `const`. `$ref`, `pattern`, custom
formats, conditionals, unevaluated properties, and executable extensions are
not accepted.

Application, device, workspace, host, and session values are keyed separately.
The central settings surface receives a bounded, host-owned catalog of current
devices, workspaces, hosts, and sessions and requires the user to select an
explicit target before editing a contextual value. It never reads or writes an
ambiguous record. Each main window owns its catalog contribution; the host
merges those contributions for the standalone settings window and withdraws a
window's targets when its renderer closes. Font settings use the host font
picker, while list and table settings use recursive schema-driven native
controls rather than editable JSON. Settings and restored view state are
user-owned records with no foreign-key
cascade to installed package versions, so uninstall does not erase them. The
platform is unreleased, so both tables are part of the complete schema at
`user_version = 1`; there is no migration chain.

Secret settings never enter the settings table or a renderer snapshot. The
host stores plaintext only through the phase-3 safeStorage-backed secret store,
shows a configured indicator, and exposes an opaque `SecretRef` to the owning
runtime. Only non-secret fields explicitly declaring `sync: true` enter the
encrypted sidecar sync path (PR 8).

## Commands, menus, and Context Keys

Commands are registered in the plugin runtime after activation and invoked
through the host's validated `plugin.command.execute` request. A plugin runtime
or custom view may execute only commands owned by the same plugin. The native
host provides command-palette, application-menu, host-context, terminal-context,
terminal-toolbar, and status-bar placements. Visibility, enablement, and checked
state are computed by the host before rendering; plugin HTML is never inserted
into a native menu or the React tree.

Theme icons are resolved through a fixed host icon catalog. Package image icons
must be declared by the currently active manifest, pass package-integrity and
realpath containment checks, and pass byte, format, and dimension preflight
before any image decoder sees plugin bytes. Decoding and resizing run through a
bounded queue of disposable sandboxed renderer workers; only the resulting
small PNG data URL reaches a Netcatty renderer or native application menu.
ViewBox-only SVGs receive their inspected viewport inside that isolated worker,
so common declarative SVG icons remain usable without trusting intrinsic
decoder dimensions.

Context Key expressions use a bounded parser for literals, namespaced keys,
parentheses, `!`, `&&`, `||`, equality/ordering, `in`, and `not in`. There is no
JavaScript evaluation. Invalid, oversized, or over-complex expressions evaluate
to false. Plugin runtimes may update only one-segment keys in their own exact
namespace.

Platform keybindings are resolved by Netcatty and ignored while the user is
typing in an input, textarea, select, any contenteditable or textbox role, or a
Monaco editor surface. Command enablement is rechecked in the main process, and
renderer snapshots fail closed immediately when their host context changes, so
stale UI cannot execute a context-gated action. Menu placements display the
first active platform binding unless the manifest suppresses it, and holding Alt
selects the declared same-plugin alternate command. Application-menu
accelerators pass through a strict bounded parser before reaching Electron.

Terminal context-menu, toolbar, status-bar, and active-terminal keybinding
invocations receive host-owned `terminal.sessionId`, `terminal.status`,
`host.id`, `host.protocol`, and, when applicable, `workspace.id` Context Keys.
Toolbar and status-bar placements are evaluated against their own surface
contexts rather than sharing one renderer snapshot context. This gives the PR 5
Terminal Provider layer a stable session identity without exposing xterm or
allowing renderer-supplied plugin keys to override runtime-owned Context Keys.

## Host-rendered custom views

All custom views use the [host-rendered UI contract](./host-rendered-ui.md).
Plugins author ordinary React or DOM and CSS in the isolated runtime. Netcatty
validates and draws their content in the same DOM as its own UI. There is no
visible browser surface, HTML entry document, or legacy renderer selection.

The host owns placement, registration, retention, overlays and window identity.
Commands, settings and privileged capabilities keep their existing permission
boundaries. The linked contract documents authoring, supported controls,
resources, quotas, cleanup and current limitations.

## Themes, localization, and accessibility

Localized manifest text is resolved by exact locale, language base, English,
default, then the first declared value. Native contribution labels are plain
text. A localized snapshot refresh preserves the existing owner-bound view and
native tab while labels reload; host-context changes still fail closed
synchronously for context-gated actions and views, while native tab-catalog
mutation waits for the matching query to finish. Open custom views receive
locale, light/dark/system theme identity,
host-owned CSS color tokens, reduced-motion preference, forced/high-contrast
preference, and subsequent environment changes. Theme-token mutations and
accessibility media-query changes are observed while the host is open, rather
than only at initial view creation. Netcatty retains the accessible
name and close control around every custom view; modal placements use dialog
semantics, while aside, panel, and tab placements use named regions.

## SDK surface

`PluginContext` now provides:

- `settings.get`, `settings.update`, and `settings.onDidChange`;
- `commands.registerCommand` and same-plugin `commands.executeCommand`;
- `contextKeys.set`;
- view message/state methods; and
- current locale/theme/accessibility values plus `environment.onDidChange`.

These methods remain JSON-RPC control-plane operations. Terminal hot-path data
is intentionally deferred to PRs 5 and 6.
