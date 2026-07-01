import type { Terminal } from '@xterm/xterm';
import type { TerminalTheme } from '../../domain/models';
import { forceSyncRenderAfterResize } from './terminalHelpers';

type PendingUpdate = {
  theme: TerminalTheme;
  visible: boolean;
  focused: boolean;
  getTerminal: () => Terminal | null;
};

const pendingBySession = new Map<string, PendingUpdate>();
let flushScheduled = false;

function themeFingerprint(theme: TerminalTheme): string {
  return `${theme.id}:${theme.colors.background}:${theme.colors.foreground}:${theme.colors.cursor}`;
}

function applyThemeToTerminal(term: Terminal, theme: TerminalTheme): void {
  term.options.theme = {
    ...theme.colors,
    selectionBackground: theme.colors.selection,
    scrollbarSliderBackground: theme.colors.foreground + '33',
    scrollbarSliderHoverBackground: theme.colors.foreground + '66',
    scrollbarSliderActiveBackground: theme.colors.foreground + '80',
  };
  forceSyncRenderAfterResize(term);
}

export function applyTerminalThemeSync(term: Terminal, theme: TerminalTheme): void {
  applyThemeToTerminal(term, theme);
}

function flushPendingUpdates(): void {
  flushScheduled = false;
  const entries = [...pendingBySession.entries()];
  pendingBySession.clear();

  const visible = entries.filter(([, update]) => update.visible || update.focused);
  const hidden = entries.filter(([, update]) => !update.visible && !update.focused);

  for (const [, update] of visible) {
    const term = update.getTerminal();
    if (!term) continue;
    applyThemeToTerminal(term, update.theme);
  }

  const runHidden = () => {
    for (const [, update] of hidden) {
      const term = update.getTerminal();
      if (!term) continue;
      applyThemeToTerminal(term, update.theme);
    }
  };

  if (hidden.length === 0) return;
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(runHidden);
  } else {
    setTimeout(runHidden, 0);
  }
}

export function cancelTerminalThemeUpdate(sessionId: string): void {
  pendingBySession.delete(sessionId);
}

export function scheduleTerminalThemeUpdate(
  sessionId: string,
  theme: TerminalTheme,
  options: { visible: boolean; focused: boolean },
  getTerminal: () => Terminal | null,
): void {
  const existing = pendingBySession.get(sessionId);
  if (existing && themeFingerprint(existing.theme) === themeFingerprint(theme)) {
    pendingBySession.set(sessionId, {
      theme,
      visible: existing.visible || options.visible,
      focused: existing.focused || options.focused,
      getTerminal,
    });
  } else {
    pendingBySession.set(sessionId, {
      theme,
      visible: options.visible,
      focused: options.focused,
      getTerminal,
    });
  }

  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(flushPendingUpdates);
}

export function resetTerminalThemeSchedulerForTests(): void {
  pendingBySession.clear();
  flushScheduled = false;
}
