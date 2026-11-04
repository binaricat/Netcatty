import type { TerminalSession } from './models';

type BroadcastSession = Pick<TerminalSession, 'id' | 'workspaceId' | 'hiddenFromTabs'>;

/**
 * The fail-closed password-prompt heuristic pauses broadcasting while an
 * untrusted prompt is on screen. With the opt-in bypass enabled (SecureCRT
 * "Send commands to all sessions" style), input keeps flowing to peer tabs
 * even during interactive / password prompts.
 */
export function shouldBroadcastDuringSensitivePrompt(input: {
  sensitivePromptActive: boolean;
  broadcastPasswordBypass: boolean;
  sensitivePromptSource?: 'heuristic' | 'explicit';
  alternateScreen?: boolean;
}): boolean {
  return !input.sensitivePromptActive || input.broadcastPasswordBypass;
}

export type ComposeSendTarget = 'all' | 'active';

/**
 * Toolbar broadcast is the keystroke fan-out switch. Turning it on or off
 * resets the compose-bar send target to match. A later compose-bar flip does
 * not move the toolbar switch.
 */
export function composeSendTargetAfterToolbarToggle(toolbarEnabled: boolean): ComposeSendTarget {
  return toolbarEnabled ? 'all' : 'active';
}

export function flipComposeSendTarget(target: ComposeSendTarget): ComposeSendTarget {
  return target === 'all' ? 'active' : 'all';
}

export function resolveTerminalBroadcastTargetIds({
  sessions,
  sourceSessionId,
  globalBroadcastEnabled,
  directTargetSessionIds,
  includeGlobalPeersWithoutToolbar = false,
}: {
  sessions: readonly BroadcastSession[];
  sourceSessionId: string;
  globalBroadcastEnabled: boolean;
  directTargetSessionIds?: readonly string[];
  /**
   * Compose-bar "send to all" can target orphan peers while the toolbar
   * (global) broadcast switch stays off. Keystroke fan-out leaves this false.
   */
  includeGlobalPeersWithoutToolbar?: boolean;
}): string[] {
  if (directTargetSessionIds) {
    const directTargetIds = new Set(directTargetSessionIds);
    return sessions
      .filter((session) => directTargetIds.has(session.id))
      .map((session) => session.id);
  }

  const sourceSession = sessions.find((session) => session.id === sourceSessionId);
  if (!sourceSession) return [];

  if (sourceSession.workspaceId) {
    return sessions
      .filter((session) => (
        session.workspaceId === sourceSession.workspaceId
        && session.id !== sourceSessionId
      ))
      .map((session) => session.id);
  }

  if (sourceSession.hiddenFromTabs) return [];
  if (!globalBroadcastEnabled && !includeGlobalPeersWithoutToolbar) return [];

  return sessions
    .filter((session) => (
      !session.workspaceId
      && !session.hiddenFromTabs
      && session.id !== sourceSessionId
    ))
    .map((session) => session.id);
}
