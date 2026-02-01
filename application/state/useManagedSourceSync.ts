import { useCallback, useEffect, useRef } from "react";
import { Host, ManagedSource } from "../../domain/models";
import {
  serializeHostsToSshConfig,
  mergeWithExistingSshConfig,
} from "../../domain/sshConfigSerializer";
import { netcattyBridge } from "../../infrastructure/services/netcattyBridge";

const MANAGED_BLOCK_BEGIN = "# BEGIN NETCATTY MANAGED - DO NOT EDIT THIS BLOCK";
const MANAGED_BLOCK_END = "# END NETCATTY MANAGED";

export interface UseManagedSourceSyncOptions {
  hosts: Host[];
  managedSources: ManagedSource[];
  onUpdateManagedSources: (sources: ManagedSource[]) => void;
}

export const useManagedSourceSync = ({
  hosts,
  managedSources,
  onUpdateManagedSources,
}: UseManagedSourceSyncOptions) => {
  const previousHostsRef = useRef<Host[]>([]);
  const syncInProgressRef = useRef(false);
  // Keep a ref to the latest managedSources to avoid stale closure issues
  const managedSourcesRef = useRef(managedSources);
  managedSourcesRef.current = managedSources;

  const getManagedHostsForSource = useCallback(
    (sourceId: string) => {
      return hosts.filter((h) => h.managedSourceId === sourceId);
    },
    [hosts],
  );

  const readExistingFileContent = useCallback(
    async (filePath: string): Promise<string | null> => {
      const bridge = netcattyBridge.get();
      if (!bridge?.readLocalFile) {
        return null;
      }
      try {
        const buffer = await bridge.readLocalFile(filePath);
        const decoder = new TextDecoder();
        return decoder.decode(buffer);
      } catch {
        // File might not exist yet
        return null;
      }
    },
    [],
  );

  const mergeWithExistingContent = useCallback(
    (
      existingContent: string | null,
      managedHosts: Host[],
      allHosts: Host[],
    ): string => {
      // Serialize the managed hosts
      const managedContent = serializeHostsToSshConfig(managedHosts, allHosts);

      if (!existingContent) {
        // No existing file, just wrap the managed content
        return `${MANAGED_BLOCK_BEGIN}\n${managedContent}${MANAGED_BLOCK_END}\n`;
      }

      const beginIndex = existingContent.indexOf(MANAGED_BLOCK_BEGIN);
      const endIndex = existingContent.indexOf(MANAGED_BLOCK_END);

      if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) {
        // No existing managed block - need to remove duplicate Host entries
        // Build a set of hostnames/aliases that will be managed
        const managedHostnameSet = new Set<string>();
        for (const host of managedHosts) {
          if (!host.protocol || host.protocol === "ssh") {
            // Add both hostname and sanitized label (alias) for matching
            managedHostnameSet.add(host.hostname.toLowerCase());
            if (host.label) {
              managedHostnameSet.add(host.label.replace(/\s/g, "").toLowerCase());
            }
          }
        }

        // Use mergeWithExistingSshConfig to filter out existing Host blocks
        // that match our managed hosts, keeping preserved content outside markers
        const mergedContent = mergeWithExistingSshConfig(
          existingContent,
          managedHosts,
          managedHostnameSet,
          allHosts,
        );
        return mergedContent;
      }

      // Replace the existing managed block
      const before = existingContent.substring(0, beginIndex);
      const after = existingContent.substring(endIndex + MANAGED_BLOCK_END.length);
      return `${before}${MANAGED_BLOCK_BEGIN}\n${managedContent}${MANAGED_BLOCK_END}${after}`;
    },
    [],
  );

  const writeSshConfigToFile = useCallback(
    async (source: ManagedSource, managedHosts: Host[]) => {
      console.log(`[ManagedSourceSync] writeSshConfigToFile called for ${source.groupName}, hosts:`, managedHosts.length);

      const bridge = netcattyBridge.get();
      if (!bridge?.writeLocalFile) {
        console.warn("[ManagedSourceSync] writeLocalFile not available");
        return false;
      }

      try {
        // Read existing file content to preserve non-managed parts
        const existingContent = await readExistingFileContent(source.filePath);

        // Merge with existing content, preserving non-managed parts and removing duplicates
        const finalContent = mergeWithExistingContent(
          existingContent,
          managedHosts,
          hosts,
        );
        console.log(`[ManagedSourceSync] Final content (${finalContent.length} chars)`);

        const encoder = new TextEncoder();
        const buffer = encoder.encode(finalContent);
        console.log(`[ManagedSourceSync] Writing to ${source.filePath}`);

        await bridge.writeLocalFile(source.filePath, buffer.buffer as ArrayBuffer);
        console.log(`[ManagedSourceSync] Write successful`);
        return true;
      } catch (err) {
        console.error("[ManagedSourceSync] Failed to write SSH config:", err);
        return false;
      }
    },
    [readExistingFileContent, mergeWithExistingContent, hosts],
  );

  const syncManagedSource = useCallback(
    async (source: ManagedSource): Promise<{ sourceId: string; success: boolean }> => {
      const managedHosts = getManagedHostsForSource(source.id);
      const success = await writeSshConfigToFile(source, managedHosts);
      return { sourceId: source.id, success };
    },
    [getManagedHostsForSource, writeSshConfigToFile],
  );

  const unmanageSource = useCallback(
    (sourceId: string) => {
      const updatedSources = managedSourcesRef.current.filter((s) => s.id !== sourceId);
      onUpdateManagedSources(updatedSources);
    },
    [onUpdateManagedSources],
  );

  // Clear the managed block in the SSH config file and then remove the source
  // This should be called before deleting a managed group to avoid stale entries
  const clearAndRemoveSource = useCallback(
    async (source: ManagedSource) => {
      console.log(`[ManagedSourceSync] Clearing managed block for ${source.groupName}`);
      // Write empty hosts list to clear the managed block
      const success = await writeSshConfigToFile(source, []);
      if (success) {
        console.log(`[ManagedSourceSync] Managed block cleared, removing source`);
      }
      // Remove the source regardless of write success
      const updatedSources = managedSourcesRef.current.filter((s) => s.id !== source.id);
      onUpdateManagedSources(updatedSources);
      return success;
    },
    [onUpdateManagedSources, writeSshConfigToFile],
  );

  // Clear and remove multiple sources atomically to avoid race conditions
  // when multiple sources are removed concurrently
  const clearAndRemoveSources = useCallback(
    async (sources: ManagedSource[]) => {
      if (sources.length === 0) return;

      console.log(`[ManagedSourceSync] Clearing ${sources.length} managed blocks`);

      // Clear all files in parallel
      const results = await Promise.all(
        sources.map(async (source) => {
          const success = await writeSshConfigToFile(source, []);
          return { sourceId: source.id, success };
        })
      );

      const successCount = results.filter(r => r.success).length;
      console.log(`[ManagedSourceSync] Cleared ${successCount}/${sources.length} managed blocks`);

      // Remove all sources atomically in a single update
      const sourceIdsToRemove = new Set(sources.map(s => s.id));
      const updatedSources = managedSourcesRef.current.filter(
        (s) => !sourceIdsToRemove.has(s.id)
      );
      onUpdateManagedSources(updatedSources);
    },
    [onUpdateManagedSources, writeSshConfigToFile],
  );

  const pendingSyncRef = useRef(false);
  const checkAndSyncRef = useRef<() => void>(() => {});

  const checkAndSync = useCallback(() => {
    if (managedSources.length === 0) {
      // Still update previousHostsRef so we have a baseline when sources are added
      previousHostsRef.current = hosts;
      return;
    }

    const prevHosts = previousHostsRef.current;
    previousHostsRef.current = hosts;

    // On initial sync (prevHosts empty), sync all sources that have managed hosts
    const isInitialSync = prevHosts.length === 0;

    const changedSourceIds = new Set<string>();

    if (isInitialSync) {
      // Initial sync: sync all sources that have hosts
      for (const source of managedSources) {
        const currManaged = hosts.filter((h) => h.managedSourceId === source.id);
        if (currManaged.length > 0) {
          changedSourceIds.add(source.id);
        }
      }
    } else {
      // Build maps for all hosts (for jump host lookup)
      const prevHostMap = new Map<string, Host>(prevHosts.map((h) => [h.id, h]));
      const currHostMap = new Map<string, Host>(hosts.map((h) => [h.id, h]));

      // Index hosts by managedSourceId to avoid O(N*M) lookups
      const prevHostsBySource = new Map<string, Host[]>();
      for (const h of prevHosts) {
        if (h.managedSourceId) {
          let list = prevHostsBySource.get(h.managedSourceId);
          if (!list) {
            list = [];
            prevHostsBySource.set(h.managedSourceId, list);
          }
          list.push(h);
        }
      }

      const currHostsBySource = new Map<string, Host[]>();
      for (const h of hosts) {
        if (h.managedSourceId) {
          let list = currHostsBySource.get(h.managedSourceId);
          if (!list) {
            list = [];
            currHostsBySource.set(h.managedSourceId, list);
          }
          list.push(h);
        }
      }

      // Helper to check if a host's SSH-relevant fields changed
      const hostChanged = (prevHost: Host | undefined, currHost: Host | undefined): boolean => {
        if (!prevHost || !currHost) return prevHost !== currHost;
        return (
          prevHost.hostname !== currHost.hostname ||
          prevHost.port !== currHost.port ||
          prevHost.username !== currHost.username ||
          prevHost.label !== currHost.label
        );
      };

      for (const source of managedSources) {
        const prevManaged = prevHostsBySource.get(source.id) || [];
        const currManaged = currHostsBySource.get(source.id) || [];

        console.log(`[ManagedSourceSync] Source ${source.groupName}: prev=${prevManaged.length}, curr=${currManaged.length}`);

        if (prevManaged.length !== currManaged.length) {
          changedSourceIds.add(source.id);
          continue;
        }

        const prevManagedMap = new Map<string, Host>(prevManaged.map((h) => [h.id, h]));
        let sourceChanged = false;

        for (const curr of currManaged) {
          const prev = prevManagedMap.get(curr.id);
          if (!prev) {
            sourceChanged = true;
            break;
          }
          // Compare hostChain arrays for ProxyJump changes
          const prevChain = prev.hostChain?.hostIds || [];
          const currChain = curr.hostChain?.hostIds || [];
          const chainChanged =
            prevChain.length !== currChain.length ||
            prevChain.some((id, i) => id !== currChain[i]);

          const hasChanged =
            prev.hostname !== curr.hostname ||
            prev.port !== curr.port ||
            prev.username !== curr.username ||
            prev.label !== curr.label ||
            prev.group !== curr.group ||
            prev.protocol !== curr.protocol ||
            chainChanged;
          if (hasChanged) {
            sourceChanged = true;
            break;
          }

          // Check if any referenced jump hosts changed (even if outside this managed source)
          for (const jumpHostId of currChain) {
            const prevJumpHost = prevHostMap.get(jumpHostId);
            const currJumpHost = currHostMap.get(jumpHostId);
            if (hostChanged(prevJumpHost, currJumpHost)) {
              sourceChanged = true;
              break;
            }
          }
          if (sourceChanged) break;
        }

        if (sourceChanged) {
          changedSourceIds.add(source.id);
        }
      }
    }

    if (changedSourceIds.size > 0) {
      console.log(`[ManagedSourceSync] Syncing sources:`, Array.from(changedSourceIds));
      syncInProgressRef.current = true;

      Promise.all(
        managedSources
          .filter((s) => changedSourceIds.has(s.id))
          .map(syncManagedSource),
      ).then((results) => {
        // Batch update lastSyncedAt for all successful syncs to avoid race conditions
        const successfulSourceIds = new Set(
          results.filter(r => r.success).map(r => r.sourceId)
        );

        if (successfulSourceIds.size > 0) {
          const currentSources = managedSourcesRef.current;
          const now = Date.now();
          const updatedSources = currentSources.map((s) =>
            successfulSourceIds.has(s.id) ? { ...s, lastSyncedAt: now } : s,
          );
          onUpdateManagedSources(updatedSources);
        }
      }).finally(() => {
        syncInProgressRef.current = false;
        // Check if there were changes during sync that need to be processed
        // Use ref to get the latest checkAndSync to avoid stale closure
        if (pendingSyncRef.current) {
          pendingSyncRef.current = false;
          checkAndSyncRef.current();
        }
      });
    }
  }, [hosts, managedSources, syncManagedSource, onUpdateManagedSources]);

  // Keep ref updated with the latest checkAndSync
  checkAndSyncRef.current = checkAndSync;

  useEffect(() => {
    if (syncInProgressRef.current) {
      // Mark that we need to re-sync after current sync completes
      pendingSyncRef.current = true;
      return;
    }
    checkAndSync();
  }, [hosts, managedSources, checkAndSync]);

  return {
    syncManagedSource,
    unmanageSource,
    clearAndRemoveSource,
    clearAndRemoveSources,
    getManagedHostsForSource,
  };
};
