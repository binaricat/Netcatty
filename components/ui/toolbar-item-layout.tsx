import {
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  LayoutList,
  MoreHorizontal,
  MoreVertical,
  PanelTop,
} from 'lucide-react';
import React, { createContext, useCallback, useContext, useState } from 'react';

import type { ToolbarItemPlacement } from '../../domain/toolbarItemLayout';
import { cn } from '../../lib/utils';
import { Button } from './button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from './context-menu';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';

const ToolbarOverflowCloseContext = createContext<(() => void) | null>(null);

/** Close the parent ⋮ overflow menu after a leaf action (no-op outside overflow). */
export function useToolbarOverflowClose(): () => void {
  return useContext(ToolbarOverflowCloseContext) ?? (() => {});
}

export type ToolbarCustomizeItem = {
  id: string;
  label: string;
  /** Icon shown before the item label in the customize menu. */
  icon?: React.ReactNode;
  /** When true, hide option is disabled (locked items). */
  locked?: boolean;
  /** When false, collapse is not offered (item is show/hide only). Default true. */
  supportsCollapse?: boolean;
};

export type ToolbarCustomizeContextMenuProps = {
  items: ToolbarCustomizeItem[];
  placementOf: (id: string) => ToolbarItemPlacement;
  onSetPlacement: (id: string, placement: ToolbarItemPlacement) => unknown;
  onMove?: (id: string, direction: 'earlier' | 'later') => void;
  onReset: () => void;
  t: (key: string, params?: Record<string, unknown>) => string;
  children: React.ReactNode;
  /** Optional className for the trigger wrapper. */
  className?: string;
  /** Optional inline style for the trigger wrapper (chrome theming). */
  style?: React.CSSProperties;
  /** Optional data-section marker for custom CSS / tests. */
  dataSection?: string;
  /** When false, right-click is disabled (e.g. compact mode). Default true. */
  enabled?: boolean;
};

const PLACEMENT_LABEL_KEYS: Record<ToolbarItemPlacement, string> = {
  show: 'toolbar.layout.show',
  collapse: 'toolbar.layout.collapse',
  hide: 'toolbar.layout.hide',
};

const PLACEMENT_ICONS: Record<ToolbarItemPlacement, React.ReactNode> = {
  show: <Eye size={12} className="shrink-0 text-muted-foreground" />,
  collapse: <LayoutList size={12} className="shrink-0 text-muted-foreground" />,
  hide: <EyeOff size={12} className="shrink-0 text-muted-foreground" />,
};

/**
 * Right-click the toolbar region to configure each action as show / collapse / hide.
 * Optional move earlier/later reorders the full item list.
 */
