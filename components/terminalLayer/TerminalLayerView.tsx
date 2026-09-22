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
      {isBottomDock ? (
        <>
          <div className="flex min-h-0 w-full flex-1">
            <TerminalLayerFocusSidebarSection ctx={ctx} />
            <TerminalLayerWorkspaceSection ctx={ctx} />
          </div>
          <TerminalLayerSidePanelSection ctx={ctx} />
        </>
      ) : (
        <>
          <TerminalLayerSidePanelSection ctx={ctx} />
          <TerminalLayerFocusSidebarSection ctx={ctx} />
          <TerminalLayerWorkspaceSection ctx={ctx} />
        </>
      )}
    </div>
  );
}

export const TerminalLayerView = memo(
  TerminalLayerViewInner,
  (prev, next) => terminalLayerViewCtxEqual(prev.ctx, next.ctx),
);
TerminalLayerView.displayName = 'TerminalLayerView';
