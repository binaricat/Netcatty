# Plugin manager window and brand icons

Status: historical design investigation. The manager dialog and the accepted brand-icon design are now implemented. See [the current author guide](plugin-icons.md) for the shipped contract and bounds. The sections below preserve the original investigation and recommendations.

## Manager window

Settings > Plugins keeps an explicit Open plugin manager entry. The existing Radix Dialog opens a modal in the current renderer, up to 1180px wide and 88dvh high. Installed and Community, local import, manifest permissions and README remain inside it. Closing releases the mounted manager hooks; reopening starts at Installed. Detail Back stays inside the manager and preserves the Community search. Escape closes the manager and restores focus to its trigger.

This uses the existing theme, dialog focus handling, plugin host and trusted bridge. A separate Electron BrowserWindow would require another renderer lifecycle, preload/context provisioning and trusted-sender review without providing a needed capability here. No window IPC, plugin runtime or grants are added.

## Existing icon support

- `packages/plugin-contract/schema/plugin-contract.schema.json`: `IconReference` is either a host-owned theme icon or a package icon with `light` and optional `dark` paths. It exists on commands, menus and views. `PluginManifest` has no top-level icon and rejects unknown properties.
- `packages/plugin-cli/src/manifest.ts` validates contribution icon paths. `archive.ts` checks the declared resources during packaging and archive inspection. Missing files and unsafe paths are rejected.
- `electron/plugins/contributionIconService.cjs` checks declaration ownership and current installed version before and after loading. It requires enabled/non-quarantined status, but does not require a running runtime. It reads a verified package root through `pluginProtocol.cjs` containment/realpath checks. Current input/output limits are 512 KiB, source edge 4096px, 16 megapixels, output edge 64px. Formats include PNG/WebP and SVG, JPEG, GIF, ICO.
- `contributionIconRasterizer.cjs` decodes in a disposable sandboxed, network-denied BrowserWindow and returns bounded PNG data. Its SVG inspection is not a general SVG sanitizer; isolation/CSP/rasterization remain essential.
- `application/state/usePluginContributionIcon.ts` discards stale requests. `components/plugins/PluginContributionIcon.tsx` selects light/dark images or a Puzzle fallback.
- `PluginMarketplace.tsx` currently uses the host Package glyph. The catalog has no separately verified logo asset. Installed/detail surfaces do not expose a plugin brand logo.

An author can already add a contribution icon (inside a command/menu/view):

```json
"icon": { "kind": "package", "light": "assets/action.png", "dark": "assets/action-dark.png" }
```

Include both files in the package and run CLI validate/pack. This changes that contribution's icon, not its market listing logo.

## Proposed minimal brand-icon contract

Reuse `IconReference`, adding an **optional** `PluginManifest.icon`; do not invent a URL/logo string format. A package brand icon would look like this after support ships:

```json
"icon": {
  "kind": "package",
  "light": "assets/logo.png",
  "dark": "assets/logo-dark.webp"
}
```

Recommended first version:

- Static PNG or WebP, transparent background if desired; recommend a square 128–256px image. Enforce 256 KiB per source and a 512px maximum edge, validate MIME/signature and decoded dimensions, reject animated input, output bounded raster PNG. A single `light` asset works in both themes; `dark` is optional. Host theme icons can reuse the existing allowlist without package I/O.
- Relative package paths only: no URL, absolute/drive/UNC paths, traversal, backslash, NUL, symlink escape or archive special entries. Do not read arbitrary renderer-supplied paths. Verify exact package hash/version and declaration on each uncached resolution; key caches by package identity/hash/theme, and discard stale results on update/uninstall.
- Old plugins omit the field and continue to work with one shared host fallback. Per `contract-and-sdk.md`, adding this optional field requires an API/schema revision. New packages using it must declare the matching API range and required feature, plus a minimum host version that understands it: older strict schemas will reject an unknown field. Do not promise new-manifest compatibility with older hosts.
- Extend the single contract and regenerate its consumers. Extend CLI path enumeration and both pack/archive checks; enforce image bounds during validation/import, not only in the UI. Reuse contained-file reads and the bounded rasterizer instead of adding file:// or runtime resource access in the application renderer.
- Separate brand-image availability from contribution availability. Verified installed packages may show a logo while disabled without enabling or activating code. Do not loosen the existing contribution-icon enabled gate globally. Share the decoding implementation through a narrow brand-image operation that resolves the active installed declaration itself.
- For uninstalled market entries, do not execute or install a plugin to obtain its logo. Use a small, catalog-reviewed static asset bundled with Netcatty, with its source commit and digest bound to that catalog version; absent assets use the same fallback. In particular the two current source-only examples have no downloadable artifact to extract. A later remote asset transport would need its own bounded allowlist/hash/redirect/cache policy and is outside this first proposal.
- Use one brand-icon component in catalog cards, catalog details and installed lists/details. On decode/read failure keep the fallback and metadata/actions usable; do not fall back to a remote URL. Icons are decorative, with plugin names remaining accessible text.

Do not add brand SVG support initially. Existing contribution SVG support is not removed. SVG brings XML/CSS/external-reference, filter and decoding complexity; supporting it for distribution means retaining isolated offline rasterization, bounded dimensions/time/concurrency and malformed/hostile-source tests. Raster PNG/WebP covers the initial need with less format complexity, though image decoders still require limits and isolation.

## Validation required before implementing brand icons

Contract/CLI tests should cover old manifests, optional fields, missing files, both themes, spoofed MIME, animation, oversized/zero dimensions, archive traversal and symlinks. Host tests should cover disabled installed packages without activation, source-only catalog fallback, stale update/uninstall results and no remote fetch. UI/native checks should cover all three surfaces, broken-image fallback, light/dark themes and accessible names. No new host, filesystem, network or terminal permission should be granted for displaying a verified logo.
