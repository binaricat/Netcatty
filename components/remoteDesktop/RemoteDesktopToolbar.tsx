import React, { useEffect, useRef, useState } from 'react';
import {
  Activity,
  AlertCircle,
  AppWindow,
  ArrowDownToLine,
  ArrowUpFromLine,
  Camera,
  Check,
  ChevronDown,
  Circle,
  Clipboard,
  ClipboardCopy,
  Command,
  Crop,
  Download,
  ExternalLink,
  Eye,
  FileDown,
  FolderOpen,
  FolderPlus,
  Gauge,
  HardDrive,
  History,
  Keyboard,
  Layers,
  Lock,
  Maximize,
  Maximize2,
  MessageSquare,
  Minimize,
  Monitor,
  MoreHorizontal,
  MousePointer,
  Pin,
  PinOff,
  Power,
  RefreshCw,
  RotateCw,
  Scaling,
  Scan,
  Search,
  ShieldAlert,
  ShieldOff,
  SlidersHorizontal,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  Upload,
  UploadCloud,
  Volume2,
  VolumeX,
  X,
  XCircle,
} from 'lucide-react';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { RdpMultiMonitorMode } from '../../domain/models/connection';
import {
  classifyNetworkQualityTier,
  formatBandwidthBps,
  RDP_RESOLUTION_PRESETS,
  type NetworkQualityTier,
  type RemoteDesktopProtocol,
} from '../../domain/remoteDesktop';
import type { RemoteDesktopSharedFolder } from '../../infrastructure/remoteDesktop/remoteDesktopSharedFolders';
import {
  getRemoteDesktopTelemetry,
  subscribeRemoteDesktopTelemetry,
} from '../../infrastructure/remoteDesktop/remoteDesktopTelemetryStore';
import { cn } from '../../lib/utils';
import {
  CattyIcon,
  RdpProtocolIcon,
  SshTunnelIcon,
  SystemRdpClientIcon,
  SystemVncClientIcon,
  VncProtocolIcon,
} from '../icons/RemoteDesktopIcons';
import { Button } from '../ui/button';
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Switch } from '../ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import {
  formatTransferBytes,
  tr,
  type RemoteDesktopClipboardFileOffer,
  type RemoteDesktopClipboardTransferState,
  type RemoteDesktopDisplayMode,
  type RemoteDesktopQualityPreset,
  type RemoteDesktopStatsEvent,
} from './remoteDesktopHelpers';
import type { RemoteDesktopSpecialKeyId } from './vncKeymap';

export interface RemoteDesktopToolbarProps {
  sessionId?: string;
  protocol: RemoteDesktopProtocol;
  hostLabel: string;
  status: 'connecting' | 'connected' | 'disconnected';
  statusDetail?: string;
  tunneled?: boolean;
  encrypted?: boolean;
  resolution?: { width: number; height: number } | null;
  fps?: number;
  isFullscreen: boolean;
  keyboardGrabActive: boolean;
  onToggleKeyboardGrab: () => void;
  onSendSpecialKey: (id: RemoteDesktopSpecialKeyId) => void;
  onTypeClipboard: () => void;
  displayMode: RemoteDesktopDisplayMode;
  onChangeDisplayMode: (mode: RemoteDesktopDisplayMode) => void;
  supportsDynamicResize?: boolean;
  // RDP display & keyboard ergonomics
  highDpi?: boolean;
  onToggleHighDpi?: (enabled: boolean) => void;
  mapCmdToCtrl?: boolean;
  onToggleMapCmdToCtrl?: (enabled: boolean) => void;
  // Resolution presets & multi-monitor (RDP, and VNC when dynamic resize supported)
  fixedResolution?: { width: number; height: number } | null;
  onSelectResolutionPreset?: (width: number, height: number) => void;
  multiMonitorMode?: RdpMultiMonitorMode;
  onChangeMultiMonitorMode?: (mode: RdpMultiMonitorMode) => void;
  monitorCount?: number;
  localDisplayCount?: number;
  activeMonitorIndex?: 'all' | number;
  onSelectActiveMonitor?: (index: 'all' | number) => void;
  // RDPDR Shared Folders (RDP only, local-only)
  sharedFolders?: readonly RemoteDesktopSharedFolder[];
  onAddSharedFolder?: () => void;
  onRemoveSharedFolder?: (folderId: string) => void;
  onToggleSharedFolderReadOnly?: (folderId: string, readOnly: boolean) => void;
  // Real-time network telemetry (RDP & VNC)
  networkStats?: RemoteDesktopStatsEvent | null;
  // RDP audio
  audioEnabled?: boolean;
  audioMuted?: boolean;
  audioVolume?: number;
  onToggleAudioMute?: () => void;
  onChangeAudioVolume?: (volume: number) => void;
  // Clipboard + RDP file transfer
  clipboardSyncEnabled: boolean;
  onToggleClipboardSync: (enabled: boolean) => void;
  onSyncClipboardNow?: () => void;
  remoteClipboardFiles?: readonly RemoteDesktopClipboardFileOffer[];
  clipboardFileTransferStatus?: string | null;
  clipboardTransfer?: RemoteDesktopClipboardTransferState | null;
  onDismissClipboardTransfer?: () => void;
  onDownloadClipboardFile?: (fileIndex: number) => void;
  onUploadLocalClipboardFiles?: (files: FileList | File[]) => void;
  // Companion SFTP
  onOpenSftp?: () => void;
  isSftpOpen?: boolean;
  // AI Vision & Computer Use
  onAskAiFull?: () => void;
  onAskAiRegion?: () => void;
  onOpenAiChat?: () => void;
  aiReadBlocked?: boolean;
  onToggleAiReadBlocked?: (blocked: boolean) => void;
  aiAuditCount?: number;
  onOpenAiAuditLog?: () => void;
  // Session Recording
  isRecording?: boolean;
  recordingElapsedLabel?: string;
  recordingSupported?: boolean;
  onToggleRecording?: () => void;
  // Quality / view-only / VNC extras
  quality: RemoteDesktopQualityPreset;
  onChangeQuality: (quality: RemoteDesktopQualityPreset) => void;
  viewOnly: boolean;
  onToggleViewOnly: (viewOnly: boolean) => void;
  showRemoteCursor?: boolean;
  onToggleShowRemoteCursor?: (show: boolean) => void;
  supportsXvp?: boolean;
  onSendXvpAction?: (action: 'shutdown' | 'reboot' | 'reset') => void;
  // Actions
  onRefreshScreen?: () => void;
  onScreenshotCopy: () => void;
  onScreenshotSave: () => void;
  onToggleFullscreen: () => void;
  onPopOut?: () => void;
  onOpenSystemClient?: () => void;
  onReconnect: () => void;
  onDisconnect: () => void;
}

const RDP_SPECIAL_KEY_ITEMS: ReadonlyArray<{
  id: RemoteDesktopSpecialKeyId;
  label: string;
  hint?: string;
  icon: React.ReactNode;
}> = [
  {
    id: 'ctrl-alt-del',
    label: 'Ctrl + Alt + Del',
    hint: 'Security',
    icon: <ShieldAlert size={13} className="text-amber-500" />,
  },
  {
    id: 'win',
    label: 'Win',
    hint: 'Start',
    icon: <AppWindow size={13} className="text-blue-500" />,
  },
  {
    id: 'win-r',
    label: 'Win + R',
    hint: 'Run',
    icon: <Terminal size={13} className="text-sky-500" />,
  },
  {
    id: 'win-e',
    label: 'Win + E',
    hint: 'Explorer',
    icon: <FolderOpen size={13} className="text-amber-400" />,
  },
  {
    id: 'win-d',
    label: 'Win + D',
    hint: 'Desktop',
    icon: <Monitor size={13} className="text-teal-500" />,
  },
  {
    id: 'win-l',
    label: 'Win + L',
    hint: 'Lock',
    icon: <Lock size={13} className="text-muted-foreground" />,
  },
  {
    id: 'alt-tab',
    label: 'Alt + Tab',
    hint: 'Switch',
    icon: <Layers size={13} className="text-sky-500" />,
  },
  {
    id: 'alt-f4',
    label: 'Alt + F4',
    hint: 'Close',
    icon: <XCircle size={13} className="text-rose-500" />,
  },
  {
    id: 'ctrl-shift-esc',
    label: 'Ctrl + Shift + Esc',
    hint: 'Task Mgr',
    icon: <Activity size={13} className="text-emerald-500" />,
  },
  {
    id: 'print-screen',
    label: 'PrintScreen',
    icon: <Camera size={13} className="text-muted-foreground" />,
  },
];

const VNC_SPECIAL_KEY_ITEMS: ReadonlyArray<{
  id: RemoteDesktopSpecialKeyId;
  label: string;
  hint?: string;
  icon: React.ReactNode;
}> = [
  {
    id: 'ctrl-alt-del',
    label: 'Ctrl + Alt + Del',
    hint: 'Security',
    icon: <ShieldAlert size={13} className="text-amber-500" />,
  },
  {
    id: 'win',
    label: 'Super / Win',
    icon: <AppWindow size={13} className="text-blue-500" />,
  },
  {
    id: 'alt-tab',
    label: 'Alt + Tab',
    hint: 'Switch',
    icon: <Layers size={13} className="text-sky-500" />,
  },
  {
    id: 'alt-f4',
    label: 'Alt + F4',
    hint: 'Close',
    icon: <XCircle size={13} className="text-rose-500" />,
  },
  {
    id: 'cmd-space',
    label: 'Cmd + Space',
    hint: 'Spotlight',
    icon: <Search size={13} className="text-violet-500" />,
  },
  {
    id: 'print-screen',
    label: 'PrintScreen',
    icon: <Camera size={13} className="text-muted-foreground" />,
  },
];

const LINUX_TTY_ITEMS: ReadonlyArray<{ id: RemoteDesktopSpecialKeyId; label: string }> = [
  { id: 'ctrl-alt-f1', label: 'Ctrl + Alt + F1' },
  { id: 'ctrl-alt-f2', label: 'Ctrl + Alt + F2' },
  { id: 'ctrl-alt-f3', label: 'Ctrl + Alt + F3' },
  { id: 'ctrl-alt-f4', label: 'Ctrl + Alt + F4' },
  { id: 'ctrl-alt-f5', label: 'Ctrl + Alt + F5' },
  { id: 'ctrl-alt-f6', label: 'Ctrl + Alt + F6' },
  { id: 'ctrl-alt-f7', label: 'Ctrl + Alt + F7' },
];

