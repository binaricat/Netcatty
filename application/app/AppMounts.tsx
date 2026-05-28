import React, { Suspense, lazy, useEffect, useState } from 'react';
import { useActiveTabId, useIsSftpActive, useIsTerminalLayerVisible, useIsVaultActive } from '../state/activeTabStore';
import { cn } from '../../lib/utils';
import { ConnectionLog, TerminalTheme } from '../../types';
import type { LogView as LogViewType } from '../state/logViewState';
import type { SftpView as SftpViewComponent } from '../../components/SftpView';
import type { TerminalLayer as TerminalLayerComponent } from '../../components/TerminalLayer';

// Visibility container for VaultView - isolates isActive subscription
export const VaultViewContainer: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const isActive = useIsVaultActive();
  const containerStyle: React.CSSProperties = isActive
    ? {}
    : { visibility: 'hidden', pointerEvents: 'none', position: 'absolute', zIndex: -1 };

  return (
    <div className={cn("absolute inset-0", isActive ? "z-20" : "")} style={containerStyle}>
      {children}
    </div>
  );
};

// LogView wrapper - manages visibility based on active tab
interface LogViewWrapperProps {
  logView: LogViewType;
  defaultTerminalTheme: TerminalTheme;
  defaultFontSize: number;
  onClose: () => void;
  onUpdateLog: (logId: string, updates: Partial<ConnectionLog>) => void;
}

export const LogViewWrapper: React.FC<LogViewWrapperProps> = ({ logView, defaultTerminalTheme, defaultFontSize, onClose, onUpdateLog }) => {
  const activeTabId = useActiveTabId();
  const isVisible = activeTabId === logView.id;

  // Use same pattern as VaultViewContainer for visibility
  const containerStyle: React.CSSProperties = isVisible
    ? {}
    : { visibility: 'hidden', pointerEvents: 'none', position: 'absolute', zIndex: -1 };

  return (
    <div className={cn("absolute inset-0", isVisible ? "z-20" : "")} style={containerStyle}>
      <Suspense fallback={null}>
        <LazyLogView
          log={logView.log}
          defaultTerminalTheme={defaultTerminalTheme}
          defaultFontSize={defaultFontSize}
          isVisible={isVisible}
          onClose={onClose}
          onUpdateLog={onUpdateLog}
        />
      </Suspense>
    </div>
  );
};

const LazyLogView = lazy(() => import('../../components/LogView'));

const LazySftpView = lazy(() =>
  import('../../components/SftpView').then((m) => ({ default: m.SftpView })),
);

const LazyTerminalLayer = lazy(() =>
  import('../../components/TerminalLayer').then((m) => ({ default: m.TerminalLayer })),
);

type SftpViewProps = React.ComponentProps<typeof SftpViewComponent>;
type TerminalLayerProps = React.ComponentProps<typeof TerminalLayerComponent>;

export const SftpViewMount: React.FC<SftpViewProps> = (props) => {
  const isActive = useIsSftpActive();
  const [shouldMount, setShouldMount] = useState(isActive);

  useEffect(() => {
    if (isActive) setShouldMount(true);
  }, [isActive]);

  if (!shouldMount) return null;

  return (
    <Suspense fallback={null}>
      <LazySftpView {...props} />
    </Suspense>
  );
};

export const TerminalLayerMount: React.FC<TerminalLayerProps> = (props) => {
  const isVisible = useIsTerminalLayerVisible(props.draggingSessionId);
  const [shouldMount, setShouldMount] = useState(isVisible);

  useEffect(() => {
    if (isVisible) setShouldMount(true);
  }, [isVisible]);

  useEffect(() => {
    if (shouldMount) return;
    type IdleWindow = Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    const idleWindow = window as IdleWindow;
    if (typeof idleWindow.requestIdleCallback === "function") {
      const id = idleWindow.requestIdleCallback(() => setShouldMount(true), { timeout: 5000 });
      return () => idleWindow.cancelIdleCallback?.(id);
    }
    const id = window.setTimeout(() => setShouldMount(true), 5000);
    return () => window.clearTimeout(id);
  }, [shouldMount]);

  const shouldRender = shouldMount || isVisible;

  if (!shouldRender) return null;

  return (
    <Suspense fallback={null}>
      <LazyTerminalLayer {...props} />
    </Suspense>
  );
};
