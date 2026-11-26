import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Check, Eye, KeyRound, Loader2, Plug, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { useTerminalSessionCloseCapture } from '../../application/state/terminalSessionCloseCapture';
import type { Host, Identity, KnownHost, SSHKey, TerminalSession } from '../../types';
import {
  resolveRemoteDesktopConnectionSpec,
  type RemoteDesktopProtocol,
} from '../../domain/remoteDesktop';
import {
  captureRemoteDesktopFrame,
  clearCapturedRemoteDesktopFramesForSession,
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
  type RemoteDesktopQualityPreset,
} from './remoteDesktopHelpers';
import {
  RemoteDesktopSnipOverlay,
  type RemoteDesktopSnipRect,
} from './RemoteDesktopSnipOverlay';
import { RemoteDesktopToolbar } from './RemoteDesktopToolbar';
import { useRemoteDesktopRecorder } from './useRemoteDesktopRecorder';
import { VncCanvasView } from './VncCanvasView';
import type { RemoteDesktopSpecialKeyId } from './vncKeymap';

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
  onOpenSftp,
  isSftpOpen = false,
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
  const [authErrorMessage, setAuthErrorMessage] = useState<string | null>(null);

  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>(
    needsAuthPrompt ? 'disconnected' : 'connecting',
  );
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
  const [viewOnly, setViewOnly] = useState<boolean>(() => !isRdp && Boolean(spec.vncConfig?.viewOnly));
  const [clipboardSyncEnabled, setClipboardSyncEnabled] = useState<boolean>(() => (
    isRdp ? (spec.rdpConfig?.clipboardSync ?? true) : (spec.vncConfig?.clipboardSync ?? true)
  ));
  const [audioMuted, setAudioMuted] = useState(false);
  const [audioVolume, setAudioVolume] = useState(1.0);
  const [keyboardGrabActive, setKeyboardGrabActive] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [resolution, setResolution] = useState<{ width: number; height: number } | null>(null);
  const [fps, setFps] = useState<number>(0);
  const [encrypted, setEncrypted] = useState<boolean>(false);
  const [desktopTitle, setDesktopTitle] = useState<string | null>(null);
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
    finalizeTerminalLogData: () => '',
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

  const handleOpenSftpClick = useCallback(() => {
    if (!onOpenSftp) return;
    void exitFullscreenIfActive().then(() => {
      onOpenSftp();
    });
  }, [exitFullscreenIfActive, onOpenSftp]);

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

    return () => {
      unsubStatus();
      unsubCert();
    };
  }, [isRdp, spec.hostHostname, spec.port, spec.rdpConfig?.ignoreCertErrors]);

  // Start / stop backend proxy session
  useEffect(() => {
    if (needsAuthPrompt) return undefined;
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
    // Intentionally reconnect only when connectAttempt, credentials, needsAuthPrompt, quality, or fallback change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectAttempt, needsAuthPrompt, fallbackDisableCredSsp, quality]);

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
      setFallbackDisableCredSsp(false);
      setConnectAttempt((n) => n + 1);
    },
    [],
  );

  const handleReconnect = useCallback(() => {
    setDisconnectError(null);
    setFallbackDisableCredSsp(false);
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
      void document.exitFullscreen().catch(() => {});
    } else {
      void root.requestFullscreen().catch(() => {});
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
      if (err.isAuthError) {
        setAuthErrorMessage(err.message);
        setNeedsAuthPrompt(true);
        setWsUrl(null);
        updateStatus('disconnected');
        return;
      }
      setDisconnectError(err.message);
      updateStatus('disconnected');
    },
    [releaseKeyboardGrab, updateStatus],
  );

  const handleCanvasDisconnected = useCallback(
    (reason?: string) => {
      releaseKeyboardGrab();
      if (reason) setDisconnectError(reason);
      updateStatus('disconnected');
    },
    [releaseKeyboardGrab, updateStatus],
  );

  const handleNegotiationFallback = useCallback(() => {
    setFallbackDisableCredSsp(true);
    setStageMessage('CredSSP unavailable, retrying with TLS security...');
    setConnectAttempt((n) => n + 1);
  }, []);

  const handleToggleKeyboardGrab = useCallback(() => {
    applyKeyboardGrab(!keyboardGrabActive);
  }, [applyKeyboardGrab, keyboardGrabActive]);

  const handleSendSpecialKey = useCallback((id: RemoteDesktopSpecialKeyId) => {
    canvasHandleRef.current?.sendSpecialKey(id);
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
    (info: { width: number; height: number; name?: string; encrypted?: boolean }) => {
      setResolution({ width: info.width, height: info.height });
      if (info.name) setDesktopTitle(info.name);
      setEncrypted(Boolean(info.encrypted));
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
        protocol={protocol}
        hostLabel={effectiveLabel}
        status={status}
        statusDetail={stageMessage}
        tunneled={tunneled}
        encrypted={encrypted}
        resolution={resolution}
        fps={fps}
        isFullscreen={isFullscreen}
        keyboardGrabActive={keyboardGrabActive}
        onToggleKeyboardGrab={handleToggleKeyboardGrab}
        onSendSpecialKey={handleSendSpecialKey}
        onTypeClipboard={handleTypeClipboardClick}
        displayMode={displayMode}
        onChangeDisplayMode={setDisplayMode}
        audioEnabled={isRdp && Boolean(spec.rdpConfig?.audioEnabled)}
        audioMuted={audioMuted}
        audioVolume={audioVolume}
        onToggleAudioMute={handleToggleAudioMute}
        onChangeAudioVolume={handleChangeAudioVolume}
        clipboardSyncEnabled={clipboardSyncEnabled}
        onToggleClipboardSync={setClipboardSyncEnabled}
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
        onOpenSftp={onOpenSftp ? handleOpenSftpClick : undefined}
        isSftpOpen={isSftpOpen}
        onAskAiFull={onAskAi ? handleAskAiFullClick : undefined}
        onAskAiRegion={onAskAi ? handleStartAskAiRegion : undefined}
        onOpenAiChat={onAskAi ? handleOpenAiChat : undefined}
        aiReadBlocked={aiReadBlocked}
        onToggleAiReadBlocked={onAskAi ? handleToggleAiReadBlocked : undefined}
        isRecording={recorder.isRecording}
        recordingElapsedLabel={recorder.formattedElapsed}
        recordingSupported={recorder.isSupported}
        onToggleRecording={handleToggleRecordingClick}
        quality={quality}
        onChangeQuality={setQuality}
        viewOnly={viewOnly}
        onToggleViewOnly={setViewOnly}
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
      <div ref={canvasAreaRef} className="relative flex min-h-0 flex-1 overflow-hidden">
        {wsUrl && !isRdp && (
          <VncCanvasView
            ref={canvasHandleRef}
            wsUrl={wsUrl}
            isVisible={isVisible}
            displayMode={displayMode}
            viewOnly={viewOnly}
            clipboardSyncEnabled={clipboardSyncEnabled}
            showRemoteCursor={spec.vncConfig?.showRemoteCursor ?? true}
            keyboardGrabActive={keyboardGrabActive}
            onRequestReleaseGrab={releaseKeyboardGrab}
            onConnected={handleVncConnected}
            onDesktopResize={setResolution}
            onDesktopName={setDesktopTitle}
            onFpsChange={setFps}
            onError={handleCanvasError}
            onDisconnected={handleCanvasDisconnected}
          />
        )}

        {wsUrl && isRdp && spec.rdpConfig && (
          <RdpCanvasView
            ref={canvasHandleRef}
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
            viewOnly={viewOnly}
            clipboardSyncEnabled={clipboardSyncEnabled}
            audioMuted={audioMuted}
            audioVolume={audioVolume}
            keyboardGrabActive={keyboardGrabActive}
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

        {/* P2-AI: 2s "AI is viewing screen" Top-Right Pill */}
        {aiViewingBadgeVisible && (
          <div
            data-testid="remote-desktop-ai-viewing-badge"
            className="pointer-events-none absolute right-3 top-3 z-30 inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-background/90 px-2.5 py-1 text-[11px] font-medium text-foreground shadow-lg backdrop-blur-md animate-in fade-in-0 zoom-in-95 duration-150"
          >
            <Eye size={12} className="text-primary animate-pulse" />
            <span>{tr(t, 'ai.vision.viewingScreen', 'AI is viewing screen')}</span>
          </div>
        )}

        {/* P2-AI: Region Snip Overlay */}
        <RemoteDesktopSnipOverlay
          open={isSnipping && status === 'connected'}
          naturalWidth={resolution?.width || 1280}
          naturalHeight={resolution?.height || 800}
          getCanvasRect={handleGetSnipCanvasRect}
          onSelect={handleSnipSelectClick}
          onCancel={() => setIsSnipping(false)}
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
            onCancel={() => {
              setNeedsAuthPrompt(false);
              setDisconnectError(tr(t, 'remoteDesktop.auth.cancelled', 'Authentication cancelled.'));
              updateStatus('disconnected');
            }}
          />
        )}
      </div>
    </div>
  );
});
RemoteDesktopPane.displayName = 'RemoteDesktopPane';

export default RemoteDesktopPane;
