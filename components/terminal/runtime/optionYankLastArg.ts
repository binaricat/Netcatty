export interface OptionYankLastArgKeyEvent {
  key: string;
  code?: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

const isPeriodKey = (e: OptionYankLastArgKeyEvent): boolean => (
  e.code === "Period" || e.key === "." || e.key === "≥"
);

const isUnderscoreKey = (e: OptionYankLastArgKeyEvent): boolean => (
  e.key === "_" || (e.code === "Minus" && e.shiftKey)
);

/**
 * macOS Option+. / Option+_ → readline yank-last-arg (issue #2364).
 *
 * Ghostty/iTerm2/kitty/VS Code do not implement this themselves — they pass
 * Meta-. through to bash/zsh. On macOS, Option+. types "≥" unless Option is
 * Meta, so map those two physical keys to ESC+. / ESC+_ without turning every
 * Option chord into Meta (unlike `altAsMeta`).
 *
 * Gated to macOS: Linux/Windows Alt+. already sends the ESC prefix via xterm.
 */
export function optionYankLastArgSequence(
  e: OptionYankLastArgKeyEvent,
  isMac: boolean,
): string | null {
  if (!isMac) return null;
  if (!e.altKey || e.ctrlKey || e.metaKey) return null;
  if (isPeriodKey(e) && !e.shiftKey) return "\x1b.";
  if (isUnderscoreKey(e)) return "\x1b_";
  return null;
}
