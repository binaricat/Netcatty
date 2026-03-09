/**
 * Terminal Context Menu
 * Right-click menu for terminal with split, copy/paste, and other actions
 */
import {
  ClipboardPaste,
  Copy,
  SplitSquareHorizontal,
  SplitSquareVertical,
  Terminal as TerminalIcon,
  Trash2,
} from 'lucide-react';
import React, { useCallback } from 'react';
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
  onSelectAll?: () => void;
  onClear?: () => void;
  onSplitHorizontal?: () => void;
  onSplitVertical?: () => void;
  onClose?: () => void;
  onSelectWord?: () => void;
}

export const TerminalContextMenu: React.FC<TerminalContextMenuProps> = ({
  children,
  hasSelection = false,
  hotkeyScheme = 'mac',
  keyBindings,
  rightClickBehavior = 'context-menu',
  isAlternateScreen = false,
  onCopy,
  onPaste,
  onSelectAll,
  onClear,
  onSplitHorizontal,
  onSplitVertical,
  onClose,
  onSelectWord,
}) => {
  const { t } = useI18n();
  const isMac = hotkeyScheme === 'mac';

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
  const selectAllShortcut = getShortcut('select-all');
  const splitHShortcut = getShortcut('split-horizontal');
  const splitVShortcut = getShortcut('split-vertical');
  const clearShortcut = getShortcut('clear-buffer');

  const showContextMenu = rightClickBehavior === 'context-menu' && !isAlternateScreen;

  const handleRightClick = useCallback(
    (e: React.MouseEvent) => {
      // In alternate screen (tmux, vim, etc.), let the terminal application
      // handle right-click natively to avoid conflicting menus
      if (isAlternateScreen) return;

      if (rightClickBehavior === 'paste') {
        e.preventDefault();
        e.stopPropagation();
        onPaste?.();
      } else if (rightClickBehavior === 'select-word') {
        e.preventDefault();
        e.stopPropagation();
        onSelectWord?.();
      }
    },
    [rightClickBehavior, onPaste, onSelectWord, isAlternateScreen],
  );

  // Always use ContextMenu wrapper to maintain consistent React tree structure
  // This prevents terminal from unmounting when rightClickBehavior changes
  return (
    <ContextMenu>
      <ContextMenuTrigger
        asChild
        disabled={!showContextMenu}
        onContextMenu={!showContextMenu ? handleRightClick : undefined}
      >
        {children}
      </ContextMenuTrigger>
      {showContextMenu && (
        <ContextMenuContent className="w-56">
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
          <ContextMenuItem onClick={onSelectAll}>
            <TerminalIcon size={14} className="mr-2" />
            {t('terminal.menu.selectAll')}
            <ContextMenuShortcut>{selectAllShortcut}</ContextMenuShortcut>
          </ContextMenuItem>

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
