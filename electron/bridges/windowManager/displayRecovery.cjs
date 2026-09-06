"use strict";

/**
 * Multi-monitor display recovery for content windows (#3244).
 *
 * On Windows, locking the session and letting a secondary display power off
 * (or sleeping the machine) temporarily tears that display down. The OS then
 * relocates the window onto the primary display. That relocation looks like a
 * normal move, so persisted window state is polluted too. When the display
 * returns after unlock, put the window back.
 *
 * Recovery is scoped to lock/sleep (and a short grace after unlock/resume).
 * Ordinary unplug/replug while the session is unlocked is out of scope.
 * User placement always wins: a manual move/resize, or Win+Shift+Arrow,
 * cancels an in-flight restore.
 */

const DEFAULT_RESTORE_GRACE_MS = 8000;

let powerMonitor = null;
try {
  const electron = require("electron");
  if (electron && typeof electron === "object") {
    powerMonitor = electron.powerMonitor || null;
  }
} catch {
  // Not running inside Electron.
}

function isFiniteBounds(bounds) {
  return Boolean(
    bounds &&
    Number.isFinite(bounds.x) &&
    Number.isFinite(bounds.y) &&
    Number.isFinite(bounds.width) &&
    Number.isFinite(bounds.height) &&
    bounds.width > 0 &&
    bounds.height > 0
  );
}

function boundsEqual(a, b) {
  return Boolean(
    a &&
    b &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height
  );
}

function boundsIntersectDisplay(bounds, displayBounds) {
  if (!isFiniteBounds(bounds) || !isFiniteBounds(displayBounds)) return false;
  return (
    bounds.x < displayBounds.x + displayBounds.width &&
    bounds.x + bounds.width > displayBounds.x &&
    bounds.y < displayBounds.y + displayBounds.height &&
    bounds.y + bounds.height > displayBounds.y
  );
}

function normalizeDisplayId(displayId) {
  return typeof displayId === "number" && Number.isFinite(displayId) && displayId >= 0
    ? displayId
    : null;
}

function normalizeRecoveryCandidate(candidate) {
  if (!candidate) return null;
  if (isFiniteBounds(candidate)) return { bounds: candidate, displayId: null };
  if (isFiniteBounds(candidate.bounds)) {
    return {
      bounds: candidate.bounds,
      displayId: normalizeDisplayId(candidate.displayId),
    };
  }
  return null;
}

function pickDisplayRecoveryBounds({ addedDisplay, currentBounds, candidates }) {
  if (!addedDisplay || !isFiniteBounds(addedDisplay.bounds)) return null;
  if (!isFiniteBounds(currentBounds)) return null;
  if (boundsIntersectDisplay(currentBounds, addedDisplay.bounds)) return null;
  const addedDisplayId = normalizeDisplayId(addedDisplay.id);
  for (const candidate of candidates || []) {
    const normalized = normalizeRecoveryCandidate(candidate);
    if (!normalized) continue;
    if (normalized.displayId !== null && addedDisplayId !== null) {
      if (normalized.displayId === addedDisplayId) return normalized.bounds;
      continue;
    }
    if (boundsIntersectDisplay(normalized.bounds, addedDisplay.bounds)) {
      return normalized.bounds;
    }
  }
  return null;
}

function displayPlacementRect(display) {
  if (!display) return null;
  if (isFiniteBounds(display.workArea)) return display.workArea;
  return isFiniteBounds(display.bounds) ? display.bounds : null;
}

function clampBoundsToDisplay(bounds, displayBounds) {
  if (!isFiniteBounds(bounds) || !isFiniteBounds(displayBounds)) return null;
  const width = Math.min(bounds.width, displayBounds.width);
  const height = Math.min(bounds.height, displayBounds.height);
  const x = Math.min(
    Math.max(bounds.x, displayBounds.x),
    displayBounds.x + displayBounds.width - width
  );
  const y = Math.min(
    Math.max(bounds.y, displayBounds.y),
    displayBounds.y + displayBounds.height - height
  );
  return { x, y, width, height };
}

