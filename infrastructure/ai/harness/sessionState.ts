const MAX_DECISIONS = 15;
const MAX_BLOCKERS = 10;

export interface CattySessionState {
  userGoal?: string;
  decisions: string[];
  activeHosts: Record<string, { hostname?: string; lastCommand?: string }>;
  blockers: string[];
  updatedAt: number;
}

function emptyState(): CattySessionState {
  return {
    decisions: [],
    activeHosts: {},
    blockers: [],
    updatedAt: Date.now(),
  };
}

function pushUnique(list: string[], value: string, cap: number): string[] {
  const trimmed = value.trim();
  if (!trimmed || list.includes(trimmed)) return list;
  return [...list, trimmed].slice(-cap);
}

export class SessionStateStore {
  private readonly bySession = new Map<string, CattySessionState>();

  get(chatSessionId: string): CattySessionState {
    return this.bySession.get(chatSessionId) ?? emptyState();
  }

  clear(chatSessionId: string): void {
    this.bySession.delete(chatSessionId);
  }

  mergeFromUserGoal(chatSessionId: string, goal: string | undefined): void {
    if (!goal?.trim()) return;
    const state = { ...this.get(chatSessionId) };
    state.userGoal = goal.trim().slice(0, 500);
    state.updatedAt = Date.now();
    this.bySession.set(chatSessionId, state);
  }

  mergeFromAssistantContent(chatSessionId: string, content: string): void {
    const decisionPatterns = [
      /\bdecided to\b[:\s]+(.{10,200})/i,
      /\bwill use\b[:\s]+(.{10,200})/i,
      /\bconstraint[:\s]+(.{10,200})/i,
    ];
    let state = this.get(chatSessionId);
    for (const pattern of decisionPatterns) {
      const match = content.match(pattern);
      if (match?.[1]) {
        state = {
          ...state,
          decisions: pushUnique(state.decisions, match[1].trim(), MAX_DECISIONS),
          updatedAt: Date.now(),
        };
      }
    }
    this.bySession.set(chatSessionId, state);
  }

  updateFromToolResult(
    chatSessionId: string,
    toolName: string,
    args: Record<string, unknown> | undefined,
    resultText: string,
    isError?: boolean,
  ): void {
    const state = { ...this.get(chatSessionId) };
    const name = toolName.toLowerCase();

    if (name === 'terminal_execute' || name === 'terminal.execute') {
      const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : undefined;
      const command = typeof args?.command === 'string' ? args.command : undefined;
      if (sessionId) {
        state.activeHosts = {
          ...state.activeHosts,
          [sessionId]: {
            ...state.activeHosts[sessionId],
            lastCommand: command,
          },
        };
      }
    }

    if (isError) {
      const preview = resultText.slice(0, 160).replace(/\s+/g, ' ').trim();
      if (preview) {
        state.blockers = pushUnique(state.blockers, `${toolName}: ${preview}`, MAX_BLOCKERS);
      }
    }

    state.updatedAt = Date.now();
    this.bySession.set(chatSessionId, state);
  }

  toReinjectionText(chatSessionId: string): string | undefined {
    const state = this.get(chatSessionId);
    const lines: string[] = [];
    if (state.userGoal) lines.push(`User goal: ${state.userGoal}`);
    if (state.decisions.length) {
      lines.push(`Decisions: ${state.decisions.slice(-5).join('; ')}`);
    }
    const hosts = Object.entries(state.activeHosts);
    if (hosts.length) {
      const hostSummary = hosts
        .slice(-5)
        .map(([id, host]) => `${id}${host.lastCommand ? ` (last: ${host.lastCommand})` : ''}`)
        .join(', ');
      lines.push(`Active hosts: ${hostSummary}`);
    }
    if (state.blockers.length) {
      lines.push(`Open blockers: ${state.blockers.slice(-3).join('; ')}`);
    }
    if (lines.length === 0) return undefined;
    return lines.join('\n');
  }
}

export const globalSessionStateStore = new SessionStateStore();
