/**
 * Terminal Context Menu
 * Right-click menu for terminal with split, copy/paste, and other actions
 */
import {
  ClipboardPaste,
  Copy,
  RefreshCcw,
  Sparkles,
  SplitSquareHorizontal,
  SplitSquareVertical,
  Terminal as TerminalIcon,
  Trash2,
  Upload,
} from 'lucide-react';
import React, { useCallback, useRef } from 'react';
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

export interface TerminalContextMenuProps {
  children: React.ReactNode;
  hasSelection?: boolean;
  hotkeyScheme?: 'disabled' | 'mac' | 'pc';
  keyBindings?: KeyBinding[];
  rightClickBehavior?: RightClickBehavior;
  isAlternateScreen?: boolean;
  onCopy?: () => void;
  onPaste?: () => void;
  onPasteSelection?: () => void;
  onSelectAll?: () => void;
  onClear?: () => void;
  onSplitHorizontal?: () => void;
  onSplitVertical?: () => void;
  onSendYmodem?: () => void;
  isReconnectable?: boolean;
  onReconnect?: () => void;
  onClose?: () => void;
  onSelectWord?: () => void;
  onAddSelectionToAI?: () => void;
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

export const TerminalContextMenu: React.FC<TerminalContextMenuProps> = ({
  children,
  hasSelection = false,
  hotkeyScheme = 'mac',
  keyBindings,
  rightClickBehavior = 'context-menu',
  isAlternateScreen = false,
  onCopy,
  onPaste,
  onPasteSelection,
  onSelectAll,
  onClear,
  onSplitHorizontal,
  onSplitVertical,
  onSendYmodem,
  isReconnectable,
  onReconnect,
  onClose,
  onSelectWord,
  onAddSelectionToAI,
}) => {
  const { t } = useI18n();
  const isMac = hotkeyScheme === 'mac';
  // Tracks the .workspace-pane whose context menu is currently open so we can
  // keep its `:focus-within`-driven opacity stable while focus is in the
  // menu portal (otherwise the pane dims for the menu's lifetime).
  const markedPaneRef = useRef<HTMLElement | null>(null);

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) {
      markedPaneRef.current?.removeAttribute('data-menu-open');
      markedPaneRef.current = null;
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
      if (shouldSuppressMouseTrackingContextMenu({ isAlternateScreen, showReconnectAction })) {
        e.preventDefault();
        return;
      }

      // Shift+Right-Click or context-menu mode: let Radix open the menu
      if (e.shiftKey || rightClickBehavior === 'context-menu') {
        const pane = (e.target as HTMLElement | null)?.closest<HTMLElement>('.workspace-pane');
        if (pane) {
          markedPaneRef.current?.removeAttribute('data-menu-open');
          pane.setAttribute('data-menu-open', '');
          markedPaneRef.current = pane;
        }
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
      {!shouldSuppressMouseTrackingContextMenu({ isAlternateScreen, showReconnectAction }) && (
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
          {onAddSelectionToAI && (
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

          {onSendYmodem && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={onSendYmodem}>
                <Upload size={14} className="mr-2" />
                {t('terminal.menu.sendYmodem')}
              </ContextMenuItem>
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
