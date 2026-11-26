import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Check, KeyRound, Loader2, Plug, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { useTerminalSessionCloseCapture } from '../../application/state/terminalSessionCloseCapture';
import type { Host, Identity, KnownHost, SSHKey, TerminalSession } from '../../types';
import type { RdpMultiMonitorMode } from '../../domain/models/connection';
import {
  computeMonitorLayoutEntries,
  resolveRemoteDesktopConnectionSpec,
  type MonitorLayoutSpec,
  type RdpDisplayControlCaps,
  type RemoteDesktopProtocol,
} from '../../domain/remoteDesktop';
import { stopAgentTurn, type AgentStopBridge } from '../../infrastructure/ai/harness/agentStop';
import {
  listRemoteDesktopAuditEntries,
  subscribeRemoteDesktopAuditLog,
} from '../../infrastructure/remoteDesktop/remoteDesktopAuditLog';
import {
  getRemoteDesktopAiControlState,
  isRemoteDesktopAiControlling,
  preemptRemoteDesktopControl,
  registerRemoteDesktopController,
  subscribeRemoteDesktopAiControlState,
} from '../../infrastructure/remoteDesktop/remoteDesktopControlRegistry';
import {
  addRemoteDesktopSharedFolder,
  loadRemoteDesktopSharedFolders,
  removeRemoteDesktopSharedFolder,
  updateRemoteDesktopSharedFolder,
  type RemoteDesktopSharedFolder,
} from '../../infrastructure/remoteDesktop/remoteDesktopSharedFolders';
import {
  clearRemoteDesktopTelemetry,
  publishRemoteDesktopFps,
  publishRemoteDesktopNetworkStats,
} from '../../infrastructure/remoteDesktop/remoteDesktopTelemetryStore';
import {
  captureRemoteDesktopFrame,
  clearCapturedRemoteDesktopFramesForSession,
  clearRemoteDesktopSessionState,
  getCapturedRemoteDesktopFrame,
  isRemoteDesktopAiReadBlocked,
  registerRemoteDesktopSnapshotProvider,
  setRemoteDesktopAiReadBlocked,
  subscribeRemoteDesktopAiReadBlocked,
  subscribeRemoteDesktopCaptureEvents,
  type RemoteDesktopCropRect,
} from '../../infrastructure/remoteDesktop/remoteDesktopSnapshotRegistry';
import { cn } from '../../lib/utils';
import type { RemoteDesktopScreenshotDraftPayload } from '../ai/remoteDesktopAiDraft';
import { DistroAvatar } from '../DistroAvatar';
import {
  CattyIcon,
  RdpProtocolIcon,
  SshTunnelIcon,
  SystemRdpClientIcon,
  SystemVncClientIcon,
  VncProtocolIcon,
} from '../icons/RemoteDesktopIcons';
import { Button } from '../ui/button';
import { toast } from '../ui/toast';
import {
  trustKnownRemoteDesktopCert,
  verifyKnownRemoteDesktopCert,
} from './knownRemoteDesktopCerts';
import { RdpCanvasView } from './RdpCanvasView';
import { RemoteDesktopAiOverlay, type RemoteDesktopAiOverlayRect } from './RemoteDesktopAiOverlay';
import { RemoteDesktopAuditDialog } from './RemoteDesktopAuditDialog';
import { RemoteDesktopAuthDialog } from './RemoteDesktopAuthDialog';
import { RemoteDesktopCertDialog } from './RemoteDesktopCertDialog';
import {
  buildRemoteDesktopStartPayload,
  buildSystemRemoteDesktopPayload,
  getRemoteDesktopBridge,
  tr,
  type RemoteDesktopCanvasHandle,
  type RemoteDesktopCertDecisionValue,
  type RemoteDesktopCertVerifyEvent,
  type RemoteDesktopClipboardFileOffer,
  type RemoteDesktopClipboardTransferState,
  type RemoteDesktopDisplayMode,
  type RemoteDesktopLocalDisplay,
  type RemoteDesktopQualityPreset,
} from './remoteDesktopHelpers';
import {
  RemoteDesktopSnipOverlay,
  type RemoteDesktopSnipRect,
} from './RemoteDesktopSnipOverlay';
import { RemoteDesktopToolbar } from './RemoteDesktopToolbar';
import { useRemoteDesktopRecorder } from './useRemoteDesktopRecorder';
import { VncCanvasView, type VncCapabilities } from './VncCanvasView';
import type { RemoteDesktopSpecialKeyId } from './vncKeymap';

const EMPTY_FINALIZE_LOG = () => '';

export interface RemoteDesktopPaneProps {
  sessionId: string;
  workspaceId?: string;
  protocol: RemoteDesktopProtocol;
  host: Host;
  chainHosts?: Host[];
  keys: SSHKey[];
  identities: Identity[];
  knownHosts?: KnownHost[];
  isVisible: boolean;
  isFocused: boolean;
  inWorkspace?: boolean;
  onStatusChange?: (sessionId: string, status: TerminalSession['status']) => void;
  onCloseSession?: (sessionId: string) => void;
  onPopOut?: (sessionId: string) => void;
  onOpenSftp?: () => void;
  isSftpOpen?: boolean;
  onAskAi?: (payload: RemoteDesktopScreenshotDraftPayload | null) => void;
  onTerminalDataCapture?: (sessionId: string, data: string) => void | Promise<void>;
}

function resolveProgressStepIndex(stage: string, wsReady: boolean, tunneled: boolean): number {
  const normalized = stage.toLowerCase();
  if (normalized.includes('connected') || normalized.includes('ready')) return 3;
  if (
    normalized.includes('auth') ||
    normalized.includes('negotiat') ||
    normalized.includes('nla') ||
    normalized.includes('rfb') ||
    wsReady
  ) {
    return 2;
  }
  if (normalized.includes('tls') || normalized.includes('cert')) return 1;
  if (normalized.includes('tunnel') || normalized.includes('bastion') || tunneled) return 0;
  return 0;
}

function sanitizeRemoteDesktopError(raw: string | null): string | null {
  if (!raw) return null;
  // Never expose local loopback proxy query tokens (sessionId/token) in the UI.
  let cleaned = raw
    .replace(/wss?:\/\/127\.0\.0\.1:\d+\/rd\?[^\s)]+/gi, 'local remote-desktop proxy')
    .replace(/([?&]token=)[^&\s)]+/gi, '$1***')
    .trim();
  if (/failed to connect to local remote-desktop proxy/i.test(cleaned)) {
    cleaned = 'Failed to establish local remote-desktop proxy channel. Please retry.';
  }
  return cleaned;
}

function formatBackendStage(stage: string, isRdp: boolean): string {
  switch (stage) {
    case 'starting':
    case 'dialing':
      return 'Connecting to server...';
    case 'tunneling':
      return 'Establishing SSH Bastion tunnel...';
    case 'tls':
    case 'cert-verify':
      return 'Verifying TLS certificate...';
    case 'authenticating':
    case 'negotiating':
      return isRdp ? 'Negotiating NLA / RDP security...' : 'Authenticating RFB session...';
    case 'connected':
    case 'ready':
      return 'Desktop connected';
    default:
      return stage;
  }
}

