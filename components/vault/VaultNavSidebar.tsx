import {
  ChevronDown,
  ChevronUp,
  EyeOff,
  RotateCcw,
  SlidersHorizontal,
} from 'lucide-react';
import React, { useCallback, useRef, useState } from 'react';

import {
  formatPluginViewBadgeAriaText,
  formatPluginViewBadgeLabel,
  isPluginViewBadgeVisible,
  type PluginViewBadgeDisplay,
} from '../../domain/pluginViewBadge';
import type {
  VaultNavDropPosition,
  VaultNavItemId,
} from '../../domain/vaultNavConfig';
import { cn } from '../../lib/utils';
import { prewarmPluginView } from '../plugins/LazyPluginHostDrawnPage';
import { PluginViewBadge } from '../plugins/PluginViewBadge';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../ui/context-menu';
import { primaryOnlyDragHandlers } from '../ui/primaryOnlyDrag';
import { RippleButton } from '../ui/ripple';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

export const VAULT_NAV_DRAG_MIME = 'application/x-netcatty-vault-nav-item';

export interface VaultNavItemDescriptor {
  id: VaultNavItemId;
  label: string;
  ariaLabel?: string;
  tooltip?: string;
  icon: React.ReactNode;
  locked: boolean;
  /** Plugin view ID for hover/focus pre-warming, when this item is a plugin page. */
  pluginViewId?: string;
  pluginName?: string;
  /** Optional live notification badge reported by a plugin view. */
  badge?: PluginViewBadgeDisplay | null;
  /** Marks the fallback focus button when a plugin page becomes unavailable. */
  isPluginFallback?: boolean;
}

export interface VaultNavSidebarListProps {
  items: VaultNavItemDescriptor[];
  activeSection: string;
  collapsed: boolean;
  isCustomized: boolean;
  canHide: (id: VaultNavItemId) => boolean;
  onSelect: (id: VaultNavItemId) => void;
  onHide: (id: VaultNavItemId) => void;
  onReorder: (
    draggedId: VaultNavItemId,
    targetId: VaultNavItemId,
    position: VaultNavDropPosition,
  ) => void;
  onMove: (id: VaultNavItemId, direction: 'up' | 'down') => void;
  onOpenCustomize: () => void;
  onReset: () => void;
  t: (key: string, params?: Record<string, unknown>) => string;
}

