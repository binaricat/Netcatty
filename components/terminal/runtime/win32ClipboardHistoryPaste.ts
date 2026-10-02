type PasteChordKeyEvent = Pick<
  KeyboardEvent,
  "key" | "code" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey" | "repeat"
>;

function isPhysicalVKey(e: PasteChordKeyEvent): boolean {
  return e.key?.toLowerCase() === "v" || e.code === "KeyV";
}

/**
 * Plain Ctrl+V as injected by the Windows clipboard history picker (Win+V).
 *
 * The picker delivers the chosen item by synthesizing a Ctrl+V keydown that
 * must not rely on the Electron Edit > Paste menu accelerator (#3582): when
 * the synthesized chord reaches the page unclaimed, xterm encodes it as bare
 * \x16 and the shell shows ^V instead of pasting. Netcatty claims the chord
 * and routes it through the shared clipboard paste path (which reads the live
 * system clipboard via the main-process bridge) instead.
 */
export function isPlainCtrlVPasteChord(e: PasteChordKeyEvent): boolean {
  return Boolean(e.ctrlKey)
    && !e.shiftKey
    && !e.altKey
    && !e.metaKey
    && !e.repeat
    && isPhysicalVKey(e);
}
