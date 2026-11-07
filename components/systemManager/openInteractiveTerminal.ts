import { canReuseTerminalConnection } from '../../application/state/terminalConnectionReuse';
import { writeSystemManagerDiagnostic } from '../../application/state/systemManagerDiagnostics';
import type { TerminalSession } from '../../types';
import type { TerminalPopupIcon } from '../../domain/systemManager/types';
import type { useSystemManagerBackend } from '../../application/state/useSystemManagerBackend';

type Backend = ReturnType<typeof useSystemManagerBackend>;

function readSystemPanelClientRect(): { x: number; y: number; width: number; height: number } | undefined {
  if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") return undefined;
  const panels = document.querySelectorAll('[data-section="system-manager-panel"]');
  for (const panel of panels) {
    if (typeof panel.getBoundingClientRect !== "function") continue;
    const rect = panel.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }
  return undefined;
}

function buildPopupTitle(parentSession: TerminalSession, title: string): string {
  const hostLabel = parentSession.hostLabel.trim();
  const cleanTitle = title.trim();
  if (!hostLabel || !cleanTitle) return cleanTitle || hostLabel;
  if (cleanTitle === hostLabel || cleanTitle.startsWith(`${hostLabel} · `)) return cleanTitle;
  return `${hostLabel} · ${cleanTitle}`;
}

function buildCommandPopupSourceSession(
  parentSession: TerminalSession,
  startupCommand: string,
  canReuseConnection: boolean,
): TerminalSession {
  const runtimeProtocol = parentSession.protocol as TerminalSession['protocol'] | 'mosh' | 'et' | undefined;
  const shouldUseSshShell =
    runtimeProtocol === undefined ||
    runtimeProtocol === 'ssh' ||
    runtimeProtocol === 'mosh' ||
    runtimeProtocol === 'et' ||
    parentSession.moshEnabled === true ||
    parentSession.etEnabled === true;

  return {
    ...parentSession,
    ...(shouldUseSshShell
      ? {
        protocol: 'ssh' as const,
        moshEnabled: false,
        etEnabled: false,
      }
      : {}),
    startupCommand,
    reuseConnectionFromSessionId: canReuseConnection
      ? parentSession.id
      : undefined,
  };
}

export interface OpenInteractiveTerminalOptions {
  icon?: TerminalPopupIcon;
  /**
   * 'popup' (default) opens a separate window; 'tab' delegates to `onOpenTab`
   * so the attach command runs in a new main-window tab. Falls back to the
   * popup when no `onOpenTab` handler is wired.
   */
  target?: 'popup' | 'tab';
  onOpenTab?: (payload: { title: string; startupCommand: string }) => void;
}

export async function openInteractiveTerminal(
  backend: Backend,
  parentSession: TerminalSession,
  title: string,
  startupCommand: string,
  options?: OpenInteractiveTerminalOptions,
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
    target: options?.target ?? 'popup',
  });
  if (options?.target === 'tab' && options.onOpenTab) {
    options.onOpenTab({ title: popupTitle, startupCommand });
    await writeSystemManagerDiagnostic('openInteractiveTerminal result', {
      title: popupTitle,
      success: true,
      target: 'tab',
    });
    return { success: true };
  }
  const avoidClientRect = readSystemPanelClientRect();
  const result = await backend.openTerminalPopup({
    title: popupTitle,
    icon: options?.icon,
    parentSessionId: parentSession.id,
    startupCommand,
    ...(avoidClientRect ? { avoidClientRect } : {}),
    sourceSession: buildCommandPopupSourceSession(parentSession, startupCommand, canReuseConnection),
  });
  await writeSystemManagerDiagnostic('openInteractiveTerminal result', {
    title: popupTitle,
    success: result.success,
    error: result.error,
    popupId: result.popupId,
  });
  return result;
}
