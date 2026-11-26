import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, OctagonX } from 'lucide-react';
import { useI18n } from '../../application/i18n/I18nProvider';
import {
  summarizeRemoteDesktopActions,
  type RemoteDesktopAction,
} from '../../domain/remoteDesktopActionCodec';
import { stopAgentTurn, type AgentStopBridge } from '../../infrastructure/ai/harness/agentStop';
import {
  getRemoteDesktopAiControlState,
  preemptRemoteDesktopControl,
  subscribeRemoteDesktopActionEvents,
  subscribeRemoteDesktopAiControlState,
  type RemoteDesktopActionEvent,
  type RemoteDesktopAiControlState,
} from '../../infrastructure/remoteDesktop/remoteDesktopControlRegistry';
import { cn } from '../../lib/utils';
import { CattyIcon } from '../icons/RemoteDesktopIcons';
import { tr } from './remoteDesktopHelpers';

export interface RemoteDesktopAiOverlayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface RemoteDesktopAiOverlayProps {
  sessionId: string;
  /**
   * Optional bounding rect of the live `<canvas>` relative to the overlay's
   * positioned container (in CSS pixels). When omitted, coordinates map across
   * the full overlay bounds (`0..100%`).
   */
  canvasRect?: RemoteDesktopAiOverlayRect | null;
  /** Optional callback fired when the user clicks Stop or presses Esc to take over. */
  onPreemptStop?: (reason: 'stop-button' | 'escape' | 'pointer') => void;
}

interface VisualActionCue {
  id: string;
  action: RemoteDesktopAction;
  createdAt: number;
}

interface VirtualCursorState {
  x: number;
  y: number;
  visible: boolean;
  pressing: boolean;
  transitionMs: number;
}

const VISUAL_CUE_TTL_MS = 1050;
const CURSOR_IDLE_FADE_MS = 1800;
const AURORA_LINGER_MS = 1400;
const MAX_CONCURRENT_CUES = 12;

