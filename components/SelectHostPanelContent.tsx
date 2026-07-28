import {
  Check,
  CheckSquare,
  ChevronRight,
  LayoutGrid,
  MinusSquare,
  Plus,
  Search,
  Square,
} from 'lucide-react';
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { cn } from '../lib/utils';
import { matchesHostSearchQuery, matchesSearchQuery } from '../lib/searchMatcher';
import { useI18n } from '../application/i18n/I18nProvider';
import {
  collectSelectableHostIdsInGroup,
  getGroupSelectionState,
  toggleIdsInSelection,
} from '../domain/selectHostSelection';
import { Host, ProxyProfile, SSHKey } from '../types';
import { ManagedSource } from '../domain/models';
import { DistroAvatar } from './DistroAvatar';
import HostDetailsPanel from './HostDetailsPanel';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { SortDropdown, SortMode } from './ui/sort-dropdown';
import { TagFilterDropdown } from './ui/tag-filter-dropdown';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './ui/tooltip';
import {
  VariableSizeVirtualList,
  type VariableSizeVirtualListHandle,
} from './ui/VariableSizeVirtualList';
import { clampListIndex, stepListIndex } from './ui/virtualListMath';

const SELECT_HOST_SECTION_HEIGHT = 28;
const SELECT_HOST_ROW_HEIGHT = 48;

export interface SelectHostPanelContentProps {
  hosts: Host[];
  customGroups?: string[];
  selectedHostIds: string[];
  multiSelect?: boolean;
  onSelect: (host: Host) => void;
  /** Preferred multi-select path for host/group toggles (selection resolves to host ids). */
  onSelectionChange?: (selectedHostIds: string[]) => void;
  onConfirm: () => void;
  onNewHost?: () => void;
  availableKeys?: SSHKey[];
  identities?: import('../domain/models').Identity[];
  proxyProfiles?: ProxyProfile[];
  managedSources?: ManagedSource[];
  onSaveHost?: (host: Host) => void;
  onCreateGroup?: (groupPath: string) => void;
  onNewHostPanelOpenChange?: (open: boolean) => void;
  className?: string;
}

type SelectHostListRow =
  | { kind: 'section'; key: string; title: string }
  | { kind: 'group'; key: string; path: string; name: string; count: number }
  | { kind: 'host'; key: string; host: Host };

type SelectHostNavigableRow = Extract<SelectHostListRow, { kind: 'group' | 'host' }>;

