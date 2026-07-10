/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { memo } from 'react';

import { TerminalLayerFocusSidebarSection } from './TerminalLayerFocusSidebarSection';
import { TerminalLayerSidePanelSection } from './TerminalLayerSidePanelSection';
import { TerminalLayerWorkspaceSection } from './TerminalLayerWorkspaceSection';
import { terminalLayerViewCtxEqual } from './terminalLayerViewMemo';
import { useTerminalHostTreeLayoutWidth } from '../../application/state/terminalHostTreeStore';
import { resolveTerminalHibernateEnabled } from '../../domain/terminalHibernate';
import { resolveTerminalLayerSurfaceStyle } from '../terminalPaneVisibility';

type TerminalLayerViewContext = Record<string, any>;

function TerminalLayerViewInner({ ctx }: { ctx: TerminalLayerViewContext }) {
  const hostTreeLayoutWidth = useTerminalHostTreeLayoutWidth();
  const surfaceStyle = resolveTerminalLayerSurfaceStyle(
    ctx.isTerminalLayerVisible,
    resolveTerminalHibernateEnabled(ctx.terminalSettings),
  );

  return (
    <div
      ref={ctx.workspaceOuterRef}
      className="absolute inset-0 bg-background flex min-h-0"
      data-section="terminal-workspace"
      inert={ctx.isTerminalLayerVisible ? undefined : true}
      style={{
        ...surfaceStyle,
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
