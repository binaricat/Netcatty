const ESCAPE = "\u001b";

/** xterm.js-generated OSC color query responses, including dynamic and palette colors. */
const OSC_COLOR_QUERY_RESPONSE_PATTERN = new RegExp(
  `${ESCAPE}\\](?:4;\\d{1,3}|10|11|12);rgb:[0-9a-f]{1,4}\\/[0-9a-f]{1,4}\\/[0-9a-f]{1,4}(?:\\u0007|${ESCAPE}\\\\)`,
  "giu",
);

/**
 * Optionally removes terminal color query replies.
 *
 * Matches only responses with a complete OSC control prefix and terminator;
 * ordinary text and other ANSI/OSC data remain unchanged. Apply this helper
 * only at xterm.js onData egress, not to remote output parsing, because the
 * same format can represent a color-setting sequence.
 */
export const stripOscColorQueryResponses = (data: string, enabled: boolean): string => (
  enabled ? data.replace(OSC_COLOR_QUERY_RESPONSE_PATTERN, "") : data
);