const DISPLAY_MODE_OPTIONS: ReadonlyArray<{
  id: RemoteDesktopDisplayMode;
  labelKey: string;
  fallback: string;
  icon: React.ReactNode;
}> = [
  {
    id: 'dynamic',
    labelKey: 'remoteDesktop.display.dynamic',
    fallback: 'Dynamic Resize',
    icon: <Maximize2 size={13} className="text-blue-500/85" />,
  },
  {
    id: 'fit',
    labelKey: 'remoteDesktop.display.fit',
    fallback: 'Fit to Pane',
    icon: <Scaling size={13} className="text-teal-500/85" />,
  },
  {
    id: 'actual',
    labelKey: 'remoteDesktop.display.actual',
    fallback: '1:1 Actual Size',
    icon: <Scan size={13} className="text-sky-500/85" />,
  },
  {
    id: 'stretch',
    labelKey: 'remoteDesktop.display.stretch',
    fallback: 'Stretch',
    icon: <Monitor size={13} className="text-muted-foreground" />,
  },
];

const QUALITY_OPTIONS: ReadonlyArray<{
  id: RemoteDesktopQualityPreset;
  fallback: string;
  badge?: string;
}> = [
  { id: 'auto', fallback: 'Auto', badge: 'Balanced' },
  { id: 'high', fallback: 'High', badge: 'Sharp' },
  { id: 'medium', fallback: 'Medium' },
  { id: 'low', fallback: 'Low (Bandwidth)', badge: 'Fast' },
  { id: 'lossless', fallback: 'Lossless', badge: 'Raw' },
];

const NETWORK_TIER_META: Readonly<Record<NetworkQualityTier, {
  bars: number;
  barClass: string;
  badgeClass: string;
  labelKey: string;
  fallback: string;
}>> = {
  excellent: {
    bars: 4,
    barClass: 'bg-emerald-500',
    badgeClass: 'border-emerald-500/30 bg-emerald-500/12 text-emerald-600 dark:text-emerald-400',
    labelKey: 'remoteDesktop.network.quality.excellent',
    fallback: 'Excellent',
  },
  good: {
    bars: 3,
    barClass: 'bg-lime-500',
    badgeClass: 'border-lime-500/30 bg-lime-500/12 text-lime-600 dark:text-lime-400',
    labelKey: 'remoteDesktop.network.quality.good',
    fallback: 'Good',
  },
  fair: {
    bars: 2,
    barClass: 'bg-amber-500',
    badgeClass: 'border-amber-500/30 bg-amber-500/12 text-amber-600 dark:text-amber-400',
    labelKey: 'remoteDesktop.network.quality.fair',
    fallback: 'Fair',
  },
  poor: {
    bars: 1,
    barClass: 'bg-rose-500',
    badgeClass: 'border-rose-500/30 bg-rose-500/12 text-rose-600 dark:text-rose-400',
    labelKey: 'remoteDesktop.network.quality.poor',
    fallback: 'Poor',
  },
  unknown: {
    bars: 0,
    barClass: 'bg-muted-foreground/40',
    badgeClass: 'border-border/60 bg-muted/50 text-muted-foreground',
    labelKey: 'remoteDesktop.network.quality.unknown',
    fallback: 'Measuring',
  },
};

const NetworkSignalBars: React.FC<{ tier: NetworkQualityTier }> = ({ tier }) => {
  const meta = NETWORK_TIER_META[tier];
  const heights = ['h-1', 'h-1.5', 'h-2', 'h-2.5'];
  return (
    <span className="inline-flex items-end gap-[1.5px] h-3" aria-hidden="true">
      {heights.map((hClass, idx) => (
        <span
          key={hClass}
          className={cn(
            'w-[2.5px] rounded-[0.5px] transition-colors',
            hClass,
            idx < meta.bars ? meta.barClass : 'bg-muted-foreground/25',
          )}
        />
      ))}
    </span>
  );
};

type ToolbarBarDensity = 'wide' | 'compact' | 'narrow';

function resolveBarDensity(width: number): ToolbarBarDensity {
  if (width < 540) return 'narrow';
  if (width < 820) return 'compact';
  return 'wide';
}

const RemoteDesktopHostFpsLabel = React.memo(({
  sessionId,
  fpsProp,
}: {
  sessionId?: string;
  fpsProp?: number;
}) => {
  const [liveFps, setLiveFps] = useState<number>(() =>
    fpsProp !== undefined ? fpsProp : (sessionId ? getRemoteDesktopTelemetry(sessionId).fps : 0),
  );
  useEffect(() => {
    if (fpsProp !== undefined || !sessionId) return undefined;
    const sync = () => {
      const next = getRemoteDesktopTelemetry(sessionId).fps;
      setLiveFps((prev) => (prev === next ? prev : next));
    };
    sync();
    return subscribeRemoteDesktopTelemetry(sessionId, sync);
  }, [fpsProp, sessionId]);

  const effectiveFps = fpsProp !== undefined ? fpsProp : liveFps;
  return effectiveFps > 0 ? <> · {Math.round(effectiveFps)} FPS</> : null;
});
RemoteDesktopHostFpsLabel.displayName = 'RemoteDesktopHostFpsLabel';

