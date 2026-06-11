import { canReuseTerminalConnection } from '../../application/state/terminalConnectionReuse';
import { writeSystemManagerDiagnostic } from '../../application/state/systemManagerDiagnostics';
import type { TerminalSession } from '../../types';
import type { TerminalPopupIcon } from '../../domain/systemManager/types';
import type { useSystemManagerBackend } from '../../application/state/useSystemManagerBackend';

type Backend = ReturnType<typeof useSystemManagerBackend>;

function buildPopupTitle(parentSession: TerminalSession, title: string): string {
  const hostLabel = parentSession.hostLabel.trim();
  const cleanTitle = title.trim();
  if (!hostLabel || !cleanTitle) return cleanTitle || hostLabel;
  if (cleanTitle === hostLabel || cleanTitle.startsWith(`${hostLabel} · `)) return cleanTitle;
  return `${hostLabel} · ${cleanTitle}`;
}

export async function openInteractiveTerminal(
  backend: Backend,
  parentSession: TerminalSession,
  title: string,
  startupCommand: string,
  options?: { icon?: TerminalPopupIcon },
): Promise<{ success: boolean; error?: string }> {
  const canReuseConnection = canReuseTerminalConnection(parentSession);
  const popupTitle = buildPopupTitle(parentSession, title);
  await writeSystemManagerDiagnostic('openInteractiveTerminal requested', {
    title: popupTitle,
    parentSessionId: parentSession.id,
    parentProtocol: parentSession.protocol,
    parentHostLabel: parentSession.hostLabel,
    startupCommand,
    canReuseConnection,
    hasIcon: !!options?.icon,
  });
  const result = await backend.openTerminalPopup({
    title: popupTitle,
    icon: options?.icon,
    parentSessionId: parentSession.id,
    startupCommand,
    sourceSession: {
      ...parentSession,
      startupCommand,
      reuseConnectionFromSessionId: canReuseConnection
        ? parentSession.id
        : undefined,
    },
  });
  await writeSystemManagerDiagnostic('openInteractiveTerminal result', {
    title: popupTitle,
    success: result.success,
    error: result.error,
    popupId: result.popupId,
  });
  return result;
}
