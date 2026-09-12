# Local native file drag

Local filesystem panes hand real files and folders to Electron's native drag API.
Remote SFTP panes retain their HTML drag payload and transfer callbacks. This
applies to both panes and the list and tree views; no SFTP download or temporary
copy is involved in the new drag path.

## Boundaries

- `isLocal === true` is required at the source. Native IPC accepts only the main
  frame of a registered app-content window during an active left-button gesture.
- Metadata validation accepts existing files, directories, and valid symlinks,
  preserving the link path. It rejects relative paths, Windows device paths,
  broken links and special files. It does not read content or traverse folders.
- Input tracking in the main process prevents asynchronous metadata validation
  from starting a drag after mouse release, Escape, or a replacement gesture.
- Chromium can emit a synthetic `mouseup` when HTML `dragstart` is canceled.
  Renderer cleanup must not treat this as completion of the native handoff.
- Drop cleanup runs in a timer, not a microtask: native event dispatch can drain
  microtasks between window capture and React bubble handlers.
- Electron does not expose a portable native-drag completion callback. The
  renderer consumes matching drops once and clears its identity on subsequent
  physical input, Escape, focus loss, page exit, or source connection disposal.
  A successful start reply is never treated as a completed transfer.
- Native drops returning to the source window must match every selected path
  before using the existing internal copy/move callbacks. Other OS drops retain
  the external-upload flow. Filesystem services and conflict handling are unchanged.
- Electron advertises COPY/LINK on Windows/Linux. The drop target negotiates an
  allowed effect while the existing same-pane callback performs a local move;
  Netcatty never requests an OS deletion of the source on external delivery.

## Automated checks

```sh
npm run lint
node --test --import tsx components/sftp/*.test.ts application/state/sftp/localFileDrag.test.ts electron/bridges/localFileDragBridge.test.cjs electron/preload/api.localFileDrag.test.cjs electron/bridges/registerBridgesTransferLimits.test.cjs
npm run build
```

The regression tests cover local selection, path matching, single delivery,
copy/move routing, remote HTML drag, connection replacement, cancellation,
invalid IPC senders, missing files, symlinks, Windows drives/UNC and native effects.

## Interactive Electron check

```sh
npm run test:local-file-drag:electron
```

The fixture uses the actual list hook, preload methods and main-process native
bridge. It creates disposable files and a destination directory under Netcatty's
own temp directory and uses a separate Electron profile. It never connects to an
SFTP server. Its copy/move callbacks **record intent**, rather than modifying files.

Drag a file or folder to the blue native target: expect `NATIVE_DROP` with real
filesystem paths. Drag between panes: expect one `INTERNAL_COPY`. Drag a file onto
a folder in the same pane: expect one `INTERNAL_MOVE`. Toggle the source to remote:
its outgoing gesture must remain HTML text and its internal drop must still call
`INTERNAL_COPY`. Close the test window when finished. The fixture directory is
printed in the terminal and retained for inspecting copied files.

## Manual acceptance matrix

Run on macOS, Windows 11, and Linux using a desktop file manager and the full app:

1. Drag single files, multiple files, folders and mixed selections from list and
   tree views into the file manager. Compare names, content and folder structure;
   verify no text clipping or lost originals.
2. Open a supported certificate/keystore by dropping it onto KeyStore Explorer,
   comparing with the same file dragged from the desktop file manager.
3. Check local-to-local, local-to-SFTP and same-pane folder moves in the full app,
   including nested tree entries, conflicts and cancellation. Check both sides.
4. Check unchanged remote-to-local and remote-to-remote drags against a test host.
5. Cancel with Escape, release over an invalid target, change/close the source
   connection, then drag another file from the OS. No previous selection may be
   transferred. Repeat quick gestures and files removed just before dragging.

## Validation recorded during implementation (2026-09-12)

- Lint and production build passed; 167 targeted/regression tests passed.
- Full `npm test` passed on macOS: 11,693 tests, 11,665 passed, 28 skipped,
  zero failures (143 seconds), including the npm pretest checks, with the agent's
  `LC_ALL=C.UTF-8` environment. The initial
  sandboxed run hit `EPERM` when opening local test servers; the complete rerun
  outside that sandbox passed.
- A subsequent user run reported ten failures. Eight server-stats failures were
  reproduced with `LC_ALL=es_ES.UTF-8` in both the working tree and unmodified
  HEAD `8be56264fc6a3b93aacdc91277a11d0753c822f4`: the 26 `getServerStats`
  tests give 18 passes / 8 failures in Spanish and 26 passes / 0 failures with
  `LC_ALL=C` in both copies. Locale-sensitive awk decimal commas conflict with
  the stats record delimiter. This is a pre-existing locale bug, not a drag regression.
- The other two reported failures involve interactive zsh (`TTY read` I/O error
  and missing wrapper output). Targeted reruns pass; their cause remains unconfirmed.
  Neither these tests nor their shell implementation was changed by this work.
- Full TypeScript checking reports 731 diagnostics both before and after this
  change (verified against a separate HEAD snapshot; no added diagnostics).
- Real Electron on macOS produced native file and folder receipts. Automated
  pointer gestures were intermittent. Manual receipts exposed premature drop
  cleanup, now corrected and regression-tested. A final native internal-copy/move
  retest, the full macOS manual matrix, Finder copies and KeyStore Explorer
  interoperability still require desktop verification.
- Windows 11 and Linux desktop runtime checks were completed successfully by
  the contributor, as reported after implementation. These are manual validation
  results supplied by the contributor; the agent did not run those desktop checks.
