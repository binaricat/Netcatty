import type { IDisposable, IParser } from "@xterm/xterm";

type CsiParam = number | number[];

/**
 * True when a CSI `?…h` / `?…l` sequence is DEC private mode 2026
 * (synchronized output).
 *
 * xterm's `IFunctionIdentifier` only carries prefix/intermediates/final and
 * `EscapeSequenceParser` keys handlers by exactly those bytes, so a `params`
 * field on the registration is ignored. Registering
 * `{ prefix: "?", final: "h", params: [2026] }` therefore fires for *every*
 * private mode — including the bracketed-paste toggles (`?2004h` / `?2004l`)
 * that bash emits around each prompt, cursor visibility (`?25h` / `?25l`) and
 * the alternate screen (`?1049h` / `?1049l`). The parameters must be checked
 * inside the callback instead.
 */
export const isDec2026SyncModeSequence = (params: readonly CsiParam[]): boolean =>
  params.some((param) => (Array.isArray(param) ? param[0] === 2026 : param === 2026));

export type Dec2026SyncBlockTracker = {
  isInSyncBlock: () => boolean;
  dispose: () => void;
};

/**
 * Tracks DEC 2026 synchronized-output blocks.
 *
 * `isInSyncBlock()` tells the erase-in-display handlers whether a full-screen
 * erase is an in-place TUI redraw (inside a block) or a shell clear, which must
 * move the visible rows into the scrollback so history survives.
 */
export const installDec2026SyncBlockTracker = (
  parser: Pick<IParser, "registerCsiHandler">,
): Dec2026SyncBlockTracker => {
  let inSyncBlock = false;

  const startDisposable: IDisposable = parser.registerCsiHandler(
    { prefix: "?", final: "h" },
    (params) => {
      if (isDec2026SyncModeSequence(params)) {
        inSyncBlock = true;
      }
      return false;
    },
  );
  const endDisposable: IDisposable = parser.registerCsiHandler(
    { prefix: "?", final: "l" },
    (params) => {
      if (isDec2026SyncModeSequence(params)) {
        inSyncBlock = false;
      }
      return false;
    },
  );

  return {
    isInSyncBlock: () => inSyncBlock,
    dispose: () => {
      startDisposable.dispose();
      endDisposable.dispose();
    },
  };
};
