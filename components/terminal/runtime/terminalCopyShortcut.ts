type CopyShortcutKeyEvent = Pick<
  KeyboardEvent,
  "key" | "code" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey"
>;

export function isPlainCtrlCInterruptChord(e: CopyShortcutKeyEvent): boolean {
  return e.ctrlKey
    && !e.shiftKey
    && !e.altKey
    && !e.metaKey
    && (e.key.toLowerCase() === "c" || e.code === "KeyC");
}

export function shouldPassThroughCopyShortcut(
  action: string,
  hasSelection: boolean,
  e: CopyShortcutKeyEvent,
): boolean {
  return action === "copy" && !hasSelection && isPlainCtrlCInterruptChord(e);
}