export const VaultNavSidebarList: React.FC<VaultNavSidebarListProps> = ({
  items,
  activeSection,
  collapsed,
  isCustomized,
  canHide,
  onSelect,
  onHide,
  onReorder,
  onMove,
  onOpenCustomize,
  onReset,
  t,
}) => {
  const draggedIdRef = useRef<VaultNavItemId | null>(null);
  const [draggedId, setDraggedId] = useState<VaultNavItemId | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    id: VaultNavItemId;
    position: VaultNavDropPosition;
  } | null>(null);

  const clearDragState = useCallback(() => {
    draggedIdRef.current = null;
    setDraggedId(null);
    setDropTarget(null);
  }, []);

  const computeDropPosition = useCallback(
    (event: React.DragEvent<HTMLElement>): VaultNavDropPosition => {
      const rect = event.currentTarget.getBoundingClientRect();
      return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    },
    [],
  );

  const isDraggingAny = draggedId !== null;

  return (
    <nav
      aria-label="Vault"
      data-section="vault-nav-list"
      className={cn(
        'min-h-0 flex-1 overflow-y-auto space-y-1',
        collapsed ? 'px-1.5' : 'px-2.5',
      )}
    >
      {items.map((item, index) => {
        const isActive = activeSection === item.id;
        const isBeingDragged = draggedId === item.id;
        const dropPosition = dropTarget?.id === item.id ? dropTarget.position : null;
        const itemCanHide = !item.locked && canHide(item.id);
        const activeBadge = isPluginViewBadgeVisible(item.badge) ? item.badge : null;
        const badgeLabel = formatPluginViewBadgeLabel(activeBadge);
        const badgeAriaText = formatPluginViewBadgeAriaText(activeBadge);
        const baseTooltip = item.tooltip ?? item.label;
        const tooltipText = activeBadge?.tooltip
          ? `${baseTooltip} · ${activeBadge.tooltip}`
          : badgeLabel
            ? `${baseTooltip} (${badgeLabel})`
            : baseTooltip;
        const baseAccessibleLabel = item.ariaLabel ?? item.label;
        const accessibleLabel = badgeAriaText
          ? `${baseAccessibleLabel} (${badgeAriaText})`
          : baseAccessibleLabel;

        return (
          <ContextMenu key={item.id}>
            <ContextMenuTrigger asChild>
              <div
                data-vault-nav-item={item.id}
                draggable
                {...primaryOnlyDragHandlers(true)}
                onDragStart={(event) => {
                  draggedIdRef.current = item.id;
                  setDraggedId(item.id);
                  event.dataTransfer.setData(VAULT_NAV_DRAG_MIME, item.id);
                  event.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(event) => {
                  const sourceId = draggedIdRef.current;
                  const hasVaultDrag =
                    sourceId !== null
                    || Array.from(event.dataTransfer.types ?? []).includes(VAULT_NAV_DRAG_MIME);
                  if (!hasVaultDrag || sourceId === item.id) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  const position = computeDropPosition(event);
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
                    || (event.dataTransfer.getData(VAULT_NAV_DRAG_MIME) as VaultNavItemId);
                  const position = computeDropPosition(event);
                  clearDragState();
                  if (sourceId && sourceId !== item.id) {
                    onReorder(sourceId, item.id, position);
                  }
                }}
                onDragEnd={clearDragState}
                className={cn(
                  'relative transition-opacity duration-150',
                  isBeingDragged && 'opacity-45',
                )}
              >
                {dropPosition && (
                  <div
                    aria-hidden="true"
                    data-vault-nav-drop-indicator={dropPosition}
                    className={cn(
                      'pointer-events-none absolute z-20 flex items-center',
                      collapsed ? 'left-1 right-1' : 'left-1.5 right-1.5',
                      dropPosition === 'before' ? '-top-[3px]' : '-bottom-[3px]',
                    )}
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
                    <span className="h-[2px] flex-1 rounded-full bg-primary" />
                  </div>
                )}

                <Tooltip>
                  <TooltipTrigger asChild>
                    <RippleButton
                      variant={isActive ? 'secondary' : 'ghost'}
                      data-plugin-vault-fallback={item.isPluginFallback ? '' : undefined}
                      aria-label={accessibleLabel}
                      aria-current={isActive ? 'page' : undefined}
                      title={item.pluginName || activeBadge ? tooltipText : undefined}
                      className={cn(
                        'w-full h-10',
                        collapsed ? 'justify-center p-0' : 'justify-start gap-3',
                        isActive
                          && 'bg-foreground/10 text-foreground hover:bg-foreground/15 border-border/40',
                      )}
                      onMouseEnter={
                        item.pluginViewId
                          ? () => prewarmPluginView(item.pluginViewId!)
                          : undefined
                      }
                      onFocus={
                        item.pluginViewId
                          ? () => prewarmPluginView(item.pluginViewId!)
                          : undefined
                      }
                      onClick={() => onSelect(item.id)}
                    >
                      <span className="relative inline-flex shrink-0 items-center justify-center">
                        {item.icon}
                        {collapsed && activeBadge && (
                          <PluginViewBadge badge={activeBadge} variant="overlay" />
                        )}
                      </span>
                      {!collapsed && <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>}
                      {!collapsed && activeBadge && (
                        <PluginViewBadge badge={activeBadge} variant="inline" />
                      )}
                    </RippleButton>
                  </TooltipTrigger>
                  {collapsed && !isDraggingAny && (
                    <TooltipContent side="right">{tooltipText}</TooltipContent>
                  )}
                </Tooltip>
              </div>
            </ContextMenuTrigger>

            <ContextMenuContent className="min-w-[12rem]">
              {!item.locked && (
                <ContextMenuItem
                  disabled={!itemCanHide}
                  onSelect={() => onHide(item.id)}
                  className="gap-2"
                >
                  <EyeOff size={14} className="shrink-0 text-muted-foreground" />
                  <span className="truncate">
                    {t('vault.nav.hideItem', { label: item.label })}
                  </span>
                </ContextMenuItem>
              )}
              <ContextMenuItem
                disabled={index === 0}
                onSelect={() => onMove(item.id, 'up')}
                className="gap-2"
              >
                <ChevronUp size={14} className="shrink-0 text-muted-foreground" />
                <span>{t('vault.nav.moveUp')}</span>
              </ContextMenuItem>
              <ContextMenuItem
                disabled={index === items.length - 1}
                onSelect={() => onMove(item.id, 'down')}
                className="gap-2"
              >
                <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
                <span>{t('vault.nav.moveDown')}</span>
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={onOpenCustomize} className="gap-2">
                <SlidersHorizontal size={14} className="shrink-0 text-muted-foreground" />
                <span>{t('vault.nav.customize')}</span>
              </ContextMenuItem>
              <ContextMenuItem
                disabled={!isCustomized}
                onSelect={onReset}
                className="gap-2"
              >
                <RotateCcw size={14} className="shrink-0 text-muted-foreground" />
                <span>{t('vault.nav.resetDefault')}</span>
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
    </nav>
  );
};
