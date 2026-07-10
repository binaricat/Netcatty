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
  softHiddenRef: React.MutableRefObject<boolean>;
  hibernatePendingBufferRef: React.MutableRefObject<string>;
  hibernateSnapshotRef: React.MutableRefObject<string>;
  hibernateViewportSnapshotRef: React.MutableRefObject<string>;
  hibernateScrollbackSnapshotRef: React.MutableRefObject<string>;
  hibernateContextSnapshotRef: React.MutableRefObject<string>;
  hibernateContextViewportSnapshotRef: React.MutableRefObject<string>;
  hibernateContextScrollbackSnapshotRef: React.MutableRefObject<string>;
  hibernateAlternateScreenRef: React.MutableRefObject<boolean>;
  hasRuntimeRef: React.MutableRefObject<boolean>;
  onHibernate: () => void;
  onSoftHideWake: () => void;
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
  softHiddenRef,
  hibernatePendingBufferRef,
  hibernateSnapshotRef,
  hibernateViewportSnapshotRef,
  hibernateScrollbackSnapshotRef,
  hibernateContextSnapshotRef,
  hibernateContextViewportSnapshotRef,
  hibernateContextScrollbackSnapshotRef,
  hibernateAlternateScreenRef,
  hasRuntimeRef,
  onHibernate,
  onSoftHideWake,
  onWake,
}: UseTerminalHibernateEffectOptions): void {
  const hiddenSinceRef = useRef<number | null>(null);
  const hibernateTimerRef = useRef<number | null>(null);
  const paneVisibleRef = useRef(resolvePaneVisible(sessionId, isVisible));
  const onHibernateRef = useRef(onHibernate);
  const onSoftHideWakeRef = useRef(onSoftHideWake);
  const onWakeRef = useRef(onWake);
  onHibernateRef.current = onHibernate;
  onSoftHideWakeRef.current = onSoftHideWake;
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
      hibernateViewportSnapshotRef.current = "";
      hibernateScrollbackSnapshotRef.current = "";
      hibernateContextSnapshotRef.current = "";
      hibernateContextViewportSnapshotRef.current = "";
      hibernateContextScrollbackSnapshotRef.current = "";
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
      if (softHiddenRef.current) {
        onSoftHideWakeRef.current();
        return;
      }
      if (!hibernatedRef.current) return;

      const sessionConnected = getSessionConnectedRef.current();
      const getPayload = (): TerminalHibernateWakePayload => ({
        snapshot: hibernateSnapshotRef.current,
        viewportSnapshot: hibernateViewportSnapshotRef.current || hibernateSnapshotRef.current,
        scrollbackSnapshot: hibernateScrollbackSnapshotRef.current,
        pendingBuffer: hibernatePendingBufferRef.current,
        alternateScreen: hibernateAlternateScreenRef.current,
      });
      logger.info("[Terminal] Waking from hibernate", {
        sessionId,
        snapshotChars: hibernateSnapshotRef.current.length,
        viewportChars: hibernateViewportSnapshotRef.current.length,
        scrollbackChars: hibernateScrollbackSnapshotRef.current.length,
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

    const applyVisibility = (visible: boolean) => {
      paneVisibleRef.current = visible;
      // Keep the write/recovery ref current even when Terminal memo used to skip
      // isVisible-only updates, and even when hibernate itself is disabled.
      isVisibleRef.current = visible;

      if (visible) {
        hiddenSinceRef.current = null;
        clearHibernateTimer();
        tryWake();
        return;
      }

      if (hibernateEnabled) {
        scheduleHibernate();
      }
    };

    if (!hibernateEnabled) {
      // Turning hibernate off must wake already soft-hidden / hibernated panes
      // immediately; waiting for the next tab select would leave the setting
      // ineffective for currently hidden sessions.
      clearHibernateTimer();
      if (hibernatedRef.current || softHiddenRef.current) {
        tryWake();
      }
    }

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
    hibernateAlternateScreenRef,
    hibernateDelayMs,
    hibernateEnabled,
    hibernateContextScrollbackSnapshotRef,
    hibernateContextSnapshotRef,
    hibernateContextViewportSnapshotRef,
    hibernatePendingBufferRef,
    hibernateScrollbackSnapshotRef,
    hibernateSnapshotRef,
    hibernateViewportSnapshotRef,
    hibernatedRef,
    isSearchOpen,
    isVisible,
    isVisibleRef,
    sessionId,
    softHiddenRef,
    status,
  ]);
}
