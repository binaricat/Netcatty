/**
 * Extract the payload of an SSE `data:` field.
 *
 * The WHATWG EventSource spec treats the space after the colon as optional
 * and strips at most one leading U+0020. Older AxonHub (0.9) and some
 * intranet OpenAI-compat proxies emit `data:{json}` with no space, which
 * a `data: ` prefix check silently drops (issue #3020).
 *
 * @param {unknown} line
 * @returns {string | null}
 */
function extractSseDataPayload(line) {
  const trimmed = typeof line === "string" ? line.trim() : "";
  if (!trimmed.startsWith("data:")) return null;
  const payload = trimmed.slice("data:".length);
  return payload.startsWith(" ") ? payload.slice(1) : payload;
}

module.exports = { extractSseDataPayload };
