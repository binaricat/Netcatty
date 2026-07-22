type InterruptShortcutEvent = Pick<KeyboardEvent, "altKey" | "code" | "ctrlKey" | "key" | "metaKey" | "shiftKey">;

export function shouldUseUrgentTerminalInterrupt(
  event: InterruptShortcutEvent,
  options: { hasSelection: boolean },
): boolean {
  if (options.hasSelection) return false;
  if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
  if (/^[\x20-\x7e]$/.test(event.key)) return event.key.toLowerCase() === "c";
  return event.code === "KeyC" || event.key.toLowerCase() === "c";
}
