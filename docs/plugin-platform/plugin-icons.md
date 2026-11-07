# Add a plugin brand icon

Brand icons appear on Community cards/details and Installed lists/details. They
are optional; plugins without them retain a host-owned fallback. An icon does
not activate code or grant plugin permissions.

## Declare the icon

Use the existing `IconReference` shape at the top level of `netcatty.plugin.json`:

```json
{
  "engines": { "netcatty": ">=0.0.0", "api": ">=0.1.0-internal.1 <0.2.0" },
  "features": { "required": ["metadata.brand-icon"] },
  "icon": {
    "kind": "package",
    "light": "assets/logo-light.png",
    "dark": "assets/logo-dark.webp"
  }
}
```

This is a manifest fragment. Preserve the required ID, name, version, publisher,
main and other fields. The host-version value above is for this repository's
unreleased development build (version 0.0.0); use the actual first supporting
Netcatty release as your lower bound when it is assigned. Do not invent a release
number. The API range and required feature enforce support in the meantime.

Alternatively use a host-owned theme glyph, for example
`"icon": { "kind": "theme", "name": "terminal" }`, with the same API/feature
requirements. Theme glyphs use the existing host allowlist; unknown names fall back safely.

## Prepare files

Use a static PNG or WebP. A square transparent 128×128 or 256×256 image is
recommended. Each source must be at most 256 KiB, with both dimensions between
1 and 512 pixels. `dark` is optional; otherwise `light` is used in both themes.
Use lowercase `.png` / `.webp` extensions matching the encoded bytes. Animated
PNG/WebP and SVG are not accepted for brand icons. Existing contribution icons
are unchanged, including their separately isolated SVG support.

Paths are relative to the package root. URLs, absolute paths, traversal,
backslashes and symlinks escaping the package are not supported. Include each
referenced file in the package. No external image URL is loaded as a fallback.
The host performs offline isolated decoding and displays a bounded PNG result;
invalid or unreadable images fall back to the host glyph.

## Validate and package

From this repository, after building your plugin:

```sh
npm run build:plugin-packages
node packages/plugin-cli/dist/cli.js validate examples/plugins/starter-netcatty
node packages/plugin-cli/dist/cli.js compatibility examples/plugins/starter-netcatty --netcatty 0.0.0 --api 0.1.0-internal.1 --features metadata.brand-icon
node packages/plugin-cli/dist/cli.js pack examples/plugins/starter-netcatty --out /tmp/starter-netcatty.ncpkg
```

Directory validation, packaging and imported-archive validation check declared
brand files and bounds. The host reads installed metadata by plugin ID and
verified package identity, not a renderer-provided file path. Disabled packages
can display their icon; quarantined, missing or changed packages fall back. The
existing enabled-only contribution icon service gate is not relaxed.

## Community previews

For an uninstalled plugin, the directory maintainer includes a reviewed raster
preview in the application bundle. The preview binds the plugin ID, version,
repository, source commit and icon declaration. Its bytes and SHA-256 are checked
against the reviewed source files in tests. The current Starter preview uses its
first-party source assets; source-only listings do not pretend to have a release
artifact. Missing or mismatched previews use the same fallback, without fetching
an image from the author's server. Submit the source assets and updated directory
metadata through the existing repository PR review process.

## Compatibility

This is API/schema revision `0.1.0-internal.1`. An older host rejects the unknown
manifest field or missing required feature. The new host continues to offer
`0.1.0-internal` for legacy plugins without the new field, including exact old
API ranges. Existing plugins need no manifest or data migration.