export const RemoteDesktopAiOverlay: React.FC<RemoteDesktopAiOverlayProps> = React.memo(({
  sessionId,
  canvasRect,
  onPreemptStop,
}) => {
  const { t, resolvedLocale } = useI18n();
  const isZh = resolvedLocale.toLowerCase().startsWith('zh');

  const [controlState, setControlState] = useState<RemoteDesktopAiControlState>(() =>
    getRemoteDesktopAiControlState(sessionId),
  );
  const [auroraActive, setAuroraActive] = useState<boolean>(() =>
    getRemoteDesktopAiControlState(sessionId).aiControlling,
  );
  const [cues, setCues] = useState<VisualActionCue[]>([]);
  const [cursor, setCursor] = useState<VirtualCursorState>({
    x: 500,
    y: 500,
    visible: false,
    pressing: false,
    transitionMs: 0,
  });

  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const cursorPosRef = useRef<{ x: number; y: number } | null>(null);
  const cursorFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const auroraFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cursorPressTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    setControlState(getRemoteDesktopAiControlState(sessionId));

    const scheduleTimer = (fn: () => void, ms: number) => {
      const id = setTimeout(() => {
        cursorPressTimersRef.current = cursorPressTimersRef.current.filter((tId) => tId !== id);
        fn();
      }, ms);
      cursorPressTimersRef.current.push(id);
      return id;
    };

    const scheduleCursorFade = () => {
      if (cursorFadeTimerRef.current) {
        clearTimeout(cursorFadeTimerRef.current);
      }
      cursorFadeTimerRef.current = setTimeout(() => {
        cursorFadeTimerRef.current = null;
        if (!getRemoteDesktopAiControlState(sessionId).aiControlling) {
          setCursor((prev) => ({ ...prev, visible: false, pressing: false }));
        }
      }, CURSOR_IDLE_FADE_MS);
    };

    const moveCursorTo = (
      targetX: number,
      targetY: number,
      options?: { pressAfterGlide?: boolean; holdDuringMove?: boolean; durationOverrideMs?: number },
    ): number => {
      const prev = cursorPosRef.current;
      const dist = prev ? Math.hypot(targetX - prev.x, targetY - prev.y) : 0;
      const glideMs =
        options?.durationOverrideMs
        ?? (prev && dist >= 4 ? Math.max(120, Math.min(260, Math.round(dist * 0.42 + 95))) : 0);

      cursorPosRef.current = { x: targetX, y: targetY };
      setCursor({
        x: targetX,
        y: targetY,
        visible: true,
        pressing: Boolean(options?.holdDuringMove),
        transitionMs: glideMs,
      });

      if (options?.pressAfterGlide) {
        scheduleTimer(() => {
          setCursor((curr) => ({ ...curr, pressing: true }));
          scheduleTimer(() => {
            setCursor((curr) => ({ ...curr, pressing: false }));
          }, 150);
        }, Math.max(0, glideMs - 20));
      }

      scheduleCursorFade();
      return glideMs;
    };

    const pushCue = (cue: VisualActionCue) => {
      setCues((prev) => {
        const next = [...prev, cue];
        return next.length > MAX_CONCURRENT_CUES
          ? next.slice(next.length - MAX_CONCURRENT_CUES)
          : next;
      });
      const timer = setTimeout(() => {
        timersRef.current.delete(cue.id);
        setCues((prev) => prev.filter((item) => item.id !== cue.id));
      }, VISUAL_CUE_TTL_MS);
      timersRef.current.set(cue.id, timer);
    };

    const unsubControl = subscribeRemoteDesktopAiControlState(sessionId, (nextState) => {
      setControlState(nextState);
      if (nextState.aiControlling) {
        if (auroraFadeTimerRef.current) {
          clearTimeout(auroraFadeTimerRef.current);
          auroraFadeTimerRef.current = null;
        }
        setAuroraActive(true);
        if (cursorFadeTimerRef.current) {
          clearTimeout(cursorFadeTimerRef.current);
          cursorFadeTimerRef.current = null;
        }
      } else {
        // Immediately cancel any scheduled cursor/ripple timers once AI control ends
        for (const tId of cursorPressTimersRef.current) {
          clearTimeout(tId);
        }
        cursorPressTimersRef.current = [];
        setCursor((prev) => (prev.pressing ? { ...prev, pressing: false } : prev));
        scheduleCursorFade();
        if (auroraFadeTimerRef.current) {
          clearTimeout(auroraFadeTimerRef.current);
        }
        auroraFadeTimerRef.current = setTimeout(() => {
          auroraFadeTimerRef.current = null;
          if (!getRemoteDesktopAiControlState(sessionId).aiControlling) {
            setAuroraActive(false);
          }
        }, AURORA_LINGER_MS);
      }
    });

    const unsubEvents = subscribeRemoteDesktopActionEvents(sessionId, (event: RemoteDesktopActionEvent) => {
      if (event.phase !== 'start') return;
      if (event.action.type === 'wait') return;

      const cue: VisualActionCue = {
        id: event.id,
        action: event.action,
        createdAt: event.timestamp,
      };

      const action = event.action;
      if (action.type === 'click') {
        const glideMs = moveCursorTo(action.x, action.y, { pressAfterGlide: true });
        if (glideMs > 0) {
          // Trigger click ripple right as the smooth gliding cursor lands on the target
          scheduleTimer(() => pushCue(cue), Math.max(0, glideMs - 25));
        } else {
          pushCue(cue);
        }
        return;
      }

      if (action.type === 'move') {
        moveCursorTo(action.x, action.y);
        pushCue(cue);
        return;
      }

      if (action.type === 'scroll') {
        const glideMs = moveCursorTo(action.x, action.y);
        if (glideMs > 0) {
          scheduleTimer(() => pushCue(cue), Math.max(0, glideMs - 25));
        } else {
          pushCue(cue);
        }
        return;
      }

      if (action.type === 'drag') {
        const toStartMs = moveCursorTo(action.fromX, action.fromY);
        const dragSteps = Math.max(6, Math.min(40, Math.round(action.steps ?? 12)));
        const dragDurationMs = Math.max(180, dragSteps * 18);
        scheduleTimer(() => {
          moveCursorTo(action.toX, action.toY, {
            holdDuringMove: true,
            durationOverrideMs: dragDurationMs,
          });
          scheduleTimer(() => {
            setCursor((curr) => ({ ...curr, pressing: false }));
          }, dragDurationMs + 30);
        }, toStartMs + 25);
        pushCue(cue);
        return;
      }

      // key / type
      pushCue(cue);
    });

    const timersMap = timersRef.current;
    return () => {
      unsubControl();
      unsubEvents();
      for (const timer of timersMap.values()) {
        clearTimeout(timer);
      }
      timersMap.clear();
      if (cursorFadeTimerRef.current) {
        clearTimeout(cursorFadeTimerRef.current);
        cursorFadeTimerRef.current = null;
      }
      if (auroraFadeTimerRef.current) {
        clearTimeout(auroraFadeTimerRef.current);
        auroraFadeTimerRef.current = null;
      }
      for (const tId of cursorPressTimersRef.current) {
        clearTimeout(tId);
      }
      cursorPressTimersRef.current = [];
    };
  }, [sessionId]);

  const handlePreemptAndStop = useCallback(
    (reason: 'stop-button' | 'escape') => {
      if (auroraFadeTimerRef.current) {
        clearTimeout(auroraFadeTimerRef.current);
        auroraFadeTimerRef.current = null;
      }
      for (const tId of cursorPressTimersRef.current) {
        clearTimeout(tId);
      }
      cursorPressTimersRef.current = [];
      setAuroraActive(false);
      setCursor((prev) => ({ ...prev, pressing: false }));
      preemptRemoteDesktopControl(sessionId, reason);
      const chatSessionId = controlState.chatSessionId || sessionId;
      const bridge = typeof window !== 'undefined'
        ? (window as unknown as { netcatty?: AgentStopBridge }).netcatty ?? null
        : null;
      void stopAgentTurn({
        chatSessionId,
        bridge,
        reason: 'user',
      });
      onPreemptStop?.(reason);
    },
    [controlState.chatSessionId, onPreemptStop, sessionId],
  );

  useEffect(() => {
    if (!controlState.aiControlling) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        handlePreemptAndStop('escape');
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [controlState.aiControlling, handlePreemptAndStop]);

  const canvasLayerStyle = useMemo<React.CSSProperties>(() => {
    if (canvasRect && canvasRect.width > 0 && canvasRect.height > 0) {
      return {
        left: `${canvasRect.left}px`,
        top: `${canvasRect.top}px`,
        width: `${canvasRect.width}px`,
        height: `${canvasRect.height}px`,
      };
    }
    return {
      left: 0,
      top: 0,
      width: '100%',
      height: '100%',
    };
  }, [canvasRect]);

  const latestKeyOrTypeCue = useMemo(() => {
    for (let i = cues.length - 1; i >= 0; i -= 1) {
      const action = cues[i].action;
      if (action.type === 'key' || action.type === 'type') {
        return cues[i];
      }
    }
    return null;
  }, [cues]);

  const pointerCues = useMemo(
    () =>
      cues.filter(
        (cue) =>
          cue.action.type === 'click'
          || cue.action.type === 'move'
          || cue.action.type === 'drag'
          || cue.action.type === 'scroll',
      ),
    [cues],
  );

  if (!controlState.aiControlling && !auroraActive && cues.length === 0 && !cursor.visible) {
    return null;
  }

  const bannerText = tr(
    t,
    'remoteDesktop.ai.controllingBanner',
    isZh ? 'Catty 控制中 · 点击桌面或按 Esc 立即接管' : 'Catty controlling · Click desktop or press Esc to take over',
  );
  const stopLabel = tr(t, 'remoteDesktop.ai.stopControl', isZh ? '停止' : 'Stop');
  const stepBadge =
    controlState.aiControlling
    && typeof controlState.totalActions === 'number'
    && controlState.totalActions > 1
      ? `${Math.min((controlState.currentActionIndex ?? 0) + 1, controlState.totalActions)}/${controlState.totalActions}`
      : null;

  return (
    <div
      data-testid="remote-desktop-ai-overlay"
      className="pointer-events-none absolute inset-0 z-30 overflow-hidden select-none"
      aria-live="polite"
    >
      {/* Full-viewport flowing aurora / iridescent inward fade-out border glow while Catty is controlling */}
      <div
        data-testid="remote-desktop-ai-aurora-border"
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute inset-0 z-10 transition-opacity duration-500',
          controlState.aiControlling || auroraActive ? 'opacity-100' : 'opacity-0',
        )}
      >
        {/* Smooth 4-edge inward fade-out aurora wave glow */}
        <div className="rd-ai-aurora-glow absolute inset-0" />
        {/* Crisp 2px flowing iridescent outer hairline */}
        <div className="rd-ai-aurora-border absolute inset-0" />
      </div>

      {/* Canvas-aligned SVG + ripple + real gliding pointer cursor layer */}
      <div
        className="pointer-events-none absolute overflow-hidden"
        style={canvasLayerStyle}
      >
        <svg
          className="h-full w-full"
          viewBox="0 0 1000 1000"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <defs>
            <marker
              id={`rd-ai-drag-arrow-${sessionId}`}
              viewBox="0 0 10 10"
              refX="7"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 10 5 L 0 9 z" fill="rgba(56, 189, 248, 0.95)" />
            </marker>
          </defs>
          {pointerCues.map((cue) => {
            if (cue.action.type !== 'drag') return null;
            const { fromX, fromY, toX, toY } = cue.action;
            return (
              <g key={cue.id} data-testid="remote-desktop-ai-drag-trail">
                <line
                  x1={fromX}
                  y1={fromY}
                  x2={toX}
                  y2={toY}
                  stroke="rgba(9, 9, 11, 0.5)"
                  strokeWidth="6"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
                <line
                  x1={fromX}
                  y1={fromY}
                  x2={toX}
                  y2={toY}
                  stroke="rgba(56, 189, 248, 0.95)"
                  strokeWidth="2.5"
                  strokeDasharray="6 4"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                  markerEnd={`url(#rd-ai-drag-arrow-${sessionId})`}
                />
                <circle
                  cx={fromX}
                  cy={fromY}
                  r="4"
                  fill="rgba(34, 211, 238, 0.95)"
                  stroke="rgba(9, 9, 11, 0.75)"
                  strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            );
          })}
        </svg>

        {/* Animated concentric shockwave ripples & cues */}
        {pointerCues.map((cue) => {
          const action = cue.action;
          if (action.type !== 'click' && action.type !== 'move' && action.type !== 'scroll') {
            return null;
          }
          const leftPct = `${(action.x / 10).toFixed(2)}%`;
          const topPct = `${(action.y / 10).toFixed(2)}%`;

          if (action.type === 'click') {
            const isRight = action.button === 'right';
            const isDouble = action.clickCount === 2 || action.clickCount === 3;
            const primaryBorder = isRight ? 'border-amber-400' : 'border-cyan-300';
            const secondaryBorder = isRight ? 'border-orange-400/80' : 'border-indigo-400/90';
            const coreBg = isRight
              ? 'bg-amber-400 shadow-[0_0_14px_rgba(251,191,36,0.9)]'
              : 'bg-cyan-300 shadow-[0_0_16px_rgba(34,211,238,0.95)]';
            const radialGlow = isRight
              ? 'radial-gradient(circle, rgba(251,191,36,0.38) 0%, rgba(251,191,36,0) 70%)'
              : 'radial-gradient(circle, rgba(34,211,238,0.4) 0%, rgba(168,85,247,0.18) 45%, rgba(34,211,238,0) 72%)';

            return (
              <div
                key={cue.id}
                data-testid="remote-desktop-ai-click-ripple"
                className="pointer-events-none absolute"
                style={{ left: leftPct, top: topPct }}
              >
                {/* Soft radial flash */}
                <span
                  className="rd-ai-ripple-ring absolute left-0 top-0 h-14 w-14 rounded-full"
                  style={{ background: radialGlow }}
                />
                {/* Primary expanding shockwave ring */}
                <span
                  className={cn(
                    'rd-ai-ripple-ring absolute left-0 top-0 h-11 w-11 rounded-full border-2',
                    primaryBorder,
                  )}
                />
                {/* Secondary staggered concentric wave ring */}
                <span
                  className={cn(
                    'rd-ai-ripple-ring-delayed absolute left-0 top-0 h-12 w-12 rounded-full border-[1.5px]',
                    secondaryBorder,
                  )}
                />
                {isDouble && (
                  <span
                    className={cn(
                      'rd-ai-ripple-ring-delayed absolute left-0 top-0 h-7 w-7 rounded-full border-2',
                      primaryBorder,
                    )}
                  />
                )}
                {/* Crisp impact core dot */}
                <span
                  className={cn(
                    'rd-ai-ripple-core absolute left-0 top-0 h-2.5 w-2.5 rounded-full',
                    coreBg,
                  )}
                />
              </div>
            );
          }

          if (action.type === 'scroll') {
            const dy = action.deltaY ?? 0;
            const dx = action.deltaX ?? 0;
            const arrow = dy > 0 ? '↓' : dy < 0 ? '↑' : dx > 0 ? '→' : '←';
            return (
              <div
                key={cue.id}
                data-testid="remote-desktop-ai-scroll-cue"
                className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 flex h-7 w-7 items-center justify-center rounded-full border border-cyan-400/80 bg-zinc-950/80 text-xs font-semibold text-cyan-300 shadow-md animate-pulse"
                style={{ left: leftPct, top: topPct }}
              >
                {arrow}
              </div>
            );
          }

          // move trail subtle pulse
          return (
            <div
              key={cue.id}
              data-testid="remote-desktop-ai-move-cue"
              className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 h-3 w-3 rounded-full border border-cyan-300/75 bg-cyan-400/25 opacity-70"
              style={{ left: leftPct, top: topPct }}
            />
          );
        })}

        {/* Realistic gliding AI mouse pointer cursor (GPU-composited transform when canvasRect is known) */}
        {cursor.visible && (() => {
          const hasPixelBounds = Boolean(canvasRect && canvasRect.width > 0 && canvasRect.height > 0);
          const cursorPosStyle: React.CSSProperties = hasPixelBounds
            ? {
                left: 0,
                top: 0,
                transform: `translate3d(${((cursor.x / 1000) * canvasRect!.width).toFixed(1)}px, ${((cursor.y / 1000) * canvasRect!.height).toFixed(1)}px, 0)`,
                transition: cursor.transitionMs > 0
                  ? `transform ${cursor.transitionMs}ms cubic-bezier(0.22, 1, 0.36, 1), opacity 250ms ease`
                  : 'opacity 250ms ease',
              }
            : {
                left: `${(cursor.x / 10).toFixed(2)}%`,
                top: `${(cursor.y / 10).toFixed(2)}%`,
                transition: cursor.transitionMs > 0
                  ? `left ${cursor.transitionMs}ms cubic-bezier(0.22, 1, 0.36, 1), top ${cursor.transitionMs}ms cubic-bezier(0.22, 1, 0.36, 1), opacity 250ms ease`
                  : 'opacity 250ms ease',
              };
          return (
            <div
              data-testid="remote-desktop-ai-cursor"
              aria-hidden="true"
              className="pointer-events-none absolute z-20 will-change-transform"
              style={cursorPosStyle}
            >
            <div
              className="relative transition-transform duration-100 ease-out"
              style={{
                transformOrigin: '2px 2px',
                transform: cursor.pressing ? 'scale(0.84) translate(-1px, -1px)' : 'scale(1) translate(-2px, -2px)',
              }}
            >
              {/* Crisp modern OS-style arrow cursor SVG with subtle iridescent glow */}
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                style={{
                  filter: cursor.pressing
                    ? 'drop-shadow(0 0 8px rgba(34, 211, 238, 0.95)) drop-shadow(0 2px 4px rgba(0, 0, 0, 0.6))'
                    : 'drop-shadow(0 0 6px rgba(99, 102, 241, 0.65)) drop-shadow(0 2px 5px rgba(0, 0, 0, 0.55))',
                }}
              >
                <path
                  d="M4.2 2.4L19.4 13.1C20.1 13.6 19.8 14.7 18.9 14.8L12.6 15.6L9.4 21.1C8.9 21.9 7.7 21.6 7.6 20.7L4.2 2.4Z"
                  fill="#0f172a"
                  stroke="#ffffff"
                  strokeWidth="1.65"
                  strokeLinejoin="round"
                />
                <path
                  d="M5.6 4.7L17.1 13.2L11.8 13.9L8.9 18.9L5.6 4.7Z"
                  fill="url(#rd-ai-cursor-grad)"
                  fillOpacity="0.32"
                />
                <defs>
                  <linearGradient id="rd-ai-cursor-grad" x1="5" y1="4" x2="18" y2="19" gradientUnits="userSpaceOnUse">
                    <stop stopColor="#22d3ee" />
                    <stop offset="0.55" stopColor="#818cf8" />
                    <stop offset="1" stopColor="#e879f9" />
                  </linearGradient>
                </defs>
              </svg>
              <span className="absolute left-4 top-4 inline-flex items-center gap-1 rounded-full border border-cyan-300/50 bg-zinc-950/90 px-1.5 py-0.5 text-[9.5px] font-semibold tracking-wide text-cyan-100 shadow-md backdrop-blur-sm whitespace-nowrap">
                <CattyIcon size={10} className="shrink-0 text-cyan-300" />
                <span>Catty</span>
              </span>
            </div>
          </div>
          );
        })()}
      </div>

      {/* Floating top-center Catty control banner with Stop button */}
      {controlState.aiControlling && (
        <div
          data-testid="remote-desktop-ai-control-banner"
          className="pointer-events-auto absolute left-1/2 top-3 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full border border-cyan-300/40 bg-zinc-950/88 px-3.5 py-1.5 text-xs text-white shadow-[0_8px_28px_rgba(0,0,0,0.45),0_0_20px_rgba(56,189,248,0.22)] backdrop-blur-md"
        >
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-cyan-300" />
          </span>
          <CattyIcon size={13} className="shrink-0 text-cyan-300" />
          <span className="whitespace-nowrap font-medium text-white/95">{bannerText}</span>
          {stepBadge && (
            <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] text-cyan-200">
              {stepBadge}
            </span>
          )}
          <button
            type="button"
            data-testid="remote-desktop-ai-stop-button"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              handlePreemptAndStop('stop-button');
            }}
            className="inline-flex items-center gap-1 rounded-full bg-red-500/90 px-2.5 py-0.5 text-[11px] font-semibold text-white transition-colors hover:bg-red-500 cursor-pointer"
          >
            <OctagonX size={12} />
            <span>{stopLabel}</span>
          </button>
        </div>
      )}

      {/* Compact keypress / typing toast chip */}
      {latestKeyOrTypeCue && (
        <div
          key={latestKeyOrTypeCue.id}
          data-testid="remote-desktop-ai-key-chip"
          className="pointer-events-none absolute bottom-4 left-1/2 z-30 flex max-w-[75%] -translate-x-1/2 items-center gap-1.5 rounded-lg border border-white/15 bg-zinc-950/88 px-3 py-1.5 font-mono text-xs text-cyan-100 shadow-lg backdrop-blur-sm animate-in fade-in-0 zoom-in-95 duration-150"
        >
          <Keyboard size={13} className="shrink-0 text-cyan-300" />
          <span className="truncate">
            {summarizeRemoteDesktopActions([latestKeyOrTypeCue.action], { redactSecrets: true })}
          </span>
        </div>
      )}
    </div>
  );
});

export default RemoteDesktopAiOverlay;
