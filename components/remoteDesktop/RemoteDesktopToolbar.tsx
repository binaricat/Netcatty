import React, { useRef, useState } from 'react';
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
  FolderTree,
  Gauge,
  Keyboard,
  Layers,
  Lock,
  Maximize,
  Maximize2,
  MessageSquare,
  Minimize,
  Monitor,
  Pin,
  PinOff,
  Power,
  RefreshCw,
  Scaling,
  Scan,
  Search,
  ShieldAlert,
  ShieldOff,
  SlidersHorizontal,
  Sparkles,
  Square,
  Terminal,
  Upload,
  UploadCloud,
  Volume2,
  VolumeX,
  X,
  XCircle,
} from 'lucide-react';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { RemoteDesktopProtocol } from '../../domain/remoteDesktop';
import { cn } from '../../lib/utils';
import {
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
} from './remoteDesktopHelpers';
import type { RemoteDesktopSpecialKeyId } from './vncKeymap';

export interface RemoteDesktopToolbarProps {
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
  // RDP audio
  audioEnabled?: boolean;
  audioMuted?: boolean;
  audioVolume?: number;
  onToggleAudioMute?: () => void;
  onChangeAudioVolume?: (volume: number) => void;
  // Clipboard + RDP file transfer
  clipboardSyncEnabled: boolean;
  onToggleClipboardSync: (enabled: boolean) => void;
  remoteClipboardFiles?: readonly RemoteDesktopClipboardFileOffer[];
  clipboardFileTransferStatus?: string | null;
  clipboardTransfer?: RemoteDesktopClipboardTransferState | null;
  onDismissClipboardTransfer?: () => void;
  onDownloadClipboardFile?: (fileIndex: number) => void;
  onUploadLocalClipboardFiles?: (files: FileList | File[]) => void;
  // Companion SFTP
  onOpenSftp?: () => void;
  isSftpOpen?: boolean;
  // AI Vision
  onAskAiFull?: () => void;
  onAskAiRegion?: () => void;
  onOpenAiChat?: () => void;
  aiReadBlocked?: boolean;
  onToggleAiReadBlocked?: (blocked: boolean) => void;
  // Session Recording
  isRecording?: boolean;
  recordingElapsedLabel?: string;
  recordingSupported?: boolean;
  onToggleRecording?: () => void;
  // Quality / view-only
  quality: RemoteDesktopQualityPreset;
  onChangeQuality: (quality: RemoteDesktopQualityPreset) => void;
  viewOnly: boolean;
  onToggleViewOnly: (viewOnly: boolean) => void;
  // Actions
  onScreenshotCopy: () => void;
  onScreenshotSave: () => void;
  onToggleFullscreen: () => void;
  onPopOut?: () => void;
  onOpenSystemClient?: () => void;
  onReconnect: () => void;
  onDisconnect: () => void;
}