/** Shared host-picker body used by aside panel and dialog variants. */
export const SelectHostPanelContent: React.FC<SelectHostPanelContentProps> = ({
  hosts,
  customGroups = [],
  selectedHostIds,
  multiSelect = false,
  onSelect,
  onSelectionChange,
  onConfirm,
  onNewHost,
  availableKeys = [],
  identities = [],
  proxyProfiles = [],
  managedSources = [],
  onSaveHost,
  onCreateGroup,
  onNewHostPanelOpenChange,
  className,
}) => {
  const { t } = useI18n();
  const [searchQuery, setSearchQuery] = useState('');
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>('az');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [showNewHostPanel, setShowNewHostPanel] = useState(false);
  const [activeNavIndex, setActiveNavIndex] = useState(0);
  const listRef = useRef<VariableSizeVirtualListHandle>(null);
  const listboxId = useId();
  // Index-based IDs stay unique even when group paths only differ by chars that
  // would collide under a sanitize-to-_ mapping (e.g. "Prod East" vs "Prod_East").
  const optionDomId = useCallback((navIndex: number) => (
    `${listboxId}-opt-${navIndex}`
  ), [listboxId]);

  useEffect(() => {
    onNewHostPanelOpenChange?.(showNewHostPanel);
  }, [onNewHostPanelOpenChange, showNewHostPanel]);

  const selectableHosts = useMemo(
    () => hosts.filter((host) => host.protocol !== 'serial'),
    [hosts],
  );
  const selectedHostIdSet = useMemo(
    () => new Set(selectedHostIds),
    [selectedHostIds],
  );

  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    selectableHosts.forEach((host) => {
      host.tags?.forEach((tag) => tagSet.add(tag));
    });
    return Array.from(tagSet).sort();
  }, [selectableHosts]);

  const allGroupPaths = useMemo(() => {
    const pathSet = new Set<string>();
    selectableHosts.forEach((host) => {
      if (host.group) {
        const parts = host.group.split('/');
        for (let i = 1; i <= parts.length; i += 1) {
          pathSet.add(parts.slice(0, i).join('/'));
        }
      }
    });
    customGroups.forEach((group) => pathSet.add(group));
    return Array.from(pathSet).sort();
  }, [selectableHosts, customGroups]);

  const groupHostCounts = useMemo(() => {
    const counts = new Map<string, number>();
    selectableHosts.forEach((host) => {
      if (!host.group) return;
      const parts = host.group.split('/');
      for (let i = 1; i <= parts.length; i += 1) {
        const path = parts.slice(0, i).join('/');
        counts.set(path, (counts.get(path) ?? 0) + 1);
      }
    });
    return counts;
  }, [selectableHosts]);

  const groupsWithCounts = useMemo(() => {
    const prefix = currentPath ? `${currentPath}/` : '';
    const groups: { path: string; name: string; count: number }[] = [];
    const seen = new Set<string>();

    allGroupPaths.forEach((path) => {
      if (currentPath === null) {
        const topLevel = path.split('/')[0];
        if (!seen.has(topLevel)) {
          seen.add(topLevel);
          groups.push({ path: topLevel, name: topLevel, count: groupHostCounts.get(topLevel) ?? 0 });
        }
      } else if (path.startsWith(prefix) && path !== currentPath) {
        const rest = path.slice(prefix.length);
        const nextLevel = rest.split('/')[0];
        const fullPath = `${prefix}${nextLevel}`;
        if (!seen.has(fullPath)) {
          seen.add(fullPath);
          groups.push({ path: fullPath, name: nextLevel, count: groupHostCounts.get(fullPath) ?? 0 });
        }
      }
    });

    return groups;
  }, [allGroupPaths, currentPath, groupHostCounts]);

  const filteredHosts = useMemo(() => {
    let result = selectableHosts;

    if (currentPath) {
      result = result.filter(
        (host) => host.group === currentPath || host.group?.startsWith(`${currentPath}/`),
      );
    }

    if (searchQuery) {
      result = result.filter(
        (host) =>
          matchesHostSearchQuery(searchQuery, host)
          || matchesSearchQuery(searchQuery, host.username, host.notes),
      );
    }

    if (selectedTags.length > 0) {
      result = result.filter(
        (host) => host.tags && selectedTags.some((tag) => host.tags.includes(tag)),
      );
    }

    result = [...result].sort((a, b) => {
      switch (sortMode) {
        case 'az':
          return a.label.localeCompare(b.label);
        case 'za':
          return b.label.localeCompare(a.label);
        case 'newest':
          return b.id.localeCompare(a.id);
        case 'oldest':
          return a.id.localeCompare(b.id);
        default:
          return 0;
      }
    });

    return result;
  }, [selectableHosts, currentPath, searchQuery, selectedTags, sortMode]);

  const breadcrumbs = useMemo(() => {
    if (!currentPath) return [];
    const parts = currentPath.split('/');
    return parts.map((part, index) => ({
      name: part,
      path: parts.slice(0, index + 1).join('/'),
    }));
  }, [currentPath]);

  const groupHostIdsByPath = useMemo(() => {
    if (!multiSelect) return new Map<string, string[]>();
    const map = new Map<string, string[]>();
    for (const group of groupsWithCounts) {
      map.set(group.path, collectSelectableHostIdsInGroup(selectableHosts, group.path));
    }
    return map;
  }, [multiSelect, groupsWithCounts, selectableHosts]);

  const listRows = useMemo<SelectHostListRow[]>(() => {
    const rows: SelectHostListRow[] = [];
    if (groupsWithCounts.length > 0) {
      rows.push({
        kind: 'section',
        key: 'section:groups',
        title: t('vault.groups.title'),
      });
      for (const group of groupsWithCounts) {
        rows.push({
          kind: 'group',
          key: `group:${group.path}`,
          path: group.path,
          name: group.name,
          count: group.count,
        });
      }
    }
    if (filteredHosts.length > 0) {
      rows.push({
        kind: 'section',
        key: 'section:hosts',
        title: t('vault.nav.hosts'),
      });
      for (const host of filteredHosts) {
        rows.push({
          kind: 'host',
          key: `host:${host.id}`,
          host,
        });
      }
    }
    return rows;
  }, [filteredHosts, groupsWithCounts, t]);

  const applySelectionChange = useCallback((nextSelectedHostIds: string[]) => {
    if (onSelectionChange) {
      onSelectionChange(nextSelectedHostIds);
      return;
    }
    // Fallback for callers that only implement per-host toggle: sync by flipping diffs.
    const prev = new Set(selectedHostIds);
    const next = new Set(nextSelectedHostIds);
    for (const host of selectableHosts) {
      const wasSelected = prev.has(host.id);
      const isSelected = next.has(host.id);
      if (wasSelected !== isSelected) onSelect(host);
    }
  }, [onSelect, onSelectionChange, selectableHosts, selectedHostIds]);

  const handleHostClick = useCallback((host: Host) => {
    if (multiSelect && onSelectionChange) {
      onSelectionChange(toggleIdsInSelection(selectedHostIds, [host.id]));
      return;
    }
    onSelect(host);
  }, [multiSelect, onSelect, onSelectionChange, selectedHostIds]);

  const handleGroupToggle = useCallback((groupPath: string) => {
    const groupHostIds = groupHostIdsByPath.get(groupPath)
      ?? collectSelectableHostIdsInGroup(selectableHosts, groupPath);
    if (groupHostIds.length === 0) return;
    applySelectionChange(toggleIdsInSelection(selectedHostIds, groupHostIds));
  }, [applySelectionChange, groupHostIdsByPath, selectableHosts, selectedHostIds]);

  // Navigable rows (groups + hosts) for listbox keyboard model under virtualization.
  const navigable = useMemo(() => {
    const entries: { key: string; listIndex: number; row: SelectHostNavigableRow }[] = [];
    listRows.forEach((row, listIndex) => {
      if (row.kind === 'group' || row.kind === 'host') {
        entries.push({ key: row.key, listIndex, row });
      }
    });
    return entries;
  }, [listRows]);

  // O(1) key → nav index for virtual row renders (avoid findIndex per visible row).
  const navigableIndexByKey = useMemo(() => {
    const map = new Map<string, number>();
    navigable.forEach((entry, index) => {
      map.set(entry.key, index);
    });
    return map;
  }, [navigable]);

  const clampedNavIndex = clampListIndex(activeNavIndex, navigable.length);
  const activeNavEntry = navigable[clampedNavIndex];
  const activeNavKey = activeNavEntry?.key ?? null;
  const activeDescendantId = activeNavEntry ? optionDomId(clampedNavIndex) : undefined;

  // Opening a group / changing filters must start at the first entry; otherwise a
  // deep prior cursor scrolls the new list partway down and hides its top rows.
  useEffect(() => {
    setActiveNavIndex(0);
  }, [currentPath, searchQuery, selectedTags, sortMode]);

  // Inventory-only shrinkage keeps the prior cursor when still in range.
  useEffect(() => {
    setActiveNavIndex((prev) => clampListIndex(prev, navigable.length));
  }, [navigable.length]);

  useEffect(() => {
    const entry = navigable[clampListIndex(activeNavIndex, navigable.length)];
    if (!entry) return;
    listRef.current?.scrollToIndex(entry.listIndex, 'auto');
  }, [activeNavIndex, navigable]);

  const handleListKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (navigable.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveNavIndex((prev) => stepListIndex(prev, navigable.length, 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveNavIndex((prev) => stepListIndex(prev, navigable.length, -1));
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      setActiveNavIndex(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      setActiveNavIndex(Math.max(0, navigable.length - 1));
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const entry = navigable[clampListIndex(activeNavIndex, navigable.length)];
      if (!entry) return;
      if (entry.row.kind === 'group') {
        if (multiSelect && event.key === ' ') {
          handleGroupToggle(entry.row.path);
          return;
        }
        setCurrentPath(entry.row.path);
        return;
      }
      if (entry.row.kind === 'host') {
        handleHostClick(entry.row.host);
      }
    }
  }, [activeNavIndex, handleGroupToggle, handleHostClick, multiSelect, navigable]);

  const renderSelectionIcon = (state: 'none' | 'partial' | 'all') => {
    if (state === 'all') return <CheckSquare size={16} className="text-primary shrink-0" />;
    if (state === 'partial') return <MinusSquare size={16} className="text-primary shrink-0" />;
    return <Square size={16} className="text-muted-foreground shrink-0" />;
  };

  const getRowHeight = useCallback((row: SelectHostListRow) => (
    row.kind === 'section' ? SELECT_HOST_SECTION_HEIGHT : SELECT_HOST_ROW_HEIGHT
  ), []);

  const renderRow = useCallback((row: SelectHostListRow) => {
    if (row.kind === 'section') {
      return (
        <div className="flex h-full items-end px-1 pb-1">
          <h4 className="text-xs font-semibold text-muted-foreground">{row.title}</h4>
        </div>
      );
    }

    const navIndex = navigableIndexByKey.get(row.key) ?? -1;
    const isActive = activeNavKey === row.key;

    if (row.kind === 'group') {
      const groupHostIds = groupHostIdsByPath.get(row.path) ?? [];
      const groupState = multiSelect
        ? getGroupSelectionState(selectedHostIdSet, groupHostIds)
        : 'none';
      const canToggleGroup = multiSelect && groupHostIds.length > 0;

      return (
        <div
          id={navIndex >= 0 ? optionDomId(navIndex) : undefined}
          role="option"
          aria-selected={multiSelect ? groupState === 'all' : false}
          data-active={isActive ? 'true' : undefined}
          className={cn(
            'flex h-full min-h-0 items-center gap-2.5 overflow-hidden px-2.5 rounded-lg transition-colors',
            isActive ? 'bg-primary/10 ring-1 ring-primary/40' : 'hover:bg-muted/70',
          )}
          onClick={() => {
            if (navIndex >= 0) setActiveNavIndex(navIndex);
            setCurrentPath(row.path);
          }}
        >
          {multiSelect ? (
            <button
              type="button"
              tabIndex={-1}
              className={cn(
                'shrink-0 rounded-sm p-0.5 -m-0.5',
                canToggleGroup
                  ? 'hover:bg-muted cursor-pointer'
                  : 'opacity-40 cursor-not-allowed',
              )}
              disabled={!canToggleGroup}
              aria-label={t('selectHost.toggleGroup', { name: row.name })}
              aria-pressed={groupState === 'all'}
              onClick={(event) => {
                event.stopPropagation();
                handleGroupToggle(row.path);
              }}
            >
              {renderSelectionIcon(groupState)}
            </button>
          ) : null}
          <div className="flex flex-1 min-w-0 items-center gap-2.5 text-left cursor-pointer">
            <div className="h-8 w-8 rounded-lg bg-primary/15 text-primary flex items-center justify-center shrink-0">
              <LayoutGrid size={15} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-medium truncate">{row.name}</div>
              <div className="text-[11px] text-muted-foreground">
                {t('vault.groups.hostsCount', { count: row.count })}
              </div>
            </div>
            <ChevronRight size={14} className="text-muted-foreground shrink-0 opacity-60" />
          </div>
        </div>
      );
    }

    const host = row.host;
    const isSelected = selectedHostIdSet.has(host.id);
    const connectionStr = `${host.username}@${host.hostname}:${host.port || 22}`;

    return (
      <div
        id={navIndex >= 0 ? optionDomId(navIndex) : undefined}
        role="option"
        aria-selected={isSelected}
        data-host-id={host.id}
        data-active={isActive ? 'true' : undefined}
        aria-label={t('selectHost.toggleHost', { name: host.label })}
        className={cn(
          'flex h-full min-h-0 cursor-pointer items-center gap-2.5 overflow-hidden rounded-lg px-2.5 transition-colors',
          isSelected ? 'bg-muted' : isActive ? 'bg-primary/10' : 'hover:bg-muted/70',
          // Keep keyboard cursor visible even when the host is already selected.
          isActive && 'ring-1 ring-primary/40',
        )}
        onClick={() => {
          if (navIndex >= 0) setActiveNavIndex(navIndex);
          handleHostClick(host);
        }}
      >
        {multiSelect ? (
          <span className="shrink-0" aria-hidden>
            {renderSelectionIcon(isSelected ? 'all' : 'none')}
          </span>
        ) : null}
        <DistroAvatar
          host={host}
          fallback={(host.os || 'L')[0].toUpperCase()}
          size="md"
        />
        <div className="flex-1 min-w-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="text-[13px] font-medium truncate">{host.label}</div>
            </TooltipTrigger>
            <TooltipContent side="top" align="start">
              <p>{host.label}</p>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="text-[11px] text-muted-foreground truncate">{connectionStr}</div>
            </TooltipTrigger>
            <TooltipContent side="top" align="start">
              <p>{connectionStr}</p>
            </TooltipContent>
          </Tooltip>
        </div>
        {!multiSelect && isSelected ? (
          <Check size={14} className="text-primary shrink-0" />
        ) : null}
      </div>
    );
  }, [
    activeNavKey,
    groupHostIdsByPath,
    handleGroupToggle,
    handleHostClick,
    multiSelect,
    navigableIndexByKey,
    optionDomId,
    selectedHostIdSet,
    t,
  ]);

  return (
    <TooltipProvider delayDuration={300}>
      <div className={cn('flex flex-col flex-1 min-h-0 min-w-0', className)}>
        <div className="px-4 py-3 flex items-center gap-2 border-b border-border/60 shrink-0">
          {(onNewHost || onSaveHost) ? (
            <Button
              variant="secondary"
              size="sm"
              className="h-8 gap-1.5"
              onClick={() => {
                if (onSaveHost) {
                  setShowNewHostPanel(true);
                } else if (onNewHost) {
                  onNewHost();
                }
              }}
            >
              <Plus size={14} />
              {t('selectHost.newHost')}
            </Button>
          ) : null}
          <div className="relative flex-1 max-w-xs">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              placeholder={t('common.searchPlaceholder')}
              className="h-8 pl-8"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </div>
          <div className="ml-auto flex items-center gap-1">
            <TagFilterDropdown
              allTags={allTags}
              selectedTags={selectedTags}
              onChange={setSelectedTags}
            />
            <SortDropdown value={sortMode} onChange={setSortMode} />
          </div>
        </div>

        <div className="flex-1 min-h-0 min-w-0 flex flex-col">
          {currentPath ? (
            <div className="flex shrink-0 items-center gap-1 px-3 pt-3 text-xs text-muted-foreground">
              <button
                type="button"
                onClick={() => setCurrentPath(null)}
                className="text-primary hover:underline"
              >
                {t('vault.hosts.allHosts')}
              </button>
              {breadcrumbs.map((crumb, index) => (
                <React.Fragment key={crumb.path}>
                  <ChevronRight size={12} className="shrink-0 opacity-50" />
                  <button
                    type="button"
                    onClick={() => setCurrentPath(crumb.path)}
                    className={cn(
                      'hover:underline',
                      index === breadcrumbs.length - 1
                        ? 'text-foreground font-medium'
                        : 'text-primary',
                    )}
                  >
                    {crumb.name}
                  </button>
                </React.Fragment>
              ))}
            </div>
          ) : null}

          {listRows.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <p>{t('selectHost.noHostsFound')}</p>
            </div>
          ) : (
            <div
              className="flex-1 min-h-0 px-3 py-2 outline-none"
              data-host-picker-virtual="select-host"
              role="listbox"
              aria-label={t('selectHost.title')}
              aria-multiselectable={multiSelect || undefined}
              aria-activedescendant={activeDescendantId}
              tabIndex={0}
              onKeyDown={handleListKeyDown}
            >
              <VariableSizeVirtualList<SelectHostListRow>
                ref={listRef}
                items={listRows}
                getItemHeight={getRowHeight}
                className="h-full"
                overscan={8}
                getItemKey={(row) => row.key}
                renderItem={renderRow}
              />
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-border/60 shrink-0">
          <Button
            className="w-full"
            disabled={selectedHostIds.length === 0}
            onClick={onConfirm}
          >
            {multiSelect
              ? t('selectHost.continueWithCount', { count: selectedHostIds.length })
              : t('selectHost.continue')}
          </Button>
        </div>

        {showNewHostPanel && onSaveHost ? (
          <HostDetailsPanel
            initialData={null}
            availableKeys={availableKeys}
            identities={identities}
            proxyProfiles={proxyProfiles}
            groups={customGroups}
            managedSources={managedSources}
            allHosts={hosts}
            onSave={(host) => {
              onSaveHost(host);
              setShowNewHostPanel(false);
            }}
            onCancel={() => setShowNewHostPanel(false)}
            onCreateGroup={onCreateGroup}
          />
        ) : null}
      </div>
    </TooltipProvider>
  );
};
