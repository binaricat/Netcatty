import { useEffect, useRef } from "react";

import {
  type TerminalHibernateWakePayload,
} from "../../domain/terminalHibernate";
import { logger } from "../../lib/logger";
import {
  resolvePaneVisible,
  subscribePaneVisible,
} from "./paneVisibilityStore";
import type { TerminalSession } from "../../types";

type UseTerminalHibernateEffectOptions = {
  sessionId: string;
  isVisible: boolean;
  isVisibleRef: React.MutableRefObject<boolean>;
  getSessionConnectedRef: React.MutableRefObject<() => boolean>;
  status: TerminalSession["status"];
  isSearchOpen: boolean;
  hibernateEnabled: boolean;
  hibernateDelayMs: number;
  fileTransferActive: boolean;
  hibernatedRef: React.MutableRefObject<boolean>;
  hibernatePendingBufferRef: React.MutableRefObject<string>;
  hibernateSnapshotRef: React.MutableRefObject<string>;
  hibernateAlternateScreenRef: React.MutableRefObject<boolean>;
  hasRuntimeRef: React.MutableRefObject<boolean>;
  onHibernate: () => void;
  onWake: (
    getPayload: () => TerminalHibernateWakePayload,
    options: { sessionConnected: boolean },
  ) => boolean | Promise<boolean>;
};

export function useTerminalHibernateEffect({
  sessionId,
  isVisible,
  isVisibleRef,
  getSessionConnectedRef,
  status,
  isSearchOpen,
  hibernateEnabled,
  hibernateDelayMs,
  fileTransferActive,
  hibernatedRef,
  hibernatePendingBufferRef,
  hibernateSnapshotRef,
  hibernateAlternateScreenRef,
  hasRuntimeRef,
  onHibernate,
  onWake,
}: UseTerminalHibernateEffectOptions): void {
  const hiddenSinceRef = useRef<number | null>(null);
  const hibernateTimerRef = useRef<number | null>(null);
  const paneVisibleRef = useRef(resolvePaneVisible(sessionId, isVisible));
  const onHibernateRef = useRef(onHibernate);
  const onWakeRef = useRef(onWake);
  onHibernateRef.current = onHibernate;
  onWakeRef.current = onWake;

  useEffect(() => {
    const resolveVisible = () => resolvePaneVisible(sessionId, isVisibleRef.current);

    const clearHibernateTimer = () => {
      if (hibernateTimerRef.current !== null) {
        window.clearTimeout(hibernateTimerRef.current);
        hibernateTimerRef.current = null;
      }
    };

    const clearHibernateState = () => {
      hibernateSnapshotRef.current = "";
      hibernatePendingBufferRef.current = "";
      hibernateAlternateScreenRef.current = false;
      hibernatedRef.current = false;
    };

    const scheduleHibernate = () => {
      if (!hibernateEnabled) return;
      clearHibernateTimer();
      if (hibernatedRef.current || !hasRuntimeRef.current) return;
      if (status !== "connected") return;
      if (isSearchOpen) return;
      if (fileTransferActive) return;

      hiddenSinceRef.current = Date.now();
      const hiddenAt = hiddenSinceRef.current;
      hibernateTimerRef.current = window.setTimeout(() => {
        hibernateTimerRef.current = null;
        if (hiddenSinceRef.current !== hiddenAt) return;
        if (resolveVisible()) return;
        onHibernateRef.current();
      }, hibernateDelayMs);
    };

    const tryWake = () => {
      if (!hibernatedRef.current) return;

      const sessionConnected = getSessionConnectedRef.current();
      const getPayload = (): TerminalHibernateWakePayload => ({
        snapshot: hibernateSnapshotRef.current,
        pendingBuffer: hibernatePendingBufferRef.current,
        alternateScreen: hibernateAlternateScreenRef.current,
      });
      logger.info("[Terminal] Waking from hibernate", {
        sessionId,
        snapshotChars: hibernateSnapshotRef.current.length,
        pendingChars: hibernatePendingBufferRef.current.length,
        sessionConnected,
      });
      void Promise.resolve(onWakeRef.current(getPayload, { sessionConnected })).then((accepted) => {
        if (accepted !== false) {
          clearHibernateState();
          if (!resolveVisible()) {
            scheduleHibernate();
          }
        }
      });
    };

    if (!hibernateEnabled) {
      clearHibernateTimer();
      if (hibernatedRef.current) {
        tryWake();
      }
      const unsubscribeDisabled = subscribePaneVisible(sessionId, () => {
        if (hibernatedRef.current && resolveVisible()) {
          tryWake();
        }
      });
      return () => {
        unsubscribeDisabled();
      };
    }

    const applyVisibility = (visible: boolean) => {
      paneVisibleRef.current = visible;
      isVisibleRef.current = visible;

      if (visible) {
        hiddenSinceRef.current = null;
        clearHibernateTimer();
        tryWake();
        return;
      }

      scheduleHibernate();
    };

    applyVisibility(resolveVisible());

    const unsubscribe = subscribePaneVisible(sessionId, () => {
      const visible = resolveVisible();
      if (visible === paneVisibleRef.current) return;
      applyVisibility(visible);
    });

    return () => {
      clearHibernateTimer();
      unsubscribe();
    };
  }, [
    fileTransferActive,
    getSessionConnectedRef,
    hasRuntimeRef,
    hibernateDelayMs,
    hibernateEnabled,
    hibernatePendingBufferRef,
    hibernateSnapshotRef,
    hibernateAlternateScreenRef,
    hibernatedRef,
    isSearchOpen,
    isVisible,
    isVisibleRef,
    sessionId,
    status,
  ]);
}
