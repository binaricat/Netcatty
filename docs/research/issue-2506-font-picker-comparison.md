# Issue #2506: Tabby / Electerm font picker comparison

Research date: 2026-07-27

Source revisions:

- Tabby: [`14e2d60b9b6dee84a53c37f05eefeb803787de04`](https://github.com/Eugeny/tabby/commit/14e2d60b9b6dee84a53c37f05eefeb803787de04)
- Electerm: [`7dfb33ed19352430f0303ca14e379d9b2387f390`](https://github.com/electerm/electerm/commit/7dfb33ed19352430f0303ca14e379d9b2387f390)

## Conclusion

[Issue #2506](https://github.com/binaricat/Netcatty/issues/2506) proposes a mature, scoped improvement: searchable font pickers. Tabby and Electerm both avoid growing a hard-coded built-in font catalog. Their shared pattern is: enumerate local fonts, support name search, and keep free-text entry so a failed or incomplete system font scan does not lock the user out.

They differ on fallback fonts. Tabby uses a clear "main font + one fallback font" model, which is closest to Netcatty's existing shape. Electerm lets users order an arbitrary font chain, which is more flexible but easier to misconfigure. For #2506, keep Netcatty's main-font / CJK-font split, make the UI font and terminal main-font pickers searchable, and do not introduce an arbitrary font-chain editor.

## Comparison

| Question | Tabby | Electerm |
|---|---|---|
| Search support | Yes. The font field is a text box with autocomplete; after a 200 ms debounce it filters by case-insensitive name substring and dedupes ([UI](https://github.com/Eugeny/tabby/blob/14e2d60b9b6dee84a53c37f05eefeb803787de04/tabby-terminal/src/components/appearanceSettingsTab.component.pug#L6-L12), [filter logic](https://github.com/Eugeny/tabby/blob/14e2d60b9b6dee84a53c37f05eefeb803787de04/tabby-terminal/src/components/appearanceSettingsTab.component.ts#L22-L32)). | Yes. The font selector enables search and filters by case-insensitive name substring ([source](https://github.com/electerm/electerm/blob/7dfb33ed19352430f0303ca14e379d9b2387f390/src/client/components/common/font-select.jsx#L32-L43)). |
| Enumerate system fonts | Yes. Windows / macOS list all available families; Linux uses `fc-list :spacing=mono` for monospace only ([source](https://github.com/Eugeny/tabby/blob/14e2d60b9b6dee84a53c37f05eefeb803787de04/tabby-electron/src/services/platform.service.ts#L209-L224)). The web build returns an empty list when enumeration is unavailable ([source](https://github.com/Eugeny/tabby/blob/14e2d60b9b6dee84a53c37f05eefeb803787de04/tabby-web/src/platform.ts#L66-L68)). | Yes. The main process reads families via `font-list`, strips quotes from names, and returns an empty list on failure without blocking startup ([source](https://github.com/electerm/electerm/blob/7dfb33ed19352430f0303ca14e379d9b2387f390/src/app/lib/font-list.js#L7-L16)). |
| Allow manual entry | Yes. The control is a free-text input; suggestions are not a closed set. | Yes. The selector uses tag mode so users can pick local fonts or type a new family ([source](https://github.com/electerm/electerm/blob/7dfb33ed19352430f0303ca14e379d9b2387f390/src/client/components/common/font-select.jsx#L32-L43)). |
| Fallback / CJK font | Has a dedicated fallback font field whose copy says it covers glyphs missing from the main font; it also has local-font autocomplete ([source](https://github.com/Eugeny/tabby/blob/14e2d60b9b6dee84a53c37f05eefeb803787de04/tabby-terminal/src/components/appearanceSettingsTab.component.pug#L151-L160)). Final order is main font, user fallback, built-in fallbacks, then system monospace fonts ([source](https://github.com/Eugeny/tabby/blob/14e2d60b9b6dee84a53c37f05eefeb803787de04/tabby-core/src/utils.ts#L20-L28)). It is not labeled "CJK font", but a Chinese font can be entered there. | No separate CJK / fallback field. Users add multiple font tags; save concatenates them into one font stack ([save logic](https://github.com/electerm/electerm/blob/7dfb33ed19352430f0303ca14e379d9b2387f390/src/client/components/setting-panel/setting-terminal.jsx#L89-L94), [UI](https://github.com/electerm/electerm/blob/7dfb33ed19352430f0303ca14e379d9b2387f390/src/client/components/setting-panel/setting-terminal.jsx#L432-L439)) and hands that stack to the terminal ([source](https://github.com/electerm/electerm/blob/7dfb33ed19352430f0303ca14e379d9b2387f390/src/client/components/terminal/terminal.jsx#L1288-L1293)). A Chinese font can be placed in a later tag. |
| Preview and per-connection override | No per-row candidate preview; main and fallback share the same simple autocomplete model. | Each candidate name is rendered in its own family for a light preview ([source](https://github.com/electerm/electerm/blob/7dfb33ed19352430f0303ca14e379d9b2387f390/src/client/components/common/font-select.jsx#L14-L25)). Per-connection font overrides remain plain text fields and do not reuse the global searchable picker ([source](https://github.com/electerm/electerm/blob/7dfb33ed19352430f0303ca14e379d9b2387f390/src/client/components/bookmark-form/config/common-fields.js#L170-L175)). |

## Recommendations for Netcatty

1. Give UI font and terminal main font the same searchable picker UX: case-insensitive name substring match, with each candidate rendered in its own family.
2. Keep reading local fonts instead of expanding a built-in catalog. Prefer monospace families for the terminal main font so proportional fonts do not break column alignment.
3. Keep free-text entry. Font enumeration can be denied, fail, or miss families; synced fonts may also exist only on another machine.
4. Keep the existing "main font + CJK font" model. It is easier to explain than Electerm's arbitrary chain and matches Tabby's approach.
5. If system font enumeration fails, still show the current value and safe built-in options; do not leave the settings page with an empty list.

## Local acceptance font pack (macOS)

These 8 fonts are for accepting #2506; they are not a quantified popularity ranking. Selection criteria: common in developer circles, open source, official projects still reachable, and installable from Homebrew's official font casks as of 2026-07-27. They deliberately cover ligatures, narrow metrics, Nerd Font icons, Simplified Chinese, handwritten-style Chinese, and multiple similar family names from one install.

### Programming fonts

| Font | Homebrew cask | Mono / CJK | Nerd Font | Acceptance value |
|---|---|---|---|---|
| [JetBrains Mono](https://www.jetbrains.com/lp/mono/) | [`font-jetbrains-mono`](https://formulae.brew.sh/cask/font-jetbrains-mono) | Monospace; no CJK han | No; base font includes a few Powerline symbols | Common baseline; easy to recognize in name search and ligature preview. |
| [Fira Code](https://github.com/tonsky/FiraCode) | [`font-fira-code`](https://formulae.brew.sh/cask/font-fira-code) | Monospace; no CJK han | No; base font supports Powerline | Rich ligatures; good check that candidates remain readable when rendered in their own family. |
| [Cascadia Code](https://github.com/microsoft/cascadia-code) | [`font-cascadia-code`](https://formulae.brew.sh/cask/font-cascadia-code) | Monospace; no CJK han | Not this cask; official NF variants exist separately | Officially distinguishes Code, Mono, Powerline, and Nerd Font; good similar-name search check. |
| [Iosevka](https://github.com/be5invis/Iosevka) | [`font-iosevka`](https://formulae.brew.sh/cask/font-iosevka) | Monospace family; no CJK han | Not this cask; Homebrew has separate NF variants | Narrow metrics and many family variants; good for long lists, similar names, and terminal column width. |

### CJK / Chinese monospace fonts

| Font | Homebrew cask | Mono / CJK | Nerd Font | Acceptance value |
|---|---|---|---|---|
| [Maple Mono NF CN](https://font.subf.dev/en/) | [`font-maple-mono-nf-cn`](https://formulae.brew.sh/cask/font-maple-mono-nf-cn) | Latin/CJK 2:1 monospace; includes Simplified Chinese | Yes | One family covering code, Chinese, and icons; the most complete terminal sample. |
| [Sarasa Gothic](https://github.com/be5invis/Sarasa-Gothic) | [`font-sarasa-gothic`](https://formulae.brew.sh/cask/font-sarasa-gothic) | Install includes `Sarasa Mono SC`, `Term SC`, `Fixed SC`, and other CJK mono variants, plus proportional variants | No | One install yields many near-duplicate family names; best stress test for search and filtering. |
| [LXGW WenKai GB](https://github.com/lxgw/LxgwWenkaiGB) | [`font-lxgw-wenkai-gb`](https://formulae.brew.sh/cask/font-lxgw-wenkai-gb) | Install includes both `LXGW WenKai Mono GB` and proportional versions; Simplified Chinese | No | Checks that search distinguishes Mono vs regular, and that Chinese style differences remain visible. |
| [Noto Sans Mono CJK SC](https://github.com/notofonts/noto-cjk/tree/main/Sans) | [`font-noto-sans-mono-cjk-sc`](https://formulae.brew.sh/cask/font-noto-sans-mono-cjk-sc) | Half-width ASCII + full-width Simplified Chinese; suited to terminal 2:1 layout | No | Neutral baseline for Chinese column width and fallback behavior. |

Install all 8 casks once, restart Netcatty, then test search, keyboard selection, main + CJK combinations, and rendering of `A中B文 0O1lI -> !=` plus Powerline / Nerd Font icons:

```sh
brew install --cask font-jetbrains-mono font-fira-code font-cascadia-code font-iosevka font-maple-mono-nf-cn font-sarasa-gothic font-lxgw-wenkai-gb font-noto-sans-mono-cjk-sc
```

Base JetBrains Mono and Fira Code include a few Powerline symbols but are not full Nerd Fonts; this set relies on Maple Mono NF CN alone for complete icon-font coverage, avoiding duplicate variants that make the font list hard to scan.

## Scope note

The Tabby and Electerm settings reviewed above target terminal fonts. The checked official settings sources do not expose a separate picker that fully matches Netcatty's "UI font" control. They therefore evidence shared patterns for search, system font enumeration, free-text entry, and fallback chains, not a required product model for UI fonts.