export const RemoteDesktopPane: React.FC<RemoteDesktopPaneProps> = React.memo(({
  sessionId,
  workspaceId,
  protocol,
  host,
  chainHosts,
  keys,
  identities,
  knownHosts,
  isVisible,
  isFocused,
  onStatusChange,
  onCloseSession,
  onPopOut,
  onAskAi,
  onTerminalDataCapture,
}) => {
  const { t } = useI18n();
  const isRdp = protocol === 'rdp';
  const paneRootRef = useRef<HTMLDivElement | null>(null);
  const canvasAreaRef = useRef<HTMLDivElement | null>(null);
  const canvasHandleRef = useRef<RemoteDesktopCanvasHandle | null>(null);
  const activeBackendSessionIdRef = useRef<string | null>(null);
  const attemptNonceRef = useRef(0);
  const closeCaptureNeverConnectedRef = useRef(false);
  const closeCaptureDoneRef = useRef(false);

  const spec = useMemo(
    () => resolveRemoteDesktopConnectionSpec(host, protocol, identities),
    [host, identities, protocol],
  );

  // Runtime credentials (may be updated via RemoteDesktopAuthDialog without mutating vault)
  const [credentials, setCredentials] = useState<{
    username: string;
    password: string;
    domain: string;
  }>(() => ({
    username: spec.username,
    password: spec.password ?? '',
    domain: spec.domain,
  }));

  // For RDP with missing password or username, prompt immediately; for VNC, allow trying None auth
  // if no password is configured unless user was already prompted.
  const [needsAuthPrompt, setNeedsAuthPrompt] = useState<boolean>(
    () => isRdp && (spec.needsPasswordPrompt || !spec.username),
  );
  // Explicit connection intent prevents dismissing the credential prompt from auto-connecting.
  const [connectionIntent, setConnectionIntent] = useState<'active' | 'idle'>(
    () => (isRdp && (spec.needsPasswordPrompt || !spec.username) ? 'idle' : 'active'),
  );
  const [authErrorMessage, setAuthErrorMessage] = useState<string | null>(null);

  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>(
    needsAuthPrompt ? 'disconnected' : 'connecting',
  );
  const statusRef = useRef<'connecting' | 'connected' | 'disconnected'>(status);
  statusRef.current = status;
  const [stageMessage, setStageMessage] = useState<string>('Initializing connection...');
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const [connectAttempt, setConnectAttempt] = useState(0);
  const [fallbackDisableCredSsp, setFallbackDisableCredSsp] = useState(false);

  // Display, audio, input, and toolbar controls
  const [displayMode, setDisplayMode] = useState<RemoteDesktopDisplayMode>(() => {
    if (isRdp) {
      const mode = spec.rdpConfig?.resolutionMode;
      if (mode === 'fixed') return 'actual';
      if (mode === 'fit') return 'fit';
      return 'dynamic';
    }
    return spec.vncConfig?.scalingMode ?? 'fit';
  });
  const [quality, setQuality] = useState<RemoteDesktopQualityPreset>('auto');
  const [highDpi, setHighDpi] = useState<boolean>(true);
  const [mapCmdToCtrl, setMapCmdToCtrl] = useState<boolean>(() => (
    typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent || '')
  ));
  const [showRemoteCursor, setShowRemoteCursor] = useState<boolean>(() => Boolean(spec.vncConfig?.showRemoteCursor ?? true));
  const [supportsDynamicResize, setSupportsDynamicResize] = useState<boolean>(isRdp);
  const [supportsXvp, setSupportsXvp] = useState<boolean>(false);
  const [viewOnly, setViewOnly] = useState<boolean>(() => !isRdp && Boolean(spec.vncConfig?.viewOnly));
  const [clipboardSyncEnabled, setClipboardSyncEnabled] = useState<boolean>(() => (
    isRdp ? (spec.rdpConfig?.clipboardSync ?? true) : (spec.vncConfig?.clipboardSync ?? true)
  ));
  const [audioMuted, setAudioMuted] = useState(false);
  const [audioVolume, setAudioVolume] = useState(1.0);
  const [keyboardGrabActive, setKeyboardGrabActive] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [resolution, setResolution] = useState<{ width: number; height: number } | null>(null);
  const [encrypted, setEncrypted] = useState<boolean>(false);
  const [desktopTitle, setDesktopTitle] = useState<string | null>(null);
  // Resolution presets, multi-monitor, RDPDR local shared folders, and live telemetry
  const [fixedResolution, setFixedResolution] = useState<{ width: number; height: number } | null>(null);
  const [multiMonitorMode, setMultiMonitorMode] = useState<RdpMultiMonitorMode>(
    () => (isRdp ? (spec.rdpConfig?.multiMonitorMode ?? 'single') : 'single'),
  );
  const [monitorLayout, setMonitorLayout] = useState<MonitorLayoutSpec[]>([]);
  const [activeMonitorIndex, setActiveMonitorIndex] = useState<'all' | number>('all');
  const [localDisplays, setLocalDisplays] = useState<RemoteDesktopLocalDisplay[]>([]);
  const [displayControlCaps, setDisplayControlCaps] = useState<RdpDisplayControlCaps | null>(null);
  const [sharedFolders, setSharedFolders] = useState<RemoteDesktopSharedFolder[]>(() => (
    isRdp ? loadRemoteDesktopSharedFolders(host.id) : []
  ));
  const lastStatsUpdateRef = useRef<number>(0);
  const appliedAllLocalRef = useRef<boolean>(false);
  const lastBellToastAtRef = useRef<number>(0);
  const [aiAuditOpen, setAiAuditOpen] = useState(false);
  const [aiAuditCount, setAiAuditCount] = useState<number>(() => listRemoteDesktopAuditEntries(sessionId).length);
  const [aiControlActive, setAiControlActive] = useState<boolean>(() => isRemoteDesktopAiControlling(sessionId));
  const [aiOverlayCanvasRect, setAiOverlayCanvasRect] = useState<RemoteDesktopAiOverlayRect | null>(null);
  const [pendingCert, setPendingCert] = useState<{
    event: RemoteDesktopCertVerifyEvent;
    previousFingerprint: string | null;
  } | null>(null);
  const [remoteClipboardFiles, setRemoteClipboardFiles] = useState<RemoteDesktopClipboardFileOffer[]>([]);
  const [clipboardFileTransferStatus, setClipboardFileTransferStatus] = useState<string | null>(null);
  const [clipboardTransfer, setClipboardTransfer] = useState<RemoteDesktopClipboardTransferState | null>(null);
  const lastToastedTransferKeyRef = useRef<string | null>(null);
  const [remoteAppBannerDismissed, setRemoteAppBannerDismissed] = useState(false);

  // P2-AI Vision state (shutter pulse, crop highlight, viewing pill, snip overlay, privacy lock)
  const [aiReadBlocked, setAiReadBlocked] = useState<boolean>(() => isRemoteDesktopAiReadBlocked(sessionId));
  const [isSnipping, setIsSnipping] = useState(false);
  const [shutterPulseActive, setShutterPulseActive] = useState(false);
  const [aiViewingBadgeVisible, setAiViewingBadgeVisible] = useState(false);
  const [aiCropHighlight, setAiCropHighlight] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);

  const tunneled = Boolean(spec.tunnelViaHostSsh || (chainHosts && chainHosts.length > 0));
  const effectiveLabel = desktopTitle || spec.label || spec.hostHostname;

  const recorder = useRemoteDesktopRecorder({
    sessionId,
    protocol,
    hostLabel: effectiveLabel,
    status,
    audioEnabled: isRdp && Boolean(spec.rdpConfig?.audioEnabled),
    canvasHandleRef,
  });

  // Stamp ConnectionLog endTime when this remote desktop session closes via any UI/hotkey path.
  const handleCloseLogCapture = useCallback(
    (closingSessionId: string, data: string) => {
      closeCaptureDoneRef.current = true;
      return onTerminalDataCapture?.(closingSessionId, data);
    },
    [onTerminalDataCapture],
  );
  useTerminalSessionCloseCapture({
    sessionId,
    enabled: Boolean(onTerminalDataCapture),
    hasConnectedRef: closeCaptureNeverConnectedRef,
    terminalDataCapturedRef: closeCaptureDoneRef,
    finalizeTerminalLogData: EMPTY_FINALIZE_LOG,
    onTerminalDataCapture: handleCloseLogCapture,
  });

  const updateStatus = useCallback(
    (next: 'connecting' | 'connected' | 'disconnected') => {
      setStatus(next);
      onStatusChange?.(sessionId, next);
    },
    [onStatusChange, sessionId],
  );

  // Sync Keyboard Grab state with Electron main process (per-window)
  const applyKeyboardGrab = useCallback((active: boolean) => {
    setKeyboardGrabActive(active);
    void getRemoteDesktopBridge()?.setKeyboardGrab(active).catch(() => {});
  }, []);

  const releaseKeyboardGrab = useCallback(() => {
    canvasHandleRef.current?.releaseAllInputs();
    applyKeyboardGrab(false);
  }, [applyKeyboardGrab]);

  // Listen for main-process grab resets (window blur / hide / minimize / navigation)
  useEffect(() => {
    const rdBridge = getRemoteDesktopBridge();
    if (!rdBridge?.onKeyboardGrabChanged) return undefined;
    return rdBridge.onKeyboardGrabChanged(({ active }) => {
      if (!active) {
        canvasHandleRef.current?.releaseAllInputs();
        setKeyboardGrabActive(false);
      }
    });
  }, []);

  // Automatically release grab when pane hides, loses focus, disconnects, or unmounts
  useEffect(() => {
    if ((!isVisible || !isFocused || status !== 'connected' || viewOnly) && keyboardGrabActive) {
      releaseKeyboardGrab();
    }
  }, [isFocused, isVisible, keyboardGrabActive, releaseKeyboardGrab, status, viewOnly]);

  useEffect(() => () => {
    if (keyboardGrabActive) {
      void getRemoteDesktopBridge()?.setKeyboardGrab(false).catch(() => {});
    }
  }, [keyboardGrabActive]);

  // P1-C: Auto-clear completed/error clipboard transfer pill after 3.5s + toast
  const handleClipboardTransferChange = useCallback(
    (next: RemoteDesktopClipboardTransferState | null) => {
      setClipboardTransfer(next);
      if (!next) return;
      if (next.phase === 'completed' || next.phase === 'error') {
        const toastKey = `${next.id}:${next.phase}`;
        if (lastToastedTransferKeyRef.current !== toastKey) {
          lastToastedTransferKeyRef.current = toastKey;
          if (next.phase === 'completed') {
            toast.success(
              next.message || tr(t, 'remoteDesktop.clipboard.transferCompleted', 'Clipboard file transfer complete'),
            );
          } else {
            toast.error(
              next.error || next.message || tr(t, 'remoteDesktop.clipboard.transferFailed', 'Clipboard file transfer failed'),
            );
          }
        }
      }
    },
    [t],
  );

  useEffect(() => {
    if (!clipboardTransfer) return undefined;
    if (clipboardTransfer.phase !== 'completed' && clipboardTransfer.phase !== 'error') {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      setClipboardTransfer((current) => (current?.id === clipboardTransfer.id ? null : current));
      setClipboardFileTransferStatus(null);
    }, 3500);
    return () => window.clearTimeout(timer);
  }, [clipboardTransfer]);

  // P2-AI: Sync per-session privacy lock state
  useEffect(() => {
    setAiReadBlocked(isRemoteDesktopAiReadBlocked(sessionId));
    return subscribeRemoteDesktopAiReadBlocked(sessionId, setAiReadBlocked);
  }, [sessionId]);

  // Reload local-only RDPDR shared folders when host changes
  useEffect(() => {
    if (!isRdp) {
      setSharedFolders([]);
      return;
    }
    setSharedFolders(loadRemoteDesktopSharedFolders(host.id));
  }, [host.id, isRdp]);

  // Discover local displays for RDP multi-monitor ("Match Local Displays")
  useEffect(() => {
    if (!isRdp) return undefined;
    let cancelled = false;
    const rdBridge = getRemoteDesktopBridge();
    if (!rdBridge?.getLocalDisplays) return undefined;
    void rdBridge
      .getLocalDisplays()
      .then((displays) => {
        if (!cancelled && Array.isArray(displays)) {
          setLocalDisplays(displays);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isRdp]);

  // Subscribe to AI Computer Use audit log count for this session
  useEffect(() => {
    const refresh = () => setAiAuditCount(listRemoteDesktopAuditEntries(sessionId).length);
    refresh();
    return subscribeRemoteDesktopAuditLog(refresh);
  }, [sessionId]);

  // Keep AI Computer Use controller registered against live canvas state
  const aiControllerStateRef = useRef({
    connected: status === 'connected',
    viewOnly,
    protocol,
    hostLabel: effectiveLabel,
    hostname: spec.hostHostname,
    desktopWidth: resolution?.width || 1280,
    desktopHeight: resolution?.height || 800,
  });
  aiControllerStateRef.current = {
    connected: status === 'connected',
    viewOnly,
    protocol,
    hostLabel: effectiveLabel,
    hostname: spec.hostHostname,
    desktopWidth: resolution?.width || 1280,
    desktopHeight: resolution?.height || 800,
  };

  useEffect(() => {
    return registerRemoteDesktopController(sessionId, {
      performAction: async (action, options) => {
        const handle = canvasHandleRef.current;
        if (!handle?.performAiAction) {
          throw new Error('Remote desktop canvas does not support AI actions.');
        }
        await handle.performAiAction(action, options);
      },
      releaseAllInputs: () => {
        canvasHandleRef.current?.releaseAllInputs();
      },
      getState: () => ({ ...aiControllerStateRef.current }),
    });
  }, [sessionId]);

  // Clean up per-session snapshot/privacy/telemetry state and RDPDR backend state when pane unmounts
  useEffect(() => () => {
    clearRemoteDesktopSessionState(sessionId);
    clearRemoteDesktopTelemetry(sessionId);
    if (isRdp) {
      void getRemoteDesktopBridge()?.rdpdrCleanup?.(sessionId).catch(() => {});
    }
  }, [isRdp, sessionId]);

  const handleFpsChange = useCallback(
    (nextFps: number) => {
      publishRemoteDesktopFps(sessionId, nextFps);
    },
    [sessionId],
  );

  // Track canvas bounding rect relative to canvasAreaRef for RemoteDesktopAiOverlay.
  // Only observe layout changes while AI control is actually active to avoid idle reflows.
  const refreshAiOverlayRect = useCallback(() => {
    const canvasRect = canvasHandleRef.current?.getCanvasRect?.();
    const areaRect = canvasAreaRef.current?.getBoundingClientRect();
    if (!canvasRect || !areaRect || canvasRect.width <= 0 || canvasRect.height <= 0) {
      setAiOverlayCanvasRect(null);
      return;
    }
    const next: RemoteDesktopAiOverlayRect = {
      left: canvasRect.left - areaRect.left,
      top: canvasRect.top - areaRect.top,
      width: canvasRect.width,
      height: canvasRect.height,
    };
    setAiOverlayCanvasRect((prev) => (
      prev
      && Math.abs(prev.left - next.left) < 1
      && Math.abs(prev.top - next.top) < 1
      && Math.abs(prev.width - next.width) < 1
      && Math.abs(prev.height - next.height) < 1
        ? prev
        : next
    ));
  }, []);

  useEffect(() => {
    setAiControlActive(isRemoteDesktopAiControlling(sessionId));
    return subscribeRemoteDesktopAiControlState(sessionId, (state) => {
      setAiControlActive(state.controlling);
      if (state.controlling) {
        refreshAiOverlayRect();
      }
    });
  }, [refreshAiOverlayRect, sessionId]);

  useEffect(() => {
    if (!aiControlActive) return undefined;
    refreshAiOverlayRect();
    const area = canvasAreaRef.current;
    const observer = typeof ResizeObserver !== 'undefined' && area
      ? new ResizeObserver(refreshAiOverlayRect)
      : null;
    if (observer && area) observer.observe(area);
    window.addEventListener('resize', refreshAiOverlayRect, { passive: true });
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', refreshAiOverlayRect);
    };
  }, [activeMonitorIndex, aiControlActive, displayMode, refreshAiOverlayRect, resolution, status]);

  const handleAiPreemptStop = useCallback(
    (reason: 'stop-button' | 'escape' | 'pointer') => {
      canvasHandleRef.current?.releaseAllInputs();
      toast.info(
        reason === 'stop-button' || reason === 'escape'
          ? tr(t, 'remoteDesktop.ai.preemptedStopped', 'AI control stopped — you have taken over')
          : tr(t, 'remoteDesktop.ai.preempted', 'AI control paused — you have taken over'),
      );
    },
    [t],
  );

  const handleCanvasAreaPointerDownCapture = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isRemoteDesktopAiControlling(sessionId)) return;
      const targetEl = e.target as HTMLElement | null;
      if (targetEl?.closest?.('[data-testid="remote-desktop-ai-control-banner"]')) {
        return;
      }
      if (preemptRemoteDesktopControl(sessionId, 'pointer')) {
        canvasHandleRef.current?.releaseAllInputs();
        toast.info(tr(t, 'remoteDesktop.ai.preempted', 'AI control paused — you have taken over'));
      }
    },
    [sessionId, t],
  );

  const handleCanvasAreaKeyDownCapture = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!isRemoteDesktopAiControlling(sessionId)) return;
      const isEscape = e.key === 'Escape';
      const chatSessionId = getRemoteDesktopAiControlState(sessionId).chatSessionId || sessionId;
      if (preemptRemoteDesktopControl(sessionId, isEscape ? 'escape' : 'keyboard')) {
        canvasHandleRef.current?.releaseAllInputs();
        if (isEscape) {
          e.preventDefault();
          e.stopPropagation();
          const bridge = typeof window !== 'undefined'
            ? (window as unknown as { netcatty?: AgentStopBridge }).netcatty ?? null
            : null;
          void stopAgentTurn({ chatSessionId, bridge, reason: 'user' });
          toast.info(tr(t, 'remoteDesktop.ai.preemptedStopped', 'AI control stopped — you have taken over'));
        } else {
          toast.info(tr(t, 'remoteDesktop.ai.preempted', 'AI control paused — you have taken over'));
        }
      }
    },
    [sessionId, t],
  );

  // P2-AI: Register/unregister snapshot provider while connected; purge LRU cache on disconnect/unmount
  useEffect(() => {
    if (status !== 'connected') {
      clearCapturedRemoteDesktopFramesForSession(sessionId);
      setIsSnipping(false);
      return undefined;
    }
    const unregister = registerRemoteDesktopSnapshotProvider(sessionId, (req) => {
      const handle = canvasHandleRef.current;
      if (!handle?.captureFrame) return null;
      return handle.captureFrame({
        ...req,
        protocol,
        hostLabel: effectiveLabel,
        hostname: spec.hostHostname,
      });
    });
    return () => {
      unregister();
      clearCapturedRemoteDesktopFramesForSession(sessionId);
    };
  }, [effectiveLabel, protocol, sessionId, spec.hostHostname, status]);

  // P2-AI: Subscribe to AI screen capture events for 280ms shutter pulse, crop highlight & 2s pill
  useEffect(() => {
    let pulseTimer: number | null = null;
    let badgeTimer: number | null = null;
    let cropTimer: number | null = null;

    const computeCropBox = (crop: RemoteDesktopCropRect) => {
      const canvasRect = canvasHandleRef.current?.getCanvasRect?.();
      const areaRect = canvasAreaRef.current?.getBoundingClientRect();
      if (!canvasRect || !areaRect || canvasRect.width <= 0 || canvasRect.height <= 0) {
        return null;
      }
      return {
        left: canvasRect.left - areaRect.left + (crop.x / 1000) * canvasRect.width,
        top: canvasRect.top - areaRect.top + (crop.y / 1000) * canvasRect.height,
        width: (crop.width / 1000) * canvasRect.width,
        height: (crop.height / 1000) * canvasRect.height,
      };
    };

    const unsubscribe = subscribeRemoteDesktopCaptureEvents(sessionId, (ev) => {
      if (ev.source !== 'ai-tool') return;
      setShutterPulseActive(true);
      setAiViewingBadgeVisible(true);
      if (pulseTimer !== null) window.clearTimeout(pulseTimer);
      if (badgeTimer !== null) window.clearTimeout(badgeTimer);
      if (cropTimer !== null) window.clearTimeout(cropTimer);

      pulseTimer = window.setTimeout(() => {
        setShutterPulseActive(false);
        pulseTimer = null;
      }, 280);
      badgeTimer = window.setTimeout(() => {
        setAiViewingBadgeVisible(false);
        badgeTimer = null;
      }, 2000);

      if (ev.crop) {
        const box = computeCropBox(ev.crop);
        setAiCropHighlight(box);
        if (box) {
          cropTimer = window.setTimeout(() => {
            setAiCropHighlight(null);
            cropTimer = null;
          }, 1200);
        }
      } else {
        setAiCropHighlight(null);
      }
    });

    return () => {
      unsubscribe();
      if (pulseTimer !== null) window.clearTimeout(pulseTimer);
      if (badgeTimer !== null) window.clearTimeout(badgeTimer);
      if (cropTimer !== null) window.clearTimeout(cropTimer);
    };
  }, [sessionId]);

  const exitFullscreenIfActive = useCallback(async () => {
    if (isFullscreen || (typeof document !== 'undefined' && document.fullscreenElement)) {
      await document.exitFullscreen?.().catch(() => {});
    }
  }, [isFullscreen]);

  const handleAskAiFull = useCallback(async () => {
    if (!onAskAi || status !== 'connected') return;
    releaseKeyboardGrab();
    await exitFullscreenIfActive();
    const res = await captureRemoteDesktopFrame(sessionId, {
      quality: 'standard',
      source: 'user-full',
    });
    if (res.ok === false) {
      toast.error('error' in res ? res.error : 'Failed to capture remote desktop frame');
      return;
    }
    const cached = getCapturedRemoteDesktopFrame(res.captureId);
    if (!cached) {
      toast.error('Failed to capture remote desktop frame');
      return;
    }
    onAskAi({
      sessionId,
      workspaceId,
      base64Data: cached.base64Data,
      mediaType: cached.mediaType,
      width: cached.width,
      height: cached.height,
      naturalWidth: cached.naturalWidth,
      naturalHeight: cached.naturalHeight,
      hostLabel: effectiveLabel,
      protocol,
    });
  }, [effectiveLabel, exitFullscreenIfActive, onAskAi, protocol, releaseKeyboardGrab, sessionId, status, workspaceId]);

  const handleStartAskAiRegion = useCallback(() => {
    if (!onAskAi || status !== 'connected') return;
    releaseKeyboardGrab();
    setIsSnipping(true);
  }, [onAskAi, releaseKeyboardGrab, status]);

  const handleSnipSelect = useCallback(
    async (rect: RemoteDesktopSnipRect) => {
      setIsSnipping(false);
      if (!onAskAi) return;
      await exitFullscreenIfActive();
      const crop: RemoteDesktopCropRect = {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
      const res = await captureRemoteDesktopFrame(sessionId, {
        quality: 'high',
        crop,
        source: 'user-snip',
      });
      if (res.ok === false) {
        toast.error('error' in res ? res.error : 'Failed to capture selected region');
        return;
      }
      const cached = getCapturedRemoteDesktopFrame(res.captureId);
      if (!cached) {
        toast.error('Failed to capture selected region');
        return;
      }
      onAskAi({
        sessionId,
        workspaceId,
        base64Data: cached.base64Data,
        mediaType: cached.mediaType,
        width: cached.width,
        height: cached.height,
        naturalWidth: cached.naturalWidth,
        naturalHeight: cached.naturalHeight,
        crop,
        hostLabel: effectiveLabel,
        protocol,
      });
    },
    [effectiveLabel, exitFullscreenIfActive, onAskAi, protocol, sessionId, workspaceId],
  );

  const handleOpenAiChat = useCallback(() => {
    if (!onAskAi) return;
    releaseKeyboardGrab();
    void exitFullscreenIfActive().then(() => {
      onAskAi(null);
    });
  }, [exitFullscreenIfActive, onAskAi, releaseKeyboardGrab]);

  const handleToggleAiReadBlocked = useCallback(
    (blocked: boolean) => {
      setRemoteDesktopAiReadBlocked(sessionId, blocked);
    },
    [sessionId],
  );

  // Fullscreen listener
  useEffect(() => {
    const handleFsChange = () => {
      const root = paneRootRef.current;
      setIsFullscreen(Boolean(root && document.fullscreenElement === root));
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => document.removeEventListener('fullscreenchange', handleFsChange);
  }, []);

  // Listen for backend status + TOFU certificate verification events for this session
  useEffect(() => {
    const rdBridge = getRemoteDesktopBridge();
    if (!rdBridge) return undefined;

    const unsubStatus = rdBridge.onStatus((payload) => {
      const activeId = activeBackendSessionIdRef.current;
      if (!activeId || payload.sessionId !== activeId) return;
      if (payload.status) {
        setStageMessage(formatBackendStage(payload.status, isRdp));
      }
      if (payload.error) {
        setDisconnectError(payload.error);
      }
    });

    const unsubCert = rdBridge.onCertVerify((event) => {
      const activeId = activeBackendSessionIdRef.current;
      if (!activeId || event.sessionId !== activeId) return;

      const check = verifyKnownRemoteDesktopCert(
        event.protocol,
        event.host || spec.hostHostname,
        event.port || spec.port,
        event.fingerprintSha256,
      );

      if (check.status === 'trusted' || (isRdp && spec.rdpConfig?.ignoreCertErrors)) {
        void rdBridge.respondCertDecision(event.requestId, 'accept-once');
        return;
      }

      setPendingCert({
        event,
        previousFingerprint: check.previousFingerprint ?? event.previousFingerprint,
      });
    });

    const unsubStats = rdBridge.onStats?.((stats) => {
      const activeId = activeBackendSessionIdRef.current;
      if (!stats || (stats.sessionId !== activeId && stats.sessionId !== sessionId)) return;
      const now = Date.now();
      if (now - lastStatsUpdateRef.current < 400) return;
      lastStatsUpdateRef.current = now;
      publishRemoteDesktopNetworkStats(sessionId, stats);
    });

    return () => {
      unsubStatus();
      unsubCert();
      unsubStats?.();
    };
  }, [isRdp, sessionId, spec.hostHostname, spec.port, spec.rdpConfig?.ignoreCertErrors]);

  // Start / stop backend proxy session
  useEffect(() => {
    if (needsAuthPrompt || connectionIntent !== 'active') return undefined;
    const rdBridge = getRemoteDesktopBridge();
    if (!rdBridge) {
      setDisconnectError('Remote desktop bridge is unavailable in this environment.');
      updateStatus('disconnected');
      return undefined;
    }

    let cancelled = false;
    let startedBackend = false;
    const attemptSessionId = `${sessionId}:${connectAttempt}:${++attemptNonceRef.current}`;
    activeBackendSessionIdRef.current = attemptSessionId;
    setWsUrl(null);
    setDisconnectError(null);
    setPendingCert(null);
    setRemoteClipboardFiles([]);
    setClipboardFileTransferStatus(null);
    setClipboardTransfer(null);
    publishRemoteDesktopNetworkStats(sessionId, null);
    publishRemoteDesktopFps(sessionId, 0);
    setDisplayControlCaps(null);
    setSupportsXvp(false);
    appliedAllLocalRef.current = false;
    updateStatus('connecting');
    setStageMessage(
      tunneled
        ? 'Connecting via SSH tunnel...'
        : isRdp
          ? 'Connecting to RDP server...'
          : 'Connecting to VNC server...',
    );

    const payload = buildRemoteDesktopStartPayload({
      sessionId: attemptSessionId,
      host,
      spec,
      credentials,
      chainHosts,
      keys,
      identities,
      knownHosts,
      quality,
      viewOnly,
      securityMode: fallbackDisableCredSsp ? 'tls' : spec.rdpConfig?.securityMode,
      ignoreCertErrors: spec.rdpConfig?.ignoreCertErrors,
    });

    // Defer backend start by a macrotask so React StrictMode's immediate
    // mount->cleanup->remount pass cancels cleanly before creating a session
    // or racing stop() against the live attempt.
    const startTimer = window.setTimeout(() => {
      if (cancelled) return;
      startedBackend = true;
      void rdBridge
        .start(payload)
        .then((result) => {
          if (cancelled) {
            void rdBridge.stop(result.sessionId).catch(() => {});
            return;
          }
          activeBackendSessionIdRef.current = result.sessionId;
          setWsUrl(result.wsUrl);
          setStageMessage(isRdp ? 'Completing TLS & NLA handshake...' : 'Completing RFB handshake...');
        })
        .catch((err) => {
          if (cancelled) return;
          const msg = err instanceof Error ? err.message : String(err);
          setDisconnectError(msg);
          updateStatus('disconnected');
        });
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(startTimer);
      if (activeBackendSessionIdRef.current === attemptSessionId) {
        activeBackendSessionIdRef.current = null;
      }
      if (startedBackend) {
        void rdBridge.stop(attemptSessionId).catch(() => {});
      }
    };
    // Intentionally reconnect only when connectAttempt, connectionIntent, needsAuthPrompt, or fallback change.
    // Quality changes apply live over the active VNC WebSocket without reconnecting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectAttempt, connectionIntent, needsAuthPrompt, fallbackDisableCredSsp]);

  const handleCertDecision = useCallback(
    (decision: RemoteDesktopCertDecisionValue) => {
      const current = pendingCert;
      setPendingCert(null);
      if (!current) return;
      if (decision === 'accept-always') {
        trustKnownRemoteDesktopCert(
          current.event.protocol,
          current.event.host || spec.hostHostname,
          current.event.port || spec.port,
          {
            fingerprintSha256: current.event.fingerprintSha256,
            subject: current.event.subject,
            issuer: current.event.issuer,
            validFrom: current.event.validFrom,
            validTo: current.event.validTo,
          },
        );
      }
      void getRemoteDesktopBridge()?.respondCertDecision(current.event.requestId, decision);
      if (decision === 'reject') {
        setDisconnectError(tr(t, 'remoteDesktop.cert.rejected', 'TLS certificate rejected by user.'));
        updateStatus('disconnected');
      }
    },
    [pendingCert, spec.hostHostname, spec.port, t, updateStatus],
  );

  const handleAuthSubmit = useCallback(
    (nextCreds: { username: string; password: string; domain: string }) => {
      setCredentials(nextCreds);
      setAuthErrorMessage(null);
      setNeedsAuthPrompt(false);
      setConnectionIntent('active');
      setFallbackDisableCredSsp(false);
      setConnectAttempt((n) => n + 1);
    },
    [],
  );

  const handleAuthCancel = useCallback(() => {
    setNeedsAuthPrompt(false);
    setConnectionIntent('idle');
    setDisconnectError(tr(t, 'remoteDesktop.auth.cancelled', 'Authentication cancelled.'));
    updateStatus('disconnected');
  }, [t, updateStatus]);

  const handleReconnect = useCallback(() => {
    setDisconnectError(null);
    setFallbackDisableCredSsp(false);
    setConnectionIntent('active');
    setConnectAttempt((n) => n + 1);
  }, []);

  const handleDisconnect = useCallback(() => {
    releaseKeyboardGrab();
    const activeId = activeBackendSessionIdRef.current;
    if (activeId) {
      void getRemoteDesktopBridge()?.stop(activeId).catch(() => {});
    }
    setWsUrl(null);
    updateStatus('disconnected');
    onCloseSession?.(sessionId);
  }, [onCloseSession, releaseKeyboardGrab, sessionId, updateStatus]);

  const handleOpenSystemClient = useCallback(async () => {
    const rdBridge = getRemoteDesktopBridge();
    if (!rdBridge) return;
    try {
      const opts = buildSystemRemoteDesktopPayload({
        host,
        protocol,
        chainHosts,
        keys,
        identities,
        knownHosts,
      });
      const res = await rdBridge.openSystemClient(opts);
      if (!res?.ok) {
        toast.error(res?.error || 'Failed to launch system remote desktop client');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to launch system client');
    }
  }, [chainHosts, host, identities, keys, knownHosts, protocol]);

  const handleToggleFullscreen = useCallback(() => {
    const root = paneRootRef.current;
    if (!root) return;
    if (document.fullscreenElement === root) {
      void document.exitFullscreen().catch((err) => {
        console.warn('[RemoteDesktop] Failed to exit fullscreen:', err);
      });
    } else {
      void root.requestFullscreen().catch((err) => {
        console.warn('[RemoteDesktop] Failed to enter fullscreen:', err);
      });
    }
  }, []);

  const handleTypeClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard?.readText();
      if (!text) {
        toast.info(tr(t, 'remoteDesktop.clipboard.empty', 'Clipboard is empty'));
        return;
      }
      canvasHandleRef.current?.typeText(text);
    } catch {
      toast.error(tr(t, 'remoteDesktop.clipboard.readFailed', 'Unable to read clipboard'));
    }
  }, [t]);

  const handleScreenshotCopy = useCallback(async () => {
    const blob = await canvasHandleRef.current?.captureScreenshot();
    if (!blob) return;
    try {
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        toast.success(tr(t, 'remoteDesktop.screenshot.copied', 'Screenshot copied to clipboard'));
      }
    } catch {
      toast.error(tr(t, 'remoteDesktop.screenshot.copyFailed', 'Failed to copy screenshot'));
    }
  }, [t]);

  const handleScreenshotSave = useCallback(async () => {
    const blob = await canvasHandleRef.current?.captureScreenshot();
    if (!blob) return;
    const safeHost = effectiveLabel.replace(/[^a-zA-Z0-9._-]+/g, '_');
    const fileName = `${safeHost}-${protocol}-${Date.now()}.png`;
    const rdBridge = getRemoteDesktopBridge();
    if (rdBridge?.saveClipboardFile) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const res = await rdBridge.saveClipboardFile({ action: 'oneshot', fileName, data: bytes });
      if (res?.ok && !res.canceled) {
        toast.success(tr(t, 'remoteDesktop.screenshot.saved', 'Screenshot saved'));
      }
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  }, [effectiveLabel, protocol, t]);

  const handleCanvasError = useCallback(
    (err: { message: string; isAuthError?: boolean }) => {
      releaseKeyboardGrab();
      publishRemoteDesktopNetworkStats(sessionId, null);
      publishRemoteDesktopFps(sessionId, 0);
      if (err.isAuthError) {
        setAuthErrorMessage(err.message);
        setConnectionIntent('idle');
        setNeedsAuthPrompt(true);
        setWsUrl(null);
        updateStatus('disconnected');
        return;
      }
      setDisconnectError(err.message);
      updateStatus('disconnected');
    },
    [releaseKeyboardGrab, sessionId, updateStatus],
  );

  const handleCanvasDisconnected = useCallback(
    (reason?: string) => {
      releaseKeyboardGrab();
      publishRemoteDesktopNetworkStats(sessionId, null);
      publishRemoteDesktopFps(sessionId, 0);
      if (reason) setDisconnectError(reason);
      updateStatus('disconnected');
    },
    [releaseKeyboardGrab, sessionId, updateStatus],
  );

  const handleNegotiationFallback = useCallback(() => {
    setFallbackDisableCredSsp(true);
    setStageMessage('CredSSP unavailable, retrying with TLS security...');
    setConnectAttempt((n) => n + 1);
  }, []);

  const handleToggleKeyboardGrab = useCallback(() => {
    const next = !keyboardGrabActive;
    applyKeyboardGrab(next);
    if (next) {
      canvasHandleRef.current?.focusInput?.();
    }
  }, [applyKeyboardGrab, keyboardGrabActive]);

  const handleSendSpecialKey = useCallback((id: RemoteDesktopSpecialKeyId) => {
    canvasHandleRef.current?.sendSpecialKey(id);
    canvasHandleRef.current?.focusInput?.();
  }, []);

  const handleRefreshScreen = useCallback(() => {
    canvasHandleRef.current?.requestRefresh?.();
  }, []);

  const handleSyncClipboardNow = useCallback(() => {
    void canvasHandleRef.current?.syncClipboardNow?.();
    toast.success(tr(t, 'remoteDesktop.clipboard.pushed', 'Local clipboard synced to remote'));
  }, [t]);

  const handleToggleClipboardSync = useCallback((enabled: boolean) => {
    setClipboardSyncEnabled(enabled);
    if (enabled) {
      void canvasHandleRef.current?.syncClipboardNow?.();
    }
  }, []);

  const handleTypeClipboardClick = useCallback(() => {
    void handleTypeClipboard();
  }, [handleTypeClipboard]);

  const handleToggleAudioMute = useCallback(() => {
    setAudioMuted((m) => !m);
  }, []);

  const handleChangeAudioVolume = useCallback((vol: number) => {
    setAudioVolume(vol);
    if (vol > 0) setAudioMuted(false);
  }, []);

  const handleDismissClipboardTransfer = useCallback(() => {
    setClipboardTransfer(null);
    setClipboardFileTransferStatus(null);
  }, []);

  const handleDownloadClipboardFile = useCallback((idx: number) => {
    void canvasHandleRef.current?.downloadRemoteClipboardFile?.(idx);
  }, []);

  const handleUploadLocalClipboardFiles = useCallback((files: FileList | File[]) => {
    void canvasHandleRef.current?.uploadLocalClipboardFiles?.(files);
  }, []);

  const handleChangeDisplayMode = useCallback((mode: RemoteDesktopDisplayMode) => {
    setDisplayMode(mode);
    if (mode === 'dynamic') {
      setFixedResolution(null);
      setMultiMonitorMode('single');
      setMonitorLayout([]);
      setActiveMonitorIndex('all');
    }
  }, []);

  const handleChangeQuality = useCallback((nextQuality: RemoteDesktopQualityPreset) => {
    setQuality(nextQuality);
    canvasHandleRef.current?.setQuality?.(nextQuality);
  }, []);

  const handleSendXvpAction = useCallback((action: 'shutdown' | 'reboot' | 'reset') => {
    canvasHandleRef.current?.sendXvpAction?.(action);
  }, []);

  const handleVncCapabilitiesChange = useCallback((caps: VncCapabilities) => {
    if (caps.extendedDesktopSize) {
      setSupportsDynamicResize(true);
    }
    if (caps.xvp) {
      setSupportsXvp(true);
    }
  }, []);

  const handleVncBell = useCallback(() => {
    const now = Date.now();
    if (now - lastBellToastAtRef.current < 3000) return;
    lastBellToastAtRef.current = now;
    toast.info(tr(t, 'remoteDesktop.vnc.bell', 'Remote desktop bell'));
  }, [t]);

  const handleSnipCancel = useCallback(() => {
    setIsSnipping(false);
  }, []);

  const handleSelectResolutionPreset = useCallback((width: number, height: number) => {
    setFixedResolution({ width, height });
    setMultiMonitorMode('single');
    setMonitorLayout([]);
    setActiveMonitorIndex('all');
    setDisplayMode((prev) => (prev === 'dynamic' ? 'fit' : prev));
    canvasHandleRef.current?.resizeToPreset?.(width, height);
  }, []);

  const applyMultiMonitorLayout = useCallback(
    (mode: RdpMultiMonitorMode, capsOverride?: RdpDisplayControlCaps | null) => {
      const rect = canvasAreaRef.current?.getBoundingClientRect();
      const paneWidth = Math.max(640, Math.floor(rect?.width || 1280));
      const paneHeight = Math.max(480, Math.floor(rect?.height || 800));
      const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
      const caps = capsOverride ?? displayControlCaps;
      const entries = computeMonitorLayoutEntries(mode, {
        paneWidth,
        paneHeight,
        dpr,
        highDpi,
        localDisplays,
        maxMonitors: caps?.maxNumMonitors,
      });
      setMultiMonitorMode(mode);
      setFixedResolution(null);
      setMonitorLayout(entries);
      setActiveMonitorIndex('all');
      if (mode === 'all-local' && localDisplays.length > 0) {
        appliedAllLocalRef.current = true;
      }
      if (entries.length > 1) {
        setDisplayMode((prev) => (prev === 'dynamic' ? 'fit' : prev));
      }
      canvasHandleRef.current?.setMonitorLayout?.(entries);
    },
    [displayControlCaps, highDpi, localDisplays],
  );

  const handleChangeMultiMonitorMode = useCallback(
    (mode: RdpMultiMonitorMode) => {
      applyMultiMonitorLayout(mode);
    },
    [applyMultiMonitorLayout],
  );

  const handleDisplayControlCaps = useCallback(
    (caps: RdpDisplayControlCaps) => {
      setDisplayControlCaps(caps);
      if (multiMonitorMode !== 'single') {
        applyMultiMonitorLayout(multiMonitorMode, caps);
      }
    },
    [applyMultiMonitorLayout, multiMonitorMode],
  );

  // If 'all-local' was requested before localDisplays finished loading, apply once both are ready.
  useEffect(() => {
    if (
      !isRdp
      || status !== 'connected'
      || multiMonitorMode !== 'all-local'
      || appliedAllLocalRef.current
      || localDisplays.length === 0
      || !displayControlCaps
    ) {
      return;
    }
    applyMultiMonitorLayout('all-local', displayControlCaps);
  }, [applyMultiMonitorLayout, displayControlCaps, isRdp, localDisplays.length, multiMonitorMode, status]);

  const syncDrivesToBackend = useCallback(
    async (folders: readonly RemoteDesktopSharedFolder[]) => {
      const rdBridge = getRemoteDesktopBridge();
      if (!rdBridge?.rdpdrRegisterDrives) return null;
      return rdBridge
        .rdpdrRegisterDrives(
          sessionId,
          folders.map((f) => ({
            deviceId: f.deviceId,
            name: f.name,
            path: f.path,
            readOnly: f.readOnly,
          })),
        )
        .catch(() => null);
    },
    [sessionId],
  );

  const handleAddSharedFolder = useCallback(async () => {
    const rdBridge = getRemoteDesktopBridge();
    if (!rdBridge?.rdpdrPickFolder) return;
    try {
      const picked = await rdBridge.rdpdrPickFolder();
      if (!picked?.ok || picked.canceled || !picked.path) return;
      const result = addRemoteDesktopSharedFolder(host.id, {
        path: picked.path,
        name: picked.name,
        readOnly: false,
      });
      if (result.duplicate) {
        toast.info(tr(t, 'remoteDesktop.sharedFolders.duplicate', 'This folder is already shared'));
        return;
      }
      setSharedFolders(result.folders);
      const regRes = await syncDrivesToBackend(result.folders);
      if (result.added && regRes) {
        const isRegistered = regRes.ok
          && regRes.registered.some((d) => d.deviceId === result.added?.deviceId);
        if (!isRegistered) {
          const rejectedReason = regRes.rejected.find((r) => r.deviceId === result.added?.deviceId)?.reason
            || regRes.error
            || 'Folder could not be registered for sharing';
          const reverted = removeRemoteDesktopSharedFolder(host.id, result.added.id);
          setSharedFolders(reverted);
          toast.error(rejectedReason);
          return;
        }
      }
      if (result.added && statusRef.current === 'connected') {
        canvasHandleRef.current?.addSharedDrive?.({
          deviceId: result.added.deviceId,
          name: result.added.name,
        });
        toast.success(
          tr(t, 'remoteDesktop.sharedFolders.mounted', 'Mounted "{name}" on remote desktop', {
            name: result.added.name,
          }),
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add shared folder');
    }
  }, [host.id, syncDrivesToBackend, t]);

  const handleAddSharedFolderClick = useCallback(() => {
    void handleAddSharedFolder();
  }, [handleAddSharedFolder]);

  const handleRemoveSharedFolder = useCallback(
    (folderId: string) => {
      const target = sharedFolders.find((f) => f.id === folderId);
      const next = removeRemoteDesktopSharedFolder(host.id, folderId);
      setSharedFolders(next);
      void syncDrivesToBackend(next);
      if (target && status === 'connected') {
        canvasHandleRef.current?.removeSharedDrive?.(target.deviceId);
        toast.info(
          tr(t, 'remoteDesktop.sharedFolders.unmounted', 'Unmounted "{name}"', {
            name: target.name,
          }),
        );
      }
    },
    [host.id, sharedFolders, status, syncDrivesToBackend, t],
  );

  const handleToggleSharedFolderReadOnly = useCallback(
    (folderId: string, readOnly: boolean) => {
      const next = updateRemoteDesktopSharedFolder(host.id, folderId, { readOnly });
      setSharedFolders(next);
      void syncDrivesToBackend(next);
    },
    [host.id, syncDrivesToBackend],
  );

  const handleOpenAiAuditLog = useCallback(() => {
    releaseKeyboardGrab();
    setAiAuditOpen(true);
  }, [releaseKeyboardGrab]);

  const handleAskAiFullClick = useCallback(() => {
    void handleAskAiFull();
  }, [handleAskAiFull]);

  const toggleRecording = recorder.toggleRecording;
  const handleToggleRecordingClick = useCallback(() => {
    void toggleRecording();
  }, [toggleRecording]);

  const handleScreenshotCopyClick = useCallback(() => {
    void handleScreenshotCopy();
  }, [handleScreenshotCopy]);

  const handleScreenshotSaveClick = useCallback(() => {
    void handleScreenshotSave();
  }, [handleScreenshotSave]);

  const handlePopOutClick = useCallback(() => {
    onPopOut?.(sessionId);
  }, [onPopOut, sessionId]);

  const handleOpenSystemClientClick = useCallback(() => {
    void handleOpenSystemClient();
  }, [handleOpenSystemClient]);

  const handleVncConnected = useCallback(
    (info: {
      width: number;
      height: number;
      name?: string;
      encrypted?: boolean;
      supportsDynamicResize?: boolean;
      supportsXvp?: boolean;
    }) => {
      setResolution({ width: info.width, height: info.height });
      if (info.name) setDesktopTitle(info.name);
      setEncrypted(Boolean(info.encrypted));
      setSupportsDynamicResize(Boolean(info.supportsDynamicResize));
      setSupportsXvp(Boolean(info.supportsXvp));
      setStageMessage('Desktop connected');
      updateStatus('connected');
    },
    [updateStatus],
  );

  const handleRdpConnected = useCallback(
    (info: { width: number; height: number; encrypted?: boolean }) => {
      setResolution({ width: info.width, height: info.height });
      setEncrypted(Boolean(info.encrypted));
      setStageMessage('Desktop connected');
      updateStatus('connected');
    },
    [updateStatus],
  );

  const handleRemoteClipboardFilesChange = useCallback(
    (files: RemoteDesktopClipboardFileOffer[]) => {
      setRemoteClipboardFiles(files);
      if (files.length > 0) {
        toast.info(
          tr(
            t,
            'remoteDesktop.clipboard.filesAvailable',
            '{{count}} remote file(s) copied — click the clipboard icon in the toolbar to save.',
            { count: files.length },
          ),
        );
      }
    },
    [t],
  );

  const handleGetSnipCanvasRect = useCallback(
    () => canvasHandleRef.current?.getCanvasRect?.() ?? null,
    [],
  );

  const handleSnipSelectClick = useCallback(
    (rect: RemoteDesktopSnipRect) => {
      void handleSnipSelect(rect);
    },
    [handleSnipSelect],
  );

  const showRemoteAppNotice =
    isRdp && Boolean(spec.rdpConfig?.remoteApplicationMode) && !remoteAppBannerDismissed;

  return (
    <div
      ref={paneRootRef}
      className={cn(
        'relative flex h-full w-full flex-col overflow-hidden bg-black text-foreground select-none',
        keyboardGrabActive && 'ring-2 ring-inset ring-primary/80',
      )}
      data-section="remote-desktop-pane"
      data-remote-desktop-protocol={protocol}
      data-remote-desktop-capture={keyboardGrabActive && isVisible && isFocused ? 'true' : undefined}
    >
      <RemoteDesktopToolbar
        sessionId={sessionId}
        protocol={protocol}
        hostLabel={effectiveLabel}
        status={status}
        statusDetail={stageMessage}
        tunneled={tunneled}
        encrypted={encrypted}
        resolution={resolution}
        isFullscreen={isFullscreen}
        keyboardGrabActive={keyboardGrabActive}
        onToggleKeyboardGrab={handleToggleKeyboardGrab}
        onSendSpecialKey={handleSendSpecialKey}
        onTypeClipboard={handleTypeClipboardClick}
        displayMode={displayMode}
        onChangeDisplayMode={handleChangeDisplayMode}
        supportsDynamicResize={isRdp || supportsDynamicResize}
        highDpi={highDpi}
        onToggleHighDpi={isRdp ? setHighDpi : undefined}
        mapCmdToCtrl={mapCmdToCtrl}
        onToggleMapCmdToCtrl={setMapCmdToCtrl}
        fixedResolution={fixedResolution}
        onSelectResolutionPreset={handleSelectResolutionPreset}
        multiMonitorMode={isRdp ? multiMonitorMode : undefined}
        onChangeMultiMonitorMode={isRdp ? handleChangeMultiMonitorMode : undefined}
        monitorCount={isRdp ? Math.max(1, monitorLayout.length) : 1}
        localDisplayCount={isRdp ? Math.max(1, localDisplays.length) : 1}
        activeMonitorIndex={activeMonitorIndex}
        onSelectActiveMonitor={isRdp ? setActiveMonitorIndex : undefined}
        sharedFolders={isRdp ? sharedFolders : undefined}
        onAddSharedFolder={isRdp ? handleAddSharedFolderClick : undefined}
        onRemoveSharedFolder={isRdp ? handleRemoveSharedFolder : undefined}
        onToggleSharedFolderReadOnly={isRdp ? handleToggleSharedFolderReadOnly : undefined}
        audioEnabled={isRdp && Boolean(spec.rdpConfig?.audioEnabled)}
        audioMuted={audioMuted}
        audioVolume={audioVolume}
        onToggleAudioMute={handleToggleAudioMute}
        onChangeAudioVolume={handleChangeAudioVolume}
        clipboardSyncEnabled={clipboardSyncEnabled}
        onToggleClipboardSync={handleToggleClipboardSync}
        onSyncClipboardNow={handleSyncClipboardNow}
        remoteClipboardFiles={remoteClipboardFiles}
        clipboardFileTransferStatus={clipboardFileTransferStatus}
        clipboardTransfer={clipboardTransfer}
        onDismissClipboardTransfer={handleDismissClipboardTransfer}
        onDownloadClipboardFile={handleDownloadClipboardFile}
        onUploadLocalClipboardFiles={
          isRdp && spec.rdpConfig?.clipboardFilesEnabled
            ? handleUploadLocalClipboardFiles
            : undefined
        }
        onAskAiFull={onAskAi ? handleAskAiFullClick : undefined}
        onAskAiRegion={onAskAi ? handleStartAskAiRegion : undefined}
        onOpenAiChat={onAskAi ? handleOpenAiChat : undefined}
        aiReadBlocked={aiReadBlocked}
        onToggleAiReadBlocked={onAskAi ? handleToggleAiReadBlocked : undefined}
        aiAuditCount={aiAuditCount}
        onOpenAiAuditLog={onAskAi ? handleOpenAiAuditLog : undefined}
        isRecording={recorder.isRecording}
        recordingElapsedLabel={recorder.formattedElapsed}
        recordingSupported={recorder.isSupported}
        onToggleRecording={handleToggleRecordingClick}
        quality={quality}
        onChangeQuality={handleChangeQuality}
        viewOnly={viewOnly}
        onToggleViewOnly={setViewOnly}
        showRemoteCursor={!isRdp ? showRemoteCursor : undefined}
        onToggleShowRemoteCursor={!isRdp ? setShowRemoteCursor : undefined}
        supportsXvp={!isRdp ? supportsXvp : undefined}
        onSendXvpAction={!isRdp ? handleSendXvpAction : undefined}
        onRefreshScreen={!isRdp ? handleRefreshScreen : undefined}
        onScreenshotCopy={handleScreenshotCopyClick}
        onScreenshotSave={handleScreenshotSaveClick}
        onToggleFullscreen={handleToggleFullscreen}
        onPopOut={onPopOut ? handlePopOutClick : undefined}
        onOpenSystemClient={handleOpenSystemClientClick}
        onReconnect={handleReconnect}
        onDisconnect={handleDisconnect}
      />

      {showRemoteAppNotice && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200">
          <div className="flex min-w-0 items-center gap-2">
            <AlertCircle size={14} className="shrink-0 text-amber-400" />
            <span className="truncate">
              {tr(
                t,
                'remoteDesktop.rdp.remoteAppNotice',
                'This .rdp profile uses RemoteApp mode. Netcatty runs full desktop mode, or you can open it in the system RDP client.',
              )}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-6 gap-1 px-2 text-[11px]"
              onClick={() => void handleOpenSystemClient()}
            >
              <SystemRdpClientIcon size={12} className="text-blue-400" />
              <span>{tr(t, 'remoteDesktop.toolbar.openSystemRdp', 'Open in System RDP')}</span>
            </Button>
            <button
              type="button"
              className="rounded p-0.5 text-amber-200/70 hover:text-amber-100"
              onClick={() => setRemoteAppBannerDismissed(true)}
              aria-label="Dismiss"
            >
              <X size={13} />
            </button>
          </div>
        </div>
      )}

      {/* Main Canvas Area */}
      <div
        ref={canvasAreaRef}
        className="relative flex min-h-0 flex-1 overflow-hidden"
        onPointerDownCapture={handleCanvasAreaPointerDownCapture}
        onKeyDownCapture={handleCanvasAreaKeyDownCapture}
      >
        {wsUrl && !isRdp && (
          <VncCanvasView
            ref={canvasHandleRef}
            wsUrl={wsUrl}
            isVisible={isVisible}
            displayMode={displayMode}
            viewOnly={viewOnly}
            clipboardSyncEnabled={clipboardSyncEnabled}
            showRemoteCursor={showRemoteCursor}
            mapCmdToCtrl={mapCmdToCtrl}
            keyboardGrabActive={keyboardGrabActive}
            onRequestReleaseGrab={releaseKeyboardGrab}
            onConnected={handleVncConnected}
            onCapabilitiesChange={handleVncCapabilitiesChange}
            onDesktopResize={setResolution}
            onDesktopName={setDesktopTitle}
            onBell={handleVncBell}
            onFpsChange={handleFpsChange}
            onError={handleCanvasError}
            onDisconnected={handleCanvasDisconnected}
          />
        )}

        {wsUrl && isRdp && spec.rdpConfig && (
          <RdpCanvasView
            ref={canvasHandleRef}
            sessionId={sessionId}
            wsUrl={wsUrl}
            hostname={spec.hostname}
            port={spec.port}
            username={credentials.username}
            password={credentials.password}
            domain={credentials.domain}
            rdpConfig={spec.rdpConfig}
            fallbackDisableCredSsp={fallbackDisableCredSsp}
            isVisible={isVisible}
            displayMode={displayMode}
            highDpi={highDpi}
            mapCmdToCtrl={mapCmdToCtrl}
            viewOnly={viewOnly}
            clipboardSyncEnabled={clipboardSyncEnabled}
            audioMuted={audioMuted}
            audioVolume={audioVolume}
            keyboardGrabActive={keyboardGrabActive}
            sharedFolders={sharedFolders}
            fixedResolution={fixedResolution}
            monitorLayout={monitorLayout}
            activeMonitorIndex={activeMonitorIndex}
            onDisplayControlCaps={handleDisplayControlCaps}
            onFpsChange={handleFpsChange}
            onRequestReleaseGrab={releaseKeyboardGrab}
            onConnected={handleRdpConnected}
            onDesktopResize={setResolution}
            onRemoteClipboardFilesChange={handleRemoteClipboardFilesChange}
            onClipboardFileTransferStatus={setClipboardFileTransferStatus}
            onClipboardTransferChange={handleClipboardTransferChange}
            onNegotiationFallbackNeeded={handleNegotiationFallback}
            onError={handleCanvasError}
            onDisconnected={handleCanvasDisconnected}
          />
        )}

        {/* P2-AI: 280ms Shutter Pulse Border Glow */}
        {shutterPulseActive && (
          <div
            data-testid="remote-desktop-ai-shutter"
            className="pointer-events-none absolute inset-0 z-30 ring-2 ring-inset ring-primary/90 shadow-[inset_0_0_24px_rgba(59,130,246,0.38)] transition-opacity duration-300"
          />
        )}

        {/* P2-AI: Crop Region Highlight */}
        {aiCropHighlight && (
          <div
            data-testid="remote-desktop-ai-crop-highlight"
            className="pointer-events-none absolute z-30 rounded-sm border-2 border-primary bg-primary/10 shadow-[0_0_12px_rgba(59,130,246,0.45)] transition-opacity duration-300"
            style={{
              left: aiCropHighlight.left,
              top: aiCropHighlight.top,
              width: aiCropHighlight.width,
              height: aiCropHighlight.height,
            }}
          />
        )}

        {/* P2-AI: 2s "Catty is viewing desktop" Top-Right Pill */}
        {aiViewingBadgeVisible && (
          <div
            data-testid="remote-desktop-ai-viewing-badge"
            className="pointer-events-none absolute right-3 top-3 z-30 inline-flex items-center gap-1.5 rounded-full border border-cyan-400/35 bg-zinc-950/88 px-2.5 py-1 text-[11px] font-medium text-cyan-100 shadow-lg backdrop-blur-md animate-in fade-in-0 zoom-in-95 duration-150"
          >
            <CattyIcon size={12} className="text-cyan-300 animate-pulse" />
            <span>{tr(t, 'ai.vision.viewingScreen', 'Catty is viewing desktop')}</span>
          </div>
        )}

        {/* P2-AI: Region Snip Overlay */}
        <RemoteDesktopSnipOverlay
          open={isSnipping && status === 'connected'}
          naturalWidth={resolution?.width || 1280}
          naturalHeight={resolution?.height || 800}
          getCanvasRect={handleGetSnipCanvasRect}
          onSelect={handleSnipSelectClick}
          onCancel={handleSnipCancel}
        />

        {/* AI Computer Use Visual Feedback & Preemption Overlay */}
        <RemoteDesktopAiOverlay
          sessionId={sessionId}
          canvasRect={aiOverlayCanvasRect}
          onPreemptStop={handleAiPreemptStop}
        />

        {/* Connecting Progress Overlay — matches Netcatty TerminalConnectionDialog */}
        {status === 'connecting' && !pendingCert && !needsAuthPrompt && (() => {
          const activeStep = resolveProgressStepIndex(stageMessage, Boolean(wsUrl), tunneled);
          const steps = [
            {
              key: 'transport',
              label: tunneled
                ? tr(t, 'remoteDesktop.step.bastion', 'Bastion')
                : tr(t, 'remoteDesktop.step.network', 'Network'),
              icon: tunneled ? <SshTunnelIcon size={13} /> : <Plug size={13} />,
            },
            {
              key: 'tls',
              label: 'TLS',
              icon: <ShieldCheck size={13} />,
            },
            {
              key: 'auth',
              label: isRdp
                ? tr(t, 'remoteDesktop.step.nla', 'NLA Auth')
                : tr(t, 'remoteDesktop.step.rfb', 'RFB Auth'),
              icon: <KeyRound size={13} />,
            },
            {
              key: 'desktop',
              label: tr(t, 'remoteDesktop.step.desktop', 'Desktop'),
              icon: isRdp ? <RdpProtocolIcon size={13} /> : <VncProtocolIcon size={13} />,
            },
          ];

          return (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/85 p-4 backdrop-blur-sm">
              <div className="w-[460px] max-w-[90vw] rounded-xl border border-border/70 bg-card/95 p-5 text-card-foreground shadow-xl space-y-4 animate-in fade-in-0 zoom-in-95 duration-200">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <DistroAvatar
                      host={host}
                      fallback={effectiveLabel.slice(0, 2).toUpperCase()}
                      size="md"
                      className="shrink-0"
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-semibold text-foreground">
                          {effectiveLabel}
                        </span>
                        {tunneled && (
                          <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-emerald-500 shrink-0">
                            <SshTunnelIcon size={10} />
                            SSH
                          </span>
                        )}
                      </div>
                      <div className="truncate font-mono text-[11px] text-muted-foreground">
                        {protocol.toUpperCase()} {spec.hostHostname}:{spec.port}
                      </div>
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 shrink-0 px-3 text-xs"
                    onClick={handleDisconnect}
                  >
                    {tr(t, 'common.cancel', 'Cancel')}
                  </Button>
                </div>

                {/* Minimalist 4-step connection stepper */}
                <div className="flex items-center pt-1">
                  {steps.map((step, idx) => {
                    const isDone = idx < activeStep;
                    const isActive = idx === activeStep;
                    return (
                      <React.Fragment key={step.key}>
                        <div className="flex flex-col items-center gap-1.5">
                          <div
                            className={cn(
                              'flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors',
                              isDone
                                ? 'bg-primary/15 text-primary'
                                : isActive
                                  ? 'bg-primary text-primary-foreground'
                                  : 'bg-muted/70 text-muted-foreground',
                            )}
                          >
                            {isDone ? (
                              <Check size={13} />
                            ) : isActive && idx === steps.length - 1 ? (
                              <Loader2 size={13} className="animate-spin" />
                            ) : (
                              step.icon
                            )}
                          </div>
                          <span
                            className={cn(
                              'text-[10px] font-medium',
                              isDone || isActive ? 'text-foreground' : 'text-muted-foreground',
                            )}
                          >
                            {step.label}
                          </span>
                        </div>
                        {idx < steps.length - 1 && (
                          <div className="relative mx-2 mb-5 h-1 flex-1 overflow-hidden rounded-full bg-border/60">
                            <div
                              className={cn(
                                'absolute inset-y-0 left-0 rounded-full bg-primary transition-all duration-300',
                                isDone ? 'w-full' : isActive ? 'w-1/2 animate-pulse' : 'w-0',
                              )}
                            />
                          </div>
                        )}
                      </React.Fragment>
                    );
                  })}
                </div>

                <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-background/60 px-3 py-2 text-xs text-muted-foreground">
                  <Loader2 size={13} className="shrink-0 animate-spin text-primary" />
                  <span className="truncate">{stageMessage}</span>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Minimalist Disconnected Overlay — mirrors Netcatty TerminalConnectionDialog */}
        {status === 'disconnected' && !needsAuthPrompt && !pendingCert && (() => {
          const displayError = sanitizeRemoteDesktopError(disconnectError);
          const hasError = Boolean(displayError);
          return (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/85 p-6 backdrop-blur-sm">
              <div className="w-[460px] max-w-[90vw] rounded-xl border border-border/70 bg-card/95 p-5 text-card-foreground shadow-xl space-y-4 animate-in fade-in-0 zoom-in-95 duration-200">
                {/* Header */}
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <DistroAvatar
                      host={host}
                      fallback={effectiveLabel.slice(0, 2).toUpperCase()}
                      size="md"
                      className="shrink-0"
                    />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-foreground">
                        {effectiveLabel}
                      </div>
                      <div className="truncate font-mono text-[11px] text-muted-foreground">
                        {protocol.toUpperCase()} {spec.hostHostname}:{spec.port}
                      </div>
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
                    onClick={handleDisconnect}
                    aria-label={tr(t, 'common.close', 'Close')}
                  >
                    <X size={14} />
                  </Button>
                </div>

                {/* 3-node status bar matching TerminalConnectionDialog */}
                <div className="flex items-center gap-2.5">
                  <div
                    className={cn(
                      'flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
                      hasError
                        ? 'bg-destructive/15 text-destructive'
                        : 'bg-muted/70 text-muted-foreground',
                    )}
                  >
                    <Plug size={13} />
                  </div>
                  <div className="h-1 flex-1 overflow-hidden rounded-full bg-border/60">
                    <div
                      className={cn(
                        'h-full w-full rounded-full',
                        hasError ? 'bg-destructive/80' : 'bg-muted-foreground/30',
                      )}
                    />
                  </div>
                  <div
                    className={cn(
                      'flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
                      hasError
                        ? 'bg-destructive/15 text-destructive'
                        : 'bg-muted/70 text-muted-foreground',
                    )}
                  >
                    <ShieldCheck size={13} />
                  </div>
                  <div className="h-1 flex-1 overflow-hidden rounded-full bg-border/60">
                    <div
                      className={cn(
                        'h-full w-full rounded-full',
                        hasError ? 'bg-destructive/80' : 'bg-muted-foreground/30',
                      )}
                    />
                  </div>
                  <div
                    className={cn(
                      'flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
                      hasError
                        ? 'bg-destructive/15 text-destructive'
                        : 'bg-muted/70 text-muted-foreground',
                    )}
                  >
                    {isRdp ? <RdpProtocolIcon size={13} /> : <VncProtocolIcon size={13} />}
                  </div>
                </div>

                {/* Clean status / error box */}
                <div className="rounded-lg border border-border/50 bg-background/60 px-3 py-2.5 text-xs leading-relaxed">
                  {displayError ? (
                    <div className="flex items-start gap-2 text-destructive">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" />
                      <span className="break-words">{displayError}</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/60" />
                      <span>{tr(t, 'remoteDesktop.disconnected.title', 'Session Disconnected')}</span>
                    </div>
                  )}
                </div>

                {/* Footer actions */}
                <div className="flex items-center justify-between gap-2 pt-0.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => void handleOpenSystemClient()}
                  >
                    {isRdp ? (
                      <SystemRdpClientIcon size={13} className="text-blue-500" />
                    ) : (
                      <SystemVncClientIcon size={13} className="text-teal-500" />
                    )}
                    <span>
                      {isRdp
                        ? tr(t, 'remoteDesktop.toolbar.openSystemRdp', 'Open in System RDP')
                        : tr(t, 'remoteDesktop.toolbar.openSystemVnc', 'Open in Screen Sharing')}
                    </span>
                  </Button>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1.5 px-3 text-xs"
                      onClick={() => {
                        setAuthErrorMessage(null);
                        setConnectionIntent('idle');
                        setNeedsAuthPrompt(true);
                      }}
                    >
                      <KeyRound size={13} />
                      <span>{tr(t, 'remoteDesktop.auth.reenter', 'Credentials')}</span>
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      className="h-8 gap-1.5 px-3.5 text-xs"
                      onClick={handleReconnect}
                    >
                      <RefreshCw size={13} />
                      <span>{tr(t, 'remoteDesktop.toolbar.reconnect', 'Reconnect')}</span>
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          );
        })()}

        {/* TLS TOFU Certificate Dialog */}
        {pendingCert && (
          <RemoteDesktopCertDialog
            event={pendingCert.event}
            previousFingerprint={pendingCert.previousFingerprint}
            onDecision={handleCertDecision}
          />
        )}

        {/* Interactive Credential Prompt */}
        {needsAuthPrompt && (
          <RemoteDesktopAuthDialog
            protocol={protocol}
            hostLabel={effectiveLabel}
            hostname={spec.hostHostname}
            port={spec.port}
            initialUsername={credentials.username}
            initialDomain={credentials.domain}
            errorMessage={authErrorMessage}
            onSubmit={handleAuthSubmit}
            onCancel={handleAuthCancel}
          />
        )}
      </div>

      {/* AI Computer Use Audit Log Dialog */}
      <RemoteDesktopAuditDialog
        open={aiAuditOpen}
        onOpenChange={setAiAuditOpen}
        sessionId={sessionId}
        hostLabel={effectiveLabel}
      />
    </div>
  );
});
RemoteDesktopPane.displayName = 'RemoteDesktopPane';

export default RemoteDesktopPane;
