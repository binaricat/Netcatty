import {
  Check,
  ChevronRight,
  LayoutGrid,
  Plus,
  Search,
} from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { cn } from '../lib/utils';
import { matchesHostSearchQuery, matchesSearchQuery } from '../lib/searchMatcher';
import { useI18n } from '../application/i18n/I18nProvider';
import { Host, ProxyProfile, SSHKey } from '../types';
import { ManagedSource } from '../domain/models';
import { DistroAvatar } from './DistroAvatar';
import HostDetailsPanel from './HostDetailsPanel';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { ScrollArea } from './ui/scroll-area';
import { SortDropdown, SortMode } from './ui/sort-dropdown';
import { TagFilterDropdown } from './ui/tag-filter-dropdown';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './ui/tooltip';

export interface SelectHostPanelContentProps {
  hosts: Host[];
  customGroups?: string[];
  selectedHostIds: string[];
  multiSelect?: boolean;
  onSelect: (host: Host) => void;
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

/** Shared host-picker body used by aside panel and dialog variants. */
export const SelectHostPanelContent: React.FC<SelectHostPanelContentProps> = ({
  hosts,
  customGroups = [],
  selectedHostIds,
  multiSelect = false,
  onSelect,
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

        <ScrollArea className="flex-1 min-h-0 min-w-0">
          <div className="p-3 space-y-3">
            {currentPath ? (
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
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

            {groupsWithCounts.length > 0 ? (
              <div>
                <h4 className="text-xs font-semibold mb-2 text-muted-foreground">{t('vault.groups.title')}</h4>
                <div className="space-y-1">
                  {groupsWithCounts.map((group) => (
                    <div
                      key={group.path}
                      className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-muted/70 cursor-pointer transition-colors"
                      onClick={() => setCurrentPath(group.path)}
                    >
                      <div className="h-8 w-8 rounded-lg bg-primary/15 text-primary flex items-center justify-center shrink-0">
                        <LayoutGrid size={15} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-medium truncate">{group.name}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {t('vault.groups.hostsCount', { count: group.count })}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {filteredHosts.length > 0 ? (
              <div>
                <h4 className="text-xs font-semibold mb-2 text-muted-foreground">{t('vault.nav.hosts')}</h4>
                <div className="space-y-1">
                  {filteredHosts.map((host) => {
                    const isSelected = selectedHostIdSet.has(host.id);
                    const connectionStr = `${host.username}@${host.hostname}:${host.port || 22}`;

                    return (
                      <div
                        key={host.id}
                        className={cn(
                          'flex items-center gap-2.5 px-2.5 py-2 rounded-lg cursor-pointer transition-colors',
                          isSelected ? 'bg-muted' : 'hover:bg-muted/70',
                        )}
                        onClick={() => onSelect(host)}
                      >
                        <DistroAvatar
                          host={host}
                          fallback={host.os[0].toUpperCase()}
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
                        {isSelected ? <Check size={14} className="text-primary shrink-0" /> : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {groupsWithCounts.length === 0 && filteredHosts.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <p>{t('selectHost.noHostsFound')}</p>
              </div>
            ) : null}
          </div>
        </ScrollArea>

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
