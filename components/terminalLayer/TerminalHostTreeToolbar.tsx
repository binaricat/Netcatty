import {
  Check,
  Expand,
  FolderPlus,
  Minimize2,
  Plus,
  Search,
  Tag,
  Terminal,
  X,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef } from 'react';

import { useI18n } from '../../application/i18n/I18nProvider';
import { useToolbarItemLayout } from '../../application/state/useToolbarItemLayout';
import type { ToolbarItemLayoutDefaults } from '../../domain/toolbarItemLayout';
import { STORAGE_KEY_TERMINAL_HOST_TREE_TOOLBAR_LAYOUT } from '../../infrastructure/config/storageKeys';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import {
  ToolbarCustomizeContextMenu,
  ToolbarOverflowMenu,
} from '../ui/toolbar-item-layout';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

export type HostTreeToolbarPanel = 'search' | 'tags' | null;

export const HOST_TREE_TOOLBAR_ITEM_IDS = [
  'newHost',
  'search',
  'tags',
  'localShell',
  'newGroup',
  'expandAll',
  'collapseAll',
] as const;

export type HostTreeToolbarItemId = (typeof HOST_TREE_TOOLBAR_ITEM_IDS)[number];

/**
 * Defaults match the previous fixed layout after #2625:
 * primary new host / search / tags / local shell; group + expand/collapse in ⋮.
 */
export const HOST_TREE_TOOLBAR_LAYOUT_DEFAULTS: ToolbarItemLayoutDefaults = {
  order: [...HOST_TREE_TOOLBAR_ITEM_IDS],
  placement: {
    newHost: 'show',
    search: 'show',
    tags: 'show',
    localShell: 'show',
    newGroup: 'collapse',
    expandAll: 'collapse',
    collapseAll: 'collapse',
  },
};

type ToolbarTheme = {
  termBg: string;
  termFg: string;
  mutedFg: string;
  separator: string;
  rowHoverBg: string;
};

interface TerminalHostTreeToolbarProps {
  theme: ToolbarTheme;
  expandedPanel: HostTreeToolbarPanel;
  onExpandedPanelChange: (panel: HostTreeToolbarPanel) => void;
  search: string;
  onSearchChange: (value: string) => void;
  allTags: string[];
  selectedTags: string[];
  onSelectedTagsChange: (tags: string[]) => void;
  onNewHost: () => void;
  canNewHost?: boolean;
  onNewRootGroup: () => void;
  canNewGroup?: boolean;
  onCreateLocalTerminal: () => void;
  canCreateLocalTerminal?: boolean;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  canExpandCollapse?: boolean;
  onCollapse: () => void;
}

const iconButtonClass =
  'netcatty-tab h-6 w-6 shrink-0 rounded-md p-0 shadow-none border-none hover:bg-transparent';
/** Local shell uses the borderless Terminal glyph (not TerminalSquare). */
const localShellButtonClass =
  'netcatty-tab h-6 w-6 shrink-0 rounded-none p-0 shadow-none border-none bg-transparent hover:bg-transparent';
const overflowMenuItemClass =
  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50';

/**
 * Primary defaults (new host, search, tags, local shell, more) + close must fit
 * the sidebar min width. Users can hide/collapse items via right-click customize.
 */
export const TERMINAL_HOST_TREE_TOOLBAR_MIN_REQUIRED_WIDTH = 176;

