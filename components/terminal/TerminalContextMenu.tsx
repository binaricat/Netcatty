/**
 * Terminal Context Menu
 * Right-click menu for terminal with split, copy/paste, and other actions
 */
import { 
  Copy, 
  ClipboardPaste, 
  SplitSquareHorizontal, 
  SplitSquareVertical,
  Trash2,
  Terminal as TerminalIcon,
} from 'lucide-react';
import React from 'react';
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
  onCopy?: () => void;
  onPaste?: () => void;
  onSelectAll?: () => void;
  onClear?: () => void;
  onSplitHorizontal?: () => void;
  onSplitVertical?: () => void;
  onClose?: () => void;
}

export const TerminalContextMenu: React.FC<TerminalContextMenuProps> = ({
  children,
  hasSelection = false,
  hotkeyScheme = 'mac',
  onCopy,
  onPaste,
  onSelectAll,
  onClear,
  onSplitHorizontal,
  onSplitVertical,
  onClose,
}) => {
  const isMac = hotkeyScheme === 'mac';

  const copyShortcut = isMac ? '⌘C' : 'Ctrl+Shift+C';
  const pasteShortcut = isMac ? '⌘V' : 'Ctrl+Shift+V';
  const selectAllShortcut = isMac ? '⌘A' : 'Ctrl+Shift+A';
  const splitHShortcut = isMac ? '⌘D' : 'Ctrl+Shift+D';
  const splitVShortcut = isMac ? '⇧⌘D' : 'Ctrl+Shift+E';
  const clearShortcut = isMac ? '⌘K' : 'Ctrl+L';

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        {/* Copy/Paste Section */}
        <ContextMenuItem 
          onClick={onCopy}
          disabled={!hasSelection}
        >
          <Copy size={14} className="mr-2" />
          复制
          <ContextMenuShortcut>{copyShortcut}</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onClick={onPaste}>
          <ClipboardPaste size={14} className="mr-2" />
          粘贴
          <ContextMenuShortcut>{pasteShortcut}</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onClick={onSelectAll}>
          <TerminalIcon size={14} className="mr-2" />
          全选
          <ContextMenuShortcut>{selectAllShortcut}</ContextMenuShortcut>
        </ContextMenuItem>
        
        <ContextMenuSeparator />
        
        {/* Split Section */}
        <ContextMenuItem onClick={onSplitVertical}>
          <SplitSquareHorizontal size={14} className="mr-2" />
          水平分屏
          <ContextMenuShortcut>{splitVShortcut}</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onClick={onSplitHorizontal}>
          <SplitSquareVertical size={14} className="mr-2" />
          垂直分屏
          <ContextMenuShortcut>{splitHShortcut}</ContextMenuShortcut>
        </ContextMenuItem>
        
        <ContextMenuSeparator />
        
        {/* Clear/Close Section */}
        <ContextMenuItem onClick={onClear}>
          <Trash2 size={14} className="mr-2" />
          清除缓冲区
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
              关闭终端
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
};

export default TerminalContextMenu;
