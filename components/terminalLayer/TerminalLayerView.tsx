/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { memo } from 'react';

import { TerminalLayerFocusSidebarSection } from './TerminalLayerFocusSidebarSection';
import { TerminalLayerSidePanelSection } from './TerminalLayerSidePanelSection';
import { TerminalLayerWorkspaceSection } from './TerminalLayerWorkspaceSection';
import { terminalLayerViewCtxEqual } from './terminalLayerViewMemo';
import {
  useTerminalHostTreeLayoutTransitionAnimated,
  useTerminalHostTreeLayoutWidth,
} from '../../application/state/terminalHostTreeStore';
import { TERMINAL_HOST_TREE_LEFT_TRANSITION } from '../../application/state/terminalHostTreeAnimation';
import { resolveTerminalLayerSurfaceStyle } from '../terminalPaneVisibility';
import type { PluginSidebarHostActions } from '../../application/state/usePluginTerminalSidebar';

type TerminalLayerViewContext = Record<string, any> & PluginSidebarHostActions;

export function getTerminalLayerViewStyle({
  isTerminalLayerVisible,
  hibernateHiddenTabs,
  hostTreeLayoutWidth,
  hostTreeLayoutAnimated,
}: {
  isTerminalLayerVisible: boolean;
  hibernateHiddenTabs: boolean;
  hostTreeLayoutWidth: number;
  hostTreeLayoutAnimated: boolean;
}): React.CSSProperties {
  const surfaceStyle = resolveTerminalLayerSurfaceStyle(
    isTerminalLayerVisible,
    hibernateHiddenTabs,
  );
  return {
    ...surfaceStyle,
    left: hostTreeLayoutWidth,
    transition: isTerminalLayerVisible && hostTreeLayoutAnimated
      ? TERMINAL_HOST_TREE_LEFT_TRANSITION
      : 'none',
  };
}

function TerminalLayerViewInner({ ctx }: { ctx: TerminalLayerViewContext }) {
  const hostTreeLayoutWidth = useTerminalHostTreeLayoutWidth();
  const hostTreeLayoutAnimated = useTerminalHostTreeLayoutTransitionAnimated();

  const isBottomDock = ctx.sidePanelPosition === 'bottom';

  return (
    <div
      ref={ctx.workspaceOuterRef}
      className={`absolute inset-0 bg-background flex min-h-0${isBottomDock ? ' flex-col' : ''}`}
      data-section="terminal-workspace"
      inert={ctx.isTerminalLayerVisible ? undefined : true}
      style={getTerminalLayerViewStyle({
        isTerminalLayerVisible: ctx.isTerminalLayerVisible,
        hibernateHiddenTabs: ctx.hibernateHiddenTabs,
        hostTreeLayoutWidth,
        hostTreeLayoutAnimated,
      })}
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
