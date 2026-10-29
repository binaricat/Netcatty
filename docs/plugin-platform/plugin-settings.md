# Host-owned plugin settings

## Product boundary

Ordinary plugin pages retain freely authored layouts and styles, subject to the
existing isolated runtime and host rendering checks. Settings are exclusively
host-owned forms. There is no `settings` custom view location and no render,
HTML, CSS, or callback field in setting declarations. The unpublished platform
has no compatibility path for custom settings pages.

Plugins declare `contributes.settings`: stable ID, localized label/description,
control, scope, default, options, constraints and optionally a localized `group`.
The host groups rows by label in first-appearance order and keeps field order
within each group. Labels/descriptions are plain text. Hidden settings are
filtered before grouping; empty groups are not rendered. Ungrouped fields do not
receive a redundant heading. Layout, controls, focus, error display, reset and
persistence belong to Netcatty. Internal setting IDs are not displayed as help
text. Permissions and uninstall remain separate host-owned controls.

Each of the six ordinary page placements offers the same circular settings
button in its upper-right corner, only when the owning plugin has visible
settings. The plugin list and package detail offer the same entry. Opening it
uses a bounded, centered host dialog above the page; the page remains mounted.
Escape closes only the settings dialog and returns focus to its entry. Forms
always query the settings context, even when opened from Vault or the terminal.
Disabling/removing the owning contribution closes the page entry's dialog.
Package management and permission controls remain in the separate manager.

Text commits on leaving the field; switches and choices commit immediately.
Writes go through the host's existing ownership, scope and validation checks.
Rejected writes show an inline error and do not replace persisted values. Reset
uses the declared default. Secret fields keep their existing secure storage and
never expose their stored plaintext in renderer snapshots. Grouping grants no
extra data access. Plugins use `settings.get` and `settings.onDidChange` for their
own values; no plugin script needs to run to draw or edit this form.

Complex editors and previews belong in ordinary pages. A future settings link
must be a host-rendered, validated reference to that plugin's own declared page;
this change does not add an arbitrary callback/link escape hatch.

## Reference products (reviewed 2026-10-29)

- [Obsidian settings migration guide](https://docs.obsidian.md/plugins/guides/migrate-declarative-settings):
  its 1.13 declarative controls let the app handle rendering, validation,
  persistence and search. We adopt host-owned ordinary controls. We do not adopt
  executable custom render callbacks inside settings or its legacy fallback.
- [VS Code configuration contributions](https://code.visualstudio.com/api/references/contribution-points#contributes.configuration):
  declarations provide types, defaults, descriptions, enums and scopes for a
  shared settings editor. We retain our existing setting ownership and scopes.
- [Joplin setting items](https://joplinapp.org/api/references/plugin_api/interfaces/settingitem.html):
  labels, sections, choices, ranges and secure storage are declared separately
  from plugin page UI. We similarly keep storage and layout separate.

This is a UI restriction as well as a consistency decision. It does not replace
runtime isolation or permission enforcement. We are not adding search, nested
settings pages, or third-party custom setting controls in this change.

## Example and verification

`hello-react-host` 0.2.0 has six custom pages and four persistent host-owned
settings: default name, greeting enabled, accent color and default note.
Grouping is localized; changes propagate to its open pages. The example asks
for access to its own settings only, not host records, files or credentials.

Contract tests reject custom settings placement/markup while accepting ordinary
pages. UI tests cover placement, grouping, saving/reopening, failed writes and
reset. Contribution tests cover localization and persistence without starting
plugin UI. Real Electron coverage checks all six ordinary pages plus persisted
preferences and live setting changes.

Validation for this change: 753 runtime checks passed (6 environment-specific
skips), 92 contract/SDK/CLI checks passed, 23 host-drawn checks passed, and the
real Electron fixture passed all six pages, form editing/reload, rejected writes,
and live preference delivery. The macOS directory package build succeeded.
The repository-wide TypeScript check still reports errors in other files; no
diagnostics were reported for the files changed in this settings work.
