import {
  Check,
  ChevronRight,
  LayoutGrid,
  Plus,
  Search,
} from "lucide-react";
import React, { useMemo, useState } from "react";
import { cn } from "../lib/utils";
import { useI18n } from "../application/i18n/I18nProvider";
import { Host, SSHKey } from "../types";
import { ManagedSource } from "../domain/models";
import { DistroAvatar } from "./DistroAvatar";
import HostDetailsPanel from "./HostDetailsPanel";
import { AsidePanel, type AsidePanelLayout } from "./ui/aside-panel";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { ScrollArea } from "./ui/scroll-area";
import { SortDropdown, SortMode } from "./ui/sort-dropdown";
import { TagFilterDropdown } from "./ui/tag-filter-dropdown";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";

interface SelectHostPanelProps {
  hosts: Host[];
  customGroups?: string[];
  selectedHostIds?: string[];
  multiSelect?: boolean;
  onSelect: (host: Host) => void;
  onBack: () => void;
  onContinue?: () => void;
  onNewHost?: () => void;
  // Props for inline host creation
  availableKeys?: SSHKey[];
  identities?: import('../domain/models').Identity[];
  managedSources?: ManagedSource[];
  onSaveHost?: (host: Host) => void;
  onCreateGroup?: (groupPath: string) => void;
  title?: string;
  subtitle?: string;
  className?: string;
  layout?: AsidePanelLayout;
}

