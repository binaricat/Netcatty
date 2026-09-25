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
 * Clipboard-based dictation tools can deliver their transcript by placing it
 * on the clipboard and simulating the system paste shortcut. The #3468
 * reporter confirmed this path for Wispr Flow by remapping Paste to Ctrl+V.
 * In xterm's legacy key path, plain Ctrl+V can reach the remote as \x16
 * (readline quoted-insert) instead of a paste (#3468).
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
