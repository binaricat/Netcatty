/** Where an in-app agent runs — distinct from RPC/MCP/CLI capability surfaces. */
export const AGENT_KINDS = {
  /** Chat side panel (Catty). */
  SIDEBAR: 'sidebar',
  /** Future app-wide agent (cross-window / proactive). */
  GLOBAL: 'global',
} as const;

export type AgentKind = (typeof AGENT_KINDS)[keyof typeof AGENT_KINDS];

export const SIDEBAR_AGENT_KIND: AgentKind = AGENT_KINDS.SIDEBAR;
export const GLOBAL_AGENT_KIND: AgentKind = AGENT_KINDS.GLOBAL;