function attachDisplayRecovery({
  win,
  screen,
  restoreGraceMs = DEFAULT_RESTORE_GRACE_MS,
  platform = process.platform,
  powerMonitor: injectedPowerMonitor = null,
}) {
  if (platform !== "win32" || !win || !screen || typeof screen.on !== "function") {
    return () => {};
  }

  let remembered = null;
  let pendingRestore = null;
  let restoreUntil = null;
  const activeInterruptions = new Set();
  let attached = true;
  const activePowerMonitor = injectedPowerMonitor || powerMonitor;

  const isInterrupted = () => activeInterruptions.size > 0;

  const canRestore = () =>
    isInterrupted() ||
    (restoreUntil !== null && Date.now() < restoreUntil);

  const isMaximizedOrFullScreen = () => {
    try {
      return Boolean(win.isMaximized?.() || win.isFullScreen?.());
    } catch {
      return false;
    }
  };

  const copyBounds = () => {
    try {
      if (isMaximizedOrFullScreen() && typeof win.getNormalBounds === "function") {
        const normal = win.getNormalBounds();
        if (isFiniteBounds(normal)) return { ...normal };
      }
      const bounds = win.getBounds();
      return isFiniteBounds(bounds) ? { ...bounds } : null;
    } catch {
      return null;
    }
  };

  const isPrimaryDisplay = (display) => {
    try {
      const primary = screen.getPrimaryDisplay?.();
      if (!display || !primary) return false;
      const displayId = normalizeDisplayId(display.id);
      const primaryId = normalizeDisplayId(primary.id);
      if (displayId !== null && primaryId !== null) return displayId === primaryId;
      return boundsEqual(display.bounds, primary.bounds);
    } catch {
      return false;
    }
  };

  const findRememberedDisplay = () => {
    if (!remembered) return null;
    try {
      return (screen.getAllDisplays?.() || []).find((display) => {
        if (!display || isPrimaryDisplay(display) || !isFiniteBounds(display.bounds)) {
          return false;
        }
        const displayId = normalizeDisplayId(display.id);
        if (remembered.displayId !== null && displayId !== null) {
          return remembered.displayId === displayId;
        }
        return boundsIntersectDisplay(remembered.bounds, display.bounds);
      }) || null;
    } catch {
      return null;
    }
  };

  const applyRestore = (display, bounds) => {
    const clamped = clampBoundsToDisplay(bounds, displayPlacementRect(display));
    if (!clamped) return false;
    const displayId = normalizeDisplayId(display?.id) ?? remembered?.displayId ?? null;
    remembered = { bounds: clamped, displayId };
    if (isMaximizedOrFullScreen()) {
      pendingRestore = { bounds: clamped, displayId };
      return true;
    }
    pendingRestore = null;
    try {
      win.setBounds(clamped);
    } catch {
      return false;
    }
    return true;
  };

  const restoreToDisplay = (display) => {
    if (!attached || !canRestore() || !remembered || !display || isPrimaryDisplay(display)) {
      return false;
    }
    const currentBounds = copyBounds();
    if (
      isFiniteBounds(currentBounds) &&
      boundsIntersectDisplay(currentBounds, display.bounds)
    ) {
      return false;
    }
    let restored = pickDisplayRecoveryBounds({
      addedDisplay: display,
      currentBounds,
      candidates: [remembered],
    });
    // Dual-screen lock/sleep often re-enumerates the only secondary with a
    // transient id and moved bounds. Identity and geometry both miss; the
    // sole remaining secondary is still that display.
    if (!restored && isFiniteBounds(currentBounds)) {
      try {
        const secondaries = (screen.getAllDisplays?.() || []).filter(
          (candidate) => candidate && !isPrimaryDisplay(candidate)
        );
        if (
          secondaries.length === 1 &&
          (secondaries[0] === display ||
            normalizeDisplayId(secondaries[0].id) === normalizeDisplayId(display.id) ||
            boundsEqual(secondaries[0].bounds, display.bounds))
        ) {
          restored = remembered.bounds;
        }
      } catch {
        // Fall through without guessing.
      }
    }
    if (!restored) return false;
    return applyRestore(display, restored);
  };

  const restoreIfNeeded = () => {
    const display = findRememberedDisplay();
    if (!display) return false;
    return restoreToDisplay(display);
  };

  const rememberPlacement = () => {
    if (!attached || isInterrupted()) return;
    if (canRestore()) {
      // Queued OS relocation can still arrive after unlock. Put the window
      // back unless the user has already cancelled recovery.
      restoreIfNeeded();
      return;
    }
    try {
      const bounds = copyBounds();
      if (!bounds) return;
      const display = screen.getDisplayMatching?.(bounds);
      if (!display) return;
      if (isPrimaryDisplay(display)) {
        const rememberedDisplay = findRememberedDisplay();
        // Still-connected secondary + primary placement is a user move.
        if (rememberedDisplay) remembered = null;
        return;
      }
      remembered = {
        bounds,
        displayId: normalizeDisplayId(display.id),
      };
    } catch {
      // Screen queries can fail during display teardown.
    }
  };

  const cancelUserIntent = () => {
    if (isInterrupted()) return;
    pendingRestore = null;
    restoreUntil = null;
    // A manual move/resize after unlock is the user's new placement. Drop the
    // frozen secondary snapshot so a later ordinary lock/unlock cannot restore
    // it after the display happens to reconnect.
    remembered = null;
  };

  const onManualPlacement = (_event, nextBounds) => {
    if (!attached) return;
    cancelUserIntent();
    if (isFiniteBounds(nextBounds)) {
      try {
        const display = screen.getDisplayMatching?.(nextBounds);
        if (display && !isPrimaryDisplay(display)) {
          remembered = {
            bounds: { ...nextBounds },
            displayId: normalizeDisplayId(display.id),
          };
          return;
        }
      } catch {
        // Fall through to ordinary tracking.
      }
    }
    rememberPlacement();
  };

  const onBeforeInputEvent = (_event, input) => {
    if (
      input?.type === "keyDown" &&
      input.meta === true &&
      input.shift === true &&
      (input.key === "ArrowLeft" || input.key === "ArrowRight")
    ) {
      cancelUserIntent();
    }
  };

  const onSessionInterrupted = (signal) => {
    activeInterruptions.add(signal);
    restoreUntil = null;
    // Freeze the last secondary placement. If the window is still on a
    // secondary display at lock/sleep time, refresh the snapshot.
    try {
      const bounds = copyBounds();
      const display = bounds ? screen.getDisplayMatching?.(bounds) : null;
      if (bounds && display && !isPrimaryDisplay(display)) {
        remembered = {
          bounds,
          displayId: normalizeDisplayId(display.id),
        };
      }
    } catch {
      // Keep whatever placement we already have.
    }
  };

  const onSessionResumed = (signal) => {
    activeInterruptions.delete(signal);
    if (activeInterruptions.size > 0) return;
    restoreUntil = Date.now() + restoreGraceMs;
    // display-added can land while the window still overlaps the returning
    // secondary. Windows may then queue the relocation to the primary before
    // unlock, and that move is ignored while the session is interrupted. Retry
    // now; there may be no later display or window event.
    restoreIfNeeded();
  };

  const onDisplayRemoved = (_event, oldDisplay) => {
    if (!attached || !oldDisplay) return;
    const currentBounds = copyBounds();
    if (
      isFiniteBounds(currentBounds) &&
      isFiniteBounds(oldDisplay.bounds) &&
      boundsIntersectDisplay(currentBounds, oldDisplay.bounds) &&
      !isPrimaryDisplay(oldDisplay)
    ) {
      remembered = {
        bounds: currentBounds,
        displayId: normalizeDisplayId(oldDisplay.id) ?? remembered?.displayId ?? null,
      };
    }
  };

  const onDisplayAdded = (_event, display) => {
    if (!attached) return;
    restoreToDisplay(display);
  };

  const applyPendingRestore = () => {
    if (!attached || !pendingRestore || isMaximizedOrFullScreen()) return;
    const display = findRememberedDisplay();
    if (!display) return;
    const currentBounds = copyBounds();
    if (
      isFiniteBounds(currentBounds) &&
      boundsIntersectDisplay(currentBounds, display.bounds)
    ) {
      pendingRestore = null;
      return;
    }
    applyRestore(display, pendingRestore.bounds);
  };

  const onSuspend = () => onSessionInterrupted("suspend");
  const onLockScreen = () => onSessionInterrupted("lock-screen");
  const onResume = () => onSessionResumed("suspend");
  const onUnlockScreen = () => onSessionResumed("lock-screen");

  try {
    activePowerMonitor?.on?.("suspend", onSuspend);
    activePowerMonitor?.on?.("lock-screen", onLockScreen);
    activePowerMonitor?.on?.("resume", onResume);
    activePowerMonitor?.on?.("unlock-screen", onUnlockScreen);
  } catch {
    // Lock/sleep tracking is best-effort.
  }

  try {
    screen.on("display-removed", onDisplayRemoved);
    screen.on("display-added", onDisplayAdded);
    screen.on("display-metrics-changed", onDisplayAdded);
    win.on?.("will-move", onManualPlacement);
    win.on?.("will-resize", onManualPlacement);
    win.on?.("move", rememberPlacement);
    win.on?.("resize", rememberPlacement);
    win.on?.("unmaximize", applyPendingRestore);
    win.on?.("leave-full-screen", applyPendingRestore);
    rememberPlacement();
  } catch {
    return () => {};
  }

  try {
    win.webContents?.on?.("before-input-event", onBeforeInputEvent);
  } catch {
    // Keyboard cancellation is best-effort.
  }

  return function detach() {
    attached = false;
    try {
      activePowerMonitor?.removeListener?.("suspend", onSuspend);
      activePowerMonitor?.removeListener?.("lock-screen", onLockScreen);
      activePowerMonitor?.removeListener?.("resume", onResume);
      activePowerMonitor?.removeListener?.("unlock-screen", onUnlockScreen);
    } catch {}
    try { screen.removeListener?.("display-removed", onDisplayRemoved); } catch {}
    try { screen.removeListener?.("display-added", onDisplayAdded); } catch {}
    try { screen.removeListener?.("display-metrics-changed", onDisplayAdded); } catch {}
    try { win.removeListener?.("will-move", onManualPlacement); } catch {}
    try { win.removeListener?.("will-resize", onManualPlacement); } catch {}
    try { win.removeListener?.("move", rememberPlacement); } catch {}
    try { win.removeListener?.("resize", rememberPlacement); } catch {}
    try { win.removeListener?.("unmaximize", applyPendingRestore); } catch {}
    try { win.removeListener?.("leave-full-screen", applyPendingRestore); } catch {}
    try {
      win.webContents?.removeListener?.("before-input-event", onBeforeInputEvent);
    } catch {}
    remembered = null;
    pendingRestore = null;
    restoreUntil = null;
    activeInterruptions.clear();
  };
}

module.exports = {
  attachDisplayRecovery,
  boundsIntersectDisplay,
  clampBoundsToDisplay,
  isFiniteBounds,
  pickDisplayRecoveryBounds,
};
