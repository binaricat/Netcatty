# Host color theme packs

Theme packs contribute validated light and dark host colors. They cannot inject
CSS, access host DOM, change layout, load remote resources, replace security
controls, or apply themselves. The feature is `appearance.theme-packs`.

## Install and select

Use normal Settings > Plugins to install and enable a package. In Appearance,
choose a plugin theme for the current light or dark mode, then select Preview or
Apply. Preview changes only the current window and writes no preference. Cancel,
closing Appearance, changing mode, package withdrawal, or a newer committed
revision ends that preview. Apply saves a host-owned, device-local choice and
refreshes other application windows. Restore default clears the plugin choice
for that mode and selects Snow or Midnight. Selecting a built-in swatch also
clears that mode's plugin choice. Failures remain visible and are not reported as
successful applications.

The current view environment is globally broadcast. To keep temporary previews
local, it publishes **committed** theme tokens only. Plugin pages follow an
applied theme through their existing environment subscription; they do not
receive another window's temporary preview. This does not add an owner-local
view environment API.

## Data-only package

A pure theme uses `main: { "data": "theme" }`, contributes only `themes`, and
omits permissions, activation events and companions. Its code runtime is never
started, including by the runtime supervisor's startup or explicit-start path.
Browser code plugins may also declare themes; choosing a theme does not start a
runtime or grant their functional permissions. Only enabled packages appear.

```json
{
  "features": { "required": ["appearance.theme-packs"] },
  "main": { "data": "theme" },
  "contributes": {
    "themes": [{
      "id": "com.example.colors.forest",
      "label": "Forest",
      "variant": "light",
      "entry": "forest.json"
    }]
  }
}
```

This fragment belongs in an otherwise complete manifest. Contribution IDs use
the package namespace. Palette paths are package-relative JSON files, included
and checked by the normal CLI/package store. Hosts lacking the required feature
reject compatibility deterministically.

```json
{ "formatVersion": 1, "base": "light", "colors": { "accent": "#166534" } }
```

Colors merge onto a fixed accessible light/dark host base. Only opaque `#RRGGBB`
values and canonical semantic keys are accepted. The 15 editable keys cover
background/foreground, card and popover pairs, secondary and muted pairs, accent,
destructive and its foreground, border and input. Primary, ring and the accent
foregrounds are derived together, matching the existing theme conversion.
Nineteen output fields are not nineteen independent controls.

Each package has at most 32 themes; each palette is at most 64 KiB; the catalog
and validated cache contain at most 256 entries. Schema and contrast checks run
before catalog publication. Text pairs and state colors require at least 4.5:1;
control borders and focus information require at least 3:1 against their
surfaces. Invalid palettes produce bounded, content-free diagnostics and cannot
be previewed or applied. Files are read from verified immutable package roots,
with bounded reads and a no-follow final file open.

## Ownership, recovery and security appearance

The host stores selections separately from plugin KV, settings sidecars and
cloud sync. A reference binds plugin ID, theme ID, exact version, archive digest
and variant. Application uses a revision check plus an active-package check just
before the atomic preference/audit transaction. An audit write failure rolls
back the selection. Audit records contain revision/action metadata, not palette
or user content.

Disable, uninstall, update, missing entries and integrity failures withdraw the
palette. A saved missing reference remains visible as unavailable while the
same-mode safe host palette is used; a changed package is not automatically
applied. Preview owner and committed revision checks prevent a late cancellation
from replacing another preview or a newer application.

Host dialogs, App Lock, grant/revoke, host details, keychain panels, host-key
prompts and the credential picker use fixed host security variables while a
plugin theme is active. The pack controls no font, icon, opacity, CSS selector,
button text or ordering. System forced-colors/high-contrast preferences use a
fixed host high-contrast fallback. Personal accent, fonts, terminal choices and
accessibility preferences retain their authority. Existing personal custom CSS
remains a user setting and is not exposed to plugins.

This first layer changes host semantic colors. Static terminal palette linkage,
custom high-contrast variants, fonts, density, icons and backgrounds remain
separate bounded follow-ups; their fields are not silently accepted here.

## Example and validation

`examples/plugins/forest-theme-pack` is a four-file data package with light and
dark Forest accents. It requests no permissions and contains no JavaScript.
The starter, Vault Scratchpad and Session Scratchpad pages now subscribe to the
existing seven public HSL tokens through `theme.js`, dispose on page hide, and
use responsive host-colored controls. No new styling RPC is needed.

Local evidence includes normal CLI validation/packing, schema/admission and
no-runtime checks; host catalog/identity/size/contrast/CAS/migration/atomic-audit
checks; picker preview/apply/cancel/reset and stale-owner/withdrawal/high-contrast
checks; and view-template initial/live environment/disposal checks. Exact-SHA
CI, independent review and parent native multi-window/security-surface acceptance
remain separate delivery gates. Local production builds do not establish them.

### First review / CI delta

The first review found that muted text was validated only against its namesake
muted surface, although host descriptions and statuses also use it on background,
card and popover surfaces. The validator now checks generic and muted text on
all neutral surfaces that reuse those tokens. The white-on-white counterexample
is rejected both by the pure validator and the host catalog. Forest light/dark
palettes remain valid.

The first exact-head test run `40317690002` failed with 15187 passing tests,
one failure and 50 skips. Its single failure was the unchanged TERM-SSHD
concurrent failure-release test expecting a particular invocation to reach OPEN
first. Both calls perform asynchronous local-file preparation. The test now
requires exactly one explicit Permission denied result, one successful result
with matching bytes, and no rejected concurrent handle; it retains concurrency
without assuming filesystem completion order. No transfer implementation changed.
The test file's original SHA256 was identical in e5bd294c, 733f44c and fdeeaf74:
`8b200d9f6a05ac5cd91fe4e0a95ea36a770d22267a6a0162b4c9fc927beb52a7`.
This is source identity and a source-based ordering diagnosis, not a claim that a
baseline runtime failure was reproduced locally. The updated test needs the new
exact-head CI result. That same first run passed the added Vite browser-import
smoke, resolving the earlier local temp-directory limitation for that head.

### Native security-color delta

Parent native acceptance at f868 verified zero-permission installation/enabling,
light/dark Preview and Cancel, Apply across main/Settings windows, Restore
default, restart persistence, and Disable fallback with the unavailable notice.
The isolated schema-3 profile was not touched. These core results remain valid.

Native QA also found Forest-colored inner New Host cards/inputs/Save and some
grant-panel text inside an otherwise fixed security container. The cause was
Tailwind's derived `--color-*` aliases: changing only raw semantic tokens at the
boundary does not recompute aliases already resolved on an ancestor. The same
existing security rule now fixes both raw tokens and those color aliases. The
selector and protected regions are unchanged; ordinary application cards remain
theme-controlled. No host, credential or grant operation changed.

The regression renders the actual HostDetailsPanel (including General, Address,
Credentials cards, real Inputs and Save), plus the real grant-panel root. It
compiles the production Tailwind source, verifies which aliases those utilities
consume, checks the fixed declarations, and verifies an ordinary card is outside
the security selector. This is component/compiled-CSS coverage, not a claim of
native computed-color acceptance. The parent's native color delta remains the
final visual check. A local Chromium probe aborted because its SUID sandbox was
not configured; sandboxing was not disabled to retry.
