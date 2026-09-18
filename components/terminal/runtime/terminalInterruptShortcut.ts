type InterruptShortcutEvent = Pick<KeyboardEvent, "altKey" | "code" | "ctrlKey" | "key" | "metaKey" | "shiftKey">;

/**
 * macOS Terminal convention: Command-Period interrupts the running
 * command, equivalent to Ctrl+C. Netcatty does not bind Command-Period elsewhere, so on
 * macOS it is forwarded as a SIGINT interrupt (#3408).
 */
export function isMacCommandPeriodInterruptChord(
  event: InterruptShortcutEvent,
): boolean {
  if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  if (/^[\x20-\x7e]$/.test(event.key)) return event.key === ".";
  return event.code === "Period" || event.key === ".";
}

export function shouldUseUrgentTerminalInterrupt(
  event: InterruptShortcutEvent,
  options: { hasSelection: boolean },
): boolean {
  if (options.hasSelection) return false;
  if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
  if (/^[\x20-\x7e]$/.test(event.key)) return event.key.toLowerCase() === "c";
  return event.code === "KeyC" || event.key.toLowerCase() === "c";
}
