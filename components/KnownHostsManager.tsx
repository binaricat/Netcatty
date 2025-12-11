import {
  ArrowRight,
  ChevronDown,
  Clock,
  FolderOpen,
  Import,
  Key,
  LayoutGrid,
  List as ListIcon,
  RefreshCw,
  Search,
  Server,
  Shield,
  Trash2,
} from "lucide-react";
import React, {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from "react";
import { cn } from "../lib/utils";
import { Host, KnownHost } from "../types";
import { Button } from "./ui/button";
import { Dropdown, DropdownContent, DropdownTrigger } from "./ui/dropdown";
import { Input } from "./ui/input";
import { ScrollArea } from "./ui/scroll-area";
import { SortDropdown, SortMode } from "./ui/sort-dropdown";

interface KnownHostsManagerProps {
  knownHosts: KnownHost[];
  hosts: Host[];
  onSave: (knownHost: KnownHost) => void;
  onUpdate: (knownHost: KnownHost) => void;
  onDelete: (id: string) => void;
  onConvertToHost: (knownHost: KnownHost) => void;
  onImportFromFile: (hosts: KnownHost[]) => void;
  onRefresh: () => void;
}

type ViewMode = "grid" | "list";

// Helper functions outside component for stable references
const formatDateFn = (timestamp: number) => {
  return new Date(timestamp).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
};

const getKeyTypeColorFn = (keyType: string) => {
  switch (keyType.toLowerCase()) {
    case "ssh-ed25519":
      return "text-emerald-500";
    case "ssh-rsa":
      return "text-amber-500";
    case "ecdsa-sha2-nistp256":
    case "ecdsa-sha2-nistp384":
    case "ecdsa-sha2-nistp521":
      return "text-blue-500";
    default:
      return "text-muted-foreground";
  }
};

// Parse known_hosts file content - pure function, moved outside component
const parseKnownHostsFile = (content: string): KnownHost[] => {
  const lines = content
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("#"));
  const parsed: KnownHost[] = [];

  for (const line of lines) {
    try {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;

      const [hostPattern, keyType, publicKey] = parts;

      let hostname = hostPattern;
      let port = 22;

      const bracketMatch = hostPattern.match(/^\[([^\]]+)\]:(\d+)$/);
      if (bracketMatch) {
        hostname = bracketMatch[1];
        port = parseInt(bracketMatch[2], 10);
      } else if (hostPattern.includes(",")) {
        hostname = hostPattern.split(",")[0];
      }

      if (hostname.startsWith("|1|")) {
        hostname = "(hashed)";
      }

      parsed.push({
        id: `kh-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        hostname,
        port,
        keyType,
        publicKey: publicKey.slice(0, 64) + "...",
        discoveredAt: Date.now(),
      });
    } catch (_e) {
      console.warn("Failed to parse known_hosts line:", line);
    }
  }

  return parsed;
};

// Memoized Grid Item Component
interface HostItemProps {
  knownHost: KnownHost;
  converted: boolean;
  viewMode: ViewMode;
  onDelete: (id: string) => void;
  onConvertToHost: (knownHost: KnownHost) => void;
}

const HostItem = React.memo<HostItemProps>(
  ({ knownHost, converted, viewMode, onDelete, onConvertToHost }) => {
    // Disabled to reduce log noise - uncomment for debugging
    // console.log('[HostItem] render:', knownHost.hostname);
    if (viewMode === "grid") {
      return (
        <div
          className={cn(
            "group cursor-pointer soft-card elevate rounded-xl h-[68px] px-3 py-2",
            converted && "opacity-60",
          )}
        >
          {/* Quick action buttons on hover */}
          <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            {!converted && (
              <button
                className="p-1 rounded hover:bg-primary/20 text-primary"
                onClick={(e) => {
                  e.stopPropagation();
                  onConvertToHost(knownHost);
                }}
                title="Convert to host"
              >
                <ArrowRight size={12} />
              </button>
            )}
            <button
              className="p-1 rounded hover:bg-destructive/20 text-destructive"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(knownHost.id);
              }}
              title="Remove"
            >
              <Trash2 size={12} />
            </button>
          </div>
          <div className="flex items-center gap-3 h-full">
            <div className="h-11 w-11 rounded-xl bg-primary/10 text-primary flex items-center justify-center flex-shrink-0">
              <Server size={18} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold truncate">
                  {knownHost.hostname}
                </span>
                {knownHost.port !== 22 && (
                  <span className="text-xs text-muted-foreground">
                    :{knownHost.port}
                  </span>
                )}
              </div>
              <div className="text-[11px] text-muted-foreground truncate">
                <span className={cn(getKeyTypeColorFn(knownHost.keyType))}>
                  {knownHost.keyType}
                </span>
              </div>
            </div>
          </div>
        </div>
      );
    }

    // List view
    return (
      <div
        className={cn(
          "group flex items-center gap-3 px-3 py-2 h-14 rounded-lg hover:bg-secondary/60 transition-colors cursor-pointer",
          converted && "opacity-60",
        )}
      >
        <div className="h-11 w-11 rounded-xl bg-primary/10 text-primary flex items-center justify-center flex-shrink-0">
          <Server size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold truncate">
              {knownHost.hostname}
            </span>
            {knownHost.port !== 22 && (
              <span className="text-xs text-muted-foreground">
                :{knownHost.port}
              </span>
            )}
            {converted && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-500">
                Managed
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span
              className={cn(
                "flex items-center gap-1",
                getKeyTypeColorFn(knownHost.keyType),
              )}
            >
              <Key size={10} />
              {knownHost.keyType}
            </span>
            <span className="flex items-center gap-1">
              <Clock size={10} />
              {formatDateFn(knownHost.discoveredAt)}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {!converted && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={(e) => {
                e.stopPropagation();
                onConvertToHost(knownHost);
              }}
              title="Convert to managed host"
            >
              <ArrowRight size={14} />
            </Button>
          )}
        </div>
      </div>
    );
  },
);

HostItem.displayName = "HostItem";

const KnownHostsManager: React.FC<KnownHostsManagerProps> = ({
  knownHosts,
  hosts,
  onSave: _onSave,
  onUpdate: _onUpdate,
  onDelete,
  onConvertToHost,
  onImportFromFile,
  onRefresh,
}) => {
  // Debug: track renders
  const renderCountRef = React.useRef(0);
  renderCountRef.current++;
  console.log(
    `[KnownHostsManager] render #${renderCountRef.current} - knownHosts: ${knownHosts.length}, hosts: ${hosts.length}`,
  );

  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [isScanning, setIsScanning] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [sortMode, setSortMode] = useState<SortMode>("newest");
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const hasScannedRef = React.useRef(false);
  const RENDER_LIMIT = 100; // Limit rendered items for performance

  // Auto-scan on first mount
  useEffect(() => {
    if (!hasScannedRef.current) {
      hasScannedRef.current = true;
      // Delay scan slightly to not block initial render
      const timer = setTimeout(() => {
        handleScanSystem();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [handleScanSystem]);

  // Sort and filter hosts
  const filteredHosts = useMemo(() => {
    let result = knownHosts;

    // Filter by search
    if (deferredSearch.trim()) {
      const term = deferredSearch.toLowerCase();
      result = result.filter(
        (h) =>
          h.hostname.toLowerCase().includes(term) ||
          h.keyType.toLowerCase().includes(term),
      );
    }

    // Sort
    result = [...result].sort((a, b) => {
      switch (sortMode) {
        case "az":
          return a.hostname.localeCompare(b.hostname);
        case "za":
          return b.hostname.localeCompare(a.hostname);
        case "newest":
          return b.discoveredAt - a.discoveredAt;
        case "oldest":
          return a.discoveredAt - b.discoveredAt;
        default:
          return 0;
      }
    });

    return result;
  }, [knownHosts, deferredSearch, sortMode]);

  // Limit rendered items for performance
  const displayedHosts = useMemo(() => {
    return filteredHosts.slice(0, RENDER_LIMIT);
  }, [filteredHosts]);

  const hasMore = filteredHosts.length > RENDER_LIMIT;

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (event) => {
        const content = event.target?.result as string;
        const parsed = parseKnownHostsFile(content);

        // Filter out already existing hosts and directly import
        const existingHostnames = new Set(
          knownHosts.map((h) => `${h.hostname}:${h.port}`),
        );
        const newHosts = parsed.filter(
          (h) => !existingHostnames.has(`${h.hostname}:${h.port}`),
        );

        if (newHosts.length > 0) {
          onImportFromFile(newHosts);
        }
      };
      reader.readAsText(file);

      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    },
    [knownHosts, onImportFromFile],
  );

  const handleScanSystem = useCallback(async () => {
    setIsScanning(true);
    // Try to read from common known_hosts locations via Electron
    if (window.nebula?.readKnownHosts) {
      try {
        const content = await window.nebula.readKnownHosts();
        if (content) {
          const parsed = parseKnownHostsFile(content);
          const existingHostnames = new Set(
            knownHosts.map((h) => `${h.hostname}:${h.port}`),
          );
          const newHosts = parsed.filter(
            (h) => !existingHostnames.has(`${h.hostname}:${h.port}`),
          );

          // Directly import new hosts without dialog
          if (newHosts.length > 0) {
            onImportFromFile(newHosts);
          }
        }
      } catch (err) {
        console.error("Failed to scan system known_hosts:", err);
      }
    }
    onRefresh();
    setIsScanning(false);
  }, [knownHosts, onRefresh, onImportFromFile]);

  // Memoize host lookup for performance
  const hostIdSet = useMemo(() => new Set(hosts.map((h) => h.id)), [hosts]);

  // Pre-compute converted status for all known hosts
  const convertedMap = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const kh of knownHosts) {
      if (kh.convertedToHostId) {
        map.set(kh.id, hostIdSet.has(kh.convertedToHostId));
      } else {
        map.set(kh.id, false);
      }
    }
    return map;
  }, [knownHosts, hostIdSet]);

  // Memoized handlers to prevent re-renders
  const handleDelete = useCallback(
    (id: string) => {
      onDelete(id);
    },
    [onDelete],
  );

  const handleConvertToHost = useCallback(
    (knownHost: KnownHost) => {
      onConvertToHost(knownHost);
    },
    [onConvertToHost],
  );

  const openFilePicker = useCallback(() => fileInputRef.current?.click(), []);

  // Memoize the rendered list to prevent re-renders
  const renderedItems = useMemo(() => {
    console.log(
      "[KnownHostsManager] renderedItems useMemo recalculated - displayedHosts:",
      displayedHosts.length,
    );
    return displayedHosts.map((knownHost) => (
      <HostItem
        key={knownHost.id}
        knownHost={knownHost}
        converted={convertedMap.get(knownHost.id) || false}
        viewMode={viewMode}
        onDelete={handleDelete}
        onConvertToHost={handleConvertToHost}
      />
    ));
  }, [
    displayedHosts,
    convertedMap,
    viewMode,
    handleDelete,
    handleConvertToHost,
  ]);

  console.log("[KnownHostsManager] about to return JSX");

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border/50 bg-secondary/50">
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <div className="relative flex-1 max-w-xs">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              placeholder="Search known hosts..."
              className="pl-9 h-9 bg-background border-border/60 text-sm"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
        <div className="flex items-center gap-1">
          {/* View Mode Toggle */}
          <Dropdown>
            <DropdownTrigger asChild>
              <Button variant="ghost" size="icon" className="h-9 w-9">
                {viewMode === "grid" ? (
                  <LayoutGrid size={16} />
                ) : (
                  <ListIcon size={16} />
                )}
                <ChevronDown size={10} className="ml-0.5" />
              </Button>
            </DropdownTrigger>
            <DropdownContent className="w-32" align="end">
              <Button
                variant={viewMode === "grid" ? "secondary" : "ghost"}
                className="w-full justify-start gap-2 h-9"
                onClick={() => setViewMode("grid")}
              >
                <LayoutGrid size={14} /> Grid
              </Button>
              <Button
                variant={viewMode === "list" ? "secondary" : "ghost"}
                className="w-full justify-start gap-2 h-9"
                onClick={() => setViewMode("list")}
              >
                <ListIcon size={14} /> List
              </Button>
            </DropdownContent>
          </Dropdown>

          {/* Sort Toggle */}
          <SortDropdown
            value={sortMode}
            onChange={setSortMode}
            className="h-9 w-9"
          />
        </div>
        <div className="w-px h-5 bg-border/50" />
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-9 px-3 text-xs"
            onClick={handleScanSystem}
            disabled={isScanning}
          >
            <RefreshCw
              size={14}
              className={cn("mr-2", isScanning && "animate-spin")}
            />
            Scan System
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".txt,known_hosts"
            className="hidden"
            onChange={handleFileSelect}
          />
          <Button
            variant="secondary"
            size="sm"
            className="h-9 px-3 text-xs"
            onClick={openFilePicker}
          >
            <Import size={14} className="mr-2" />
            Import File
          </Button>
        </div>
      </div>

      {/* Content */}
      <ScrollArea className="flex-1">
        <div
          className={cn(
            "p-4",
            viewMode === "grid"
              ? "grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3"
              : "flex flex-col gap-0",
          )}
        >
          {displayedHosts.length === 0 ? (
            <div
              className={cn(
                "flex flex-col items-center justify-center py-16 text-muted-foreground",
                viewMode === "grid" && "col-span-full",
              )}
            >
              <div className="h-16 w-16 rounded-2xl bg-secondary/80 flex items-center justify-center mb-4">
                <Shield size={32} className="opacity-60" />
              </div>
              <h3 className="text-lg font-semibold text-foreground mb-2">
                No Known Hosts
              </h3>
              <p className="text-sm text-center max-w-sm mb-4">
                Known hosts are SSH servers you've connected to before. Import
                from your system's known_hosts file to get started.
              </p>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  onClick={handleScanSystem}
                  disabled={isScanning}
                >
                  <RefreshCw
                    size={14}
                    className={cn("mr-2", isScanning && "animate-spin")}
                  />
                  Scan System
                </Button>
                <Button variant="outline" onClick={openFilePicker}>
                  <FolderOpen size={14} className="mr-2" />
                  Browse File
                </Button>
              </div>
            </div>
          ) : (
            <>
              {renderedItems}
              {hasMore && (
                <div
                  className={cn(
                    "text-center py-4 text-sm text-muted-foreground",
                    viewMode === "grid" && "col-span-full",
                  )}
                >
                  Showing {RENDER_LIMIT} of {filteredHosts.length} hosts. Use
                  search to find specific hosts.
                </div>
              )}
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
};

// Custom comparison - only compare data props, not callbacks
const knownHostsManagerAreEqual = (
  prev: KnownHostsManagerProps,
  next: KnownHostsManagerProps,
): boolean => {
  return prev.knownHosts === next.knownHosts && prev.hosts === next.hosts;
};

export default memo(KnownHostsManager, knownHostsManagerAreEqual);
