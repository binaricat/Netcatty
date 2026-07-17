# Issue #2206: local Chinese font selection

Research date: 2026-07-17

Source revisions:

- Netcatty: `e6ffbd3f6894c810d148002670f5187bf654a345`
- Tabby: `14e2d60b9b6dee84a53c37f05eefeb803787de04`
- Electerm: `6fbddfe55c66bffcb5aaad23676c0dd006e16367`

## Conclusion

[Issue #2206](https://github.com/binaricat/Netcatty/issues/2206) is supportable without a new persistence model or a native font-scanning dependency. Netcatty already asks Chromium for every installed font family, uses that result to populate the main terminal-font picker, and persists the CJK fallback as a family-name string. The actual gap is narrower: the separate “Chinese / CJK font” picker is built from eight hard-coded choices, so an installed Chinese font outside that list is never offered.

Tabby is the best product reference. It keeps a simple “main font + fallback font” model, gives both fields local-font autocomplete while retaining free text, and constructs one ordered CSS font stack. Electerm proves that a more flexible ordered list also works, but its tag-list UX is harder to explain and easier to misconfigure. Netcatty should keep its existing two-field model and make the CJK picker searchable over installed families, rather than replacing it with an arbitrary font-chain editor.

## Current Netcatty behavior and precise gap

- Netcatty calls `queryLocalFonts()` once, caches all installed family names, and separately derives likely monospace families for the main font list ([local-font query](https://github.com/binaricat/Netcatty/blob/e6ffbd3f6894c810d148002670f5187bf654a345/lib/localFonts.ts#L90-L164), [store integration](https://github.com/binaricat/Netcatty/blob/e6ffbd3f6894c810d148002670f5187bf654a345/application/state/fontStore.ts#L60-L95)). Electron explicitly grants the app origin the `local-fonts` permission ([permission policy](https://github.com/binaricat/Netcatty/blob/e6ffbd3f6894c810d148002670f5187bf654a345/electron/main.cjs#L955-L1004)).
- The main terminal-font picker already receives those dynamically discovered fonts. The CJK picker does not: it owns a static eight-entry `OPTIONS` array and only filters those entries by installation status ([CJK picker](https://github.com/binaricat/Netcatty/blob/e6ffbd3f6894c810d148002670f5187bf654a345/components/settings/TerminalCjkFontSelect.tsx#L16-L97)). This explains why a locally installed Chinese font can exist but remain unselectable.
- The selected CJK family is already stored as `terminalSettings.fallbackFont`, included in sync, and inserted before Netcatty's broader CJK/Nerd/system fallback stack ([settings UI](https://github.com/binaricat/Netcatty/blob/e6ffbd3f6894c810d148002670f5187bf654a345/components/settings/tabs/SettingsTerminalTab.tsx#L511-L522), [sync field list](https://github.com/binaricat/Netcatty/blob/e6ffbd3f6894c810d148002670f5187bf654a345/application/syncPayload.ts#L197-L205), [font-stack composition](https://github.com/binaricat/Netcatty/blob/e6ffbd3f6894c810d148002670f5187bf654a345/infrastructure/config/cjkFonts.ts#L120-L181)). Therefore the first version needs a better picker and source data, not a schema migration.

## Competitor comparison

| Product | Local font UX | Saved model | Relevant tradeoff |
|---|---|---|---|
| Tabby | Main and fallback are searchable text inputs backed by the same local list; users can still type a missing family manually ([UI](https://github.com/Eugeny/tabby/blob/14e2d60b9b6dee84a53c37f05eefeb803787de04/tabby-terminal/src/components/appearanceSettingsTab.component.pug#L1-L18), [fallback UI](https://github.com/Eugeny/tabby/blob/14e2d60b9b6dee84a53c37f05eefeb803787de04/tabby-terminal/src/components/appearanceSettingsTab.component.pug#L151-L161), [autocomplete](https://github.com/Eugeny/tabby/blob/14e2d60b9b6dee84a53c37f05eefeb803787de04/tabby-terminal/src/components/appearanceSettingsTab.component.ts#L22-L32)). | Global `font` plus one optional `fallbackFont`; defaults are OS-specific ([config](https://github.com/Eugeny/tabby/blob/14e2d60b9b6dee84a53c37f05eefeb803787de04/tabby-terminal/src/config.ts#L18-L24), [platform defaults](https://github.com/Eugeny/tabby/blob/14e2d60b9b6dee84a53c37f05eefeb803787de04/tabby-terminal/src/config.ts#L70-L177)). | Windows/macOS list all families through a native library, while Linux asks `fc-list` for monospace families only ([scanner](https://github.com/Eugeny/tabby/blob/14e2d60b9b6dee84a53c37f05eefeb803787de04/tabby-electron/src/services/platform.service.ts#L209-L226)). Free text covers omissions. |
| Electerm | A searchable tag selector shows every scanned family in its own face and permits custom entries ([selector](https://github.com/electerm/electerm/blob/6fbddfe55c66bffcb5aaad23676c0dd006e16367/src/client/components/common/font-select.jsx#L6-L44)). | Ordered tags are joined into one comma-separated `fontFamily`; sessions may override the global value ([save](https://github.com/electerm/electerm/blob/6fbddfe55c66bffcb5aaad23676c0dd006e16367/src/client/components/setting-panel/setting-terminal.jsx#L89-L94), [runtime inheritance](https://github.com/electerm/electerm/blob/6fbddfe55c66bffcb5aaad23676c0dd006e16367/src/client/components/terminal/terminal.jsx#L1185-L1199)). | Flexible ordering also makes symbol/emoji/CJK conflicts easier to create; its own [issue #2803](https://github.com/electerm/electerm/issues/2803) documents user confusion around the fallback order. Font-list failure returns an empty list rather than blocking startup ([scanner](https://github.com/electerm/electerm/blob/6fbddfe55c66bffcb5aaad23676c0dd006e16367/src/app/lib/font-list.js#L7-L16)). |

Tabby's earlier [issue #1041](https://github.com/Eugeny/tabby/issues/1041) is directly analogous: users needed a Latin/Powerline font followed by Chinese/Japanese fallbacks. The accepted behavior was an ordered comma-separated stack with preview and terminal rendering kept consistent. In [issue #2144](https://github.com/Eugeny/tabby/issues/2144#issuecomment-821451200), the maintainer also clarified that selecting a Latin-only face cannot change Chinese glyphs; the user must select or add a Chinese-capable fallback.

## Recommended Netcatty plan

1. Reuse the already-cached full installed-family set in `TerminalCjkFontSelect`; do not make a second `queryLocalFonts()` call.
2. Replace the closed static dropdown with a searchable combobox. Put `Auto` and Netcatty's known-safe monospaced CJK choices first, then an “Installed fonts” section. Show each family name using itself and preview a short mixed sample such as `ABC 你好 123`.
3. Retain manual entry, as Tabby and Electerm do. Local-font permission can be unavailable, native lists can be incomplete, and a synced family may not exist on the current device. Manual entry must not suppress Netcatty's final fallback stack.
4. Keep storing the exact family name in the existing `fallbackFont` field. On another device, show it as “not installed on this device” while continuing to fall back safely; do not silently replace the synced choice.
5. Preserve the current guardrail instead of claiming every installed CJK font is terminal-safe. Mark the known monospaced set as recommended; place other local fonts under an explicit warning that proportional fonts can break column alignment. A preview should include box drawing and aligned CJK/ASCII columns so the user can see the risk before committing.
6. When the choice changes, keep the existing font-ready remeasure/refit path and verify an already-open terminal, a newly opened terminal, and a restored terminal all use the same family and maintain cursor/grid alignment.

## Edge cases and acceptance checks

- Local-font permission unavailable or query fails: settings still show `Auto`, bundled/recommended choices, the current saved value, and manual entry.
- Duplicate faces/styles: deduplicate case-insensitively by family, not by full face name, as the current store already does.
- Cross-device sync: retain the family string even when absent locally; label it unavailable and let the existing stack continue.
- Family names containing spaces, quotes, or commas: quote/escape them as one CSS family rather than treating a comma inside a family name as a fallback separator.
- A selected proportional font: show an alignment warning/preview; never remove the system fallback safety net.
- Font installed or removed while Netcatty is open: a refresh/retry action should update the list without requiring an application restart.
- Verification matrix: macOS, Windows, and Linux; permission allowed/denied; installed safe CJK mono font; arbitrary local Chinese font; missing synced font; current and new terminal sessions; WebGL and DOM renderers where both are supported.

## Scope recommendation

The first implementation should be global-only and should not add Electerm-style arbitrary ordered chains or per-host CJK overrides. Netcatty already has a clear global main-font/CJK-fallback relationship; expanding configuration scope before the picker works would add migration, inheritance, and sync complexity without improving #2206's core outcome.