const SPECIAL_KEY_ITEMS: ReadonlyArray<{
  id: RemoteDesktopSpecialKeyId;
  label: string;
  hint?: string;
  icon: React.ReactNode;
}> = [
  {
    id: 'ctrl-alt-del',
    label: 'Ctrl + Alt + Del',
    hint: 'Security screen',
    icon: <ShieldAlert size={13} className="text-amber-500" />,
  },
  {
    id: 'win',
    label: 'Win / Super',
    icon: <AppWindow size={13} className="text-blue-500" />,
  },
  {
    id: 'alt-tab',
    label: 'Alt + Tab',
    hint: 'Switch window',
    icon: <Layers size={13} className="text-sky-500" />,
  },
  {
    id: 'alt-f4',
    label: 'Alt + F4',
    hint: 'Close window',
    icon: <XCircle size={13} className="text-rose-500" />,
  },
  {
    id: 'ctrl-shift-esc',
    label: 'Ctrl + Shift + Esc',
    hint: 'Task Manager',
    icon: <Activity size={13} className="text-emerald-500" />,
  },
  {
    id: 'cmd-space',
    label: 'Cmd + Space',
    hint: 'Spotlight',
    icon: <Search size={13} className="text-violet-500" />,
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

export const RemoteDesktopToolbar: React.FC<RemoteDesktopToolbarProps> = React.memo(({
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
  audioEnabled,
  audioMuted,
  audioVolume = 1,
  onToggleAudioMute,
  onChangeAudioVolume,
  clipboardSyncEnabled,
  onToggleClipboardSync,
  remoteClipboardFiles = [],
  clipboardFileTransferStatus,
  clipboardTransfer = null,
  onDismissClipboardTransfer,
  onDownloadClipboardFile,
  onUploadLocalClipboardFiles,
  onOpenSftp,
  isSftpOpen = false,
  onAskAiFull,
  onAskAiRegion,
  onOpenAiChat,
  aiReadBlocked = false,
  onToggleAiReadBlocked,
  isRecording = false,
  recordingElapsedLabel = '00:00',
  recordingSupported = true,
  onToggleRecording,
  quality,
  onChangeQuality,
  viewOnly,
  onToggleViewOnly,
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
  const localFileInputRef = useRef<HTMLInputElement | null>(null);
  const isRdp = protocol === 'rdp';

  const statusDotClass =
    status === 'connected'
      ? 'bg-emerald-500'
      : status === 'connecting'
        ? 'bg-amber-400 animate-pulse'
        : 'bg-muted-foreground/45';

  const resolutionLabel = resolution ? `${resolution.width}×${resolution.height}` : '--';
  const fpsLabel = typeof fps === 'number' && fps > 0 ? `${Math.round(fps)} FPS` : '';
  const volumePercent = Math.round((audioMuted ? 0 : audioVolume) * 100);
  const activeDisplayOption = DISPLAY_MODE_OPTIONS.find((opt) => opt.id === displayMode);
  const activeDisplayLabel = activeDisplayOption
    ? tr(t, activeDisplayOption.labelKey, activeDisplayOption.fallback)
    : tr(t, 'remoteDesktop.display.fit', 'Fit to Pane');

  const barContent = (
    <div
      className={cn(
        'flex items-center gap-1 text-xs select-none',
        isFullscreen
          ? 'h-9 rounded-full border border-border/70 bg-background/95 px-3 shadow-xl ring-1 ring-black/10 backdrop-blur-md'
          : 'h-9 w-full shrink-0 border-b border-border/60 bg-background px-2.5',
      )}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Status & Minimalist Host Identity */}
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex h-7 min-w-0 items-center gap-2 rounded-md px-1.5 transition-colors hover:bg-muted/60">
            <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', statusDotClass)} />
            <span className={cn('shrink-0', isRdp ? 'text-blue-500' : 'text-teal-500')}>
              {isRdp ? <RdpProtocolIcon size={13} /> : <VncProtocolIcon size={13} />}
            </span>
            <span className="max-w-[160px] truncate text-xs font-medium text-foreground">
              {hostLabel}
            </span>
            {tunneled && (
              <span
                className="inline-flex items-center gap-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400 shrink-0"
                title={tr(t, 'remoteDesktop.toolbar.sshTunneled', 'Tunneled over SSH')}
              >
                <SshTunnelIcon size={11} />
                <span>SSH</span>
              </span>
            )}
            {encrypted && (
              <Lock
                size={11}
                className="shrink-0 text-emerald-500/80"
                aria-label={tr(t, 'remoteDesktop.toolbar.encrypted', 'Encrypted TLS connection')}
              />
            )}
            {viewOnly && (
              <span className="inline-flex items-center gap-1 rounded bg-amber-500/12 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400 shrink-0">
                <Eye size={10} />
                <span>{tr(t, 'remoteDesktop.toolbar.viewOnlyBadge', 'View')}</span>
              </span>
            )}
            {resolution && !isFullscreen && (
              <span className="hidden lg:inline-block font-mono text-[11px] text-muted-foreground/75 shrink-0">
                {resolutionLabel}
              </span>
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 font-medium">
              {isRdp ? <RdpProtocolIcon size={13} className="text-blue-500" /> : <VncProtocolIcon size={13} className="text-teal-500" />}
              <span>{hostLabel}</span>
              <span className="text-muted-foreground">({protocol.toUpperCase()})</span>
            </div>
            <div className="font-mono text-[11px] text-muted-foreground">
              {statusDetail || status} · {resolutionLabel}
              {fpsLabel ? ` · ${fpsLabel}` : ''}
            </div>
            {tunneled && (
              <div className="flex items-center gap-1 text-emerald-500">
                <SshTunnelIcon size={11} />
                <span>{tr(t, 'remoteDesktop.toolbar.sshTunneled', 'Tunneled over SSH')}</span>
              </div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>

      <div className="mx-1 h-3.5 w-px bg-border/50" />

      {/* Input Group: Keyboard Grab Toggle + Send Special Keys */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn(
              'h-7 gap-1.5 rounded-md px-2 text-xs font-normal transition-colors',
              keyboardGrabActive
                ? 'bg-primary/12 text-primary font-medium hover:bg-primary/18'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            )}
            onClick={onToggleKeyboardGrab}
            disabled={viewOnly}
          >
            <Keyboard size={13} />
            <span>
              {keyboardGrabActive
                ? tr(t, 'remoteDesktop.toolbar.keysRemote', 'Keys: Remote')
                : tr(t, 'remoteDesktop.toolbar.keysLocal', 'Keys: Local')}
            </span>
            {keyboardGrabActive && <Lock size={10} className="opacity-85" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[260px] text-xs">
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

      {/* Send Special Keys + Type Clipboard */}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 rounded-md px-2 text-xs font-normal text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            disabled={status !== 'connected' || viewOnly}
          >
            <Command size={13} />
            <span>{tr(t, 'remoteDesktop.toolbar.sendKeys', 'Send Keys')}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-1.5 text-xs">
          <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] font-semibold text-muted-foreground">
            <Command size={11} />
            <span>{tr(t, 'remoteDesktop.toolbar.specialKeys', 'Special Key Chords')}</span>
          </div>
          {SPECIAL_KEY_ITEMS.map((item) => (
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

      {/* Display / Scaling Mode */}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 rounded-md px-2 text-xs font-normal text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            title={tr(t, 'remoteDesktop.toolbar.display', 'Display Scaling')}
          >
            <Scaling size={13} />
            <span className="hidden sm:inline">{activeDisplayLabel}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-48 p-1.5 text-xs">
          {DISPLAY_MODE_OPTIONS.map((opt) => (
            <PopoverClose key={opt.id} asChild>
              <button
                type="button"
                onClick={() => onChangeDisplayMode(opt.id)}
                className={cn(
                  'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent',
                  displayMode === opt.id && 'bg-accent/70 font-medium text-foreground',
                )}
              >
                <span className="flex items-center gap-2">
                  {opt.icon}
                  <span>{tr(t, opt.labelKey, opt.fallback)}</span>
                </span>
                {displayMode === opt.id && <Check size={13} className="text-primary" />}
              </button>
            </PopoverClose>
          ))}
        </PopoverContent>
      </Popover>

      <div className="flex-1" />

      {/* Right Utility Controls */}
      <div className="flex items-center gap-0.5">
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
              <div className="space-y-0.5">
                <div className="font-medium">{clipboardTransfer.message}</div>
                {clipboardTransfer.totalBytes > 0 && (
                  <div className="font-mono text-[11px] text-muted-foreground">
                    {formatTransferBytes(clipboardTransfer.transferredBytes)} / {formatTransferBytes(clipboardTransfer.totalBytes)}
                  </div>
                )}
              </div>
            </TooltipContent>
          </Tooltip>
        )}

        {/* Companion SSH SFTP Quick Open (P1-C) */}
        {onOpenSftp && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="remote-desktop-sftp-btn"
                aria-pressed={isSftpOpen}
                className={cn(
                  'h-7 gap-1.5 rounded-md px-2 text-xs font-normal transition-colors',
                  isSftpOpen
                    ? 'bg-primary/12 text-primary font-medium hover:bg-primary/18'
                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                )}
                onClick={onOpenSftp}
              >
                <FolderTree size={13} />
                <span>{tr(t, 'remoteDesktop.toolbar.openSftp', 'SFTP')}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {tr(t, 'remoteDesktop.toolbar.openSftp', 'SFTP')}
            </TooltipContent>
          </Tooltip>
        )}

        {/* RDP Audio Control */}
        {isRdp && audioEnabled && (
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
        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn(
                'h-7 gap-1 rounded-md px-1.5 text-xs',
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

        {/* Quality & View-Only Popover */}
        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              aria-label={tr(t, 'remoteDesktop.toolbar.options', 'Quality & Input Options')}
              title={tr(t, 'remoteDesktop.toolbar.options', 'Quality & Input Options')}
            >
              <SlidersHorizontal size={13} />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-60 space-y-3 p-3 text-xs">
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 font-medium">
                <Eye size={13} className="text-amber-500" />
                {tr(t, 'remoteDesktop.toolbar.viewOnly', 'View-Only Mode')}
              </span>
              <Switch checked={viewOnly} onCheckedChange={onToggleViewOnly} />
            </div>
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
                        'flex items-center justify-between rounded-md px-2 py-1 text-left text-[11px] transition-colors hover:bg-accent',
                        quality === opt.id && 'bg-accent font-medium text-foreground',
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

        {/* Screenshot Popover */}
        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
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

        {/* Ask AI Split Button + Region Snip + Privacy Lock (P2-AI) */}
        {(onAskAiFull || onOpenAiChat) && (
          <div className="inline-flex h-7 items-center rounded-md transition-colors hover:bg-muted/60">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid="remote-desktop-ask-ai-btn"
                  className="h-7 gap-1 rounded-l-md rounded-r-none px-2 text-xs font-normal text-muted-foreground hover:bg-transparent hover:text-foreground"
                  disabled={status !== 'connected'}
                  onClick={onAskAiFull ?? onOpenAiChat}
                >
                  <Sparkles size={13} className="text-primary/85" />
                  <span>{tr(t, 'ai.vision.askAi', 'Ask AI')}</span>
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
        {onToggleRecording && (
          <Tooltip>
            <TooltipTrigger asChild>
              {isRecording ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid="remote-desktop-record-btn"
                  data-recording="true"
                  className="h-7 gap-1.5 rounded-md bg-rose-500/12 px-2 text-xs font-medium text-rose-500 hover:bg-rose-500/20"
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
                  className="h-7 w-7 rounded-md text-muted-foreground hover:bg-muted/60 hover:text-rose-500"
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

        <div className="mx-1 h-3.5 w-px bg-border/50" />

        {/* Fullscreen */}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
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
              'h-7 w-7 rounded-md',
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
        {onPopOut && !isFullscreen && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
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
          className="h-7 w-7 rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
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
          className="h-7 w-7 rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
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
      className="pointer-events-auto absolute left-0 right-0 top-0 z-30 flex justify-center pt-1.5"
      onMouseEnter={() => setHoverReveal(true)}
      onMouseLeave={() => setHoverReveal(false)}
    >
      {/* Top-edge hover trigger strip */}
      <div className="absolute inset-x-0 top-0 h-3" />
      <div
        className={cn(
          'transition-all duration-150',
          pinnedFullscreen || hoverReveal
            ? 'translate-y-0 opacity-100'
            : '-translate-y-full opacity-0 pointer-events-none',
        )}
      >
        {barContent}
      </div>
    </div>
  );
});
