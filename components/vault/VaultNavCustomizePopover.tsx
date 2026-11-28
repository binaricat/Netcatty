import {
  ChevronDown,
  ChevronUp,
  GripVertical,
  Pin,
  RotateCcw,
  SlidersHorizontal,
} from 'lucide-react';
import React, { useCallback, useRef, useState } from 'react';

import type {
  VaultNavDropPosition,
  VaultNavItemId,
} from '../../domain/vaultNavConfig';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { primaryOnlyDragHandlers } from '../ui/primaryOnlyDrag';
import { Switch } from '../ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

const POPOVER_DRAG_MIME = 'application/x-netcatty-vault-nav-customize-item';

export interface VaultNavCustomizeItem {
  id: VaultNavItemId;
  label: string;
  icon: React.ReactNode;
  pluginName?: string;
  visible: boolean;
  locked: boolean;
  canHide: boolean;
}

export interface VaultNavCustomizePopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  collapsed: boolean;
  items: VaultNavCustomizeItem[];
  isCustomized: boolean;
  onToggleVisible: (id: VaultNavItemId) => void;
  onReorder: (
    draggedId: VaultNavItemId,
    targetId: VaultNavItemId,
    position: VaultNavDropPosition,
  ) => void;
  onMove: (id: VaultNavItemId, direction: 'up' | 'down') => void;
  onReset: () => void;
  t: (key: string, params?: Record<string, unknown>) => string;
}

