/**
 * Terminal Toolbar
 * Displays high-frequency terminal actions and close button in the terminal status bar.
 * Dense actions support show / collapse / hide via right-click customize.
 */
import {
  Check,
  ChevronRight,
  Circle,
  Download,
  FileText,
  FolderInput,
  FolderSync,
  Highlighter,
  History,
  Languages,
  MoreVertical,
  Palette,
  Search,
  TextCursorInput,
  Upload,
  X,
  Zap,
} from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { useToolbarItemLayout } from '../../application/state/useToolbarItemLayout';
import type { ToolbarItemLayoutDefaults } from '../../domain/toolbarItemLayout';
import { STORAGE_KEY_TERMINAL_TOOLBAR_LAYOUT } from '../../infrastructure/config/storageKeys';
import { Host, Snippet } from '../../types';
import { ScriptsSidePanel } from '../ScriptsSidePanel';
import { Button } from '../ui/button';
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '../ui/popover';
import { ToolbarCustomizeContextMenu } from '../ui/toolbar-item-layout';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import { cn } from '../../lib/utils';
import HostKeywordHighlightPopover from './HostKeywordHighlightPopover';

export const TERMINAL_TOOLBAR_ITEM_IDS = [
  'highlight',
  'sftp',
  'ymodemSend',
  'ymodemReceive',
  'compose',
  'search',
  'sessionLog',
  'scripts',
  'history',
  'configureOsc7',
  'terminalSettings',
  'recording',
  'encoding',
] as const;

export type TerminalToolbarItemId = (typeof TERMINAL_TOOLBAR_ITEM_IDS)[number];

/** Defaults mirror the previous fixed layout: primary actions shown, opener-style in ⋮. */
export const TERMINAL_TOOLBAR_LAYOUT_DEFAULTS: ToolbarItemLayoutDefaults = {
  order: [...TERMINAL_TOOLBAR_ITEM_IDS],
  placement: {
    highlight: 'show',
    sftp: 'show',
    ymodemSend: 'show',
    ymodemReceive: 'show',
    compose: 'show',
    search: 'show',
    sessionLog: 'show',
    scripts: 'show',
    history: 'collapse',
    configureOsc7: 'collapse',
    terminalSettings: 'collapse',
    recording: 'collapse',
    encoding: 'collapse',
  },
  // Always-present action so reachability cannot rely on session-only ids.
  lockedIds: ['search'],
};

export interface TerminalToolbarProps {
  status: 'connecting' | 'connected' | 'disconnected';
  host?: Host;
  /** Popup/minimal mode: compose bar, search, and snippets only. */
  compactToolbar?: boolean;
  snippets?: Snippet[];
  snippetPackages?: string[];
  onSnippetClick?: (snippet: Snippet) => void;
  onOpenSFTP: () => void;
  onSendYmodem?: () => void;
  onReceiveYmodem?: () => void;
  onOpenScripts: () => void;
  onOpenHistory?: () => void;
  onOpenTheme: () => void;
  onConfigureOsc7?: () => void;
  onUpdateHost?: (host: Host) => void;
  showClose?: boolean;
  onClose?: () => void;
  // Search functionality
  isSearchOpen?: boolean;
  onToggleSearch?: () => void;
  // Manual session log
  showLogButton?: boolean;
  onToggleSessionLog?: () => void;
  isSessionLogging?: boolean;
  isSessionLogDisabled?: boolean;
  // Compose bar
  isComposeBarOpen?: boolean;
  onToggleComposeBar?: () => void;
  // Terminal encoding
  terminalEncoding?: 'utf-8' | 'gb18030';
  onSetTerminalEncoding?: (encoding: 'utf-8' | 'gb18030') => void;
  recordingIndicator?: React.ReactNode;
  onStartRecording?: () => void;
}