const SelectHostPanel: React.FC<SelectHostPanelProps> = ({
  hosts,
  customGroups = [],
  selectedHostIds = [],
  multiSelect = false,
  onSelect,
  onBack,
  onContinue,
  onNewHost,
  availableKeys = [],
  identities = [],
  managedSources = [],
  onSaveHost,
  onCreateGroup,
  title,
  subtitle,
  className,
  layout = "overlay",
}) => {
  const { t } = useI18n();
  const panelTitle = title ?? t("selectHost.title");
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>("az");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [showNewHostPanel, setShowNewHostPanel] = useState(false);

  const selectableHosts = useMemo(
    () => hosts.filter((host) => host.protocol !== "serial"),
    [hosts]
  );

  // Get all unique tags from hosts
  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    selectableHosts.forEach((h) => {
      if (h.tags) {
        h.tags.forEach((tag) => tagSet.add(tag));
      }
    });
    return Array.from(tagSet).sort();
  }, [selectableHosts]);

  // Get unique group paths from both hosts and customGroups
  const allGroupPaths = useMemo(() => {
    const pathSet = new Set<string>();
    selectableHosts.forEach((h) => {
      if (h.group) {
        // Add all parent paths as well
        const parts = h.group.split("/");
        for (let i = 1; i <= parts.length; i++) {
          pathSet.add(parts.slice(0, i).join("/"));
        }
      }
    });
    customGroups.forEach((g) => pathSet.add(g));
    return Array.from(pathSet).sort();
  }, [selectableHosts, customGroups]);

  // Get groups at current level
  const groupsWithCounts = useMemo(() => {
    const prefix = currentPath ? `${currentPath}/` : "";
    const groups: { path: string; name: string; count: number }[] = [];
    const seen = new Set<string>();

    allGroupPaths.forEach((path) => {
      if (currentPath === null) {
        // Root level - get top-level groups
        const topLevel = path.split("/")[0];
        if (!seen.has(topLevel)) {
          seen.add(topLevel);
          const count = selectableHosts.filter(
            (h) =>
              h.group &&
              (h.group === topLevel || h.group.startsWith(`${topLevel}/`)),
          ).length;
          groups.push({ path: topLevel, name: topLevel, count });
        }
      } else if (path.startsWith(prefix) && path !== currentPath) {
        // Subgroups
        const rest = path.slice(prefix.length);
        const nextLevel = rest.split("/")[0];
        const fullPath = `${prefix}${nextLevel}`;
        if (!seen.has(fullPath)) {
          seen.add(fullPath);
          const count = selectableHosts.filter(
            (h) =>
              h.group &&
              (h.group === fullPath || h.group.startsWith(`${fullPath}/`)),
          ).length;
          groups.push({ path: fullPath, name: nextLevel, count });
        }
      }
    });

    return groups;
  }, [allGroupPaths, currentPath, selectableHosts]);

  // Get hosts at current level with filtering and sorting
  const filteredHosts = useMemo(() => {
    let result = selectableHosts;

    // Filter by current path
    if (currentPath) {
      result = result.filter(
        (h) =>
          h.group === currentPath || h.group?.startsWith(`${currentPath}/`),
      );
    }

    // Filter by search
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (h) =>
          h.label.toLowerCase().includes(q) ||
          h.hostname.toLowerCase().includes(q) ||
          h.username.toLowerCase().includes(q),
      );
    }

    // Filter by tags
    if (selectedTags.length > 0) {
      result = result.filter(
        (h) => h.tags && selectedTags.some((tag) => h.tags.includes(tag)),
      );
    }

    // Sort hosts
    result = [...result].sort((a, b) => {
      switch (sortMode) {
        case "az":
          return a.label.localeCompare(b.label);
        case "za":
          return b.label.localeCompare(a.label);
        case "newest":
          // Use id as proxy for creation time (UUIDs are time-sortable or fall back to label)
          return b.id.localeCompare(a.id);
        case "oldest":
          return a.id.localeCompare(b.id);
        default:
          return 0;
      }
    });

    return result;
  }, [selectableHosts, currentPath, searchQuery, selectedTags, sortMode]);

  // Build breadcrumb from current path
  const breadcrumbs = useMemo(() => {
    if (!currentPath) return [];
    const parts = currentPath.split("/");
    return parts.map((part, index) => ({
      name: part,
      path: parts.slice(0, index + 1).join("/"),
    }));
  }, [currentPath]);

  return (
    <TooltipProvider delayDuration={300}>
    <AsidePanel
      open={true}
      onClose={onBack}
      title={panelTitle}
      subtitle={subtitle}
      showBackButton={true}
      onBack={onBack}
      className={cn(
        layout === "overlay" && "z-40",
        showNewHostPanel && "overflow-visible",
        className,
      )}
      layout={layout}
    >

      {/* Toolbar */}
      <div className="px-4 py-3 flex items-center gap-2 border-b border-border/60 shrink-0">
        {(onNewHost || onSaveHost) && (
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
        )}
        <div className="relative flex-1 max-w-xs">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            placeholder={t('common.searchPlaceholder')}
            className="h-8 pl-8"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
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

      {/* Content */}
      <ScrollArea className="flex-1 min-w-0">
        <div className="p-3 space-y-3">
          {/* Breadcrumbs */}
          {currentPath && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <button
                onClick={() => setCurrentPath(null)}
                className="text-primary hover:underline"
              >
                {t("vault.hosts.allHosts")}
              </button>
              {breadcrumbs.map((crumb, index) => (
                <React.Fragment key={crumb.path}>
                  <ChevronRight size={12} className="shrink-0 opacity-50" />
                  <button
                    onClick={() => setCurrentPath(crumb.path)}
                    className={cn(
                      "hover:underline",
                      index === breadcrumbs.length - 1
                        ? "text-foreground font-medium"
                        : "text-primary",
                    )}
                  >
                    {crumb.name}
                  </button>
                </React.Fragment>
              ))}
            </div>
          )}
          {groupsWithCounts.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold mb-2 text-muted-foreground">{t("vault.groups.title")}</h4>
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
                        {t("vault.groups.hostsCount", { count: group.count })}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Hosts Section */}
          {filteredHosts.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold mb-2 text-muted-foreground">{t("vault.nav.hosts")}</h4>
              <div className="space-y-1">
                {filteredHosts.map((host) => {
                  const isSelected = selectedHostIds.includes(host.id);
                  const connectionStr = `${host.username}@${host.hostname}:${host.port || 22}`;

                  return (
                    <div
                      key={host.id}
                      className={cn(
                        "flex items-center gap-2.5 px-2.5 py-2 rounded-lg cursor-pointer transition-colors",
                        isSelected
                          ? "bg-muted"
                          : "hover:bg-muted/70",
                      )}
                      onClick={() => onSelect(host)}
                    >
                      <DistroAvatar
                        host={host}
                        fallback={host.os[0].toUpperCase()}
                        className="h-8 w-8 rounded-md"
                      />
                      <div className="flex-1 min-w-0">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="text-[13px] font-medium truncate">
                              {host.label}
                            </div>
                          </TooltipTrigger>
                          <TooltipContent side="top" align="start">
                            <p>{host.label}</p>
                          </TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="text-[11px] text-muted-foreground truncate">
                              {connectionStr}
                            </div>
                          </TooltipTrigger>
                          <TooltipContent side="top" align="start">
                            <p>{connectionStr}</p>
                          </TooltipContent>
                        </Tooltip>
                      </div>
                      {isSelected && (
                        <Check size={14} className="text-primary shrink-0" />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Empty state */}
          {groupsWithCounts.length === 0 && filteredHosts.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">
              <p>{t("selectHost.noHostsFound")}</p>
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-border/60 shrink-0">
        <Button
          className="w-full"
          disabled={selectedHostIds.length === 0}
          onClick={() => {
            if (onContinue) {
              onContinue();
            } else {
              const host = selectableHosts.find((h) => selectedHostIds.includes(h.id));
              if (host) {
                onSelect(host);
              }
            }
          }}
        >
          {multiSelect
            ? t('selectHost.continueWithCount', { count: selectedHostIds.length })
            : t('selectHost.continue')}
        </Button>
      </div>

      {/* New Host Panel Overlay */}
      {showNewHostPanel && onSaveHost && (
        <HostDetailsPanel
          initialData={null}
          availableKeys={availableKeys}
          identities={identities}
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
      )}
    </AsidePanel>
    </TooltipProvider>
  );
};

export default SelectHostPanel;