export const ToolbarCustomizeContextMenu: React.FC<ToolbarCustomizeContextMenuProps> = ({
  items,
  placementOf,
  onSetPlacement,
  onMove,
  onReset,
  t,
  children,
  className,
  style,
  dataSection,
  enabled = true,
}) => {
  if (!enabled || items.length === 0) {
    return (
      <div className={className} style={style} data-section={dataSection}>
        {children}
      </div>
    );
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={className}
          style={style}
          data-section={dataSection}
          data-toolbar-customize-root="true"
        >
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-[12rem]">
        <ContextMenuLabel className="flex items-center gap-2">
          <PanelTop size={14} className="shrink-0 text-muted-foreground" />
          {t('toolbar.layout.customize')}
        </ContextMenuLabel>
        <ContextMenuSeparator />
        {items.map((item, index) => {
          const placement = placementOf(item.id);
          return (
            <ContextMenuSub key={item.id}>
              <ContextMenuSubTrigger className="gap-2">
                {item.icon ? (
                  <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-muted-foreground [&>svg]:h-3.5 [&>svg]:w-3.5">
                    {item.icon}
                  </span>
                ) : null}
                <span className="flex-1 truncate">{item.label}</span>
                <span className="flex items-center gap-1 text-[10px] text-muted-foreground shrink-0">
                  {PLACEMENT_ICONS[placement]}
                  {t(PLACEMENT_LABEL_KEYS[placement])}
                </span>
              </ContextMenuSubTrigger>
              <ContextMenuSubContent className="min-w-[10rem]">
                <ContextMenuRadioGroup
                  value={
                    item.supportsCollapse === false && placement === 'collapse' ? 'show' : placement
                  }
                  onValueChange={(value) => {
                    if (value === 'show' || value === 'collapse' || value === 'hide') {
                      if (value === 'collapse' && item.supportsCollapse === false) return;
                      onSetPlacement(item.id, value);
                    }
                  }}
                >
                  <ContextMenuRadioItem value="show" className="gap-2">
                    <Eye size={12} className="shrink-0" />
                    {t('toolbar.layout.show')}
                  </ContextMenuRadioItem>
                  {item.supportsCollapse !== false && (
                    <ContextMenuRadioItem value="collapse" className="gap-2">
                      <LayoutList size={12} className="shrink-0" />
                      {t('toolbar.layout.collapse')}
                    </ContextMenuRadioItem>
                  )}
                  <ContextMenuRadioItem value="hide" disabled={item.locked} className="gap-2">
                    <EyeOff size={12} className="shrink-0" />
                    {t('toolbar.layout.hide')}
                  </ContextMenuRadioItem>
                </ContextMenuRadioGroup>
                {onMove && (
                  <>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      disabled={index === 0}
                      onSelect={(e) => {
                        e.preventDefault();
                        onMove(item.id, 'earlier');
                      }}
                    >
                      <ChevronUp size={14} className="mr-2" />
                      {t('toolbar.layout.moveEarlier')}
                    </ContextMenuItem>
                    <ContextMenuItem
                      disabled={index === items.length - 1}
                      onSelect={(e) => {
                        e.preventDefault();
                        onMove(item.id, 'later');
                      }}
                    >
                      <ChevronDown size={14} className="mr-2" />
                      {t('toolbar.layout.moveLater')}
                    </ContextMenuItem>
                  </>
                )}
              </ContextMenuSubContent>
            </ContextMenuSub>
          );
        })}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onReset()}>{t('toolbar.layout.reset')}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
};

export type ToolbarOverflowMenuProps = {
  /** When empty, the ⋮ trigger is not rendered. */
  hasItems: boolean;
  label: string;
  children: React.ReactNode;
  /** Icon orientation; terminal uses vertical, sftp horizontal. */
  orientation?: 'horizontal' | 'vertical';
  buttonClassName?: string;
  contentClassName?: string;
  align?: 'start' | 'center' | 'end';
};

/**
 * ⋮ button that opens the collapsed-item region. Hidden when nothing is collapsed.
 * Uses controlled Popover so leaf actions can close via useToolbarOverflowClose().
 * Nested portaled menus (encoding, bookmark list) use data-toolbar-nested-menu
 * to stay open while the nested panel is used.
 */
export const ToolbarOverflowMenu: React.FC<ToolbarOverflowMenuProps> = ({
  hasItems,
  label,
  children,
  orientation = 'horizontal',
  buttonClassName,
  contentClassName,
  align = 'end',
}) => {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  if (!hasItems) return null;
  const Icon = orientation === 'vertical' ? MoreVertical : MoreHorizontal;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={buttonClassName}
              aria-label={label}
              data-toolbar-overflow-trigger="true"
            >
              <Icon size={14} />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
      <PopoverContent
        align={align}
        className={cn('p-1 w-auto', contentClassName)}
        data-toolbar-overflow-menu="true"
        onInteractOutside={(e) => {
          const target = e.target as Element | null;
          if (target?.closest('[data-toolbar-nested-menu="true"]')) {
            e.preventDefault();
          }
        }}
        onClick={(e) => {
          // Leaf clicks close; nested openers keep the menu for the child panel.
          const target = e.target as Element | null;
          if (!target) return;
          if (target.closest('[data-toolbar-overflow-keep-open="true"]')) return;
          if (target.closest('[data-toolbar-nested-menu="true"]')) return;
          if (target.closest('button, [role="menuitem"], a')) {
            // Defer so the leaf onClick still runs first.
            requestAnimationFrame(() => setOpen(false));
          }
        }}
      >
        <ToolbarOverflowCloseContext.Provider value={close}>
          {children}
        </ToolbarOverflowCloseContext.Provider>
      </PopoverContent>
    </Popover>
  );
};
