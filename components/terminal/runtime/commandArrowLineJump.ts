/** macOS line editing fallback for shells using readline/ZLE bindings. */
export function commandArrowLineJumpSequence(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "altKey" | "ctrlKey" | "shiftKey" | "isComposing" | "keyCode">,
  isMac: boolean,
): string | null {
  if (!isMac || !e.metaKey || e.altKey || e.ctrlKey || e.shiftKey) return null;
  if (e.isComposing || e.keyCode === 229) return null;
  if (e.key === "ArrowLeft") return "\x01";
  if (e.key === "ArrowRight") return "\x05";
  return null;
}
