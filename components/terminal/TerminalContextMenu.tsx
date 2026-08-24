/**
 * Terminal Context Menu
 * Right-click menu for terminal with split, copy/paste, and other actions
 */
import {
  ClipboardPaste,
  Copy,
  Download,
  Pencil,
  RefreshCcw,
  Sparkles,
  SquareArrowOutUpRight,
  SplitSquareHorizontal,
  SplitSquareVertical,
  Terminal as TerminalIcon,
  Trash2,
  Upload,
} from 'lucide-react';
import React, { useCallback, useRef, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { KeyBinding, RightClickBehavior } from '../../domain/models';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '../ui/context-menu';
import { isMiddleClickContextMenuEvent, isMouseTrackingActive } from './runtime/middleClickBehavior';
import { isHistoryPreviewContextMenuTarget } from './runtime/terminalHistoryScrollOverride';
import { collectOwnedPluginMenus, comparePluginMenus, usePluginContributions } from '../../application/state/usePluginContributions';
import { buildTerminalPluginContributionContext } from '../../application/state/pluginContributionContexts';
import { PluginContributionIcon } from '../plugins/PluginContributionIcon';

export interface TerminalContextMenuProps {
  children: React.ReactNode;
  sessionId: string;
  workspaceId?: string;
  status: 'connecting' | 'connected' | 'disconnected';
  hostId?: string;
  hostProtocol?: string;
  hasSelection?: boolean;
  hotkeyScheme?: 'disabled' | 'mac' | 'pc';
  keyBindings?: KeyBinding[];
  rightClickBehavior?: RightClickBehavior;
  isAlternateScreen?: boolean;
  /** Read the current xterm mouse-tracking mode when handling a right-click. */
  getMouseTrackingMode?: () => string | undefined;
  /** When true, show the app context menu even while a fullscreen app (tmux/vim) holds mouse tracking. */
  showContextMenuOverFullscreenApps?: boolean;
  onCopy?: () => void;
  onPaste?: () => void;
  onUploadClipboardImage?: () => void;
  onPasteSelection?: () => void;
  onSelectAll?: () => void;
  onClear?: () => void;
  onSplitHorizontal?: () => void;
  onSplitVertical?: () => void;
  onSendYmodem?: () => void;
  onReceiveYmodem?: () => void;
  isReconnectable?: boolean;
  onReconnect?: () => void;
  onClose?: () => void;
  onSelectWord?: () => void;
  onAddSelectionToAI?: () => void;
  onRename?: () => void;
  onDetach?: () => void;
}

export const shouldShowReconnectAction = ({
  isReconnectable,
  onReconnect,
}: {
  isReconnectable?: boolean;
  onReconnect?: () => void;
}): boolean => Boolean(isReconnectable && onReconnect);

export const shouldSuppressMouseTrackingContextMenu = ({
  isAlternateScreen,
  terminalMouseTrackingMode,
  showReconnectAction,
  forceMenuInAlternateScreen,
  isHistoryPreviewTarget,
}: {
  isAlternateScreen?: boolean;
  terminalMouseTrackingMode?: string;
  showReconnectAction?: boolean;
  forceMenuInAlternateScreen?: boolean;
  isHistoryPreviewTarget?: boolean;
}): boolean => Boolean(
  !isHistoryPreviewTarget
  && isMouseTrackingActive({
    mouseTracking: Boolean(isAlternateScreen),
    terminalMouseTrackingMode,
  })
  && !showReconnectAction
  && !forceMenuInAlternateScreen,
);

export const shouldShowAddSelectionToAIContextMenuAction = (
  onAddSelectionToAI?: () => void,
): boolean => Boolean(onAddSelectionToAI);

export const shouldShowUploadClipboardImageContextMenuAction = (
  onUploadClipboardImage?: () => void,
): boolean => Boolean(onUploadClipboardImage);

export const shouldRenderTerminalContextMenuContent = ({
  isAlternateScreen,
  terminalMouseTrackingMode,
  showReconnectAction,
  allowSuppressedMenuContent,
  forceMenuInAlternateScreen,
  isHistoryPreviewTarget,
}: {
  isAlternateScreen?: boolean;
  terminalMouseTrackingMode?: string;
  showReconnectAction?: boolean;
  allowSuppressedMenuContent?: boolean;
  forceMenuInAlternateScreen?: boolean;
  isHistoryPreviewTarget?: boolean;
}): boolean =>
  allowSuppressedMenuContent ||
  !shouldSuppressMouseTrackingContextMenu({
    isAlternateScreen,
    terminalMouseTrackingMode,
    showReconnectAction,
    forceMenuInAlternateScreen,
    isHistoryPreviewTarget,
  });

export const shouldAllowSuppressedTerminalContextMenuContent = ({
  event,
  isAlternateScreen,
  terminalMouseTrackingMode,
  showReconnectAction,
  forceMenuInAlternateScreen,
  isHistoryPreviewTarget,
}: {
  event: { shiftKey?: boolean; nativeEvent: MouseEvent };
  isAlternateScreen?: boolean;
  terminalMouseTrackingMode?: string;
  showReconnectAction?: boolean;
  forceMenuInAlternateScreen?: boolean;
  isHistoryPreviewTarget?: boolean;
}): boolean =>
  isMiddleClickContextMenuEvent(event.nativeEvent)
  || Boolean(isHistoryPreviewTarget)
  || Boolean(event.shiftKey && shouldSuppressMouseTrackingContextMenu({
    isAlternateScreen,
    terminalMouseTrackingMode,
    showReconnectAction,
    forceMenuInAlternateScreen,
  }));

export const shouldOpenTerminalContextMenu = ({
  event,
  rightClickBehavior = 'context-menu',
  isAlternateScreen,
  terminalMouseTrackingMode,
  showReconnectAction,
  forceMenuInAlternateScreen,
  isHistoryPreviewTarget,
}: {
  event: { shiftKey?: boolean; nativeEvent: MouseEvent };
  rightClickBehavior?: RightClickBehavior;
  isAlternateScreen?: boolean;
  terminalMouseTrackingMode?: string;
  showReconnectAction?: boolean;
  forceMenuInAlternateScreen?: boolean;
  isHistoryPreviewTarget?: boolean;
}): boolean => {
  if (isMiddleClickContextMenuEvent(event.nativeEvent)) {
    return true;
  }

  if (event.shiftKey || isHistoryPreviewTarget) {
    return true;
  }

  if (shouldSuppressMouseTrackingContextMenu({
    isAlternateScreen,
    terminalMouseTrackingMode,
    showReconnectAction,
    forceMenuInAlternateScreen,
    isHistoryPreviewTarget,
  })) {
    return false;
  }

  return rightClickBehavior === 'context-menu';
};

export const TerminalContextMenu: React.FC<TerminalContextMenuProps> = ({
  children,
  sessionId,
  workspaceId,
  status,
  hostId,
  hostProtocol,
  hasSelection = false,
  hotkeyScheme = 'mac',
  keyBindings,
  rightClickBehavior = 'context-menu',
  isAlternateScreen = false,
  getMouseTrackingMode,
  showContextMenuOverFullscreenApps = false,
  onCopy,
  onPaste,
  onUploadClipboardImage,
  onPasteSelection,
  onSelectAll,
  onClear,
  onSplitHorizontal,
  onSplitVertical,
  onSendYmodem,
  onReceiveYmodem,
  isReconnectable,
  onReconnect,
  onClose,
  onSelectWord,
  onAddSelectionToAI,
  onRename,
  onDetach,
}) => {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const terminalContext = buildTerminalPluginContributionContext({
    surface: 'terminal/context',
    sessionId,
    status,
    hostId,
    hostProtocol,
    workspaceId,
    hasSelection,
    alternateScreen: isAlternateScreen,
    reconnectable: Boolean(isReconnectable),
  });
  const pluginContributions = usePluginContributions(
    { context: terminalContext },
    { enabled: menuOpen },
  );
  const pluginMenus = collectOwnedPluginMenus(pluginContributions.snapshot.plugins)
    .filter((menu) => menu.location === 'terminal/context' && menu.visible)
    .sort(comparePluginMenus);
  const isMac = hotkeyScheme === 'mac';
  // Tracks the .workspace-pane whose context menu is currently open so we can
  // keep its `:focus-within`-driven opacity stable while focus is in the
  // menu portal (otherwise the pane dims for the menu's lifetime).
  const markedPaneRef = useRef<HTMLElement | null>(null);
  const [allowSuppressedMenuContent, setAllowSuppressedMenuContent] = useState(false);

  const handleOpenChange = useCallback((open: boolean) => {
    setMenuOpen(open);
    if (!open) {
      markedPaneRef.current?.removeAttribute('data-menu-open');
      markedPaneRef.current = null;
      setAllowSuppressedMenuContent(false);
    }
  }, []);

  // Helper to get shortcut from keyBindings and format for display
  const getShortcut = (bindingId: string): string => {
    const binding = keyBindings?.find(b => b.id === bindingId);
    if (!binding) return '';
    const key = isMac ? binding.mac : binding.pc;
    if (!key || key === 'Disabled') return '';
    // Replace " + " with space for cleaner display (e.g., "⌘ + Shift + D" → "⌘ Shift D")
    return key.replace(/\s*\+\s*/g, ' ').trim();
  };

  const copyShortcut = getShortcut('copy');
  const pasteShortcut = getShortcut('paste');
  const pasteSelectionShortcut = getShortcut('paste-selection');
  const selectAllShortcut = getShortcut('select-all');
  const splitHShortcut = getShortcut('split-horizontal');
  const splitVShortcut = getShortcut('split-vertical');
  const clearShortcut = getShortcut('clear-buffer');
  const showReconnectAction = shouldShowReconnectAction({ isReconnectable, onReconnect });

  const terminalMouseTrackingMode = getMouseTrackingMode?.();

  // Handle right-click: intercept for paste/select-word unless Shift is held
  // or rightClickBehavior is 'context-menu'. The ContextMenuTrigger stays always
  // enabled so Shift+Right-Click opens the menu on the first click.
  const handleRightClick = useCallback(
    (e: React.MouseEvent) => {
      // In alternate screen (tmux, vim, etc.), let the terminal application
      // handle right-click natively to avoid conflicting menus. Reconnect is
      // still available after disconnect, even if mouse tracking was left on.
      const currentMouseTrackingMode = getMouseTrackingMode?.();
      const isHistoryPreviewTarget = isHistoryPreviewContextMenuTarget(e.target);
      const shouldOpenMenu = shouldOpenTerminalContextMenu({
        event: e,
        rightClickBehavior,
        isAlternateScreen,
        terminalMouseTrackingMode: currentMouseTrackingMode,
        showReconnectAction,
        forceMenuInAlternateScreen: showContextMenuOverFullscreenApps,
        isHistoryPreviewTarget,
      });

      if (!shouldOpenMenu && shouldSuppressMouseTrackingContextMenu({
        isAlternateScreen,
        terminalMouseTrackingMode: currentMouseTrackingMode,
        showReconnectAction,
        forceMenuInAlternateScreen: showContextMenuOverFullscreenApps,
        isHistoryPreviewTarget,
      })) {
        e.preventDefault();
        return;
      }

      // Shift+Right-Click or context-menu mode: let Radix open the menu
      if (shouldOpenMenu) {
        const pane = (e.target as HTMLElement | null)?.closest<HTMLElement>('.workspace-pane');
        if (pane) {
          markedPaneRef.current?.removeAttribute('data-menu-open');
          pane.setAttribute('data-menu-open', '');
          markedPaneRef.current = pane;
        }
        setAllowSuppressedMenuContent(shouldAllowSuppressedTerminalContextMenuContent({
          event: e,
          isAlternateScreen,
          terminalMouseTrackingMode: currentMouseTrackingMode,
          showReconnectAction,
          forceMenuInAlternateScreen: showContextMenuOverFullscreenApps,
          isHistoryPreviewTarget,
        }));
        return;
      }

      // Paste / select-word: intercept and prevent the context menu
      e.preventDefault();
      if (rightClickBehavior === 'paste') {
        onPaste?.();
      } else if (rightClickBehavior === 'select-word') {
        onSelectWord?.();
      }
    },
    [rightClickBehavior, onPaste, onSelectWord, isAlternateScreen, getMouseTrackingMode, showReconnectAction, showContextMenuOverFullscreenApps],
  );

  // Always use ContextMenu wrapper to maintain consistent React tree structure
  // This prevents terminal from unmounting when rightClickBehavior changes
  return (
    <ContextMenu onOpenChange={handleOpenChange}>
      <ContextMenuTrigger
        asChild
        onContextMenu={handleRightClick}
      >
        {children}
      </ContextMenuTrigger>
      {shouldRenderTerminalContextMenuContent({
        isAlternateScreen,
        terminalMouseTrackingMode,
        showReconnectAction,
        allowSuppressedMenuContent,
        forceMenuInAlternateScreen: showContextMenuOverFullscreenApps,
      }) && (
        <ContextMenuContent className="w-max">
          <ContextMenuItem onClick={onCopy} disabled={!hasSelection}>
            <Copy size={14} className="mr-2" />
            {t('terminal.menu.copy')}
            <ContextMenuShortcut>{copyShortcut}</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onClick={onPaste}>
            <ClipboardPaste size={14} className="mr-2" />
            {t('terminal.menu.paste')}
            <ContextMenuShortcut>{pasteShortcut}</ContextMenuShortcut>
          </ContextMenuItem>
          {shouldShowUploadClipboardImageContextMenuAction(onUploadClipboardImage) && (
            <ContextMenuItem onClick={onUploadClipboardImage}>
              <Upload size={14} className="mr-2" />
              {t('terminal.menu.uploadClipboardImage')}
            </ContextMenuItem>
          )}
          {shouldShowAddSelectionToAIContextMenuAction(onAddSelectionToAI) && (
            <ContextMenuItem onClick={onAddSelectionToAI} disabled={!hasSelection}>
              <Sparkles size={14} className="mr-2" />
              {t('terminal.menu.addSelectionToAI')}
            </ContextMenuItem>
          )}
          {onPasteSelection && (
            <ContextMenuItem onClick={onPasteSelection} disabled={!hasSelection}>
              <ClipboardPaste size={14} className="mr-2" />
              {t('terminal.menu.pasteSelection')}
              <ContextMenuShortcut>{pasteSelectionShortcut}</ContextMenuShortcut>
            </ContextMenuItem>
          )}
          <ContextMenuItem onClick={onSelectAll}>
            <TerminalIcon size={14} className="mr-2" />
            {t('terminal.menu.selectAll')}
            <ContextMenuShortcut>{selectAllShortcut}</ContextMenuShortcut>
          </ContextMenuItem>

          {showReconnectAction && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={onReconnect}>
                <RefreshCcw size={14} className="mr-2" />
                {t('terminal.menu.reconnect')}
              </ContextMenuItem>
            </>
          )}

          {(onSendYmodem || onReceiveYmodem) && (
            <>
              <ContextMenuSeparator />
              {onSendYmodem && (
                <ContextMenuItem onClick={onSendYmodem}>
                  <Upload size={14} className="mr-2" />
                  {t('terminal.menu.sendYmodem')}
                </ContextMenuItem>
              )}
              {onReceiveYmodem && (
                <ContextMenuItem onClick={onReceiveYmodem}>
                  <Download size={14} className="mr-2" />
                  {t('terminal.menu.receiveYmodem')}
                </ContextMenuItem>
              )}
            </>
          )}

          <ContextMenuSeparator />

          <ContextMenuItem onClick={onSplitHorizontal}>
            <SplitSquareVertical size={14} className="mr-2" />
            {t('terminal.menu.splitHorizontal')}
            <ContextMenuShortcut>{splitHShortcut}</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onClick={onSplitVertical}>
            <SplitSquareHorizontal size={14} className="mr-2" />
            {t('terminal.menu.splitVertical')}
            <ContextMenuShortcut>{splitVShortcut}</ContextMenuShortcut>
          </ContextMenuItem>

          <ContextMenuSeparator />

          <ContextMenuItem onClick={onClear}>
            <Trash2 size={14} className="mr-2" />
            {t('terminal.menu.clearBuffer')}
            <ContextMenuShortcut>{clearShortcut}</ContextMenuShortcut>
          </ContextMenuItem>

          {onRename && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={onRename}>
                <Pencil size={14} className="mr-2" />
                {t('terminal.menu.rename')}
              </ContextMenuItem>
            </>
          )}

          {onDetach && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={onDetach}>
                <SquareArrowOutUpRight size={14} className="mr-2" />
                {t('terminal.menu.detach')}
              </ContextMenuItem>
            </>
          )}

          {pluginMenus.length > 0 && (
            <>
              <ContextMenuSeparator />
              {pluginMenus.map((menu) => (
                <ContextMenuItem
                  key={menu.id}
                  disabled={!menu.enabled}
                  onClick={(event) => void pluginContributions.executeCommand(event.altKey && menu.alt ? menu.alt : menu.command, undefined, {
                    ...terminalContext,
                  }).catch(() => {})}
                >
                  <PluginContributionIcon pluginId={menu.pluginId} icon={menu.icon} className="mr-2" />
                  {menu.title}
                  {menu.checked && <span className="ml-auto pl-4" aria-hidden="true">✓</span>}
                  {menu.shortcut && <ContextMenuShortcut>{menu.shortcut}</ContextMenuShortcut>}
                </ContextMenuItem>
              ))}
            </>
          )}

          {onClose && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={onClose}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 size={14} className="mr-2" />
                {t('terminal.menu.closeTerminal')}
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      )}
    </ContextMenu>
  );
};

export default TerminalContextMenu;