export const TerminalToolbar: React.FC<TerminalToolbarProps> = ({
  status,
  host,
  compactToolbar = false,
  snippets = [],
  snippetPackages = [],
  onSnippetClick,
  onOpenSFTP,
  onSendYmodem,
  onReceiveYmodem,
  onOpenScripts,
  onOpenHistory,
  onOpenTheme,
  onConfigureOsc7,
  onUpdateHost,
  showClose,
  onClose,
  isSearchOpen,
  onToggleSearch,
  showLogButton = false,
  onToggleSessionLog,
  isSessionLogging = false,
  isSessionLogDisabled = false,
  isComposeBarOpen,
  onToggleComposeBar,
  terminalEncoding,
  onSetTerminalEncoding,
  recordingIndicator,
  onStartRecording,
}) => {
  const { t } = useI18n();
  const [highlightPopoverOpen, setHighlightPopoverOpen] = useState(false);
  const [scriptsPopoverOpen, setScriptsPopoverOpen] = useState(false);
  // Overflow popover + encoding submenu are both controlled so that
  // picking an encoding closes the whole chain, and so the parent popover
  // can ignore clicks that land in the submenu portal (otherwise the
  // submenu click would read as "outside" and dismiss the parent).
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [encodingSubmenuOpen, setEncodingSubmenuOpen] = useState(false);
  const buttonBase =
    'h-6 w-6 p-0 shadow-none border-none text-[color:var(--terminal-toolbar-fg)] bg-transparent hover:bg-transparent';

  const isLocalTerminal = host?.protocol === 'local' || host?.id?.startsWith('local-');
  const isSerialTerminal = host?.protocol === 'serial' || host?.id?.startsWith('serial-');
  const isMoshSession = host?.protocol === 'mosh' || host?.moshEnabled;
  const isEtSession = host?.protocol === 'et' || host?.etEnabled;
  // Local PTY inherits the OS locale and mosh/ET always use their own framing,
  // so the quick-switch menu only makes sense for sessions whose
  // backend decoder we actually control (SSH, telnet, serial). Hostname
  // isn't part of the gate — telnet/SSH targets pointed at localhost
  // (test daemons, forwarded endpoints) still have a real backend
  // decoder we can drive.
  const encodingSwitchSupported = !isLocalTerminal && !isMoshSession && !isEtSession;
  const hidesSftp = isLocalTerminal || isSerialTerminal;
  const historySupported =
    !!onOpenHistory && !isLocalTerminal && !isSerialTerminal && host?.protocol !== 'telnet';
  const unavailableYmodemSendLabel = `${t('terminal.toolbar.sendYmodem')} - ${t('terminal.toolbar.availableAfterConnect')}`;
  const unavailableYmodemReceiveLabel = `${t('terminal.toolbar.receiveYmodem')} - ${t('terminal.toolbar.availableAfterConnect')}`;

  const menuItemClass =
    'w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded-sm hover:bg-secondary transition-colors';
  const activeButtonStyle: React.CSSProperties = {
    backgroundColor: 'var(--terminal-toolbar-btn-active)',
  };

  const toolbarLayout = useToolbarItemLayout(
    STORAGE_KEY_TERMINAL_TOOLBAR_LAYOUT,
    TERMINAL_TOOLBAR_LAYOUT_DEFAULTS,
  );

  const availableIds = useMemo(() => {
    const ids: TerminalToolbarItemId[] = [
      'highlight',
      'compose',
      'search',
      'scripts',
      'terminalSettings',
    ];
    if (!hidesSftp) ids.push('sftp');
    if (isSerialTerminal) {
      ids.push('ymodemSend', 'ymodemReceive');
    }
    if (showLogButton) ids.push('sessionLog');
    if (historySupported) ids.push('history');
    if (onConfigureOsc7 && !hidesSftp) ids.push('configureOsc7');
    if (onStartRecording) ids.push('recording');
    if (encodingSwitchSupported && onSetTerminalEncoding) ids.push('encoding');
    return ids;
  }, [
    encodingSwitchSupported,
    hidesSftp,
    historySupported,
    isSerialTerminal,
    onConfigureOsc7,
    onSetTerminalEncoding,
    onStartRecording,
    showLogButton,
  ]);

  const itemLabels = useMemo(
    (): Record<TerminalToolbarItemId, string> => ({
      highlight: t('terminal.toolbar.hostHighlight.title'),
      sftp: t('terminal.toolbar.openSftp'),
      ymodemSend: t('terminal.toolbar.sendYmodem'),
      ymodemReceive: t('terminal.toolbar.receiveYmodem'),
      compose: t('terminal.toolbar.composeBar'),
      search: t('terminal.toolbar.searchTerminal'),
      sessionLog: isSessionLogging
        ? t('terminal.toolbar.stopSessionLog')
        : t('terminal.toolbar.startSessionLog'),
      scripts: t('terminal.toolbar.scripts'),
      history: t('terminal.toolbar.history'),
      configureOsc7: t('terminal.toolbar.configureOsc7'),
      terminalSettings: t('terminal.toolbar.terminalSettings'),
      recording: t('scripts.recording.start'),
      encoding: t('terminal.toolbar.encoding'),
    }),
    [isSessionLogging, t],
  );

  const itemIcons = useMemo(
    (): Record<TerminalToolbarItemId, React.ReactNode> => ({
      highlight: <Highlighter size={14} />,
      sftp: <FolderInput size={14} />,
      ymodemSend: <Upload size={14} />,
      ymodemReceive: <Download size={14} />,
      compose: <TextCursorInput size={14} />,
      search: <Search size={14} />,
      sessionLog: <FileText size={14} />,
      scripts: <Zap size={14} />,
      history: <History size={14} />,
      configureOsc7: <FolderSync size={14} />,
      terminalSettings: <Palette size={14} />,
      recording: <Circle size={14} className="text-red-500" />,
      encoding: <Languages size={14} />,
    }),
    [],
  );

  const customizeItems = useMemo(
    () =>
      toolbarLayout.layout.order
        .filter((id): id is TerminalToolbarItemId =>
          (availableIds as string[]).includes(id),
        )
        .map((id) => ({
          id,
          label: itemLabels[id],
          icon: itemIcons[id],
          locked: id === 'search',
          // Host-highlight popover is inline-only; collapse would be a silent hide.
          supportsCollapse: id !== 'highlight',
        })),
    [availableIds, itemIcons, itemLabels, toolbarLayout.layout.order],
  );

  const { shown, collapsed } = useMemo(() => {
    const available = new Set(availableIds);
    const shownIds: string[] = [];
    const collapsedIds: string[] = [];
    for (const id of toolbarLayout.layout.order) {
      if (!available.has(id)) continue;
      let placement = toolbarLayout.layout.placement[id] ?? 'show';
      // highlight is show/hide only — never leave it stranded as collapsed-but-null.
      if (id === 'highlight' && placement === 'collapse') placement = 'show';
      if (placement === 'show') shownIds.push(id);
      else if (placement === 'collapse') collapsedIds.push(id);
    }
    return { shown: shownIds, collapsed: collapsedIds };
  }, [availableIds, toolbarLayout.layout]);

  if (compactToolbar) {
    return (
      <TooltipProvider delayDuration={500} skipDelayDuration={100} disableHoverableContent>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="secondary"
              size="icon"
              className={buttonBase}
              aria-label={t('terminal.toolbar.composeBar')}
              aria-pressed={isComposeBarOpen}
              onClick={onToggleComposeBar}
              style={isComposeBarOpen ? activeButtonStyle : undefined}
            >
              <TextCursorInput size={12} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('terminal.toolbar.composeBar')}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="secondary"
              size="icon"
              className={buttonBase}
              aria-label={t('terminal.toolbar.searchTerminal')}
              aria-pressed={isSearchOpen}
              onClick={onToggleSearch}
              style={isSearchOpen ? activeButtonStyle : undefined}
            >
              <Search size={12} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('terminal.toolbar.searchTerminal')}</TooltipContent>
        </Tooltip>

        <Popover open={scriptsPopoverOpen} onOpenChange={setScriptsPopoverOpen}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  variant="secondary"
                  size="icon"
                  className={buttonBase}
                  aria-label={t('terminal.toolbar.scripts')}
                  aria-pressed={scriptsPopoverOpen}
                  style={scriptsPopoverOpen ? activeButtonStyle : undefined}
                >
                  <Zap size={12} />
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('terminal.toolbar.scripts')}</TooltipContent>
          </Tooltip>
          <PopoverContent className="w-80 p-0 h-80 flex flex-col overflow-hidden" align="end">
            <ScriptsSidePanel
              snippets={snippets}
              packages={snippetPackages}
              isVisible={scriptsPopoverOpen}
              onSnippetClick={(snippet) => {
                onSnippetClick?.(snippet);
                setScriptsPopoverOpen(false);
              }}
            />
          </PopoverContent>
        </Popover>
      </TooltipProvider>
    );
  }

  const renderEncodingSubmenu = () => {
    if (!encodingSwitchSupported || !onSetTerminalEncoding) return null;
    return (
      <Popover open={encodingSubmenuOpen} onOpenChange={setEncodingSubmenuOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={menuItemClass}
            aria-haspopup="menu"
            aria-expanded={encodingSubmenuOpen}
          >
            <Languages size={12} className="shrink-0" />
            <span className="flex-1 text-left truncate">{t('terminal.toolbar.encoding')}</span>
            <ChevronRight size={12} className="shrink-0 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          data-encoding-submenu="true"
          className="w-40 p-1"
          side="right"
          align="start"
          sideOffset={6}
        >
          {(['utf-8', 'gb18030'] as const).map((enc) => {
            const isActive = terminalEncoding === enc;
            return (
              <button
                key={enc}
                type="button"
                className={cn(menuItemClass, isActive && 'font-medium')}
                onClick={() => {
                  onSetTerminalEncoding(enc);
                  setEncodingSubmenuOpen(false);
                  setOverflowOpen(false);
                }}
              >
                <Languages size={12} className="shrink-0" />
                <span className="flex-1 text-left truncate">
                  {t(`terminal.toolbar.encoding.${enc === 'utf-8' ? 'utf8' : enc}`)}
                </span>
                <Check
                  size={12}
                  className={cn('shrink-0', isActive ? 'opacity-100' : 'opacity-0')}
                />
              </button>
            );
          })}
        </PopoverContent>
      </Popover>
    );
  };

  const renderInline = (id: string): React.ReactNode => {
    switch (id as TerminalToolbarItemId) {
      case 'highlight':
        return (
          <HostKeywordHighlightPopover
            key={id}
            host={host}
            onUpdateHost={onUpdateHost}
            isOpen={highlightPopoverOpen}
            setIsOpen={setHighlightPopoverOpen}
            buttonClassName={buttonBase}
          />
        );
      case 'sftp':
        return (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <Button
                variant="secondary"
                size="icon"
                className={cn(buttonBase, status !== 'connected' && 'opacity-50')}
                aria-label={
                  status === 'connected'
                    ? t('terminal.toolbar.openSftp')
                    : t('terminal.toolbar.availableAfterConnect')
                }
                onClick={onOpenSFTP}
                disabled={status !== 'connected'}
              >
                <FolderInput size={12} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {status === 'connected'
                ? t('terminal.toolbar.openSftp')
                : t('terminal.toolbar.availableAfterConnect')}
            </TooltipContent>
          </Tooltip>
        );
      case 'ymodemSend':
        return (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <Button
                variant="secondary"
                size="icon"
                className={cn(buttonBase, status !== 'connected' && 'opacity-50')}
                aria-label={
                  status === 'connected' ? t('terminal.toolbar.sendYmodem') : unavailableYmodemSendLabel
                }
                onClick={onSendYmodem}
                disabled={status !== 'connected' || !onSendYmodem}
              >
                <Upload size={12} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {status === 'connected'
                ? t('terminal.toolbar.sendYmodem')
                : t('terminal.toolbar.availableAfterConnect')}
            </TooltipContent>
          </Tooltip>
        );
      case 'ymodemReceive':
        return (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <Button
                variant="secondary"
                size="icon"
                className={cn(buttonBase, status !== 'connected' && 'opacity-50')}
                aria-label={
                  status === 'connected'
                    ? t('terminal.toolbar.receiveYmodem')
                    : unavailableYmodemReceiveLabel
                }
                onClick={onReceiveYmodem}
                disabled={status !== 'connected' || !onReceiveYmodem}
              >
                <Download size={12} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {status === 'connected'
                ? t('terminal.toolbar.receiveYmodem')
                : t('terminal.toolbar.availableAfterConnect')}
            </TooltipContent>
          </Tooltip>
        );
      case 'compose':
        return (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="secondary"
                size="icon"
                className={buttonBase}
                aria-label={t('terminal.toolbar.composeBar')}
                aria-pressed={isComposeBarOpen}
                onClick={onToggleComposeBar}
                style={isComposeBarOpen ? activeButtonStyle : undefined}
              >
                <TextCursorInput size={12} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('terminal.toolbar.composeBar')}</TooltipContent>
          </Tooltip>
        );
      case 'search':
        return (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="secondary"
                size="icon"
                className={buttonBase}
                aria-label={t('terminal.toolbar.searchTerminal')}
                aria-pressed={isSearchOpen}
                onClick={onToggleSearch}
                style={isSearchOpen ? activeButtonStyle : undefined}
              >
                <Search size={12} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('terminal.toolbar.searchTerminal')}</TooltipContent>
          </Tooltip>
        );
      case 'sessionLog':
        return (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="secondary"
                size="icon"
                className={cn(buttonBase, isSessionLogDisabled && 'opacity-50')}
                aria-label={
                  isSessionLogging
                    ? t('terminal.toolbar.stopSessionLog')
                    : t('terminal.toolbar.startSessionLog')
                }
                aria-pressed={isSessionLogging}
                onClick={onToggleSessionLog}
                disabled={isSessionLogDisabled || !onToggleSessionLog}
                style={isSessionLogging ? activeButtonStyle : undefined}
              >
                <FileText size={12} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {isSessionLogging
                ? t('terminal.toolbar.stopSessionLog')
                : t('terminal.toolbar.startSessionLog')}
            </TooltipContent>
          </Tooltip>
        );
      case 'scripts':
        return (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="secondary"
                size="icon"
                className={buttonBase}
                aria-label={t('terminal.toolbar.scripts')}
                onClick={onOpenScripts}
              >
                <Zap size={12} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('terminal.toolbar.scripts')}</TooltipContent>
          </Tooltip>
        );
      case 'history':
        return (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="secondary"
                size="icon"
                className={cn(buttonBase, status !== 'connected' && 'opacity-50')}
                aria-label={
                  status === 'connected'
                    ? t('terminal.toolbar.history')
                    : t('terminal.toolbar.availableAfterConnect')
                }
                disabled={status !== 'connected'}
                onClick={onOpenHistory}
              >
                <History size={12} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {status === 'connected'
                ? t('terminal.toolbar.history')
                : t('terminal.toolbar.availableAfterConnect')}
            </TooltipContent>
          </Tooltip>
        );
      case 'configureOsc7':
        return (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="secondary"
                size="icon"
                className={cn(buttonBase, status !== 'connected' && 'opacity-50')}
                aria-label={
                  status === 'connected'
                    ? t('terminal.toolbar.configureOsc7')
                    : t('terminal.toolbar.availableAfterConnect')
                }
                disabled={status !== 'connected'}
                onClick={onConfigureOsc7}
              >
                <FolderSync size={12} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {status === 'connected'
                ? t('terminal.toolbar.configureOsc7')
                : t('terminal.toolbar.availableAfterConnect')}
            </TooltipContent>
          </Tooltip>
        );
      case 'terminalSettings':
        return (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="secondary"
                size="icon"
                className={buttonBase}
                aria-label={t('terminal.toolbar.terminalSettings')}
                onClick={onOpenTheme}
              >
                <Palette size={12} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('terminal.toolbar.terminalSettings')}</TooltipContent>
          </Tooltip>
        );
      case 'recording':
        if (status !== 'connected' || recordingIndicator) return null;
        return (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="secondary"
                size="icon"
                className={buttonBase}
                aria-label={t('scripts.recording.start')}
                onClick={onStartRecording}
              >
                <Circle size={12} className="text-red-500" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('scripts.recording.start')}</TooltipContent>
          </Tooltip>
        );
      case 'encoding':
        return (
          <Popover key={id}>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon"
                    className={buttonBase}
                    aria-label={t('terminal.toolbar.encoding')}
                  >
                    <Languages size={12} />
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t('terminal.toolbar.encoding')}</TooltipContent>
            </Tooltip>
            <PopoverContent className="w-40 p-1" align="end">
              {(['utf-8', 'gb18030'] as const).map((enc) => {
                const isActive = terminalEncoding === enc;
                return (
                  <PopoverClose asChild key={enc}>
                    <button
                      type="button"
                      className={cn(menuItemClass, isActive && 'font-medium')}
                      onClick={() => onSetTerminalEncoding?.(enc)}
                    >
                      <Languages size={12} className="shrink-0" />
                      <span className="flex-1 text-left truncate">
                        {t(`terminal.toolbar.encoding.${enc === 'utf-8' ? 'utf8' : enc}`)}
                      </span>
                      <Check
                        size={12}
                        className={cn('shrink-0', isActive ? 'opacity-100' : 'opacity-0')}
                      />
                    </button>
                  </PopoverClose>
                );
              })}
            </PopoverContent>
          </Popover>
        );
      default:
        return null;
    }
  };

  const renderCollapsed = (id: string): React.ReactNode => {
    switch (id as TerminalToolbarItemId) {
      case 'highlight':
        return null; // popover-heavy; only useful inline
      case 'sftp':
        return (
          <PopoverClose asChild key={id}>
            <button
              type="button"
              className={menuItemClass}
              disabled={status !== 'connected'}
              onClick={onOpenSFTP}
            >
              <FolderInput size={12} className="shrink-0" />
              <span className="flex-1 text-left truncate">
                {status === 'connected'
                  ? t('terminal.toolbar.openSftp')
                  : t('terminal.toolbar.availableAfterConnect')}
              </span>
            </button>
          </PopoverClose>
        );
      case 'ymodemSend':
        return (
          <PopoverClose asChild key={id}>
            <button
              type="button"
              className={menuItemClass}
              disabled={status !== 'connected' || !onSendYmodem}
              onClick={onSendYmodem}
            >
              <Upload size={12} className="shrink-0" />
              <span className="flex-1 text-left truncate">
                {status === 'connected'
                  ? t('terminal.toolbar.sendYmodem')
                  : t('terminal.toolbar.availableAfterConnect')}
              </span>
            </button>
          </PopoverClose>
        );
      case 'ymodemReceive':
        return (
          <PopoverClose asChild key={id}>
            <button
              type="button"
              className={menuItemClass}
              disabled={status !== 'connected' || !onReceiveYmodem}
              onClick={onReceiveYmodem}
            >
              <Download size={12} className="shrink-0" />
              <span className="flex-1 text-left truncate">
                {status === 'connected'
                  ? t('terminal.toolbar.receiveYmodem')
                  : t('terminal.toolbar.availableAfterConnect')}
              </span>
            </button>
          </PopoverClose>
        );
      case 'compose':
        return (
          <PopoverClose asChild key={id}>
            <button type="button" className={menuItemClass} onClick={onToggleComposeBar}>
              <TextCursorInput size={12} className="shrink-0" />
              <span className="flex-1 text-left truncate">{t('terminal.toolbar.composeBar')}</span>
            </button>
          </PopoverClose>
        );
      case 'search':
        return (
          <PopoverClose asChild key={id}>
            <button type="button" className={menuItemClass} onClick={onToggleSearch}>
              <Search size={12} className="shrink-0" />
              <span className="flex-1 text-left truncate">{t('terminal.toolbar.searchTerminal')}</span>
            </button>
          </PopoverClose>
        );
      case 'sessionLog':
        return (
          <PopoverClose asChild key={id}>
            <button
              type="button"
              className={menuItemClass}
              disabled={isSessionLogDisabled || !onToggleSessionLog}
              onClick={onToggleSessionLog}
            >
              <FileText size={12} className="shrink-0" />
              <span className="flex-1 text-left truncate">
                {isSessionLogging
                  ? t('terminal.toolbar.stopSessionLog')
                  : t('terminal.toolbar.startSessionLog')}
              </span>
            </button>
          </PopoverClose>
        );
      case 'scripts':
        return (
          <PopoverClose asChild key={id}>
            <button type="button" className={menuItemClass} onClick={onOpenScripts}>
              <Zap size={12} className="shrink-0" />
              <span className="flex-1 text-left truncate">{t('terminal.toolbar.scripts')}</span>
            </button>
          </PopoverClose>
        );
      case 'history':
        return (
          <PopoverClose asChild key={id}>
            <button
              type="button"
              className={menuItemClass}
              disabled={status !== 'connected'}
              onClick={onOpenHistory}
            >
              <History size={12} className="shrink-0" />
              <span className="flex-1 text-left truncate">
                {status === 'connected'
                  ? t('terminal.toolbar.history')
                  : t('terminal.toolbar.availableAfterConnect')}
              </span>
            </button>
          </PopoverClose>
        );
      case 'configureOsc7':
        return (
          <PopoverClose asChild key={id}>
            <button
              type="button"
              className={menuItemClass}
              disabled={status !== 'connected'}
              onClick={onConfigureOsc7}
            >
              <FolderSync size={12} className="shrink-0" />
              <span className="flex-1 text-left truncate">
                {status === 'connected'
                  ? t('terminal.toolbar.configureOsc7')
                  : t('terminal.toolbar.availableAfterConnect')}
              </span>
            </button>
          </PopoverClose>
        );
      case 'terminalSettings':
        return (
          <PopoverClose asChild key={id}>
            <button type="button" className={menuItemClass} onClick={onOpenTheme}>
              <Palette size={12} className="shrink-0" />
              <span className="flex-1 text-left truncate">{t('terminal.toolbar.terminalSettings')}</span>
            </button>
          </PopoverClose>
        );
      case 'recording':
        if (status !== 'connected' || recordingIndicator || !onStartRecording) return null;
        return (
          <PopoverClose asChild key={id}>
            <button type="button" className={menuItemClass} onClick={onStartRecording}>
              <Circle size={12} className="shrink-0 text-red-500" />
              <span className="flex-1 text-left truncate">{t('scripts.recording.start')}</span>
            </button>
          </PopoverClose>
        );
      case 'encoding':
        return <React.Fragment key={id}>{renderEncodingSubmenu()}</React.Fragment>;
      default:
        return null;
    }
  };

  const collapsedNodes = collapsed.map(renderCollapsed).filter(Boolean);
  const hasCollapsed = collapsedNodes.length > 0;

  return (
    <TooltipProvider delayDuration={500} skipDelayDuration={100} disableHoverableContent>
      <ToolbarCustomizeContextMenu
        items={customizeItems}
        placementOf={(id) => {
          const placement = toolbarLayout.layout.placement[id] ?? 'show';
          // Highlight cannot collapse; treat stored collapse as show for display.
          if (id === 'highlight' && placement === 'collapse') return 'show';
          return placement;
        }}
        onSetPlacement={(id, placement) => toolbarLayout.setPlacement(id, placement, availableIds)}
        onMove={(id, direction) => toolbarLayout.move(id, direction, availableIds)}
        onReset={toolbarLayout.reset}
        t={t}
        className="inline-flex items-center min-h-6 min-w-6"
      >
        {shown.map(renderInline)}

        {/* ⋮ opens collapsed actions only */}
        {hasCollapsed && (
          <Popover
            open={overflowOpen}
            onOpenChange={(open) => {
              setOverflowOpen(open);
              if (!open) setEncodingSubmenuOpen(false);
            }}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button
                    variant="secondary"
                    size="icon"
                    className={buttonBase}
                    aria-label={t('terminal.toolbar.more')}
                    data-toolbar-overflow-trigger="true"
                  >
                    <MoreVertical size={14} />
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t('terminal.toolbar.more')}</TooltipContent>
            </Tooltip>
            <PopoverContent
              className="w-48 p-1"
              align="end"
              onInteractOutside={(e) => {
                // Radix treats the submenu's portalled content as
                // "outside" this popover; without this guard a click
                // in the submenu would dismiss the parent.
                const target = e.target as Element | null;
                if (target?.closest('[data-encoding-submenu="true"]')) {
                  e.preventDefault();
                }
              }}
            >
              {collapsedNodes}
            </PopoverContent>
          </Popover>
        )}
      </ToolbarCustomizeContextMenu>

      {recordingIndicator}

      {showClose && onClose && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-[color:var(--terminal-toolbar-fg)] hover:bg-transparent"
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
            >
              <X size={11} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('terminal.toolbar.closeSession')}</TooltipContent>
        </Tooltip>
      )}
    </TooltipProvider>
  );
};

export default TerminalToolbar;
