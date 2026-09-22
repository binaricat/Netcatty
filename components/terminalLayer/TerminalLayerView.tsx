/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { memo } from 'react';

import { TerminalLayerFocusSidebarSection } from './TerminalLayerFocusSidebarSection';
import { TerminalLayerSidePanelSection } from './TerminalLayerSidePanelSection';
import { TerminalLayerWorkspaceSection } from './TerminalLayerWorkspaceSection';
import { terminalLayerViewCtxEqual } from './terminalLayerViewMemo';
import { useTerminalHostTreeLayoutWidth } from '../../application/state/terminalHostTreeStore';
import { resolveTerminalLayerSurfaceStyle } from '../terminalPaneVisibility';

type TerminalLayerViewContext = Record<string, any>;

function TerminalLayerViewInner({ ctx }: { ctx: TerminalLayerViewContext }) {
  const hostTreeLayoutWidth = useTerminalHostTreeLayoutWidth();
  const surfaceStyle = resolveTerminalLayerSurfaceStyle(
    ctx.isTerminalLayerVisible,
    ctx.hibernateHiddenTabs,
  );

  const isBottomDock = ctx.sidePanelPosition === 'bottom';

  return (
    <div
      ref={ctx.workspaceOuterRef}
      className={`absolute inset-0 bg-background flex min-h-0${isBottomDock ? ' flex-col' : ''}`}
      data-section="terminal-workspace"
      inert={ctx.isTerminalLayerVisible ? undefined : true}
      style={{
        ...surfaceStyle,
        left: hostTreeLayoutWidth,
      }}
    >
      {/* Keep TerminalLayerSidePanelSection at a stable tree position (first
          child) so cycling between side and bottom docks reorders it via flex
          `order` instead of unmounting/recreating it. The wrapper below uses
          `display: contents` in side-dock mode so its children participate in
          the outer flex row exactly like direct children. */}
      <TerminalLayerSidePanelSection ctx={ctx} />
      <div
        data-section="terminal-workspace-row"
        className={isBottomDock ? 'flex min-h-0 w-full flex-1' : 'contents'}
      >
        <TerminalLayerFocusSidebarSection ctx={ctx} />
        <TerminalLayerWorkspaceSection ctx={ctx} />
      </div>
    </div>
  );
}

export const TerminalLayerView = memo(
  TerminalLayerViewInner,
  (prev, next) => terminalLayerViewCtxEqual(prev.ctx, next.ctx),
);
TerminalLayerView.displayName = 'TerminalLayerView';
