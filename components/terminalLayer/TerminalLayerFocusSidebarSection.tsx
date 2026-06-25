/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { memo } from 'react';

import { TerminalFocusSidebar } from './TerminalFocusSidebar';
import { terminalLayerFocusSidebarPropsEqual } from './terminalLayerViewMemo';

type FocusSidebarContext = Record<string, any>;

function TerminalLayerFocusSidebarSectionInner({ ctx }: { ctx: FocusSidebarContext }) {
  if (!ctx.isFocusMode || !ctx.activeWorkspace) return null;

  return (
    <TerminalFocusSidebar
      activeWorkspace={ctx.activeWorkspace}
      focusedSessionId={ctx.focusedSessionId}
      onReorderWorkspaceSessions={ctx.onReorderWorkspaceSessions}
      onRequestAddToWorkspace={ctx.onRequestAddToWorkspace}
      onCloseSession={ctx.handleCloseSession}
      onCopySession={ctx.onCopySession}
      onCopySessionToNewWindow={ctx.onCopySessionToNewWindow}
      onDetachSessionFromWorkspace={ctx.onRemoveSessionFromWorkspace}
      onSetWorkspaceFocusedSession={ctx.onSetWorkspaceFocusedSession}
      onToggleWorkspaceViewMode={ctx.onToggleWorkspaceViewMode}
      onSubmitSessionRename={ctx.onSubmitSessionRename}
      resolvedPreviewTheme={ctx.resolvedPreviewTheme}
      sessionHostsMap={ctx.sessionHostsMap}
      sessions={ctx.sessions}
      dynamicTabTitleMode={ctx.terminalSettings?.dynamicTabTitleMode}
      t={ctx.t}
    />
  );
}

export const TerminalLayerFocusSidebarSection = memo(
  TerminalLayerFocusSidebarSectionInner,
  (prev, next) => terminalLayerFocusSidebarPropsEqual(prev.ctx, next.ctx),
);
TerminalLayerFocusSidebarSection.displayName = 'TerminalLayerFocusSidebarSection';
