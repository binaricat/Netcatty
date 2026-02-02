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
 * Detect if the current platform is macOS.
 * Used for keyboard shortcut handling to differentiate between Mac and PC shortcuts.
 */
export function isMacPlatform(): boolean {
  if (typeof navigator !== 'undefined') {
    return /Mac|iPod|iPhone|iPad/.test(navigator.platform);
  }
  return false;
}