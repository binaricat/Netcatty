const DEFAULT_TOOLTIP_MAX_CHARS = 280;
const DEFAULT_TOOLTIP_MAX_LINES = 8;

export function flattenSnippetCommandPreview(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

/** Truncate multi-line snippet/script commands for compact tooltip previews. */
export function formatSnippetCommandTooltip(
  command: string,
  options?: { maxChars?: number; maxLines?: number },
): string {
  if (!command.trim()) return "";

  const maxChars = options?.maxChars ?? DEFAULT_TOOLTIP_MAX_CHARS;
  const maxLines = options?.maxLines ?? DEFAULT_TOOLTIP_MAX_LINES;
  const normalized = command.replace(/\r\n/g, "\n").trimEnd();
  const lines = normalized.split("\n");

  let preview = lines.slice(0, maxLines).join("\n");
  const truncatedByLines = lines.length > maxLines;

  if (preview.length > maxChars) {
    preview = preview.slice(0, maxChars).replace(/\s+$/, "");
  }

  const truncated = truncatedByLines || normalized.length > preview.length;
  if (truncated && !preview.endsWith("…")) {
    preview += "…";
  }

  return preview;
}
