import type { TerminalSession } from './models';

/**
 * Session fields that affect terminal pane React trees (xterm host, layout,
 * connect/startup chrome). Presentation-only fields used by TopTabs
 * (`dynamicTitle`, `codingCliProviderId`) are intentionally ignored so title
 * churn does not invalidate TerminalLayer / TerminalPanesHost memoization.
 *
 * Keep this list aligned with props TerminalPane passes into `<Terminal />`.
 */
export type TerminalPaneSessionFields = Pick<
  TerminalSession,
  | 'id'
  | 'hostId'
  | 'workspaceId'
  | 'status'
  | 'protocol'
  | 'hostname'
  | 'username'
  | 'port'
  | 'moshEnabled'
  | 'etEnabled'
  | 'fontSize'
  | 'fontSizeOverride'
  | 'customName'
  | 'hostLabel'
  | 'hiddenFromTabs'
  | 'localShell'
  | 'localShellName'
  | 'localShellArgs'
  | 'localStartDir'
  | 'shellType'
  | 'charset'
  | 'serialConfig'
  | 'pluginConnection'
  | 'restoreState'
  | 'pendingInitialCwd'
  | 'startupCommand'
  | 'noAutoRun'
  | 'multiLineRunMode'
  | 'pendingScriptId'
  | 'pendingScript'
  | 'reuseConnectionFromSessionId'
  | 'requireFreshConnection'
  | 'autoOpenSidePanel'
>;

function paneFieldEqual(
  a: TerminalPaneSessionFields,
  b: TerminalPaneSessionFields,
): boolean {
  return a.id === b.id
    && a.hostId === b.hostId
    && a.workspaceId === b.workspaceId
    && a.status === b.status
    && a.protocol === b.protocol
    && a.hostname === b.hostname
    && a.username === b.username
    && (a.port ?? 22) === (b.port ?? 22)
    && Boolean(a.moshEnabled) === Boolean(b.moshEnabled)
    && Boolean(a.etEnabled) === Boolean(b.etEnabled)
    && a.fontSize === b.fontSize
    && Boolean(a.fontSizeOverride) === Boolean(b.fontSizeOverride)
    && a.customName === b.customName
    && a.hostLabel === b.hostLabel
    && Boolean(a.hiddenFromTabs) === Boolean(b.hiddenFromTabs)
    && a.localShell === b.localShell
    && a.localShellName === b.localShellName
    && a.localShellArgs === b.localShellArgs
    && a.localStartDir === b.localStartDir
    && a.shellType === b.shellType
    && a.charset === b.charset
    && a.serialConfig === b.serialConfig
    && a.pluginConnection === b.pluginConnection
    && a.restoreState === b.restoreState
    && a.pendingInitialCwd === b.pendingInitialCwd
    && a.startupCommand === b.startupCommand
    && Boolean(a.noAutoRun) === Boolean(b.noAutoRun)
    && a.multiLineRunMode === b.multiLineRunMode
    && a.pendingScriptId === b.pendingScriptId
    && a.pendingScript === b.pendingScript
    && a.reuseConnectionFromSessionId === b.reuseConnectionFromSessionId
    && Boolean(a.requireFreshConnection) === Boolean(b.requireFreshConnection)
    && a.autoOpenSidePanel === b.autoOpenSidePanel;
}

export function terminalPaneSessionsEqual(
  prev: ReadonlyArray<TerminalPaneSessionFields> | null | undefined,
  next: ReadonlyArray<TerminalPaneSessionFields> | null | undefined,
): boolean {
  if (prev === next) return true;
  if (!prev || !next) return false;
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i += 1) {
    const a = prev[i];
    const b = next[i];
    if (!a || !b) return false;
    if (a === b) continue;
    if (!paneFieldEqual(a, b)) return false;
  }
  return true;
}

/**
 * Keep the previous sessions array identity when only TopTabs presentation
 * fields changed. Used by App domain memos so title/provider live updates do
 * not rebuild appTerminalDomain / appChromeDomain.
 */
export function retainStableSessionsIgnoringPresentation(
  previous: readonly TerminalSession[] | null | undefined,
  next: readonly TerminalSession[],
): readonly TerminalSession[] {
  if (previous && terminalPaneSessionsEqual(previous, next)) {
    return previous;
  }
  return next;
}
