import { useEffect, useRef } from 'react';
import { subscribeTerminalCommandCompletion } from '../terminalCommandCompletion';

interface Options {
  sessionId: string | null;
  enabled: boolean;
  visible: boolean;
  busy: boolean;
  matchesTerminal: boolean;
  paneId: string;
  connectionId: string | null;
  path: string | null;
  connected: boolean;
  refresh: () => Promise<void>;
}

/** Coalesce completion bursts; never poll or carry refreshes across pane changes. */
export function useSftpCommandRefresh(options: Options): void {
  const latest = useRef(options);
  latest.current = options;
  const drain = useRef(() => {});
  useEffect(() => {
    if (!options.enabled || !options.visible || !options.sessionId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending = false;
    let refreshing = false;
    let disposed = false;
    const eligible = () => {
      const live = latest.current;
      return !disposed && live.enabled && live.visible && live.connected && live.matchesTerminal
        && live.sessionId === options.sessionId && live.paneId === options.paneId
        && live.connectionId === options.connectionId && live.path === options.path;
    };
    const schedule = () => {
      if (!pending || refreshing || latest.current.busy || !eligible()) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!eligible() || latest.current.busy) return;
        pending = false;
        refreshing = true;
        void latest.current.refresh().catch(() => {}).finally(() => {
          refreshing = false;
          schedule();
        });
      }, 250);
    };
    drain.current = schedule;
    const unsubscribe = subscribeTerminalCommandCompletion((sessionId) => {
      if (sessionId !== options.sessionId || !eligible()) return;
      pending = true;
      schedule();
    });
    return () => { disposed = true; clearTimeout(timer); unsubscribe(); drain.current = () => {}; };
  }, [options.enabled, options.visible, options.sessionId, options.paneId, options.connectionId, options.path]);
  useEffect(() => { drain.current(); }, [options.busy]);
}