export const TerminalHostTreeToolbar: React.FC<TerminalHostTreeToolbarProps> = ({
  theme,
  expandedPanel,
  onExpandedPanelChange,
  search,
  onSearchChange,
  allTags,
  selectedTags,
  onSelectedTagsChange,
  onNewHost,
  canNewHost = true,
  onNewRootGroup,
  canNewGroup = true,
  onCreateLocalTerminal,
  canCreateLocalTerminal = true,
  onExpandAll,
  onCollapseAll,
  canExpandCollapse = true,
  onCollapse,
}) => {
  const { t } = useI18n();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const toolbarLayout = useToolbarItemLayout(
    STORAGE_KEY_TERMINAL_HOST_TREE_TOOLBAR_LAYOUT,
    HOST_TREE_TOOLBAR_LAYOUT_DEFAULTS,
  );

  const togglePanel = (panel: Exclude<HostTreeToolbarPanel, null>) => {
    onExpandedPanelChange(expandedPanel === panel ? null : panel);
  };

  const hasTagFilters = selectedTags.length > 0;
  const hasSearch = search.trim().length > 0;

  useEffect(() => {
    if (expandedPanel !== 'search') return;
    const frame = requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [expandedPanel]);

  const toggleTag = (tag: string) => {
    if (selectedTags.includes(tag)) {
      onSelectedTagsChange(selectedTags.filter((item) => item !== tag));
    } else {
      onSelectedTagsChange([...selectedTags, tag]);
    }
  };

  const availableIds = useMemo(() => [...HOST_TREE_TOOLBAR_ITEM_IDS], []);

  const itemLabels = useMemo(
    (): Record<HostTreeToolbarItemId, string> => ({
      newHost: t('terminal.layer.hostTree.newHost'),
      search: t('terminal.layer.hostTree.searchButton'),
      tags: t('terminal.layer.hostTree.tagsButton'),
      localShell: t('terminal.layer.hostTree.localShell'),
      newGroup: t('terminal.layer.hostTree.newGroup'),
      expandAll: t('vault.tree.expandAll'),
      collapseAll: t('vault.tree.collapseAll'),
    }),
    [t],
  );

  const itemIcons = useMemo(
    (): Record<HostTreeToolbarItemId, React.ReactNode> => ({
      newHost: <Plus size={14} />,
      search: <Search size={14} />,
      tags: <Tag size={14} />,
      localShell: <Terminal size={14} />,
      newGroup: <FolderPlus size={14} />,
      expandAll: <Expand size={14} />,
      collapseAll: <Minimize2 size={14} />,
    }),
    [],
  );

  const customizeItems = useMemo(
    () =>
      toolbarLayout.layout.order
        .filter((id): id is HostTreeToolbarItemId =>
          (availableIds as string[]).includes(id),
        )
        .map((id) => ({
          id,
          label: itemLabels[id],
          icon: itemIcons[id],
        })),
    [availableIds, itemIcons, itemLabels, toolbarLayout.layout.order],
  );

  const setPlacement = useCallback(
    (id: string, placement: 'show' | 'collapse' | 'hide') => {
      toolbarLayout.setPlacement(id, placement, availableIds);
    },
    [availableIds, toolbarLayout],
  );

  const moveItem = useCallback(
    (id: string, direction: 'earlier' | 'later') => {
      toolbarLayout.move(id, direction, availableIds);
    },
    [availableIds, toolbarLayout],
  );

  const { shown, collapsed } = toolbarLayout.partition(availableIds);

  const renderInline = (id: string): React.ReactNode => {
    switch (id as HostTreeToolbarItemId) {
      case 'newHost':
        return (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={iconButtonClass}
                style={{ color: theme.mutedFg }}
                disabled={!canNewHost}
                onClick={onNewHost}
                aria-label={itemLabels.newHost}
              >
                <Plus size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{itemLabels.newHost}</TooltipContent>
          </Tooltip>
        );
      case 'search':
        return (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={iconButtonClass}
                style={{
                  color: expandedPanel === 'search' || hasSearch ? theme.termFg : theme.mutedFg,
                }}
                onClick={() => togglePanel('search')}
                aria-label={itemLabels.search}
              >
                <Search size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{itemLabels.search}</TooltipContent>
          </Tooltip>
        );
      case 'tags':
        return (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={iconButtonClass}
                style={{
                  color: expandedPanel === 'tags' || hasTagFilters ? theme.termFg : theme.mutedFg,
                }}
                onClick={() => togglePanel('tags')}
                aria-label={itemLabels.tags}
              >
                <Tag size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{itemLabels.tags}</TooltipContent>
          </Tooltip>
        );
      case 'localShell':
        return (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={localShellButtonClass}
                style={{ color: theme.mutedFg }}
                disabled={!canCreateLocalTerminal}
                onClick={() => onCreateLocalTerminal()}
                aria-label={itemLabels.localShell}
                data-section="terminal-host-tree-local-shell"
              >
                <Terminal size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{itemLabels.localShell}</TooltipContent>
          </Tooltip>
        );
      case 'newGroup':
        return (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={iconButtonClass}
                style={{ color: theme.mutedFg }}
                disabled={!canNewGroup}
                onClick={onNewRootGroup}
                aria-label={itemLabels.newGroup}
              >
                <FolderPlus size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{itemLabels.newGroup}</TooltipContent>
          </Tooltip>
        );
      case 'expandAll':
        return (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={iconButtonClass}
                style={{ color: theme.mutedFg }}
                disabled={!canExpandCollapse}
                onClick={onExpandAll}
                aria-label={itemLabels.expandAll}
              >
                <Expand size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{itemLabels.expandAll}</TooltipContent>
          </Tooltip>
        );
      case 'collapseAll':
        return (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={iconButtonClass}
                style={{ color: theme.mutedFg }}
                disabled={!canExpandCollapse}
                onClick={onCollapseAll}
                aria-label={itemLabels.collapseAll}
              >
                <Minimize2 size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{itemLabels.collapseAll}</TooltipContent>
          </Tooltip>
        );
      default:
        return null;
    }
  };

  const renderCollapsed = (id: string): React.ReactNode => {
    switch (id as HostTreeToolbarItemId) {
      case 'newHost':
        return (
          <button
            key={id}
            type="button"
            className={overflowMenuItemClass}
            disabled={!canNewHost}
            onClick={onNewHost}
          >
            <Plus size={14} />
            {itemLabels.newHost}
          </button>
        );
      case 'search':
        return (
          <button
            key={id}
            type="button"
            className={overflowMenuItemClass}
            onClick={() => togglePanel('search')}
          >
            <Search size={14} />
            {itemLabels.search}
          </button>
        );
      case 'tags':
        return (
          <button
            key={id}
            type="button"
            className={overflowMenuItemClass}
            onClick={() => togglePanel('tags')}
          >
            <Tag size={14} />
            {itemLabels.tags}
          </button>
        );
      case 'localShell':
        return (
          <button
            key={id}
            type="button"
            className={overflowMenuItemClass}
            disabled={!canCreateLocalTerminal}
            onClick={() => onCreateLocalTerminal()}
          >
            <Terminal size={14} />
            {itemLabels.localShell}
          </button>
        );
      case 'newGroup':
        return (
          <button
            key={id}
            type="button"
            className={overflowMenuItemClass}
            disabled={!canNewGroup}
            onClick={onNewRootGroup}
          >
            <FolderPlus size={14} />
            {itemLabels.newGroup}
          </button>
        );
      case 'expandAll':
        return (
          <button
            key={id}
            type="button"
            className={overflowMenuItemClass}
            disabled={!canExpandCollapse}
            onClick={onExpandAll}
          >
            <Expand size={14} />
            {itemLabels.expandAll}
          </button>
        );
      case 'collapseAll':
        return (
          <button
            key={id}
            type="button"
            className={overflowMenuItemClass}
            disabled={!canExpandCollapse}
            onClick={onCollapseAll}
          >
            <Minimize2 size={14} />
            {itemLabels.collapseAll}
          </button>
        );
      default:
        return null;
    }
  };

  const overflowNodes = collapsed.map(renderCollapsed).filter(Boolean);

  return (
    <div className="flex-shrink-0">
      <div
        className="flex h-9 shrink-0 min-w-0 items-center gap-0.5 px-1.5 py-1"
        style={{
          backgroundColor: theme.termBg,
          borderBottom: `1px solid ${theme.separator}`,
        }}
        data-section="terminal-host-tree-toolbar"
      >
        <ToolbarCustomizeContextMenu
          items={customizeItems}
          placementOf={(id) => toolbarLayout.layout.placement[id] ?? 'show'}
          onSetPlacement={setPlacement}
          onMove={moveItem}
          onReset={toolbarLayout.reset}
          t={t}
          className="relative flex min-w-0 flex-1 items-center overflow-hidden"
          dataSection="terminal-host-tree-toolbar-actions"
        >
          <div className="flex items-center gap-1" style={{ color: theme.mutedFg }}>
            {shown.map(renderInline)}
            <ToolbarOverflowMenu
              hasItems={overflowNodes.length > 0}
              label={t('terminal.toolbar.more')}
              orientation="horizontal"
              buttonClassName={iconButtonClass}
              contentClassName="w-44"
              align="start"
            >
              <div className="flex flex-col">{overflowNodes}</div>
            </ToolbarOverflowMenu>
          </div>
        </ToolbarCustomizeContextMenu>

        <div
          className="flex shrink-0 items-center"
          data-section="terminal-host-tree-toolbar-close"
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={cn(iconButtonClass, 'mr-0.5')}
                style={{ color: theme.mutedFg }}
                onClick={onCollapse}
                aria-label={t('terminal.layer.hostTree.collapse')}
              >
                <X size={15} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('terminal.layer.hostTree.collapse')}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div
        className={cn(
          'overflow-hidden transition-[max-height,opacity] duration-200 ease-out',
          expandedPanel === 'search' ? 'max-h-9 opacity-100' : 'max-h-0 opacity-0',
        )}
        style={{
          backgroundColor: theme.termBg,
          borderBottom: expandedPanel === 'search' ? `1px solid ${theme.separator}` : undefined,
        }}
      >
        <div className="h-9 flex items-center gap-0.5 px-1.5" style={{ backgroundColor: theme.termBg }}>
          <div className="relative flex-1 min-w-0">
            <Search
              size={12}
              className="absolute left-1 top-1/2 -translate-y-1/2 pointer-events-none"
              style={{ color: theme.mutedFg }}
            />
            <Input
              ref={searchInputRef}
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder={t('terminal.layer.hostTree.search')}
              className="h-7 pl-6 pr-1 text-xs bg-transparent border-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
              style={{ color: theme.termFg }}
            />
          </div>
          {hasSearch && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={iconButtonClass}
                  style={{ color: theme.mutedFg }}
                  onClick={() => {
                    onSearchChange('');
                    searchInputRef.current?.focus();
                  }}
                  aria-label={t('common.clear')}
                >
                  <X size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t('common.clear')}</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      <div
        className={cn(
          'overflow-hidden transition-[max-height,opacity] duration-200 ease-out',
          expandedPanel === 'tags' ? 'max-h-40 opacity-100' : 'max-h-0 opacity-0',
        )}
        style={{
          backgroundColor: theme.termBg,
          borderBottom: expandedPanel === 'tags' ? `1px solid ${theme.separator}` : undefined,
        }}
      >
        <div
          className="max-h-40 overflow-y-auto overflow-x-hidden py-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
          style={{ backgroundColor: theme.termBg }}
        >
          {allTags.length === 0 ? (
            <div className="px-3 py-3 text-center text-xs" style={{ color: theme.mutedFg }}>
              {t('terminal.layer.hostTree.tagsEmpty')}
            </div>
          ) : (
            <>
              {hasTagFilters && (
                <button
                  type="button"
                  className="w-full px-3 py-1.5 text-left text-xs"
                  style={{ color: theme.mutedFg }}
                  onClick={() => onSelectedTagsChange([])}
                >
                  {t('terminal.layer.hostTree.clearTags')}
                </button>
              )}
              {allTags.map((tag) => {
                const isSelected = selectedTags.includes(tag);
                return (
                  <button
                    key={tag}
                    type="button"
                    className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-xs"
                    style={{ color: theme.termFg }}
                    onMouseEnter={(event) => {
                      event.currentTarget.style.backgroundColor = theme.rowHoverBg;
                    }}
                    onMouseLeave={(event) => {
                      event.currentTarget.style.backgroundColor = '';
                    }}
                    onClick={() => toggleTag(tag)}
                  >
                    <span
                      className={cn(
                        'h-2.5 w-2.5 shrink-0 rounded-full border',
                        isSelected ? 'bg-current border-current' : 'border-current opacity-50',
                      )}
                      style={{ color: theme.termFg }}
                    />
                    <span className="min-w-0 flex-1 truncate">{tag}</span>
                    {isSelected && <Check size={12} className="shrink-0" />}
                  </button>
                );
              })}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
