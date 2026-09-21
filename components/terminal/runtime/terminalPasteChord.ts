type PasteChordKeyEvent = Pick<
  KeyboardEvent,
  "key" | "code" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey"
>;

function isPhysicalVKey(e: PasteChordKeyEvent): boolean {
  return e.key.toLowerCase() === "v" || e.code === "KeyV";
}

/**
 * Unmodified Ctrl+V — the system paste chord on Windows.
 *
 * Windows dictation / voice tools (Wispr Flow, Typeless, ...) deliver their
 * transcript by placing it on the clipboard and simulating the system paste
 * shortcut. While the terminal owns keyboard focus the window ignores menu
 * shortcuts, so the chord is not turned into a browser paste event and xterm's
 * legacy path forwards it to the remote as \x16 (readline quoted-insert) — the
 * transcript never lands in the terminal (#3468).
 *
 * Also matches non-Latin layouts via the physical KeyV code, mirroring
 * isPlainCtrlCInterruptChord.
 */
export function isPlainCtrlVPasteChord(e: PasteChordKeyEvent): boolean {
  return e.ctrlKey
    && !e.shiftKey
    && !e.altKey
    && !e.metaKey
    && isPhysicalVKey(e);
}
