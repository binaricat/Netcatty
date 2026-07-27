# Issue #2526: Large host vault patterns in terminal clients

Research date: 2026-07-27

Source revisions:

- Tabby: `14e2d60b9b6dee84a53c37f05eefeb803787de04`
- Electerm: `7dfb33ed19352430f0303ca14e379d9b2387f390`
- Wave Terminal: `c99022c15bd1f17273728e728a61743e690d6423`
- TanStack Virtual fixed-size example: `f28cd833d6c5dbc79d0d44462a3c1cb4eb0a09b9`

## Conclusion

The strongest directly comparable implementation is Electerm's bookmark tree. In April 2026 it replaced recursive full rendering with a fixed-height virtual list specifically to improve tree-list performance ([commit](https://github.com/electerm/electerm/commit/333d9d07ed28d1151e383b669f900dcb34870d1c)). It first flattens the expanded or searched tree against the complete bookmark data, then renders only the rows around the viewport. Search therefore still covers every bookmark; virtualization changes only how many matching rows exist in the DOM.

Tabby is not a good large-vault rendering reference today. Its profile tree and selector still render their complete result arrays with Angular `ngFor` ([profile tree](https://github.com/Eugeny/tabby/blob/14e2d60b9b6dee84a53c37f05eefeb803787de04/tabby-core/src/components/profileTree.component.pug#L12-L46), [profile selector](https://github.com/Eugeny/tabby/blob/14e2d60b9b6dee84a53c37f05eefeb803787de04/tabby-core/src/components/selectorModal.component.pug#L10-L33)). Its search is full-data fuzzy search, but the matching results are also fully rendered.

For Netcatty, a real virtual window is preferable to a "show 200 more" button. The list and tree views can use fixed-height rows, which is the simple and proven case. The grid can be virtualized by **card rows**: calculate the responsive column count, split the filtered hosts into rows, give each row a stable height, and render only visible rows. This preserves natural scrolling without letting the page grow to thousands of cards. TanStack's official fixed-size example demonstrates both a 10,000-row list and a fixed-size grid using this model ([source](https://github.com/TanStack/virtual/blob/f28cd833d6c5dbc79d0d44462a3c1cb4eb0a09b9/examples/react/fixed/src/main.tsx#L31-L170)).

The import path should remain a separate concern. Tabby and Electerm use asynchronous file APIs, but neither exposes useful per-stage import progress. Electerm still parses JSON and mutates its bookmark store in the UI process, while Tabby's importer contract returns only a final promise. Netcatty's background parsing plus visible reading/parsing/saving progress is therefore a defensible improvement rather than an invention contradicted by peers.

## Comparison

| Client | Large host/session rendering | Row sizing and window | Search/filter semantics | Groups/tree | Import execution and feedback |
|---|---|---|---|---|---|
| Electerm | Custom virtual list for the actual bookmark sidebar | Fixed 26 px rows; 8 rows of overscan; only the calculated slice is rendered | Searches the full bookmark map and descriptions before windowing; search traverses collapsed groups | Flattens only expanded groups normally; search includes matching descendants regardless of collapse | File read is awaited, but JSON parsing and store updates happen in the UI path; no progress state is exposed |
| Tabby | No windowing in the current profile tree or selector | All profiles in expanded groups/results are rendered | Fetches all profiles, fuzzy-matches name/description, then fully renders matches | Recursive groups with persisted collapsed state | Promise-based async reads, shared in-flight promise, memory/disk cache; no progress callback or progress UI |
| Wave Terminal | Reusable virtual tree (supplementary evidence; not its connection picker) | TanStack Virtual; default 24 px estimated row and 10-row overscan | No search in this generic component | Flattens expanded nodes, loads children on demand, caps a directory at 500 by default, and shows a capped marker | Not an import reference |

## Electerm

### Rendering

Electerm's `VirtualTreeList` computes `startIndex` and `endIndex` from scroll position, viewport height, a fixed row height, and an overscan of eight. It creates a full-height spacer but maps only `items.slice(startIndex, endIndex)` into positioned rows ([virtual list](https://github.com/electerm/electerm/blob/7dfb33ed19352430f0303ca14e379d9b2387f390/src/client/components/tree-list/virtual-tree-list.jsx#L3-L111)). The bookmark sidebar passes a fixed `treeRowHeight` of 26 px to this component ([layout constants](https://github.com/electerm/electerm/blob/7dfb33ed19352430f0303ca14e379d9b2387f390/src/client/components/tree-list/tree-list-layout.js#L1-L3), [sidebar integration](https://github.com/electerm/electerm/blob/7dfb33ed19352430f0303ca14e379d9b2387f390/src/client/components/tree-list/tree-list.jsx#L831-L902)).

The tree is flattened before it reaches the virtualizer. With no keyword, recursion stops at collapsed groups. With a keyword, it recursively checks every group's descendants, includes groups that contain a match, and appends only matching bookmarks. Bookmark match results and group match results are cached for the current build ([flattening and filtering](https://github.com/electerm/electerm/blob/7dfb33ed19352430f0303ca14e379d9b2387f390/src/client/components/tree-list/tree-list-rows.js#L31-L139)). Keyboard search navigates this full logical row list and scrolls to the selected row by index, rather than querying rendered DOM nodes ([navigation](https://github.com/electerm/electerm/blob/7dfb33ed19352430f0303ca14e379d9b2387f390/src/client/components/tree-list/tree-list.jsx#L120-L184)).

This is the most transferable pattern for Netcatty: **filter and flatten against full data first; virtualize only the final presentation rows**.

### Import

Electerm awaits reading the selected file, then calls `JSON.parse`, copies the current collections, de-duplicates IDs, and pushes bookmarks/groups into its UI store ([bookmark import](https://github.com/electerm/electerm/blob/7dfb33ed19352430f0303ca14e379d9b2387f390/src/client/components/tree-list/bookmark-upload.js#L24-L105)). Its upload wrapper invokes the callback without awaiting or displaying state ([upload control](https://github.com/electerm/electerm/blob/7dfb33ed19352430f0303ca14e379d9b2387f390/src/client/components/common/upload.jsx#L47-L80)). The cited path has no progress events, stage labels, or completion summary. This is not a pattern Netcatty should copy for an 8,000-host import.

## Tabby

### Rendering and search

Tabby loads profile groups with their profiles, filters and sorts them, builds a group tree, and stores collapse state ([tree loading](https://github.com/Eugeny/tabby/blob/14e2d60b9b6dee84a53c37f05eefeb803787de04/tabby-core/src/components/profileTree.component.ts#L52-L81)). The template recursively renders every profile in each expanded group and every expanded child group; it does not apply a viewport window in this component ([template](https://github.com/Eugeny/tabby/blob/14e2d60b9b6dee84a53c37f05eefeb803787de04/tabby-core/src/components/profileTree.component.pug#L12-L46)).

Filtering asks the profile service for the full profile collection and fuzzy-searches `name` and `description`. Matches are replaced with one flat "Filter results" group ([filter](https://github.com/Eugeny/tabby/blob/14e2d60b9b6dee84a53c37f05eefeb803787de04/tabby-core/src/components/profileTree.component.ts#L202-L233)). This confirms the important semantic boundary—search should cover the complete data set—but not the rendering solution.

### Import

Tabby's SSH importers expose only `getProfiles(): Promise<...[]>` ([contract](https://github.com/Eugeny/tabby/blob/14e2d60b9b6dee84a53c37f05eefeb803787de04/tabby-ssh/src/api/importer.ts#L1-L6)). The OpenSSH importer uses asynchronous reads, shares one in-flight import promise, reuses an in-memory result, and maintains a modification-time disk cache; the cache write is deliberately fire-and-forget ([implementation](https://github.com/Eugeny/tabby/blob/14e2d60b9b6dee84a53c37f05eefeb803787de04/tabby-electron/src/sshImporters.ts#L370-L434)). Importers are awaited serially and only the final arrays are returned ([consumer](https://github.com/Eugeny/tabby/blob/14e2d60b9b6dee84a53c37f05eefeb803787de04/tabby-ssh/src/profiles.ts#L63-L92)). The contract has no progress channel, so this is useful evidence for caching and asynchronous I/O, not for import feedback.

## Wave Terminal as a supporting pattern

Wave Terminal's reusable tree control uses `@tanstack/react-virtual`, a default 24 px row estimate, and an overscan of ten. It builds the logical visible rows from expanded nodes, then renders only `virtualizer.getVirtualItems()` ([tree model and defaults](https://github.com/wavetermdev/waveterm/blob/c99022c15bd1f17273728e728a61743e690d6423/frontend/app/treeview/treeview.tsx#L19-L177), [virtual rendering](https://github.com/wavetermdev/waveterm/blob/c99022c15bd1f17273728e728a61743e690d6423/frontend/app/treeview/treeview.tsx#L206-L257), [visible items](https://github.com/wavetermdev/waveterm/blob/c99022c15bd1f17273728e728a61743e690d6423/frontend/app/treeview/treeview.tsx#L430-L470)).

It also loads a directory only when expanded, defaults to at most 500 fetched children, records loading/error/capped states, and adds a visible "Showing first ... entries" row when capped ([lazy loading](https://github.com/wavetermdev/waveterm/blob/c99022c15bd1f17273728e728a61743e690d6423/frontend/app/treeview/treeview.tsx#L284-L355)). This is not a direct host-vault implementation, but it independently supports the same design: flatten expanded content, virtualize fixed-height rows, and keep loading/cap state explicit.

## Recommended Netcatty shape

1. **List view:** virtualize fixed-height host rows. Keep the full filtered/sorted array and render only viewport rows plus a small overscan.
2. **Tree view:** flatten expanded groups and hosts into one logical row array, then virtualize that array. During search, evaluate all hosts and expose matching paths even when their groups were collapsed, following Electerm's separation of full-data search from viewport rendering.
3. **Grid view:** virtualize rows of cards, not individual cards. Column count comes from the available width; each virtual row contains that many hosts. A stable card height makes this nearly as predictable as list virtualization. If grouped grid headers make row heights irregular, measure those rows or initially keep grouped mode on the list/tree path.
4. **Do not make "load more" the primary solution.** It bounds first paint but the DOM grows without bound, changes the natural scrollbar, and forces extra reset rules after search, sorting, or import. It can remain only as a temporary fallback.
5. **Keep search semantics independent of rendering.** Filtering, counts, selection, keyboard navigation, and group totals must use full logical results. Only the final visible DOM is windowed.
6. **Keep background import and progress UI.** Report reading, parsing/validation, saving, and completion/error as explicit stages. Neither Tabby nor Electerm supplies a stronger bulk-import UX to copy.

## SecureCRT follow-up

SecureCRT stores saved sessions as individual `.ini` files below its `Sessions`
directory. VanDyke's own recursive-session example walks that directory tree and
explicitly ignores `Default.ini` and `__FolderData__.ini`
([example](https://www.vandyke.com/support/scripting/scripting-examples/interate-over-saved-sessions.html)).
Its session API also describes each session path as relative to the `Sessions`
directory and matching the folders shown in Session Manager
([documentation](https://documentation.help/SecureCRT/SessionConfiguration_Object.htm)).

That makes directory import the natural bulk-import entry point: read every
session file, skip SecureCRT metadata files, and map relative folders to Vault
groups. A single-file choice should remain available for small or partial
imports. SecureCRT's protocol-specific port field is hexadecimal and commonly
appears as `D:"[SSH2] Port"`; it must be read before falling back to port 22.

## Evidence limits

- All product claims above come from official repositories pinned to exact revisions. No benchmark from another project was treated as proof of Netcatty's timings.
- "No progress" means the cited importer contracts and UI coordination paths expose no progress mechanism; it does not claim that every unrelated import feature in those repositories was audited.
- Wave Terminal's tree is supporting architectural evidence, not evidence about its connection picker.
- Virtualization fixes rendering cost. It does not remove the separate costs of parsing, validation, persistence, search, sorting, or rebuilding derived group structures.
