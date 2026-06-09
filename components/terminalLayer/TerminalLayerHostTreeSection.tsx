/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { memo } from 'react';

import { TerminalHostTreeSidebar } from './TerminalHostTreeSidebar';
import { terminalLayerHostTreePropsEqual } from './terminalLayerViewMemo';

type HostTreeContext = Record<string, any>;

function TerminalLayerHostTreeSectionInner({ ctx }: { ctx: HostTreeContext }) {
  return (
    <TerminalHostTreeSidebar
      enabled={ctx.showHostTreeSidebar !== false}
      hosts={ctx.hosts}
      customGroups={ctx.customGroups}
      resolvedPreviewTheme={ctx.resolvedPreviewTheme}
      activeHostId={ctx.activeHostIdForSidebar}
      onConnect={ctx.onConnectToHost}
      onCreateLocalTerminal={ctx.onCreateLocalTerminal}
    />
  );
}

export const TerminalLayerHostTreeSection = memo(
  TerminalLayerHostTreeSectionInner,
  (prev, next) => terminalLayerHostTreePropsEqual(prev.ctx, next.ctx),
);
TerminalLayerHostTreeSection.displayName = 'TerminalLayerHostTreeSection';
