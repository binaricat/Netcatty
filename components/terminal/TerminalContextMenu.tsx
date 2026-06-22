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
import { isMiddleClickContextMenuEvent } from './runtime/middleClickBehavior';

export interface TerminalContextMenuProps {
  children: React.ReactNode;
  hasSelection?: boolean;
  hotkeyScheme?: 'disabled' | 'mac' | 'pc';
  keyBindings?: KeyBinding[];
  rightClickBehavior?: RightClickBehavior;
  isAlternateScreen?: boolean;
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
  showReconnectAction,
}: {
  isAlternateScreen?: boolean;
  showReconnectAction?: boolean;
}): boolean => Boolean(isAlternateScreen && !showReconnectAction);

export const shouldShowAddSelectionToAIContextMenuAction = (
  onAddSelectionToAI?: () => void,
): boolean => Boolean(onAddSelectionToAI);

export const shouldShowUploadClipboardImageContextMenuAction = (
  onUploadClipboardImage?: () => void,
): boolean => Boolean(onUploadClipboardImage);

export const shouldRenderTerminalContextMenuContent = ({
  isAlternateScreen,
  showReconnectAction,
  allowSuppressedMenuContent,
}: {
  isAlternateScreen?: boolean;
  showReconnectAction?: boolean;
  allowSuppressedMenuContent?: boolean;
}): boolean =>
  allowSuppressedMenuContent ||
  !shouldSuppressMouseTrackingContextMenu({ isAlternateScreen, showReconnectAction });

export const shouldOpenTerminalContextMenu = ({
  event,
  rightClickBehavior = 'context-menu',
  isAlternateScreen,
  showReconnectAction,
}: {
  event: { shiftKey?: boolean; nativeEvent: MouseEvent };
  rightClickBehavior?: RightClickBehavior;
  isAlternateScreen?: boolean;
  showReconnectAction?: boolean;
}): boolean => {
  if (isMiddleClickContextMenuEvent(event.nativeEvent)) {
    return true;
  }

  if (shouldSuppressMouseTrackingContextMenu({ isAlternateScreen, showReconnectAction })) {
    return false;
  }

  return Boolean(event.shiftKey || rightClickBehavior === 'context-menu');
};

export const TerminalContextMenu: React.FC<TerminalContextMenuProps> = ({
  children,
  hasSelection = false,
  hotkeyScheme = 'mac',
  keyBindings,
  rightClickBehavior = 'context-menu',
  isAlternateScreen = false,
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
  const isMac = hotkeyScheme === 'mac';
  // Tracks the .workspace-pane whose context menu is currently open so we can
  // keep its `:focus-within`-driven opacity stable while focus is in the
  // menu portal (otherwise the pane dims for the menu's lifetime).
  const markedPaneRef = useRef<HTMLElement | null>(null);
  const [allowSuppressedMenuContent, setAllowSuppressedMenuContent] = useState(false);

  const handleOpenChange = useCallback((open: boolean) => {
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

  // Handle right-click: intercept for paste/select-word unless Shift is held
  // or rightClickBehavior is 'context-menu'. The ContextMenuTrigger stays always
  // enabled so Shift+Right-Click opens the menu on the first click.
  const handleRightClick = useCallback(
    (e: React.MouseEvent) => {
      // In alternate screen (tmux, vim, etc.), let the terminal application
      // handle right-click natively to avoid conflicting menus. Reconnect is
      // still available after disconnect, even if mouse tracking was left on.
      const shouldOpenMenu = shouldOpenTerminalContextMenu({
        event: e,
        rightClickBehavior,
        isAlternateScreen,
        showReconnectAction,
      });
      const isMiddleClickMenu = isMiddleClickContextMenuEvent(e.nativeEvent);

      if (!shouldOpenMenu && shouldSuppressMouseTrackingContextMenu({ isAlternateScreen, showReconnectAction })) {
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
        setAllowSuppressedMenuContent(isMiddleClickMenu);
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
    [rightClickBehavior, onPaste, onSelectWord, isAlternateScreen, showReconnectAction],
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
        showReconnectAction,
        allowSuppressedMenuContent,
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

          <ContextMenuItem onClick={onSplitVertical}>
            <SplitSquareHorizontal size={14} className="mr-2" />
            {t('terminal.menu.splitHorizontal')}
            <ContextMenuShortcut>{splitVShortcut}</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onClick={onSplitHorizontal}>
            <SplitSquareVertical size={14} className="mr-2" />
            {t('terminal.menu.splitVertical')}
            <ContextMenuShortcut>{splitHShortcut}</ContextMenuShortcut>
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
