/** Renderer-side Catty tool approval timeout (5 minutes). */
export const CATTY_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * MCP / external SDK approval timeout aligned with Codex MCP limits (~110s).
 * Kept separate from Catty because external agents block on main-process IPC.
 */
export const MCP_APPROVAL_TIMEOUT_MS = 110 * 1000;
