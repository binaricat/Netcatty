import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Normalize line endings to LF (Unix style).
 * Converts CRLF (Windows) and standalone CR (old Mac) to LF.
 * Used for clipboard paste operations in terminal to avoid extra blank lines.
 */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Wrap text in bracketed paste escape sequences.
 * When a terminal application enables bracketed paste mode (CSI ?2004h),
 * pasted text should be wrapped so the application can distinguish paste
 * from typed input (e.g. vim disables autoindent during paste).
 */
export function wrapBracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}

/**
 * Detect if the current platform is macOS.
 * Used for keyboard shortcut handling to differentiate between Mac and PC shortcuts.
 */
export function isMacPlatform(): boolean {
  if (typeof navigator !== 'undefined') {
    return /Mac|iPod|iPhone|iPad/.test(navigator.platform);
  }
  return false;
}
