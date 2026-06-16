/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { memo } from 'react';

import { TerminalLayerFocusSidebarSection } from './TerminalLayerFocusSidebarSection';
import { TerminalLayerSidePanelSection } from './TerminalLayerSidePanelSection';
import { TerminalLayerWorkspaceSection } from './TerminalLayerWorkspaceSection';
import { terminalLayerViewCtxEqual } from './terminalLayerViewMemo';
import { useTerminalHostTreeLayoutWidth } from '../../application/state/terminalHostTreeStore';

type TerminalLayerViewContext = Record<string, any>;

function TerminalLayerViewInner({ ctx }: { ctx: TerminalLayerViewContext }) {
  const hostTreeLayoutWidth = useTerminalHostTreeLayoutWidth();

  return (
    <div
      ref={ctx.workspaceOuterRef}
      className="absolute inset-0 bg-background flex min-h-0"
      data-section="terminal-workspace"
      style={{
        visibility: ctx.isTerminalLayerVisible ? 'visible' : 'hidden',
        pointerEvents: ctx.isTerminalLayerVisible ? 'auto' : 'none',
        zIndex: ctx.isTerminalLayerVisible ? 10 : 0,
        left: hostTreeLayoutWidth,
      }}
    >
      <TerminalLayerSidePanelSection ctx={ctx} />
      <TerminalLayerFocusSidebarSection ctx={ctx} />
      <TerminalLayerWorkspaceSection ctx={ctx} />
    </div>
  );
}

export const TerminalLayerView = memo(
  TerminalLayerViewInner,
  (prev, next) => terminalLayerViewCtxEqual(prev.ctx, next.ctx),
);
TerminalLayerView.displayName = 'TerminalLayerView';