const RemoteDesktopNetworkTelemetryPill = React.memo(({
  sessionId,
  protocol,
  networkStatsProp,
  fpsProp,
  resolutionLabel,
  encrypted,
  tunneled,
  narrowMode,
}: {
  sessionId?: string;
  protocol: RemoteDesktopProtocol;
  networkStatsProp?: RemoteDesktopStatsEvent | null;
  fpsProp?: number;
  resolutionLabel: string;
  encrypted?: boolean;
  tunneled?: boolean;
  narrowMode: boolean;
}) => {
  const { t } = useI18n();
  const [popoverOpen, setPopoverOpen] = useState(false);
  const popoverOpenRef = useRef(popoverOpen);
  popoverOpenRef.current = popoverOpen;

  const [liveTelemetry, setLiveTelemetry] = useState(() =>
    sessionId ? getRemoteDesktopTelemetry(sessionId) : { networkStats: null, fps: 0 },
  );

  useEffect(() => {
    if (!sessionId || networkStatsProp !== undefined) return undefined;
    const sync = () => {
      const next = getRemoteDesktopTelemetry(sessionId);
      setLiveTelemetry((prev) => {
        if (popoverOpenRef.current) {
          return prev === next ? prev : next;
        }
        // When popover is closed, only re-render if visible pill RTT text or quality tier changed!
        const prevRtt = typeof prev.networkStats?.rttMs === 'number' && Number.isFinite(prev.networkStats.rttMs)
          ? Math.max(0, Math.round(prev.networkStats.rttMs))
          : null;
        const nextRtt = typeof next.networkStats?.rttMs === 'number' && Number.isFinite(next.networkStats.rttMs)
          ? Math.max(0, Math.round(next.networkStats.rttMs))
          : null;
        if (prevRtt === nextRtt) return prev;
        return next;
      });
    };
    sync();
    return subscribeRemoteDesktopTelemetry(sessionId, sync);
  }, [networkStatsProp, sessionId]);

  // Refresh full bandwidth stats immediately when the user opens the telemetry popover
  useEffect(() => {
    if (popoverOpen && sessionId && networkStatsProp === undefined) {
      setLiveTelemetry(getRemoteDesktopTelemetry(sessionId));
    }
  }, [networkStatsProp, popoverOpen, sessionId]);

  const stats = networkStatsProp !== undefined ? networkStatsProp : liveTelemetry.networkStats;
  const effectiveFps = fpsProp !== undefined ? fpsProp : liveTelemetry.fps;
  const networkTier = classifyNetworkQualityTier(stats?.rttMs ?? null);
  const networkTierMeta = NETWORK_TIER_META[networkTier];
  const rttDisplay = typeof stats?.rttMs === 'number' && Number.isFinite(stats.rttMs)
    ? `${Math.max(0, Math.round(stats.rttMs))}ms`
    : '--';
  const fpsLabel = typeof effectiveFps === 'number' && effectiveFps > 0 ? `${Math.round(effectiveFps)} FPS` : '';

  return (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="remote-desktop-network-pill"
          data-quality-tier={networkTier}
          className="h-7 shrink-0 gap-1.5 rounded-md px-1.5 text-xs font-normal text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          title={tr(t, 'remoteDesktop.network.title', 'Connection Telemetry')}
          aria-label={tr(t, 'remoteDesktop.network.title', 'Connection Telemetry')}
        >
          <NetworkSignalBars tier={networkTier} />
          {!narrowMode && (
            <span className="font-mono text-[11px] tabular-nums">{rttDisplay}</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 space-y-2.5 p-3 text-xs">
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
            <NetworkSignalBars tier={networkTier} />
            <span>{tr(t, 'remoteDesktop.network.title', 'Connection Telemetry')}</span>
          </span>
          <span
            className={cn(
              'inline-flex items-center rounded border px-1.5 py-0 text-[10px] font-semibold leading-4',
              networkTierMeta.badgeClass,
            )}
          >
            {tr(t, networkTierMeta.labelKey, networkTierMeta.fallback)}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-1.5 rounded-md border border-border/60 bg-muted/35 p-2 font-mono text-[11px]">
          <div>
            <div className="font-sans text-[10px] text-muted-foreground">
              {tr(t, 'remoteDesktop.network.latency', 'Latency')}
            </div>
            <div className="font-semibold text-foreground">{rttDisplay}</div>
          </div>
          <div>
            <div className="font-sans text-[10px] text-muted-foreground">
              {tr(t, 'remoteDesktop.network.resolution', 'Resolution')}
            </div>
            <div className="font-semibold text-foreground">{resolutionLabel}</div>
          </div>
          <div>
            <div className="font-sans text-[10px] text-muted-foreground">
              {tr(t, 'remoteDesktop.network.downlink', 'Downlink (RX)')}
            </div>
            <div className="text-emerald-600 dark:text-emerald-400">
              {formatBandwidthBps(stats?.rxBps ?? 0)}
            </div>
          </div>
          <div>
            <div className="font-sans text-[10px] text-muted-foreground">
              {tr(t, 'remoteDesktop.network.uplink', 'Uplink (TX)')}
            </div>
            <div className="text-sky-600 dark:text-sky-400">
              {formatBandwidthBps(stats?.txBps ?? 0)}
            </div>
          </div>
          <div>
            <div className="font-sans text-[10px] text-muted-foreground">
              {tr(t, 'remoteDesktop.network.totalRx', 'Total RX')}
            </div>
            <div className="text-foreground/85">
              {formatTransferBytes(stats?.totalRxBytes ?? 0)}
            </div>
          </div>
          <div>
            <div className="font-sans text-[10px] text-muted-foreground">
              {tr(t, 'remoteDesktop.network.totalTx', 'Total TX')}
            </div>
            <div className="text-foreground/85">
              {formatTransferBytes(stats?.totalTxBytes ?? 0)}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-1.5 border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1 font-mono uppercase">
            <span>{protocol.toUpperCase()}</span>
            {fpsLabel && <span>· {fpsLabel}</span>}
          </span>
          <span className="inline-flex items-center gap-1.5">
            {encrypted && (
              <span className="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
                <Lock size={10} />
                <span>{tr(t, 'remoteDesktop.network.tlsEncrypted', 'TLS')}</span>
              </span>
            )}
            {tunneled && (
              <span className="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
                <SshTunnelIcon size={10} />
                <span>SSH</span>
              </span>
            )}
          </span>
        </div>
      </PopoverContent>
    </Popover>
  );
});
RemoteDesktopNetworkTelemetryPill.displayName = 'RemoteDesktopNetworkTelemetryPill';

export const RemoteDesktopToolbar: React.FC<RemoteDesktopToolbarProps> = React.memo(({
  sessionId,
  protocol,
  hostLabel,
  status,
  statusDetail,
  tunneled,
  encrypted,
  resolution,
  fps,
  isFullscreen,
  keyboardGrabActive,
  onToggleKeyboardGrab,
  onSendSpecialKey,
  onTypeClipboard,
  displayMode,
  onChangeDisplayMode,
  supportsDynamicResize = true,
  highDpi = true,
  onToggleHighDpi,
  mapCmdToCtrl = false,
  onToggleMapCmdToCtrl,
  fixedResolution = null,
  onSelectResolutionPreset,
  multiMonitorMode = 'single',
  onChangeMultiMonitorMode,
  monitorCount = 1,
  localDisplayCount = 1,
  activeMonitorIndex = 'all',
  onSelectActiveMonitor,
  sharedFolders = [],
  onAddSharedFolder,
  onRemoveSharedFolder,
  onToggleSharedFolderReadOnly,
  networkStats,
  audioEnabled,
  audioMuted,
  audioVolume = 1,
  onToggleAudioMute,
  onChangeAudioVolume,
  clipboardSyncEnabled,
  onToggleClipboardSync,
  onSyncClipboardNow,
  remoteClipboardFiles = [],
  clipboardFileTransferStatus,
  clipboardTransfer = null,
  onDismissClipboardTransfer,
  onDownloadClipboardFile,
  onUploadLocalClipboardFiles,
  onAskAiFull,
  onAskAiRegion,
  onOpenAiChat,
  aiReadBlocked = false,
  onToggleAiReadBlocked,
  aiAuditCount = 0,
  onOpenAiAuditLog,
  isRecording = false,
  recordingElapsedLabel = '00:00',
  recordingSupported = true,
  onToggleRecording,
  quality,
  onChangeQuality,
  viewOnly,
  onToggleViewOnly,
  showRemoteCursor = true,
  onToggleShowRemoteCursor,
  supportsXvp = false,
  onSendXvpAction,
  onRefreshScreen,
  onScreenshotCopy,
  onScreenshotSave,
  onToggleFullscreen,
  onPopOut,
  onOpenSystemClient,
  onReconnect,
  onDisconnect,
}) => {
  const { t } = useI18n();
  const [pinnedFullscreen, setPinnedFullscreen] = useState(false);
  const [hoverReveal, setHoverReveal] = useState(false);
  const [barDensity, setBarDensity] = useState<ToolbarBarDensity>('wide');
  const [customWidthInput, setCustomWidthInput] = useState(() => String(fixedResolution?.width || resolution?.width || 1920));
  const [customHeightInput, setCustomHeightInput] = useState(() => String(fixedResolution?.height || resolution?.height || 1080));
  const barRef = useRef<HTMLDivElement | null>(null);
  const localFileInputRef = useRef<HTMLInputElement | null>(null);
  const hoverHideTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const isRdp = protocol === 'rdp';

  const canPickResolution = Boolean(onSelectResolutionPreset && (isRdp || supportsDynamicResize));

  const handleApplyCustomResolution = () => {
    if (!onSelectResolutionPreset) return;
    const w = Number.parseInt(customWidthInput, 10);
    const h = Number.parseInt(customHeightInput, 10);
    if (!Number.isFinite(w) || !Number.isFinite(h)) return;
    const clampedW = Math.min(8192, Math.max(200, w));
    const clampedH = Math.min(8192, Math.max(200, h));
    setCustomWidthInput(String(clampedW));
    setCustomHeightInput(String(clampedH));
    onSelectResolutionPreset(clampedW, clampedH);
  };

  useEffect(() => () => clearTimeout(hoverHideTimerRef.current), [isFullscreen]);

  useEffect(() => {
    const el = barRef.current;
    if (!el || isFullscreen || typeof ResizeObserver === 'undefined') return undefined;
    const applyWidth = (w: number) => {
      if (w > 0) {
        const next = resolveBarDensity(w);
        setBarDensity((prev) => (prev === next ? prev : next));
      }
    };
    applyWidth(el.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      const w = entry?.contentRect?.width ?? el.getBoundingClientRect().width;
      applyWidth(w);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [isFullscreen]);

  // Responsive container breakpoints (discretized into 3 tiers so drag-resizing causes 0 idle re-renders)
  const compactLabels = !isFullscreen && barDensity !== 'wide';
  const narrowMode = !isFullscreen && barDensity === 'narrow';
  const specialKeyItems = isRdp ? RDP_SPECIAL_KEY_ITEMS : VNC_SPECIAL_KEY_ITEMS;

  const statusDotClass =
    status === 'connected'
      ? 'bg-emerald-500'
      : status === 'connecting'
        ? 'bg-amber-400 animate-pulse'
        : 'bg-muted-foreground/45';

  const resolutionLabel = resolution ? `${resolution.width}×${resolution.height}` : '--';
  const volumePercent = Math.round((audioMuted ? 0 : audioVolume) * 100);
  const activeDisplayOption = DISPLAY_MODE_OPTIONS.find((opt) => opt.id === displayMode);
  const activeDisplayLabel = activeDisplayOption
    ? tr(t, activeDisplayOption.labelKey, activeDisplayOption.fallback)
    : tr(t, 'remoteDesktop.display.fit', 'Fit to Pane');

  const barContent = (
    <div
      ref={barRef}
      className={cn(
        'flex items-center gap-1 text-xs select-none overflow-hidden',
        isFullscreen
          ? 'h-9 rounded-full border border-border/70 bg-background/95 px-3 shadow-xl ring-1 ring-black/10 backdrop-blur-md'
          : 'h-9 w-full min-w-0 shrink-0 border-b border-border/60 bg-background px-2',
      )}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Status & Minimalist Host Identity */}
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex h-7 min-w-0 max-w-[190px] shrink items-center gap-1.5 rounded-md px-1.5 transition-colors hover:bg-muted/60 overflow-hidden">
            <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', statusDotClass)} />
            <span className={cn('shrink-0', isRdp ? 'text-blue-500' : 'text-teal-500')}>
              {isRdp ? <RdpProtocolIcon size={13} /> : <VncProtocolIcon size={13} />}
            </span>
            <span className="min-w-0 truncate text-xs font-medium text-foreground">
              {hostLabel}
            </span>
            {!narrowMode && tunneled && (
              <span
                className="inline-flex items-center gap-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400 shrink-0"
                title={tr(t, 'remoteDesktop.toolbar.sshTunneled', 'Tunneled over SSH')}
              >
                <SshTunnelIcon size={11} />
                <span>SSH</span>
              </span>
            )}
            {!narrowMode && encrypted && (
              <Lock
                size={11}
                className="shrink-0 text-emerald-500/80"
                aria-label={tr(t, 'remoteDesktop.toolbar.encrypted', 'Encrypted TLS connection')}
              />
            )}
            {viewOnly && (
              <span className="inline-flex items-center gap-1 rounded bg-amber-500/12 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400 shrink-0">
                <Eye size={10} />
                {!narrowMode && <span>{tr(t, 'remoteDesktop.toolbar.viewOnlyBadge', 'View')}</span>}
              </span>
            )}
            {resolution && !isFullscreen && !compactLabels && (
              <span className="font-mono text-[11px] text-muted-foreground/75 shrink-0">
                {resolutionLabel}
              </span>
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          <div className="space-y-1 text-primary-foreground">
            <div className="flex items-center gap-1.5 font-medium">
              {isRdp ? <RdpProtocolIcon size={13} className="text-primary-foreground" /> : <VncProtocolIcon size={13} className="text-primary-foreground" />}
              <span>{hostLabel}</span>
              <span className="text-primary-foreground/75">({protocol.toUpperCase()})</span>
            </div>
            <div className="font-mono text-[11px] text-primary-foreground/85">
              {statusDetail || status} · {resolutionLabel}
              <RemoteDesktopHostFpsLabel sessionId={sessionId} fpsProp={fps} />
            </div>
            {tunneled && (
              <div className="flex items-center gap-1 text-primary-foreground/90">
                <SshTunnelIcon size={11} />
                <span>{tr(t, 'remoteDesktop.toolbar.sshTunneled', 'Tunneled over SSH')}</span>
              </div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>

      <div className="mx-0.5 h-3.5 w-px shrink-0 bg-border/50" />

      {/* Input Group: Keyboard Grab Toggle (hidden into overflow on narrow panes unless active) */}
      {(!narrowMode || keyboardGrabActive) && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn(
                'h-7 shrink-0 gap-1.5 rounded-md text-xs font-normal transition-colors',
                compactLabels ? 'w-7 px-0' : 'px-2',
                keyboardGrabActive
                  ? 'bg-primary/12 text-primary font-medium hover:bg-primary/18'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
              )}
              onClick={onToggleKeyboardGrab}
              disabled={status !== 'connected' || viewOnly}
              aria-label={keyboardGrabActive
                ? tr(t, 'remoteDesktop.toolbar.keysRemote', 'Keys: Remote')
                : tr(t, 'remoteDesktop.toolbar.keysLocal', 'Keys: Local')}
            >
              <Keyboard size={13} />
              {!compactLabels && (
                <span>
                  {keyboardGrabActive
                    ? tr(t, 'remoteDesktop.toolbar.keysRemote', 'Keys: Remote')
                    : tr(t, 'remoteDesktop.toolbar.keysLocal', 'Keys: Local')}
                </span>
              )}
              {!compactLabels && keyboardGrabActive && <Lock size={10} className="opacity-85" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[260px] text-xs">
            <div className="font-medium mb-0.5">
              {keyboardGrabActive
                ? tr(t, 'remoteDesktop.toolbar.keysRemote', 'Keys: Remote')
                : tr(t, 'remoteDesktop.toolbar.keysLocal', 'Keys: Local')}
            </div>
            {keyboardGrabActive
              ? tr(
                  t,
                  'remoteDesktop.toolbar.keysRemoteTip',
                  'App shortcuts are forwarded to remote. Press Ctrl+Alt+Shift or double-tap Right Alt/Option to release.',
                )
              : tr(
                  t,
                  'remoteDesktop.toolbar.keysLocalTip',
                  'Local tab/window shortcuts stay active. Click to capture shortcuts for remote desktop.',
                )}
          </TooltipContent>
        </Tooltip>
      )}

      {/* Send Special Keys + Type Clipboard */}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn(
              'h-7 shrink-0 gap-1.5 rounded-md text-xs font-normal text-muted-foreground hover:bg-muted/60 hover:text-foreground',
              compactLabels ? 'w-7 px-0' : 'px-2',
            )}
            disabled={status !== 'connected' || viewOnly}
            title={tr(t, 'remoteDesktop.toolbar.sendKeys', 'Send Keys')}
            aria-label={tr(t, 'remoteDesktop.toolbar.sendKeys', 'Send Keys')}
          >
            <Command size={13} />
            {!compactLabels && <span>{tr(t, 'remoteDesktop.toolbar.sendKeys', 'Send Keys')}</span>}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-1.5 text-xs">
          <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] font-semibold text-muted-foreground">
            <Command size={11} />
            <span>{tr(t, 'remoteDesktop.toolbar.specialKeys', 'Special Key Chords')}</span>
          </div>
          {specialKeyItems.map((item) => (
            <PopoverClose key={item.id} asChild>
              <button
                type="button"
                onClick={() => onSendSpecialKey(item.id)}
                className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent"
              >
                <span className="flex items-center gap-2 font-medium">
                  {item.icon}
                  <span>{item.label}</span>
                </span>
                {item.hint && <span className="text-[10px] text-muted-foreground">{item.hint}</span>}
              </button>
            </PopoverClose>
          ))}
          <div className="my-1 h-px bg-border/60" />
          <PopoverClose asChild>
            <button
              type="button"
              onClick={onTypeClipboard}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent"
            >
              <ClipboardCopy size={13} className="text-emerald-500" />
              <span>{tr(t, 'remoteDesktop.toolbar.typeClipboard', 'Type Clipboard as Keystrokes')}</span>
            </button>
          </PopoverClose>
          {!isRdp && (
            <>
              <div className="my-1 h-px bg-border/60" />
              <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-medium text-muted-foreground">
                <Terminal size={11} />
                <span>{tr(t, 'remoteDesktop.toolbar.linuxTty', 'Linux Virtual Consoles')}</span>
              </div>
              <div className="grid grid-cols-4 gap-1 px-2 py-1">
                {LINUX_TTY_ITEMS.map((item, idx) => (
                  <PopoverClose key={item.id} asChild>
                    <button
                      type="button"
                      className="rounded-md border border-border/60 bg-secondary/40 px-1.5 py-0.5 font-mono text-[10px] transition-colors hover:bg-accent"
                      onClick={() => onSendSpecialKey(item.id)}
                    >
                      F{idx + 1}
                    </button>
                  </PopoverClose>
                ))}
              </div>
              {supportsXvp && onSendXvpAction && (
                <>
                  <div className="my-1 h-px bg-border/60" />
                  <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-medium text-muted-foreground">
                    <Power size={11} className="text-amber-500" />
                    <span>{tr(t, 'remoteDesktop.xvp.title', 'Remote Power (XVP)')}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-1 px-2 py-1">
                    <PopoverClose asChild>
                      <button
                        type="button"
                        className="rounded-md border border-border/60 bg-secondary/40 px-1.5 py-1 text-[10px] font-medium transition-colors hover:bg-accent"
                        onClick={() => onSendXvpAction('reboot')}
                      >
                        {tr(t, 'remoteDesktop.xvp.reboot', 'Reboot')}
                      </button>
                    </PopoverClose>
                    <PopoverClose asChild>
                      <button
                        type="button"
                        className="rounded-md border border-amber-500/35 bg-amber-500/10 px-1.5 py-1 text-[10px] font-medium text-amber-500 transition-colors hover:bg-amber-500/20"
                        onClick={() => onSendXvpAction('shutdown')}
                      >
                        {tr(t, 'remoteDesktop.xvp.shutdown', 'Shutdown')}
                      </button>
                    </PopoverClose>
                    <PopoverClose asChild>
                      <button
                        type="button"
                        className="rounded-md border border-destructive/35 bg-destructive/10 px-1.5 py-1 text-[10px] font-medium text-destructive transition-colors hover:bg-destructive/20"
                        onClick={() => onSendXvpAction('reset')}
                      >
                        {tr(t, 'remoteDesktop.xvp.reset', 'Hard Reset')}
                      </button>
                    </PopoverClose>
                  </div>
                </>
              )}
            </>
          )}
          <div className="my-1 h-px bg-border/60" />
          <div className="px-2 py-1 text-[10px] leading-snug text-muted-foreground">
            {tr(
              t,
              'remoteDesktop.toolbar.osChordNote',
              'OS-reserved chords (Alt+Tab, Cmd+Tab, Ctrl+Alt+Del) are intercepted by your local OS and must be sent from this menu.',
            )}
          </div>
        </PopoverContent>
      </Popover>

      {/* Display / Scaling Mode + Resolution Presets + Multi-Monitor */}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn(
              'h-7 shrink-0 gap-1.5 rounded-md text-xs font-normal text-muted-foreground hover:bg-muted/60 hover:text-foreground',
              compactLabels ? 'w-7 px-0' : 'px-2',
            )}
            title={`${tr(t, 'remoteDesktop.toolbar.display', 'Display Scaling')}: ${activeDisplayLabel}`}
            aria-label={tr(t, 'remoteDesktop.toolbar.display', 'Display Scaling')}
          >
            <Scaling size={13} />
            {!compactLabels && <span>{activeDisplayLabel}</span>}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-2 text-xs">
          <div className="space-y-0.5">
            {DISPLAY_MODE_OPTIONS.map((opt) => {
              const disabled = opt.id === 'dynamic' && !isRdp && !supportsDynamicResize;
              return (
                <PopoverClose key={opt.id} asChild>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => onChangeDisplayMode(opt.id)}
                    className={cn(
                      'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/70 disabled:opacity-45 disabled:pointer-events-none',
                      displayMode === opt.id && 'bg-primary/15 font-medium text-foreground',
                    )}
                  >
                    <span className="flex items-center gap-2">
                      {opt.icon}
                      <span>{tr(t, opt.labelKey, opt.fallback)}</span>
                    </span>
                    <span className="flex items-center gap-1">
                      {disabled && (
                        <span className="text-[10px] text-muted-foreground">
                          {tr(t, 'remoteDesktop.display.unsupported', 'Unsupported')}
                        </span>
                      )}
                      {displayMode === opt.id && <Check size={13} className="text-primary" />}
                    </span>
                  </button>
                </PopoverClose>
              );
            })}
          </div>

          {/* Resolution Presets + Custom W x H */}
          {canPickResolution && (
            <>
              <div className="my-2 h-px bg-border/60" />
              <div className="space-y-1.5 px-1">
                <div className="flex items-center justify-between text-[11px] font-medium text-muted-foreground">
                  <span>{tr(t, 'remoteDesktop.display.resolutionPresets', 'Resolution Presets')}</span>
                  {resolution && (
                    <span className="font-mono text-[10px] text-muted-foreground/80">{resolutionLabel}</span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-1">
                  {RDP_RESOLUTION_PRESETS.map((preset) => {
                    const isActive =
                      (fixedResolution?.width === preset.width && fixedResolution?.height === preset.height)
                      || (!fixedResolution && resolution?.width === preset.width && resolution?.height === preset.height);
                    return (
                      <PopoverClose key={preset.label} asChild>
                        <button
                          type="button"
                          disabled={status !== 'connected'}
                          onClick={() => {
                            setCustomWidthInput(String(preset.width));
                            setCustomHeightInput(String(preset.height));
                            onSelectResolutionPreset?.(preset.width, preset.height);
                          }}
                          className={cn(
                            'rounded-md border px-2 py-1 font-mono text-[11px] transition-colors disabled:opacity-45 disabled:pointer-events-none',
                            isActive
                              ? 'border-primary/50 bg-primary/12 font-medium text-primary'
                              : 'border-border/60 bg-secondary/30 text-foreground/85 hover:bg-accent',
                          )}
                        >
                          {preset.label}
                        </button>
                      </PopoverClose>
                    );
                  })}
                </div>
                <div className="flex items-center gap-1 pt-0.5">
                  <input
                    type="number"
                    min={200}
                    max={8192}
                    value={customWidthInput}
                    onChange={(e) => setCustomWidthInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleApplyCustomResolution();
                    }}
                    aria-label={tr(t, 'remoteDesktop.display.customWidth', 'Width')}
                    placeholder="1920"
                    className="h-6 w-full min-w-0 rounded border border-input bg-background px-1.5 font-mono text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                  <span className="text-[10px] text-muted-foreground">×</span>
                  <input
                    type="number"
                    min={200}
                    max={8192}
                    value={customHeightInput}
                    onChange={(e) => setCustomHeightInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleApplyCustomResolution();
                    }}
                    aria-label={tr(t, 'remoteDesktop.display.customHeight', 'Height')}
                    placeholder="1080"
                    className="h-6 w-full min-w-0 rounded border border-input bg-background px-1.5 font-mono text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                  <PopoverClose asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={status !== 'connected'}
                      className="h-6 shrink-0 px-2 text-[10px]"
                      onClick={handleApplyCustomResolution}
                    >
                      {tr(t, 'remoteDesktop.display.applyResolution', 'Apply')}
                    </Button>
                  </PopoverClose>
                </div>
              </div>
            </>
          )}

          {/* HiDPI Toggle (RDP) */}
          {isRdp && onToggleHighDpi && (
            <>
              <div className="my-2 h-px bg-border/60" />
              <div className="flex items-center justify-between gap-2 rounded-md px-1.5 py-1">
                <span className="text-xs font-medium">
                  {tr(t, 'remoteDesktop.display.highDpi', 'Retina HiDPI')}
                </span>
                <Switch checked={highDpi} onCheckedChange={onToggleHighDpi} />
              </div>
            </>
          )}

          {/* Multi-Monitor Layout (RDP) */}
          {isRdp && onChangeMultiMonitorMode && (
            <>
              <div className="my-2 h-px bg-border/60" />
              <div className="space-y-1 px-1">
                <div className="text-[11px] font-medium text-muted-foreground">
                  {tr(t, 'remoteDesktop.display.multiMonitor', 'Multi-Monitor Layout')}
                </div>
                {(
                  [
                    {
                      id: 'single' as const,
                      label: tr(t, 'remoteDesktop.display.monitorSingle', 'Single Monitor'),
                    },
                    {
                      id: 'dual' as const,
                      label: tr(t, 'remoteDesktop.display.monitorDual', 'Dual Side-by-Side'),
                    },
                    {
                      id: 'all-local' as const,
                      label: localDisplayCount > 1
                        ? tr(
                            t,
                            'remoteDesktop.display.monitorAllLocalCount',
                            'Match Local Displays ({count})',
                            { count: localDisplayCount },
                          )
                        : tr(t, 'remoteDesktop.display.monitorAllLocal', 'Match Local Displays'),
                    },
                  ]
                ).map((item) => (
                  <PopoverClose key={item.id} asChild>
                    <button
                      type="button"
                      disabled={status !== 'connected'}
                      onClick={() => onChangeMultiMonitorMode(item.id)}
                      className={cn(
                        'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-[11px] transition-colors hover:bg-accent disabled:opacity-45 disabled:pointer-events-none',
                        multiMonitorMode === item.id && 'bg-accent/70 font-medium text-foreground',
                      )}
                    >
                      <span className="flex items-center gap-1.5">
                        <Monitor size={12} className="text-muted-foreground" />
                        <span>{item.label}</span>
                      </span>
                      {multiMonitorMode === item.id && <Check size={12} className="text-primary" />}
                    </button>
                  </PopoverClose>
                ))}
              </div>
            </>
          )}
        </PopoverContent>
      </Popover>

      {/* Active Monitor Switcher Pill (RDP Multi-Monitor >1) */}
      {isRdp && monitorCount > 1 && onSelectActiveMonitor && (
        <div
          data-testid="rdp-monitor-switcher"
          className="inline-flex h-6 shrink-0 items-center rounded-md border border-border/60 bg-muted/40 p-0.5 text-[10px]"
          role="group"
          aria-label={tr(t, 'remoteDesktop.display.monitorSwitcher', 'Switch active monitor')}
        >
          <button
            type="button"
            onClick={() => onSelectActiveMonitor('all')}
            className={cn(
              'h-5 rounded px-1.5 font-medium transition-colors cursor-pointer',
              activeMonitorIndex === 'all'
                ? 'bg-background text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {tr(t, 'remoteDesktop.display.monitorAll', 'All')}
          </button>
          {Array.from({ length: monitorCount }, (_, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => onSelectActiveMonitor(idx)}
              className={cn(
                'h-5 min-w-[20px] rounded px-1.5 font-mono font-medium transition-colors cursor-pointer',
                activeMonitorIndex === idx
                  ? 'bg-background text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {idx + 1}
            </button>
          ))}
        </div>
      )}

      <div className="min-w-1 flex-1" />

      {/* Right Utility Controls */}
      <div className="flex shrink-0 items-center gap-0.5">
        {/* Live Clipboard Transfer Pill (P1-C) */}
        {clipboardTransfer && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                data-testid="rdp-clipboard-transfer-pill"
                data-transfer-phase={clipboardTransfer.phase}
                className={cn(
                  'mr-0.5 inline-flex h-6 max-w-[200px] items-center gap-1.5 rounded-md border px-1.5 text-[10px] font-medium',
                  clipboardTransfer.phase === 'error'
                    ? 'border-destructive/40 bg-destructive/12 text-destructive'
                    : clipboardTransfer.phase === 'completed'
                      ? 'border-emerald-500/35 bg-emerald-500/12 text-emerald-600 dark:text-emerald-400'
                      : 'border-sky-500/35 bg-sky-500/12 text-sky-600 dark:text-sky-400',
                )}
              >
                {clipboardTransfer.phase === 'staged' && <UploadCloud size={11} className="shrink-0" />}
                {clipboardTransfer.phase === 'transferring' && (
                  clipboardTransfer.direction === 'upload'
                    ? <ArrowUpFromLine size={11} className="shrink-0 animate-pulse" />
                    : <ArrowDownToLine size={11} className="shrink-0 animate-pulse" />
                )}
                {clipboardTransfer.phase === 'completed' && <Check size={11} className="shrink-0" />}
                {clipboardTransfer.phase === 'error' && <AlertCircle size={11} className="shrink-0" />}
                {clipboardTransfer.phase === 'staged' ? (
                  <span className="truncate">
                    {tr(
                      t,
                      'remoteDesktop.clipboard.stagedPill',
                      '{count} file(s) · Ctrl+V',
                      { count: clipboardTransfer.fileCount },
                    )}
                  </span>
                ) : clipboardTransfer.phase === 'transferring' ? (
                  <>
                    <span className="max-w-[72px] truncate">{clipboardTransfer.fileName}</span>
                    <span className="h-1.5 w-10 shrink-0 overflow-hidden rounded-full bg-current/20">
                      <span
                        className="block h-full rounded-full bg-current transition-all duration-100"
                        style={{ width: `${Math.max(4, Math.min(100, clipboardTransfer.percent))}%` }}
                      />
                    </span>
                    <span className="shrink-0 font-mono">{clipboardTransfer.percent}%</span>
                  </>
                ) : (
                  <span className="truncate">{clipboardTransfer.message}</span>
                )}
                {(clipboardTransfer.phase === 'completed' || clipboardTransfer.phase === 'error')
                  && onDismissClipboardTransfer && (
                    <button
                      type="button"
                      onClick={onDismissClipboardTransfer}
                      aria-label="Dismiss transfer status"
                      className="ml-0.5 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded hover:bg-black/10 dark:hover:bg-white/10"
                    >
                      <X size={9} />
                    </button>
                  )}
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              <div className="space-y-0.5 text-primary-foreground">
                <div className="font-medium">{clipboardTransfer.message}</div>
                {clipboardTransfer.totalBytes > 0 && (
                  <div className="font-mono text-[11px] text-primary-foreground/85">
                    {formatTransferBytes(clipboardTransfer.transferredBytes)} / {formatTransferBytes(clipboardTransfer.totalBytes)}
                  </div>
                )}
              </div>
            </TooltipContent>
          </Tooltip>
        )}

        {/* Network Quality & Live Telemetry Pill (isolated leaf subscription for 0 toolbar re-renders) */}
        {status === 'connected' && (sessionId !== undefined || networkStats !== undefined) && (
          <RemoteDesktopNetworkTelemetryPill
            sessionId={sessionId}
            protocol={protocol}
            networkStatsProp={networkStats}
            fpsProp={fps}
            resolutionLabel={resolutionLabel}
            encrypted={encrypted}
            tunneled={tunneled}
            narrowMode={narrowMode}
          />
        )}

        {/* Shared Folders (RDPDR) Popover (RDP only) */}
        {isRdp && onAddSharedFolder && (!narrowMode || sharedFolders.length > 0) && (
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="rdp-shared-folders-btn"
                className={cn(
                  'h-7 shrink-0 gap-1 rounded-md px-1.5 text-xs',
                  sharedFolders.length > 0
                    ? 'bg-primary/12 text-primary hover:bg-primary/18'
                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                )}
                title={tr(t, 'remoteDesktop.sharedFolders.title', 'Shared Folders (RDPDR)')}
                aria-label={tr(t, 'remoteDesktop.sharedFolders.title', 'Shared Folders (RDPDR)')}
              >
                <HardDrive size={13} />
                {sharedFolders.length > 0 && (
                  <span className="font-mono text-[11px] font-semibold">{sharedFolders.length}</span>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-76 space-y-2.5 p-3 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                  <HardDrive size={13} className="text-blue-500" />
                  <span>{tr(t, 'remoteDesktop.sharedFolders.title', 'Shared Folders (RDPDR)')}</span>
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-6 gap-1 px-2 text-[11px]"
                  onClick={onAddSharedFolder}
                >
                  <FolderPlus size={11} />
                  <span>{tr(t, 'remoteDesktop.sharedFolders.add', 'Add Folder')}</span>
                </Button>
              </div>
              {sharedFolders.length === 0 ? (
                <div className="rounded-md border border-dashed border-border/70 bg-muted/25 px-3 py-3 text-center text-[11px] text-muted-foreground">
                  {tr(
                    t,
                    'remoteDesktop.sharedFolders.empty',
                    'Mount a local folder as a virtual drive on the remote Windows desktop.',
                  )}
                </div>
              ) : (
                <div className="max-h-48 space-y-1.5 overflow-y-auto">
                  {sharedFolders.map((folder) => (
                    <div
                      key={folder.id}
                      className="rounded-md border border-border/60 bg-secondary/35 px-2.5 py-2 space-y-1.5"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs font-medium text-foreground" title={folder.name}>
                            {folder.name}
                          </div>
                          <div
                            className="truncate font-mono text-[10px] text-muted-foreground"
                            title={folder.path}
                          >
                            {folder.path}
                          </div>
                        </div>
                        {onRemoveSharedFolder && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-5 w-5 shrink-0 text-muted-foreground hover:text-destructive"
                            onClick={() => onRemoveSharedFolder(folder.id)}
                            aria-label={tr(t, 'remoteDesktop.sharedFolders.remove', 'Remove folder')}
                            title={tr(t, 'remoteDesktop.sharedFolders.remove', 'Remove folder')}
                          >
                            <Trash2 size={11} />
                          </Button>
                        )}
                      </div>
                      {onToggleSharedFolderReadOnly && (
                        <div className="flex items-center justify-between border-t border-border/50 pt-1 text-[10px] text-muted-foreground">
                          <span>{tr(t, 'remoteDesktop.sharedFolders.readOnly', 'Read-only')}</span>
                          <Switch
                            checked={folder.readOnly}
                            onCheckedChange={(ro) => onToggleSharedFolderReadOnly(folder.id, ro)}
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <div className="border-t border-border/60 pt-2 text-[10px] leading-snug text-muted-foreground">
                {tr(
                  t,
                  'remoteDesktop.sharedFolders.hint',
                  'Windows: This PC → <Folder> on Netcatty (\\\\tsclient\\<Name>). Local-only, never synced.',
                )}
              </div>
            </PopoverContent>
          </Popover>
        )}

        {/* RDP Audio Control */}
        {!narrowMode && isRdp && audioEnabled && (
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(
                  'h-7 w-7 rounded-md',
                  audioMuted || audioVolume <= 0
                    ? 'text-muted-foreground/55 hover:bg-muted/60 hover:text-foreground'
                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                )}
                aria-label={tr(t, 'remoteDesktop.toolbar.audio', 'Audio')}
                title={tr(t, 'remoteDesktop.toolbar.audio', 'RDP Audio')}
              >
                {audioMuted || audioVolume <= 0 ? <VolumeX size={13} /> : <Volume2 size={13} />}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-52 p-3">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="inline-flex items-center gap-1.5 font-medium">
                  <Volume2 size={13} className="text-sky-500" />
                  {tr(t, 'remoteDesktop.toolbar.audio', 'RDP Audio')}
                </span>
                <span className="font-mono text-[11px] text-muted-foreground">{volumePercent}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={audioMuted ? 0 : audioVolume}
                onChange={(e) => onChangeAudioVolume?.(Number(e.target.value))}
                className="mt-2.5 w-full accent-primary"
                aria-label="Volume"
              />
              <div className="mt-2 flex justify-end">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-6 gap-1 px-2 text-[11px]"
                  onClick={onToggleAudioMute}
                >
                  {audioMuted ? <Volume2 size={11} /> : <VolumeX size={11} />}
                  {audioMuted
                    ? tr(t, 'remoteDesktop.toolbar.unmute', 'Unmute')
                    : tr(t, 'remoteDesktop.toolbar.mute', 'Mute')}
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        )}

        {/* Clipboard Sync & RDP Clipboard Files */}
        {(!narrowMode || remoteClipboardFiles.length > 0) && (
        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn(
                'h-7 shrink-0 gap-1 rounded-md px-1.5 text-xs',
                remoteClipboardFiles.length > 0
                  ? 'bg-primary/12 text-primary hover:bg-primary/18'
                  : clipboardSyncEnabled
                    ? 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                    : 'text-muted-foreground/45 hover:bg-muted/60 hover:text-foreground',
              )}
              title={tr(t, 'remoteDesktop.toolbar.clipboard', 'Clipboard Sync')}
            >
              {remoteClipboardFiles.length > 0 ? <FileDown size={13} /> : <Clipboard size={13} />}
              {remoteClipboardFiles.length > 0 && (
                <span className="font-mono text-[11px] font-semibold">{remoteClipboardFiles.length}</span>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 space-y-3 p-3 text-xs">
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 font-medium">
                <ClipboardCopy size={13} className="text-emerald-500" />
                {tr(t, 'remoteDesktop.toolbar.clipboardSync', 'Clipboard Sync')}
              </span>
              <Switch checked={clipboardSyncEnabled} onCheckedChange={onToggleClipboardSync} />
            </div>
            {onSyncClipboardNow && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 w-full gap-1.5 text-[11px]"
                disabled={status !== 'connected' || viewOnly}
                onClick={onSyncClipboardNow}
              >
                <ClipboardCopy size={12} />
                <span>{tr(t, 'remoteDesktop.clipboard.pushNow', 'Push Local Clipboard Now')}</span>
              </Button>
            )}
            {isRdp && (
              <div className="space-y-2 border-t border-border/60 pt-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                    <FileDown size={12} className="text-blue-500" />
                    {tr(t, 'remoteDesktop.toolbar.clipboardFiles', 'RDP Clipboard Files')}
                  </span>
                  {onUploadLocalClipboardFiles && (
                    <>
                      <input
                        ref={localFileInputRef}
                        type="file"
                        multiple
                        className="hidden"
                        onChange={(e) => {
                          if (e.target.files && e.target.files.length > 0) {
                            onUploadLocalClipboardFiles(e.target.files);
                          }
                          e.target.value = '';
                        }}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-6 gap-1 px-2 text-[10px]"
                        disabled={status !== 'connected' || viewOnly}
                        onClick={() => localFileInputRef.current?.click()}
                      >
                        <Upload size={10} />
                        <span>{tr(t, 'remoteDesktop.clipboard.sendLocalFiles', 'Send Local Files...')}</span>
                      </Button>
                    </>
                  )}
                </div>
                {clipboardTransfer ? (
                  <div className="space-y-1 rounded-md border border-border/60 bg-muted/50 px-2.5 py-2 text-[11px]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium text-foreground">{clipboardTransfer.message}</span>
                      {clipboardTransfer.phase === 'transferring' && (
                        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                          {clipboardTransfer.percent}%
                        </span>
                      )}
                    </div>
                    {clipboardTransfer.phase === 'transferring' && (
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                        <div
                          className="h-full rounded-full bg-blue-500 transition-all duration-100"
                          style={{ width: `${Math.max(2, Math.min(100, clipboardTransfer.percent))}%` }}
                        />
                      </div>
                    )}
                    {clipboardTransfer.totalBytes > 0 && (
                      <div className="font-mono text-[10px] text-muted-foreground">
                        {formatTransferBytes(clipboardTransfer.transferredBytes)} / {formatTransferBytes(clipboardTransfer.totalBytes)}
                      </div>
                    )}
                  </div>
                ) : clipboardFileTransferStatus ? (
                  <div className="rounded-md bg-muted/60 px-2 py-1 text-[11px] text-foreground">
                    {clipboardFileTransferStatus}
                  </div>
                ) : null}
                {remoteClipboardFiles.length === 0 ? (
                  <div className="text-[11px] text-muted-foreground leading-relaxed">
                    {tr(
                      t,
                      'remoteDesktop.toolbar.clipboardFilesHint',
                      'Copy files on remote to download here, or drag local files onto the desktop to copy.',
                    )}
                  </div>
                ) : (
                  <div className="max-h-36 space-y-1 overflow-y-auto">
                    {remoteClipboardFiles.map((file) => (
                      <div
                        key={file.index}
                        className="flex items-center justify-between gap-2 rounded-md border border-border/50 bg-secondary/40 px-2 py-1"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[11px]" title={file.name}>{file.name}</div>
                          {!file.isDirectory && file.size > 0 && (
                            <div className="font-mono text-[10px] text-muted-foreground">
                              {formatTransferBytes(file.size)}
                            </div>
                          )}
                        </div>
                        {!file.isDirectory && onDownloadClipboardFile && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-5 w-5 shrink-0"
                            onClick={() => onDownloadClipboardFile(file.index)}
                            title={tr(t, 'remoteDesktop.toolbar.saveFile', 'Save File')}
                          >
                            <Download size={11} />
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </PopoverContent>
        </Popover>
        )}

        {/* Quality & View-Only Popover */}
        {!narrowMode && (
        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              aria-label={tr(t, 'remoteDesktop.toolbar.options', 'Quality & Input Options')}
              title={tr(t, 'remoteDesktop.toolbar.options', 'Quality & Input Options')}
            >
              <SlidersHorizontal size={13} />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64 space-y-3 p-3 text-xs">
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 font-medium">
                <Eye size={13} className="text-amber-500" />
                {tr(t, 'remoteDesktop.toolbar.viewOnly', 'View-Only Mode')}
              </span>
              <Switch checked={viewOnly} onCheckedChange={onToggleViewOnly} />
            </div>
            {isRdp && onToggleHighDpi && (
              <div className="flex items-center justify-between border-t border-border/60 pt-2">
                <span className="inline-flex items-center gap-1.5 font-medium">
                  <Monitor size={13} className="text-sky-500" />
                  {tr(t, 'remoteDesktop.display.highDpi', 'Retina HiDPI')}
                </span>
                <Switch checked={highDpi} onCheckedChange={onToggleHighDpi} />
              </div>
            )}
            {onToggleMapCmdToCtrl && (
              <div className="flex items-center justify-between border-t border-border/60 pt-2">
                <span className="inline-flex items-center gap-1.5 font-medium">
                  <Keyboard size={13} className="text-blue-500" />
                  {tr(t, 'remoteDesktop.toolbar.mapCmdToCtrl', 'Map Cmd → Ctrl')}
                </span>
                <Switch checked={mapCmdToCtrl} onCheckedChange={onToggleMapCmdToCtrl} />
              </div>
            )}
            {!isRdp && onToggleShowRemoteCursor && (
              <div className="flex items-center justify-between border-t border-border/60 pt-2">
                <span className="inline-flex items-center gap-1.5 font-medium">
                  <MousePointer size={13} className="text-teal-500" />
                  {tr(t, 'remoteDesktop.toolbar.showRemoteCursor', 'Show Remote Cursor')}
                </span>
                <Switch checked={showRemoteCursor} onCheckedChange={onToggleShowRemoteCursor} />
              </div>
            )}
            {!isRdp && onRefreshScreen && (
              <div className="border-t border-border/60 pt-2">
                <PopoverClose asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 w-full gap-1.5 text-[11px]"
                    disabled={status !== 'connected'}
                    onClick={onRefreshScreen}
                  >
                    <RotateCw size={12} />
                    <span>{tr(t, 'remoteDesktop.toolbar.refreshScreen', 'Force Full Screen Refresh')}</span>
                  </Button>
                </PopoverClose>
              </div>
            )}
            {!isRdp && (
              <div className="space-y-1.5 border-t border-border/60 pt-2">
                <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                  <Sparkles size={12} className="text-amber-500" />
                  {tr(t, 'remoteDesktop.toolbar.quality', 'Encoding Quality')}
                </div>
                <div className="grid grid-cols-1 gap-1">
                  {QUALITY_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      className={cn(
                        'flex items-center justify-between rounded-md px-2 py-1 text-left text-[11px] transition-colors hover:bg-muted/70',
                        quality === opt.id && 'bg-primary/15 font-medium text-foreground',
                      )}
                      onClick={() => onChangeQuality(opt.id)}
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <Gauge size={11} className="text-muted-foreground" />
                        <span>{opt.fallback}</span>
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        {opt.badge && (
                          <span className="text-[10px] text-muted-foreground">{opt.badge}</span>
                        )}
                        {quality === opt.id && <Check size={12} className="text-primary" />}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {onOpenSystemClient && (
              <div className="border-t border-border/60 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 w-full gap-1.5 text-[11px]"
                  onClick={onOpenSystemClient}
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
              </div>
            )}
          </PopoverContent>
        </Popover>
        )}

        {/* Screenshot Popover */}
        {!narrowMode && (
        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              disabled={status !== 'connected'}
              aria-label={tr(t, 'remoteDesktop.toolbar.screenshot', 'Screenshot')}
              title={tr(t, 'remoteDesktop.toolbar.screenshot', 'Screenshot')}
            >
              <Camera size={13} />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-52 p-1.5 text-xs">
            <PopoverClose asChild>
              <button
                type="button"
                onClick={onScreenshotCopy}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent"
              >
                <ClipboardCopy size={13} className="text-sky-500" />
                <span>{tr(t, 'remoteDesktop.toolbar.copyScreenshot', 'Copy PNG to Clipboard')}</span>
              </button>
            </PopoverClose>
            <PopoverClose asChild>
              <button
                type="button"
                onClick={onScreenshotSave}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent"
              >
                <Download size={13} className="text-emerald-500" />
                <span>{tr(t, 'remoteDesktop.toolbar.saveScreenshot', 'Save PNG Screenshot')}</span>
              </button>
            </PopoverClose>
          </PopoverContent>
        </Popover>
        )}

        {/* Ask AI Split Button + Region Snip + Privacy Lock (P2-AI) */}
        {(onAskAiFull || onOpenAiChat) && (
          <div className="inline-flex h-7 shrink-0 items-center rounded-md transition-colors hover:bg-muted/60">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid="remote-desktop-ask-ai-btn"
                  className={cn(
                    'h-7 gap-1 rounded-l-md rounded-r-none text-xs font-normal text-muted-foreground hover:bg-transparent hover:text-foreground',
                    compactLabels ? 'px-1.5' : 'px-2',
                  )}
                  disabled={status !== 'connected'}
                  onClick={onAskAiFull ?? onOpenAiChat}
                  aria-label={tr(t, 'ai.vision.askAi', 'Ask AI')}
                >
                  <CattyIcon size={13} className="text-primary/85" />
                  {!compactLabels && <span>Catty</span>}
                  {aiReadBlocked && (
                    <ShieldOff size={11} className="text-amber-500" aria-label={tr(t, 'ai.vision.privacyLockOn', 'AI screen reading blocked')} />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                {tr(t, 'ai.vision.captureFullAndAsk', 'Capture screen & ask AI')}
              </TooltipContent>
            </Tooltip>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  data-testid="remote-desktop-ask-ai-menu"
                  className="h-7 w-4 rounded-l-none rounded-r-md px-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
                  disabled={status !== 'connected'}
                  aria-label={tr(t, 'ai.vision.askAi', 'Ask AI')}
                >
                  <ChevronDown size={11} />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-60 p-1.5 text-xs">
                {onAskAiFull && (
                  <PopoverClose asChild>
                    <button
                      type="button"
                      onClick={onAskAiFull}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent"
                    >
                      <Camera size={13} className="text-primary" />
                      <span>{tr(t, 'ai.vision.captureFullAndAsk', 'Capture screen & ask AI')}</span>
                    </button>
                  </PopoverClose>
                )}
                {onAskAiRegion && (
                  <PopoverClose asChild>
                    <button
                      type="button"
                      data-testid="remote-desktop-ask-ai-snip"
                      onClick={onAskAiRegion}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent"
                    >
                      <Crop size={13} className="text-sky-500" />
                      <span>{tr(t, 'ai.vision.snipRegionAndAsk', 'Snip region & ask AI')}</span>
                    </button>
                  </PopoverClose>
                )}
                {onOpenAiChat && (
                  <PopoverClose asChild>
                    <button
                      type="button"
                      onClick={onOpenAiChat}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent"
                    >
                      <MessageSquare size={13} className="text-emerald-500" />
                      <span>{tr(t, 'ai.vision.openAiChat', 'Open AI assistant')}</span>
                    </button>
                  </PopoverClose>
                )}
                {onOpenAiAuditLog && (
                  <PopoverClose asChild>
                    <button
                      type="button"
                      data-testid="remote-desktop-ai-audit-btn"
                      onClick={onOpenAiAuditLog}
                      className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent"
                    >
                      <span className="flex items-center gap-2">
                        <History size={13} className="text-cyan-500" />
                        <span>{tr(t, 'remoteDesktop.ai.audit.menuItem', 'Computer Use Audit Log')}</span>
                      </span>
                      {aiAuditCount > 0 && (
                        <span className="rounded-full bg-primary/15 px-1.5 py-0 font-mono text-[10px] font-semibold text-primary">
                          {aiAuditCount}
                        </span>
                      )}
                    </button>
                  </PopoverClose>
                )}
                {onToggleAiReadBlocked && (
                  <>
                    <div className="my-1 h-px bg-border/60" />
                    <div className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5">
                      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium">
                        {aiReadBlocked ? (
                          <ShieldOff size={12} className="text-amber-500" />
                        ) : (
                          <Eye size={12} className="text-muted-foreground" />
                        )}
                        <span>
                          {aiReadBlocked
                            ? tr(t, 'ai.vision.privacyLockOn', 'AI screen reading blocked')
                            : tr(t, 'ai.vision.privacyLockOff', 'Allow AI to read screen')}
                        </span>
                      </span>
                      <Switch
                        checked={!aiReadBlocked}
                        onCheckedChange={(allow) => onToggleAiReadBlocked(!allow)}
                      />
                    </div>
                  </>
                )}
              </PopoverContent>
            </Popover>
          </div>
        )}

        {/* Session Recording Button / Active Pill (P2-B, visible in fullscreen too) */}
        {onToggleRecording && (!narrowMode || isRecording) && (
          <Tooltip>
            <TooltipTrigger asChild>
              {isRecording ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid="remote-desktop-record-btn"
                  data-recording="true"
                  className="h-7 shrink-0 gap-1.5 rounded-md bg-rose-500/12 px-2 text-xs font-medium text-rose-500 hover:bg-rose-500/20"
                  onClick={onToggleRecording}
                  aria-label={tr(t, 'remoteDesktop.toolbar.stopRecording', 'Stop recording')}
                >
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-rose-500 animate-pulse" />
                  <Square size={9} className="fill-current" />
                  <span className="font-mono text-[11px] font-medium">{recordingElapsedLabel}</span>
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  data-testid="remote-desktop-record-btn"
                  data-recording="false"
                  className="h-7 w-7 shrink-0 rounded-md text-muted-foreground hover:bg-muted/60 hover:text-rose-500"
                  disabled={status !== 'connected' || !recordingSupported}
                  onClick={onToggleRecording}
                  aria-label={tr(t, 'remoteDesktop.toolbar.record', 'Record session')}
                  title={tr(t, 'remoteDesktop.toolbar.record', 'Record session')}
                >
                  <Circle size={12} />
                </Button>
              )}
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {isRecording
                ? tr(t, 'remoteDesktop.toolbar.stopRecording', 'Stop recording')
                : tr(t, 'remoteDesktop.toolbar.record', 'Record session')}
            </TooltipContent>
          </Tooltip>
        )}

        {/* Narrow-Pane Responsive Overflow Menu */}
        {narrowMode && (
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                data-testid="remote-desktop-overflow-btn"
                className="h-7 w-7 shrink-0 rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                aria-label={tr(t, 'remoteDesktop.toolbar.moreActions', 'More Actions')}
                title={tr(t, 'remoteDesktop.toolbar.moreActions', 'More Actions')}
              >
                <MoreHorizontal size={14} />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-60 space-y-1.5 p-2 text-xs">
              <div className="flex items-center justify-between rounded-md px-2 py-1">
                <span className="inline-flex items-center gap-2 font-medium">
                  <Keyboard size={13} className="text-muted-foreground" />
                  {keyboardGrabActive
                    ? tr(t, 'remoteDesktop.toolbar.keysRemote', 'Keys: Remote')
                    : tr(t, 'remoteDesktop.toolbar.keysLocal', 'Keys: Local')}
                </span>
                <Switch
                  checked={keyboardGrabActive}
                  disabled={status !== 'connected' || viewOnly}
                  onCheckedChange={onToggleKeyboardGrab}
                />
              </div>
              <div className="flex items-center justify-between rounded-md px-2 py-1">
                <span className="inline-flex items-center gap-2 font-medium">
                  <Clipboard size={13} className="text-muted-foreground" />
                  {tr(t, 'remoteDesktop.toolbar.clipboardSync', 'Clipboard Sync')}
                </span>
                <Switch checked={clipboardSyncEnabled} onCheckedChange={onToggleClipboardSync} />
              </div>
              {isRdp && audioEnabled && onToggleAudioMute && (
                <div className="flex items-center justify-between rounded-md px-2 py-1">
                  <span className="inline-flex items-center gap-2 font-medium">
                    {audioMuted ? <VolumeX size={13} className="text-muted-foreground" /> : <Volume2 size={13} className="text-muted-foreground" />}
                    {tr(t, 'remoteDesktop.toolbar.audio', 'RDP Audio')}
                  </span>
                  <Switch checked={!audioMuted} onCheckedChange={() => onToggleAudioMute()} />
                </div>
              )}
              <div className="flex items-center justify-between rounded-md px-2 py-1">
                <span className="inline-flex items-center gap-2 font-medium">
                  <Eye size={13} className="text-muted-foreground" />
                  {tr(t, 'remoteDesktop.toolbar.viewOnly', 'View-Only Mode')}
                </span>
                <Switch checked={viewOnly} onCheckedChange={onToggleViewOnly} />
              </div>
              {isRdp && onToggleHighDpi && (
                <div className="flex items-center justify-between rounded-md px-2 py-1">
                  <span className="inline-flex items-center gap-2 font-medium">
                    <Monitor size={13} className="text-muted-foreground" />
                    {tr(t, 'remoteDesktop.display.highDpi', 'Retina HiDPI')}
                  </span>
                  <Switch checked={highDpi} onCheckedChange={onToggleHighDpi} />
                </div>
              )}
              {onToggleMapCmdToCtrl && (
                <div className="flex items-center justify-between rounded-md px-2 py-1">
                  <span className="inline-flex items-center gap-2 font-medium">
                    <Command size={13} className="text-muted-foreground" />
                    {tr(t, 'remoteDesktop.toolbar.mapCmdToCtrl', 'Map Cmd → Ctrl')}
                  </span>
                  <Switch checked={mapCmdToCtrl} onCheckedChange={onToggleMapCmdToCtrl} />
                </div>
              )}
              {!isRdp && onToggleShowRemoteCursor && (
                <div className="flex items-center justify-between rounded-md px-2 py-1">
                  <span className="inline-flex items-center gap-2 font-medium">
                    <MousePointer size={13} className="text-muted-foreground" />
                    {tr(t, 'remoteDesktop.toolbar.showRemoteCursor', 'Show Remote Cursor')}
                  </span>
                  <Switch checked={showRemoteCursor} onCheckedChange={onToggleShowRemoteCursor} />
                </div>
              )}
              {!isRdp && (
                <div className="space-y-1 rounded-md px-2 py-1">
                  <div className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground">
                    <Sparkles size={11} className="text-amber-500" />
                    <span>{tr(t, 'remoteDesktop.toolbar.quality', 'Encoding Quality')}</span>
                  </div>
                  <div className="grid grid-cols-5 gap-1">
                    {QUALITY_OPTIONS.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        className={cn(
                          'rounded border px-1 py-0.5 text-center text-[10px] transition-colors',
                          quality === opt.id
                            ? 'border-primary/60 bg-primary/15 font-medium text-primary'
                            : 'border-border/60 bg-secondary/40 text-muted-foreground hover:bg-accent hover:text-foreground',
                        )}
                        onClick={() => onChangeQuality(opt.id)}
                      >
                        {opt.id === 'lossless'
                          ? 'Raw'
                          : opt.id === 'medium'
                            ? 'Med'
                            : opt.id === 'low'
                              ? 'Low'
                              : opt.fallback}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="my-1 h-px bg-border/60" />
              {isRdp && onAddSharedFolder && (
                <PopoverClose asChild>
                  <button
                    type="button"
                    onClick={onAddSharedFolder}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
                  >
                    <FolderPlus size={13} className="text-muted-foreground" />
                    <span>{tr(t, 'remoteDesktop.sharedFolders.add', 'Add Folder')}</span>
                  </button>
                </PopoverClose>
              )}
              {onSyncClipboardNow && (
                <PopoverClose asChild>
                  <button
                    type="button"
                    disabled={status !== 'connected' || viewOnly}
                    onClick={onSyncClipboardNow}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent disabled:opacity-45"
                  >
                    <ClipboardCopy size={13} className="text-muted-foreground" />
                    <span>{tr(t, 'remoteDesktop.clipboard.pushNow', 'Push Local Clipboard Now')}</span>
                  </button>
                </PopoverClose>
              )}
              {!isRdp && onRefreshScreen && (
                <PopoverClose asChild>
                  <button
                    type="button"
                    disabled={status !== 'connected'}
                    onClick={onRefreshScreen}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent disabled:opacity-45"
                  >
                    <RotateCw size={13} className="text-muted-foreground" />
                    <span>{tr(t, 'remoteDesktop.toolbar.refreshScreen', 'Force Full Screen Refresh')}</span>
                  </button>
                </PopoverClose>
              )}
              <PopoverClose asChild>
                <button
                  type="button"
                  disabled={status !== 'connected'}
                  onClick={onScreenshotCopy}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent disabled:opacity-45"
                >
                  <Camera size={13} className="text-muted-foreground" />
                  <span>{tr(t, 'remoteDesktop.toolbar.copyScreenshot', 'Copy PNG to Clipboard')}</span>
                </button>
              </PopoverClose>
              <PopoverClose asChild>
                <button
                  type="button"
                  disabled={status !== 'connected'}
                  onClick={onScreenshotSave}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent disabled:opacity-45"
                >
                  <Download size={13} className="text-muted-foreground" />
                  <span>{tr(t, 'remoteDesktop.toolbar.saveScreenshot', 'Save PNG Screenshot')}</span>
                </button>
              </PopoverClose>
              {onToggleRecording && (
                <PopoverClose asChild>
                  <button
                    type="button"
                    disabled={status !== 'connected' || !recordingSupported}
                    onClick={onToggleRecording}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent disabled:opacity-45"
                  >
                    <Circle size={12} className={isRecording ? 'fill-rose-500 text-rose-500' : 'text-muted-foreground'} />
                    <span>
                      {isRecording
                        ? tr(t, 'remoteDesktop.toolbar.stopRecording', 'Stop recording')
                        : tr(t, 'remoteDesktop.toolbar.record', 'Record session')}
                    </span>
                  </button>
                </PopoverClose>
              )}
              {onPopOut && (
                <PopoverClose asChild>
                  <button
                    type="button"
                    onClick={onPopOut}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
                  >
                    <ExternalLink size={13} className="text-muted-foreground" />
                    <span>{tr(t, 'remoteDesktop.toolbar.popOut', 'Open in New Window')}</span>
                  </button>
                </PopoverClose>
              )}
              {onOpenSystemClient && (
                <PopoverClose asChild>
                  <button
                    type="button"
                    onClick={onOpenSystemClient}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
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
                  </button>
                </PopoverClose>
              )}
            </PopoverContent>
          </Popover>
        )}

        <div className="mx-0.5 h-3.5 w-px shrink-0 bg-border/50" />

        {/* Fullscreen */}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          onClick={onToggleFullscreen}
          aria-label={isFullscreen ? tr(t, 'remoteDesktop.toolbar.exitFullscreen', 'Exit Fullscreen') : tr(t, 'remoteDesktop.toolbar.fullscreen', 'Fullscreen')}
          title={isFullscreen ? tr(t, 'remoteDesktop.toolbar.exitFullscreen', 'Exit Fullscreen') : tr(t, 'remoteDesktop.toolbar.fullscreen', 'Fullscreen')}
        >
          {isFullscreen ? <Minimize size={13} /> : <Maximize size={13} />}
        </Button>

        {/* Pin pill toggle (fullscreen only) */}
        {isFullscreen && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              'h-7 w-7 shrink-0 rounded-md',
              pinnedFullscreen
                ? 'bg-primary/12 text-primary'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            )}
            onClick={() => setPinnedFullscreen((p) => !p)}
            title={pinnedFullscreen ? tr(t, 'remoteDesktop.toolbar.unpin', 'Unpin toolbar') : tr(t, 'remoteDesktop.toolbar.pin', 'Pin toolbar')}
          >
            {pinnedFullscreen ? <PinOff size={13} /> : <Pin size={13} />}
          </Button>
        )}

        {/* Pop-out window */}
        {onPopOut && !isFullscreen && !narrowMode && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            onClick={onPopOut}
            aria-label={tr(t, 'remoteDesktop.toolbar.popOut', 'Open in New Window')}
            title={tr(t, 'remoteDesktop.toolbar.popOut', 'Open in New Window')}
          >
            <ExternalLink size={13} />
          </Button>
        )}

        {/* Reconnect */}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          onClick={onReconnect}
          aria-label={tr(t, 'remoteDesktop.toolbar.reconnect', 'Reconnect')}
          title={tr(t, 'remoteDesktop.toolbar.reconnect', 'Reconnect')}
        >
          <RefreshCw size={13} />
        </Button>

        {/* Disconnect */}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          onClick={onDisconnect}
          aria-label={tr(t, 'remoteDesktop.toolbar.disconnect', 'Disconnect')}
          title={tr(t, 'remoteDesktop.toolbar.disconnect', 'Disconnect')}
        >
          <Power size={13} />
        </Button>
      </div>
    </div>
  );

  if (!isFullscreen) {
    return barContent;
  }

  return (
    <div
      className="pointer-events-none absolute left-0 right-0 top-0 z-30 flex justify-center pt-1.5"
      onMouseEnter={() => {
        clearTimeout(hoverHideTimerRef.current);
        setHoverReveal(true);
      }}
      onMouseLeave={() => {
        // Allow travel from the trigger strip onto the animating pill.
        hoverHideTimerRef.current = setTimeout(() => setHoverReveal(false), 150);
      }}
    >
      {/* Top-edge hover trigger strip */}
      <div className="pointer-events-auto absolute inset-x-0 top-0 h-3" />
      <div
        className={cn(
          'transition-all duration-150',
          pinnedFullscreen || hoverReveal
            ? 'translate-y-0 opacity-100 pointer-events-auto'
            : '-translate-y-full opacity-0 pointer-events-none',
        )}
      >
        {barContent}
      </div>
    </div>
  );
});
