import { useCallback, useEffect, useRef } from "react";
import { Host, ManagedSource } from "../../domain/models";
import {
  serializeHostsToSshConfig,
  mergeWithExistingSshConfig,
  toSafeSshHostAlias,
  isSafeSshHostMatchLiteral,
} from "../../domain/sshConfigSerializer";
import { netcattyBridge } from "../../infrastructure/services/netcattyBridge";
import { STORAGE_KEY_MANAGED_SOURCES } from "../../infrastructure/config/storageKeys";
import { localStorageAdapter } from "../../infrastructure/persistence/localStorageAdapter";
import { withVaultImportLock } from "./vaultManagedImportLock";

const MANAGED_BLOCK_BEGIN = "# BEGIN NETCATTY MANAGED - DO NOT EDIT THIS BLOCK";
const MANAGED_BLOCK_END = "# END NETCATTY MANAGED";

export interface UseManagedSourceSyncOptions {
  hosts: Host[];
  managedSources: ManagedSource[];
  onUpdateManagedSources: (sources: ManagedSource[]) => void;
  onReadPersistedHosts: () => Promise<Host[]>;
}

export const haveSameManagedSshAgentFields = (previous: Host, current: Host): boolean => (
  previous.useSshAgent === current.useSshAgent
  && previous.identityAgent === current.identityAgent
  && previous.identitiesOnly === current.identitiesOnly
  && previous.addKeysToAgent === current.addKeysToAgent
  && previous.useKeychain === current.useKeychain
  && (previous.identityFilePaths?.length ?? 0) === (current.identityFilePaths?.length ?? 0)
  && (previous.identityFilePaths ?? []).every(
    (path, index) => path === current.identityFilePaths?.[index],
  )
);

export const useManagedSourceSync = ({
  hosts,
  managedSources,
  onUpdateManagedSources,
  onReadPersistedHosts,
}: UseManagedSourceSyncOptions) => {
  const previousHostsRef = useRef<Host[]>([]);
  const hostsRef = useRef(hosts);
  hostsRef.current = hosts;
  const syncInProgressRef = useRef(false);
  // Keep a ref to the latest managedSources to avoid stale closure issues
  const managedSourcesRef = useRef(managedSources);
  managedSourcesRef.current = managedSources;

  const getManagedHostsForSource = useCallback(
    (sourceId: string) => {
      return hostsRef.current.filter((h) => h.managedSourceId === sourceId);
    },
    [],
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
            if (isSafeSshHostMatchLiteral(host.hostname)) {
              managedHostnameSet.add(host.hostname.toLowerCase());
            }
            if (host.label) {
              managedHostnameSet.add(toSafeSshHostAlias(host.label, host.hostname).toLowerCase());
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
    async (source: ManagedSource, managedHosts: Host[], allHosts = hostsRef.current) => {
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
          allHosts,
        );
        const encoder = new TextEncoder();
        const buffer = encoder.encode(finalContent);
        await bridge.writeLocalFile(source.filePath, buffer.buffer as ArrayBuffer);
        return true;
      } catch (err) {
        console.error("[ManagedSourceSync] Failed to write SSH config:", err);
        return false;
      }
    },
    [readExistingFileContent, mergeWithExistingContent],
  );

  const syncManagedSource = useCallback(
    async (source: ManagedSource): Promise<{ sourceId: string; success: boolean }> => {
      return withVaultImportLock("vault", async () => {
        const persistedSources = localStorageAdapter.read<ManagedSource[]>(
          STORAGE_KEY_MANAGED_SOURCES,
        ) ?? managedSourcesRef.current;
        if (!persistedSources.some((candidate) => candidate.id === source.id)) {
          return { sourceId: source.id, success: false };
        }
        const latestHosts = await onReadPersistedHosts();
        const managedHosts = latestHosts.filter((host) => host.managedSourceId === source.id);
        const success = await writeSshConfigToFile(source, managedHosts, latestHosts);
        return { sourceId: source.id, success };
      });
    },
    [onReadPersistedHosts, writeSshConfigToFile],
  );

  const unmanageSource = useCallback(
    (sourceId: string) => {
      const updatedSources = managedSourcesRef.current.filter((s) => s.id !== sourceId);
      onUpdateManagedSources(updatedSources);
    },
    [onUpdateManagedSources],
  );

  // Clear the managed block before the caller atomically removes the Vault
  // source and hosts. Keeping state unchanged here lets a failed clear abort
  // the deletion without leaving a half-removed source record.
  const clearAndRemoveSource = useCallback(
    async (source: ManagedSource) => {
      const success = await writeSshConfigToFile(source, []);
      if (!success) throw new Error("Could not clear managed SSH config source");
      return async () => {
        const latestHosts = await onReadPersistedHosts();
        const restored = await writeSshConfigToFile(
          source,
          latestHosts.filter((host) => host.managedSourceId === source.id),
          latestHosts,
        );
        if (!restored) throw new Error("Could not restore managed SSH config source");
      };
    },
    [onReadPersistedHosts, writeSshConfigToFile],
  );

  // Clear and remove multiple sources atomically to avoid race conditions
  // when multiple sources are removed concurrently
  const clearAndRemoveSources = useCallback(
    async (sources: ManagedSource[]) => {
      const clearedSources: ManagedSource[] = [];
      for (const source of sources) {
        const success = await writeSshConfigToFile(source, []);
        if (!success) {
          const latestHosts = await onReadPersistedHosts();
          const restored = await Promise.all(clearedSources.map((clearedSource) => writeSshConfigToFile(
            clearedSource,
            latestHosts.filter((host) => host.managedSourceId === clearedSource.id),
            latestHosts,
          )));
          if (restored.some((result) => !result)) {
            throw new Error("Could not clear or restore every managed SSH config source");
          }
          throw new Error("Could not clear every managed SSH config source");
        }
        clearedSources.push(source);
      }
      return async () => {
        const latestHosts = await onReadPersistedHosts();
        const results = await Promise.all(clearedSources.map((source) => writeSshConfigToFile(
          source,
          latestHosts.filter((host) => host.managedSourceId === source.id),
          latestHosts,
        )));
        if (results.some((success) => !success)) {
          throw new Error("Could not restore every managed SSH config source");
        }
      };
    },
    [onReadPersistedHosts, writeSshConfigToFile],
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
            !haveSameManagedSshAgentFields(prev, curr) ||
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
      syncInProgressRef.current = true;

      Promise.all(
        managedSources
          .filter((s) => changedSourceIds.has(s.id))
          .map((source) => syncManagedSource(source)),
      ).then(async (results) => {
        // Batch update lastSyncedAt for all successful syncs to avoid race conditions
        const successfulSourceIds = new Set(
          results.filter(r => r.success).map(r => r.sourceId)
        );

        if (successfulSourceIds.size > 0) {
          await withVaultImportLock("vault", async () => {
            const currentSources = localStorageAdapter.read<ManagedSource[]>(
              STORAGE_KEY_MANAGED_SOURCES,
            ) ?? managedSourcesRef.current;
            const now = Date.now();
            const updatedSources = currentSources.map((s) =>
              successfulSourceIds.has(s.id) ? { ...s, lastSyncedAt: now } : s,
            );
            onUpdateManagedSources(updatedSources);
          });
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
