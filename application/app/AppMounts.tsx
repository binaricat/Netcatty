import React, { Suspense, lazy, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useActiveTabId, useIsSftpActive, useIsVaultActive } from '../state/activeTabStore';
import { useTerminalHostTreeLayoutWidth } from '../state/terminalHostTreeStore';
import { isTerminalContentTabSurface } from './workTabSurface';
import { cn } from '../../lib/utils';
import { ConnectionLog, TerminalTheme } from '../../types';
import { LazyLoadBoundary } from '../../components/ui/lazy-load-boundary';
import type { LogView as LogViewType } from '../state/logViewState';
import type { SftpView as SftpViewComponent } from '../../components/SftpView';
import type { TerminalLayer as TerminalLayerComponent } from '../../components/TerminalLayer';

// Visibility container for VaultView - isolates isActive subscription
export const VaultViewContainer: React.FC<{
  children: React.ReactNode;
  appThemeStyle?: React.CSSProperties;
}> = ({ children, appThemeStyle }) => {
  const isActive = useIsVaultActive();
  const wasActiveRef = useRef(isActive);
  const [suppressActiveTransition, setSuppressActiveTransition] = useState(false);
  const isActivating = isActive && !wasActiveRef.current;
  const shouldSuppressTransition = isActivating || suppressActiveTransition;
  const containerStyle: React.CSSProperties = isActive
    ? {}
    : { visibility: 'hidden', pointerEvents: 'none', position: 'absolute', zIndex: -1 };

  useLayoutEffect(() => {
    const wasActive = wasActiveRef.current;
    wasActiveRef.current = isActive;
    if (!isActive || wasActive) return;

    setSuppressActiveTransition(true);
    const view = window;
    let firstFrame = 0;
    let secondFrame = 0;
    firstFrame = view.requestAnimationFrame(() => {
      secondFrame = view.requestAnimationFrame(() => {
        setSuppressActiveTransition(false);
      });
    });

    return () => {
      view.cancelAnimationFrame(firstFrame);
      view.cancelAnimationFrame(secondFrame);
    };
  }, [isActive]);

  return (
    <div
      className={cn("absolute inset-0", isActive ? "z-20" : "")}
      data-inactive-app-surface={isActive ? undefined : "true"}
      data-app-surface-transition-suppressed={shouldSuppressTransition ? "true" : undefined}
      style={{ ...appThemeStyle, ...containerStyle }}
    >
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

export function getLogViewWrapperStyle(
  isVisible: boolean,
  hostTreeLayoutWidth: number,
): React.CSSProperties {
  const baseStyle = {
    left: hostTreeLayoutWidth,
  };
  return isVisible
    ? baseStyle
    : { visibility: 'hidden', pointerEvents: 'none', position: 'absolute', zIndex: -1, ...baseStyle };
}

export const LogViewWrapper: React.FC<LogViewWrapperProps> = ({ logView, defaultTerminalTheme, defaultFontSize, onClose, onUpdateLog }) => {
  const activeTabId = useActiveTabId();
  const isVisible = activeTabId === logView.id;
  const hostTreeLayoutWidth = useTerminalHostTreeLayoutWidth();

  const containerStyle = getLogViewWrapperStyle(isVisible, hostTreeLayoutWidth);

  return (
    <div
      className={cn("absolute inset-0", isVisible ? "z-20" : "")}
      data-inactive-app-surface={isVisible ? undefined : "true"}
      style={containerStyle}
    >
      <LazyLoadBoundary name="Log view" resetKey={logView.id}>
        <Suspense fallback={<LogViewFallback />}>
          <LazyLogView
            log={logView.log}
            defaultTerminalTheme={defaultTerminalTheme}
            defaultFontSize={defaultFontSize}
            isVisible={isVisible}
            onClose={onClose}
            onUpdateLog={onUpdateLog}
          />
        </Suspense>
      </LazyLoadBoundary>
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

const LogViewFallback = () => (
  <div className="netcatty-lazy-fade-in h-full min-h-0 bg-background" aria-hidden="true" />
);

const SftpViewFallback = ({ visible }: { visible: boolean }) => {
  if (!visible) return null;
  return (
    <div className="netcatty-lazy-fade-in absolute inset-0 z-20 bg-background" aria-hidden="true" />
  );
};

const TerminalLayerFallback = ({ visible }: { visible: boolean }) => {
  if (!visible) return null;
  return (
    <div className="netcatty-lazy-fade-in absolute inset-0 z-20 bg-background" aria-hidden="true" />
  );
};

export function shouldRenderTerminalLayerMount(
  isVisible: boolean,
  shouldMount: boolean,
): boolean {
  return isVisible || shouldMount;
}

export const SftpViewMount: React.FC<SftpViewProps> = (props) => {
  const isActive = useIsSftpActive();
  const [shouldMount, setShouldMount] = useState(isActive);

  useEffect(() => {
    if (isActive) setShouldMount(true);
  }, [isActive]);

  if (!shouldMount) return null;

  return (
    <LazyLoadBoundary name="SFTP" resetKey={isActive ? "active" : "idle"}>
      <Suspense fallback={<SftpViewFallback visible={isActive} />}>
        <LazySftpView {...props} />
      </Suspense>
    </LazyLoadBoundary>
  );
};

export const TerminalLayerMount: React.FC<TerminalLayerProps> = (props) => {
  const activeTabId = useActiveTabId();
  const sessionIds = useMemo(() => new Set(props.sessions.map((session) => session.id)), [props.sessions]);
  const workspaceIds = useMemo(() => new Set(props.workspaces.map((workspace) => workspace.id)), [props.workspaces]);
  const isVisible = isTerminalContentTabSurface({
    activeTabId,
    sessionIds,
    workspaceIds,
  }) || !!props.draggingSessionId;
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

  const shouldRender = shouldRenderTerminalLayerMount(isVisible, shouldMount);

  if (!shouldRender) return null;

  return (
    <LazyLoadBoundary name="Terminal" resetKey={activeTabId}>
      <Suspense fallback={<TerminalLayerFallback visible={isVisible} />}>
        <LazyTerminalLayer {...props} />
      </Suspense>
    </LazyLoadBoundary>
  );
};