export const VaultNavCustomizePopover: React.FC<VaultNavCustomizePopoverProps> = ({
  open,
  onOpenChange,
  collapsed,
  items,
  isCustomized,
  onToggleVisible,
  onReorder,
  onMove,
  onReset,
  t,
}) => {
  const draggedIdRef = useRef<VaultNavItemId | null>(null);
  const [draggedId, setDraggedId] = useState<VaultNavItemId | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    id: VaultNavItemId;
    position: VaultNavDropPosition;
  } | null>(null);

  const clearDrag = useCallback(() => {
    draggedIdRef.current = null;
    setDraggedId(null);
    setDropTarget(null);
  }, []);

  const visibleCount = items.filter((item) => item.visible).length;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant={open ? 'secondary' : 'ghost'}
              aria-label={t('vault.nav.customize')}
              data-vault-nav-customize-trigger="true"
              className={cn(
                'w-full',
                collapsed ? 'justify-center p-0' : 'justify-start gap-3',
                open && 'bg-foreground/10 text-foreground hover:bg-foreground/15',
              )}
            >
              <span className="relative flex-shrink-0">
                <SlidersHorizontal size={16} />
                {isCustomized && (
                  <span
                    aria-hidden="true"
                    className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-primary"
                  />
                )}
              </span>
              {!collapsed && (
                <span className="truncate">{t('vault.nav.customize')}</span>
              )}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        {collapsed && !open && (
          <TooltipContent side="right">
            {t('vault.nav.customize')}
          </TooltipContent>
        )}
      </Tooltip>

      <PopoverContent
        side="right"
        align="end"
        sideOffset={8}
        className="w-72 p-0 overflow-hidden"
        data-vault-nav-customize-popover="true"
      >
        <div className="px-3 py-2.5 border-b border-border/60">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-foreground">
              {t('vault.nav.customize')}
            </span>
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {visibleCount}/{items.length}
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {t('vault.nav.customizeHint')}
          </p>
        </div>

        <div
          className="max-h-[340px] overflow-y-auto p-1.5 space-y-0.5"
          role="list"
          aria-label={t('vault.nav.customize')}
        >
          {items.map((item, index) => {
            const isBeingDragged = draggedId === item.id;
            const dropPosition = dropTarget?.id === item.id ? dropTarget.position : null;
            const disableToggle = item.locked || (item.visible && !item.canHide);
            return (
              <div
                key={item.id}
                role="listitem"
                data-vault-nav-customize-row={item.id}
                draggable
                {...primaryOnlyDragHandlers(true)}
                onDragStart={(event) => {
                  draggedIdRef.current = item.id;
                  setDraggedId(item.id);
                  event.dataTransfer.setData(POPOVER_DRAG_MIME, item.id);
                  event.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(event) => {
                  const sourceId = draggedIdRef.current;
                  if (!sourceId || sourceId === item.id) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  const rect = event.currentTarget.getBoundingClientRect();
                  const position: VaultNavDropPosition =
                    event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
                  setDropTarget((prev) =>
                    prev?.id === item.id && prev.position === position
                      ? prev
                      : { id: item.id, position },
                  );
                }}
                onDragLeave={(event) => {
                  if (
                    event.relatedTarget instanceof Node
                    && event.currentTarget.contains(event.relatedTarget)
                  ) {
                    return;
                  }
                  setDropTarget((prev) => (prev?.id === item.id ? null : prev));
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const sourceId =
                    draggedIdRef.current
                    || (event.dataTransfer.getData(POPOVER_DRAG_MIME) as VaultNavItemId);
                  const rect = event.currentTarget.getBoundingClientRect();
                  const position: VaultNavDropPosition =
                    event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
                  clearDrag();
                  if (sourceId && sourceId !== item.id) {
                    onReorder(sourceId, item.id, position);
                  }
                }}
                onDragEnd={clearDrag}
                className={cn(
                  'group relative flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors',
                  'hover:bg-accent/60',
                  isBeingDragged && 'opacity-45',
                  !item.visible && 'text-muted-foreground',
                )}
              >
                {dropPosition && (
                  <span
                    aria-hidden="true"
                    data-vault-nav-customize-drop-indicator={dropPosition}
                    className={cn(
                      'pointer-events-none absolute left-1.5 right-1.5 h-[2px] rounded-full bg-primary z-20',
                      dropPosition === 'before' ? '-top-px' : '-bottom-px',
                    )}
                  />
                )}

                <GripVertical
                  size={13}
                  className="shrink-0 text-muted-foreground/60 group-hover:text-muted-foreground cursor-grab active:cursor-grabbing"
                  aria-hidden="true"
                />

                <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
                  {item.icon}
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-medium text-foreground/90">
                      {item.label}
                    </span>
                    {item.pluginName && (
                      <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] font-medium text-muted-foreground">
                        {t('vault.nav.pluginBadge')}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                  <button
                    type="button"
                    disabled={index === 0}
                    aria-label={`${t('vault.nav.moveUp')}: ${item.label}`}
                    onClick={() => onMove(item.id, 'up')}
                    className="rounded p-0.5 text-muted-foreground hover:bg-background/80 hover:text-foreground disabled:opacity-30 disabled:pointer-events-none"
                  >
                    <ChevronUp size={12} />
                  </button>
                  <button
                    type="button"
                    disabled={index === items.length - 1}
                    aria-label={`${t('vault.nav.moveDown')}: ${item.label}`}
                    onClick={() => onMove(item.id, 'down')}
                    className="rounded p-0.5 text-muted-foreground hover:bg-background/80 hover:text-foreground disabled:opacity-30 disabled:pointer-events-none"
                  >
                    <ChevronDown size={12} />
                  </button>
                </div>

                {item.locked ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className="flex items-center gap-1 text-muted-foreground/70 pr-1"
                        aria-label={t('vault.nav.alwaysVisible')}
                      >
                        <Pin size={12} />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="left">
                      {t('vault.nav.alwaysVisible')}
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <div className="flex items-center justify-end w-8 shrink-0">
                    <Switch
                      checked={item.visible}
                      disabled={disableToggle}
                      aria-label={t('vault.nav.toggleVisibility', { label: item.label })}
                      onCheckedChange={() => onToggleVisible(item.id)}
                      className="origin-right scale-[0.7]"
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="border-t border-border/60 px-2.5 py-2 flex items-center justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!isCustomized}
            data-vault-nav-reset="true"
            onClick={onReset}
            className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
          >
            <RotateCcw size={12} />
            {t('vault.nav.resetDefault')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
};
