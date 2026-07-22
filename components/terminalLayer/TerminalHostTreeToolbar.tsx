import { Check, Expand, FolderPlus, Minimize2, MoreHorizontal, Plus, Search, Tag, TerminalSquare, X } from 'lucide-react';
import React, { useEffect, useRef } from 'react';

import { useI18n } from '../../application/i18n/I18nProvider';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

export type HostTreeToolbarPanel = 'search' | 'tags' | null;

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

const iconButtonClass = 'netcatty-tab h-6 w-6 shrink-0 rounded-md p-0 hover:bg-transparent';
const overflowMenuItemClass = 'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50';
export const TERMINAL_HOST_TREE_TOOLBAR_MIN_REQUIRED_WIDTH = 148;

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
        <div
          className="relative flex min-w-0 flex-1 items-center overflow-hidden"
          data-section="terminal-host-tree-toolbar-actions"
        >
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={iconButtonClass}
                  style={{ color: theme.mutedFg }}
                  disabled={!canNewHost}
                  onClick={onNewHost}
                  aria-label={t('terminal.layer.hostTree.newHost')}
                >
                  <Plus size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t('terminal.layer.hostTree.newHost')}</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={iconButtonClass}
                  style={{ color: expandedPanel === 'search' || hasSearch ? theme.termFg : theme.mutedFg }}
                  onClick={() => togglePanel('search')}
                  aria-label={t('terminal.layer.hostTree.searchButton')}
                >
                  <Search size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t('terminal.layer.hostTree.searchButton')}</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={iconButtonClass}
                  style={{ color: expandedPanel === 'tags' || hasTagFilters ? theme.termFg : theme.mutedFg }}
                  onClick={() => togglePanel('tags')}
                  aria-label={t('terminal.layer.hostTree.tagsButton')}
                >
                  <Tag size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t('terminal.layer.hostTree.tagsButton')}</TooltipContent>
            </Tooltip>

            <Popover>
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={iconButtonClass}
                      style={{ color: theme.mutedFg }}
                      aria-label={t('terminal.toolbar.more')}
                    >
                      <MoreHorizontal size={14} />
                    </Button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t('terminal.toolbar.more')}</TooltipContent>
              </Tooltip>
              <PopoverContent className="w-44 p-1" align="start" side="bottom">
                <PopoverClose asChild>
                  <button
                    type="button"
                    className={overflowMenuItemClass}
                    disabled={!canNewGroup}
                    onClick={onNewRootGroup}
                  >
                    <FolderPlus size={14} />
                    {t('terminal.layer.hostTree.newGroup')}
                  </button>
                </PopoverClose>
                <PopoverClose asChild>
                  <button
                    type="button"
                    className={overflowMenuItemClass}
                    disabled={!canCreateLocalTerminal}
                    onClick={onCreateLocalTerminal}
                  >
                    <TerminalSquare size={14} />
                    {t('terminal.layer.hostTree.localShell')}
                  </button>
                </PopoverClose>
                <PopoverClose asChild>
                  <button
                    type="button"
                    className={overflowMenuItemClass}
                    disabled={!canExpandCollapse}
                    onClick={onExpandAll}
                  >
                    <Expand size={14} />
                    {t('vault.tree.expandAll')}
                  </button>
                </PopoverClose>
                <PopoverClose asChild>
                  <button
                    type="button"
                    className={overflowMenuItemClass}
                    disabled={!canExpandCollapse}
                    onClick={onCollapseAll}
                  >
                    <Minimize2 size={14} />
                    {t('vault.tree.collapseAll')}
                  </button>
                </PopoverClose>
              </PopoverContent>
            </Popover>
          </div>

        </div>

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
