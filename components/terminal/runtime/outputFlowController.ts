/**
 * Watermark-based flow control for terminal output.
 *
 * SSH/PTY output has no back-pressure by default: the source streams as fast as
 * it can, the main process forwards it over IPC, and the renderer queues every
 * chunk into xterm. When output outpaces rendering (e.g. `cat` of a big file, a
 * noisy build, `tail -f`, `yes`), the renderer-side backlog and xterm's internal
 * buffer grow without bound — memory climbs and the whole UI, typing included,
 * janks.
 *
 * This tracks bytes that have been received but not yet acknowledged by xterm's
 * write callback. When the backlog crosses `highWaterMark` it asks the caller to
 * pause the source; once it drains back to `lowWaterMark` it asks to resume. The
 * hysteresis gap avoids rapid pause/resume flapping. During interactive use the
 * backlog hovers near zero, so this never engages.
 */
export interface OutputFlowController {
  /** Account bytes handed to xterm (call when a chunk is received). */
  received(bytes: number): void;
  /** Account bytes whose xterm write callback has fired. */
  written(bytes: number): void;
  /** Clear pending state; calls `onResume` if currently paused. */
  reset(options?: { resume?: boolean }): void;
  pendingBytes(): number;
  isPaused(): boolean;
}

export interface OutputFlowControllerOptions {
  highWaterMark: number;
  lowWaterMark: number;
  /** Asked to pause the source when the backlog crosses the high watermark. */
  onPause: () => void;
  /** Asked to resume the source when the backlog drains to the low watermark. */
  onResume: () => void;
}

export function createOutputFlowController(
  options: OutputFlowControllerOptions,
): OutputFlowController {
  const { highWaterMark, lowWaterMark, onPause, onResume } = options;
  let pending = 0;
  let paused = false;

  return {
    received(bytes: number): void {
      if (bytes <= 0) return;
      pending += bytes;
      if (!paused && pending >= highWaterMark) {
        paused = true;
        onPause();
      }
    },
    written(bytes: number): void {
      if (bytes <= 0) return;
      pending -= bytes;
      if (pending < 0) pending = 0;
      if (paused && pending <= lowWaterMark) {
        paused = false;
        onResume();
      }
    },
    reset(options?: { resume?: boolean }): void {
      if (paused && options?.resume !== false) onResume();
      pending = 0;
      paused = false;
    },
    pendingBytes(): number {
      return pending;
    },
    isPaused(): boolean {
      return paused;
    },
  };
}
