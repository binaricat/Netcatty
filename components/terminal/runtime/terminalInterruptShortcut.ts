type InterruptShortcutEvent = Pick<KeyboardEvent, "altKey" | "code" | "ctrlKey" | "key" | "metaKey" | "shiftKey">;

export function shouldUseUrgentTerminalInterrupt(
  event: InterruptShortcutEvent,
  options: { hasSelection: boolean },
): boolean {
  if (options.hasSelection) return false;
  if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
  return event.code === "KeyC" || event.key.toLowerCase() === "c";
}
