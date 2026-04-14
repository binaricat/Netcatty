import { useCallback, useEffect, useRef, useState } from "react";
import { normalizeDistroId, sanitizeHost } from "../../domain/host";
import {
  ConnectionLog,
  GroupConfig,
  Host,
  Identity,
  KeyCategory,
  KnownHost,
  ManagedSource,
  ShellHistoryEntry,
  Snippet,
  SSHKey,
} from "../../domain/models";
import {
  INITIAL_HOSTS,
  INITIAL_SNIPPETS,
} from "../../infrastructure/config/defaultData";
import {
  STORAGE_KEY_CONNECTION_LOGS,
  STORAGE_KEY_GROUP_CONFIGS,
  STORAGE_KEY_GROUPS,
  STORAGE_KEY_HOSTS,
  STORAGE_KEY_IDENTITIES,
  STORAGE_KEY_KEYS,
  STORAGE_KEY_KNOWN_HOSTS,
  STORAGE_KEY_LEGACY_KEYS,
  STORAGE_KEY_MANAGED_SOURCES,
  STORAGE_KEY_SHELL_HISTORY,
  STORAGE_KEY_SNIPPET_PACKAGES,
  STORAGE_KEY_SNIPPETS,
} from "../../infrastructure/config/storageKeys";
import { localStorageAdapter } from "../../infrastructure/persistence/localStorageAdapter";
import {
  decryptGroupConfigs,
  decryptHosts,
  decryptIdentities,
  decryptKeys,
  encryptGroupConfigs,
  encryptHosts,
  encryptIdentities,
  encryptKeys,
} from "../../infrastructure/persistence/secureFieldAdapter";

type ExportableVaultData = {
  hosts: Host[];
  keys: SSHKey[];
  identities?: Identity[];
  snippets: Snippet[];
  customGroups: string[];
  snippetPackages?: string[];
  knownHosts?: KnownHost[];
  groupConfigs?: GroupConfig[];
};

type LegacyKeyRecord = Record<string, unknown> & { id?: string; source?: string };

// Migration helper for old SSHKey format to new format
const migrateKey = (key: Partial<SSHKey>): SSHKey => {
  const id = key.id ?? crypto.randomUUID();
  const label = key.label ?? `Key ${id.slice(0, 8)}`;

  const source =
    key.source === "generated" || key.source === "imported"
      ? key.source
      : key.privateKey
        ? "imported"
        : "generated";

  return {
    id,
    label,
    type: key.type || "ED25519",
    privateKey: key.privateKey || "",
    publicKey: key.publicKey,
    certificate: key.certificate,
    passphrase: key.passphrase,
    savePassphrase: key.savePassphrase,
    source,
    category:
      key.category ||
      ((key.certificate ? "certificate" : "key") as KeyCategory),
    created: key.created || Date.now(),
  };
};

const isLegacyUnsupportedKey = (key: LegacyKeyRecord): boolean => {
  const source = key.source;
  if (source === "biometric" || source === "fido2" || source === "passkey") return true;
  // Legacy experimental WebAuthn fields
  if ("credentialId" in key || "rpId" in key || "userVerification" in key) return true;
  return false;
};

const safeParse = <T,>(value: string | null): T | null => {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
};

export const useVaultState = () => {
  const [isInitialized, setIsInitialized] = useState(false);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [keys, setKeys] = useState<SSHKey[]>([]);
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [customGroups, setCustomGroups] = useState<string[]>([]);
  const [snippetPackages, setSnippetPackages] = useState<string[]>([]);
  const [knownHosts, setKnownHosts] = useState<KnownHost[]>([]);
  const [shellHistory, setShellHistory] = useState<ShellHistoryEntry[]>([]);
  const [connectionLogs, setConnectionLogs] = useState<ConnectionLog[]>([]);
  const [managedSources, setManagedSources] = useState<ManagedSource[]>([]);
  const [groupConfigs, setGroupConfigs] = useState<GroupConfig[]>([]);

  // Write-version counters prevent out-of-order async writes from overwriting
  // newer data.  Each update bumps the counter; the .then() callback only
  // persists if its version still matches the latest.
  const hostsWriteVersion = useRef(0);
  const keysWriteVersion = useRef(0);
  const identitiesWriteVersion = useRef(0);
  const groupConfigsWriteVersion = useRef(0);

  // Read-sequence counters for cross-window storage events.  Each incoming
  // event bumps the counter; the async decrypt callback only applies state if
  // its sequence still matches, preventing stale decrypts from overwriting
  // newer data when multiple events arrive in quick succession.
  const hostsReadSeq = useRef(0);
  const keysReadSeq = useRef(0);
  const identitiesReadSeq = useRef(0);
  const groupConfigsReadSeq = useRef(0);

  const updateHosts = useCallback((data: Host[]) => {
    const cleaned = data.map(sanitizeHost);
    setHosts(cleaned);
    const ver = ++hostsWriteVersion.current;
    encryptHosts(cleaned).then((enc) => {
      if (ver === hostsWriteVersion.current)
        localStorageAdapter.write(STORAGE_KEY_HOSTS, enc);
    });
  }, []);

  const updateKeys = useCallback((data: SSHKey[]) => {
    setKeys(data);
    const ver = ++keysWriteVersion.current;
    encryptKeys(data).then((enc) => {
      if (ver === keysWriteVersion.current)
        localStorageAdapter.write(STORAGE_KEY_KEYS, enc);
    });
  }, []);

  const updateIdentities = useCallback((data: Identity[]) => {
    setIdentities(data);
    const ver = ++identitiesWriteVersion.current;
    encryptIdentities(data).then((enc) => {
      if (ver === identitiesWriteVersion.current)
        localStorageAdapter.write(STORAGE_KEY_IDENTITIES, enc);
    });
  }, []);

  const updateSnippets = useCallback((data: Snippet[]) => {
    setSnippets(data);
    localStorageAdapter.write(STORAGE_KEY_SNIPPETS, data);
  }, []);

  const updateSnippetPackages = useCallback((data: string[]) => {
    setSnippetPackages(data);
    localStorageAdapter.write(STORAGE_KEY_SNIPPET_PACKAGES, data);
  }, []);

  const updateCustomGroups = useCallback((data: string[]) => {
    setCustomGroups(data);
    localStorageAdapter.write(STORAGE_KEY_GROUPS, data);
  }, []);

  const updateKnownHosts = useCallback((data: KnownHost[]) => {
    setKnownHosts(data);
    localStorageAdapter.write(STORAGE_KEY_KNOWN_HOSTS, data);
  }, []);

  const updateManagedSources = useCallback((data: ManagedSource[]) => {
    setManagedSources(data);
    localStorageAdapter.write(STORAGE_KEY_MANAGED_SOURCES, data);
  }, []);

  const updateGroupConfigs = useCallback((data: GroupConfig[]) => {
    setGroupConfigs(data);
    const ver = ++groupConfigsWriteVersion.current;
    encryptGroupConfigs(data).then((enc) => {
      if (ver === groupConfigsWriteVersion.current)
        localStorageAdapter.write(STORAGE_KEY_GROUP_CONFIGS, enc);
    });
  }, []);

  const clearVaultData = useCallback(() => {
    updateHosts([]);
    updateKeys([]);
    updateIdentities([]);
    updateSnippets([]);
    updateSnippetPackages([]);
    updateCustomGroups([]);
    updateKnownHosts([]);
    updateManagedSources([]);
    updateGroupConfigs([]);
    localStorageAdapter.remove(STORAGE_KEY_LEGACY_KEYS);
  }, [
    updateHosts,
    updateKeys,
    updateIdentities,
    updateSnippets,
    updateSnippetPackages,
    updateCustomGroups,
    updateKnownHosts,
    updateManagedSources,
    updateGroupConfigs,
  ]);

  const addShellHistoryEntry = useCallback(
    (entry: Omit<ShellHistoryEntry, "id" | "timestamp">) => {
      const newEntry: ShellHistoryEntry = {
        ...entry,
        id: crypto.randomUUID(),
        timestamp: Date.now(),
      };
      setShellHistory((prev) => {
        // Keep only the last 1000 entries
        const updated = [newEntry, ...prev].slice(0, 1000);
        localStorageAdapter.write(STORAGE_KEY_SHELL_HISTORY, updated);
        return updated;
      });
    },
    [],
  );

  const clearShellHistory = useCallback(() => {
    setShellHistory([]);
    localStorageAdapter.write(STORAGE_KEY_SHELL_HISTORY, []);
  }, []);

  // Connection logs management
  const addConnectionLog = useCallback(
    (log: Omit<ConnectionLog, "id">) => {
      const newLog: ConnectionLog = {
        ...log,
        id: crypto.randomUUID(),
      };
      setConnectionLogs((prev) => {
        // Keep only the last 500 non-saved entries plus all saved entries
        const savedLogs = prev.filter((l) => l.saved);
        const unsavedLogs = prev.filter((l) => !l.saved);
        const updated = [newLog, ...unsavedLogs].slice(0, 500);
        const final = [...updated, ...savedLogs].sort(
          (a, b) => b.startTime - a.startTime
        );
        localStorageAdapter.write(STORAGE_KEY_CONNECTION_LOGS, final);
        return final;
      });
      return newLog.id;
    },
    []
  );

  const updateConnectionLog = useCallback(
    (id: string, updates: Partial<ConnectionLog>) => {
      setConnectionLogs((prev) => {
        const updated = prev.map((log) =>
          log.id === id ? { ...log, ...updates } : log
        );
        localStorageAdapter.write(STORAGE_KEY_CONNECTION_LOGS, updated);
        return updated;
      });
    },
    []
  );

  const toggleConnectionLogSaved = useCallback((id: string) => {
    setConnectionLogs((prev) => {
      const updated = prev.map((log) =>
        log.id === id ? { ...log, saved: !log.saved } : log
      );
      localStorageAdapter.write(STORAGE_KEY_CONNECTION_LOGS, updated);
      return updated;
    });
  }, []);

  const deleteConnectionLog = useCallback((id: string) => {
    setConnectionLogs((prev) => {
      const updated = prev.filter((log) => log.id !== id);
      localStorageAdapter.write(STORAGE_KEY_CONNECTION_LOGS, updated);
      return updated;
    });
  }, []);

  const clearUnsavedConnectionLogs = useCallback(() => {
    setConnectionLogs((prev) => {
      const saved = prev.filter((log) => log.saved);
      localStorageAdapter.write(STORAGE_KEY_CONNECTION_LOGS, saved);
      return saved;
    });
  }, []);

  // Convert a known host to a managed host
  const convertKnownHostToHost = useCallback((knownHost: KnownHost): Host => {
    const newHost: Host = {
      id: `host-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      label: knownHost.hostname,
      hostname: knownHost.hostname,
      port: knownHost.port,
      username: "", // Will be set when connecting
      os: "linux",
      group: "",
      tags: [],
      protocol: "ssh",
    };

    // Update the known host to mark it as converted using functional update
    setKnownHosts((prevKnownHosts) => {
      const updated = prevKnownHosts.map((kh) =>
        kh.id === knownHost.id ? { ...kh, convertedToHostId: newHost.id } : kh,
      );
      localStorageAdapter.write(STORAGE_KEY_KNOWN_HOSTS, updated);
      return updated;
    });

    // Add to hosts using functional update
    setHosts((prevHosts) => {
      const updated = [...prevHosts, sanitizeHost(newHost)];
      const ver = ++hostsWriteVersion.current;
      encryptHosts(updated).then((enc) => {
        if (ver === hostsWriteVersion.current)
          localStorageAdapter.write(STORAGE_KEY_HOSTS, enc);
      });
      return updated;
    });

    return newHost;
  }, []);

  useEffect(() => {
    const init = async () => {
      try {
        const savedHosts = localStorageAdapter.read<Host[]>(STORAGE_KEY_HOSTS);

        if (savedHosts) {
          // Capture version before the async gap so that any write occurring
          // during decryption (storage event, user edit) advances the counter
          // and causes this stale result to be discarded.
          const ver = ++hostsWriteVersion.current;
          const decrypted = await decryptHosts(savedHosts);
          if (ver === hostsWriteVersion.current) {
            const sanitized = decrypted.map(sanitizeHost);
            setHosts(sanitized);
            encryptHosts(sanitized).then((enc) => {
              if (ver === hostsWriteVersion.current)
                localStorageAdapter.write(STORAGE_KEY_HOSTS, enc);
            });
          }
        } else {
          updateHosts(INITIAL_HOSTS);
        }

        // Read keys fresh here (not before the hosts await) so we don't apply
        // a stale snapshot if keys were updated during host decryption.
        const savedKeysRaw = localStorageAdapter.read<unknown[]>(STORAGE_KEY_KEYS);

        // Migrate old keys to new format with source/category fields
        if (savedKeysRaw?.length) {
          const migratedKeys: SSHKey[] = [];
          const legacyKeys: LegacyKeyRecord[] = [];

          for (const entry of savedKeysRaw) {
            const record =
              entry && typeof entry === "object" ? (entry as LegacyKeyRecord) : null;
            if (!record) continue;

            if (isLegacyUnsupportedKey(record)) {
              legacyKeys.push(record);
              continue;
            }

            migratedKeys.push(migrateKey(record as Partial<SSHKey>));
          }

          // Decrypt sensitive fields (passphrase, privateKey)
          const keyVer = ++keysWriteVersion.current;
          const decryptedKeys = await decryptKeys(migratedKeys);
          if (keyVer === keysWriteVersion.current) {
            setKeys(decryptedKeys);
            encryptKeys(decryptedKeys).then((enc) => {
              if (keyVer === keysWriteVersion.current)
                localStorageAdapter.write(STORAGE_KEY_KEYS, enc);
            });
          }
          if (legacyKeys.length) {
            localStorageAdapter.write(STORAGE_KEY_LEGACY_KEYS, legacyKeys);
          }
        }

        // Read identities fresh here (not before the hosts/keys awaits) so we
        // don't apply a stale snapshot if identities were updated during prior decryption.
        const savedIdentities =
          localStorageAdapter.read<Identity[]>(STORAGE_KEY_IDENTITIES);
        if (savedIdentities) {
          const idVer = ++identitiesWriteVersion.current;
          const decryptedIds = await decryptIdentities(savedIdentities);
          if (idVer === identitiesWriteVersion.current) {
            setIdentities(decryptedIds);
            encryptIdentities(decryptedIds).then((enc) => {
              if (idVer === identitiesWriteVersion.current)
                localStorageAdapter.write(STORAGE_KEY_IDENTITIES, enc);
            });
          }
        }

        // Read remaining non-encrypted data fresh after all async gaps above
        const savedGroups = localStorageAdapter.read<string[]>(STORAGE_KEY_GROUPS);
        const savedSnippets =
          localStorageAdapter.read<Snippet[]>(STORAGE_KEY_SNIPPETS);
        const savedSnippetPackages = localStorageAdapter.read<string[]>(
          STORAGE_KEY_SNIPPET_PACKAGES,
        );

        if (savedSnippets) setSnippets(savedSnippets);
        else updateSnippets(INITIAL_SNIPPETS);

        if (savedGroups) setCustomGroups(savedGroups);
        if (savedSnippetPackages) setSnippetPackages(savedSnippetPackages);

        // Load known hosts
        const savedKnownHosts = localStorageAdapter.read<KnownHost[]>(
          STORAGE_KEY_KNOWN_HOSTS,
        );
        if (savedKnownHosts) setKnownHosts(savedKnownHosts);

        // Load shell history
        const savedShellHistory = localStorageAdapter.read<ShellHistoryEntry[]>(
          STORAGE_KEY_SHELL_HISTORY,
        );
        if (savedShellHistory) setShellHistory(savedShellHistory);

        // Load connection logs
        const savedConnectionLogs = localStorageAdapter.read<ConnectionLog[]>(
          STORAGE_KEY_CONNECTION_LOGS,
        );
        if (savedConnectionLogs) setConnectionLogs(savedConnectionLogs);

        // Load managed sources
        const savedManagedSources = localStorageAdapter.read<ManagedSource[]>(
          STORAGE_KEY_MANAGED_SOURCES,
        );
        if (savedManagedSources) setManagedSources(savedManagedSources);

        // Load group configs
        const savedGroupConfigs = localStorageAdapter.read<GroupConfig[]>(STORAGE_KEY_GROUP_CONFIGS);
        if (savedGroupConfigs) {
          const gcVer = ++groupConfigsWriteVersion.current;
          const decryptedGC = await decryptGroupConfigs(savedGroupConfigs);
          if (gcVer === groupConfigsWriteVersion.current) {
            setGroupConfigs(decryptedGC);
            encryptGroupConfigs(decryptedGC).then((enc) => {
              if (gcVer === groupConfigsWriteVersion.current)
                localStorageAdapter.write(STORAGE_KEY_GROUP_CONFIGS, enc);
            });
          }
        }
      } finally {
        setIsInitialized(true);
      }
    };

    init();
  }, [updateHosts, updateSnippets]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleStorage = (event: StorageEvent) => {
      if (event.storageArea !== window.localStorage) return;
      const key = event.key;
      if (!key) return;

      if (key === STORAGE_KEY_HOSTS) {
        const next = safeParse<Host[]>(event.newValue) ?? [];
        // Bump write version to invalidate any in-flight encrypt from this
        // window — the cross-window data is newer and must not be overwritten.
        ++hostsWriteVersion.current;
        const seq = ++hostsReadSeq.current;
        const writeAtStart = hostsWriteVersion.current;
        decryptHosts(next).then((dec) => {
          // Discard if a newer storage event arrived OR a local write occurred
          // during the decrypt (writeVersion would have advanced).
          if (seq === hostsReadSeq.current && writeAtStart === hostsWriteVersion.current)
            setHosts(dec.map(sanitizeHost));
        });
        return;
      }

      if (key === STORAGE_KEY_KEYS) {
        const raw = safeParse<unknown[]>(event.newValue) ?? [];
        const migratedKeys: SSHKey[] = [];
        for (const entry of raw) {
          const record =
            entry && typeof entry === "object" ? (entry as LegacyKeyRecord) : null;
          if (!record || isLegacyUnsupportedKey(record)) continue;
          migratedKeys.push(migrateKey(record as Partial<SSHKey>));
        }
        ++keysWriteVersion.current;
        const seq = ++keysReadSeq.current;
        const writeAtStart = keysWriteVersion.current;
        decryptKeys(migratedKeys).then((dec) => {
          if (seq === keysReadSeq.current && writeAtStart === keysWriteVersion.current)
            setKeys(dec);
        });
        return;
      }

      if (key === STORAGE_KEY_IDENTITIES) {
        const next = safeParse<Identity[]>(event.newValue) ?? [];
        ++identitiesWriteVersion.current;
        const seq = ++identitiesReadSeq.current;
        const writeAtStart = identitiesWriteVersion.current;
        decryptIdentities(next).then((dec) => {
          if (seq === identitiesReadSeq.current && writeAtStart === identitiesWriteVersion.current)
            setIdentities(dec);
        });
        return;
      }

      if (key === STORAGE_KEY_SNIPPETS) {
        const next = safeParse<Snippet[]>(event.newValue) ?? [];
        setSnippets(next);
        return;
      }

      if (key === STORAGE_KEY_GROUPS) {
        const next = safeParse<string[]>(event.newValue) ?? [];
        setCustomGroups(next);
        return;
      }

      if (key === STORAGE_KEY_SNIPPET_PACKAGES) {
        const next = safeParse<string[]>(event.newValue) ?? [];
        setSnippetPackages(next);
        return;
      }

      if (key === STORAGE_KEY_KNOWN_HOSTS) {
        const next = safeParse<KnownHost[]>(event.newValue) ?? [];
        setKnownHosts(next);
        return;
      }

      if (key === STORAGE_KEY_SHELL_HISTORY) {
        const next = safeParse<ShellHistoryEntry[]>(event.newValue) ?? [];
        setShellHistory(next);
        return;
      }

      if (key === STORAGE_KEY_CONNECTION_LOGS) {
        const next = safeParse<ConnectionLog[]>(event.newValue) ?? [];
        setConnectionLogs(next);
        return;
      }

      if (key === STORAGE_KEY_MANAGED_SOURCES) {
        const next = safeParse<ManagedSource[]>(event.newValue) ?? [];
        setManagedSources(next);
        return;
      }

      if (key === STORAGE_KEY_GROUP_CONFIGS) {
        const next = safeParse<GroupConfig[]>(event.newValue) ?? [];
        ++groupConfigsWriteVersion.current;
        const seq = ++groupConfigsReadSeq.current;
        const writeAtStart = groupConfigsWriteVersion.current;
        decryptGroupConfigs(next).then((dec) => {
          if (seq === groupConfigsReadSeq.current && writeAtStart === groupConfigsWriteVersion.current)
            setGroupConfigs(dec);
        });
        return;
      }
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const updateHostLastConnected = useCallback((hostId: string) => {
    setHosts((prev) => {
      const next = prev.map((h) =>
        h.id === hostId ? { ...h, lastConnectedAt: Date.now() } : h,
      );
      const ver = ++hostsWriteVersion.current;
      encryptHosts(next).then((enc) => {
        if (ver === hostsWriteVersion.current)
          localStorageAdapter.write(STORAGE_KEY_HOSTS, enc);
      });
      return next;
    });
  }, []);

  const updateHostDistro = useCallback((hostId: string, distro: string) => {
    const normalized = normalizeDistroId(distro);
    setHosts((prev) => {
      const next = prev.map((h) =>
        h.id === hostId ? { ...h, distro: normalized } : h,
      );
      const ver = ++hostsWriteVersion.current;
      encryptHosts(next).then((enc) => {
        if (ver === hostsWriteVersion.current)
          localStorageAdapter.write(STORAGE_KEY_HOSTS, enc);
      });
      return next;
    });
  }, []);

  const exportData = useCallback(
    (): ExportableVaultData => ({
      hosts,
      keys,
      identities,
      snippets,
      customGroups,
      snippetPackages,
      knownHosts,
      groupConfigs,
    }),
    [hosts, keys, identities, snippets, customGroups, snippetPackages, knownHosts, groupConfigs],
  );

  const importData = useCallback(
    (payload: Partial<ExportableVaultData>) => {
      if (payload.hosts) updateHosts(payload.hosts);
      if (payload.keys) updateKeys(payload.keys);
      if (payload.identities) updateIdentities(payload.identities);
      if (payload.snippets) updateSnippets(payload.snippets);
      if (payload.customGroups) updateCustomGroups(payload.customGroups);
      if (payload.snippetPackages) updateSnippetPackages(payload.snippetPackages);
      if (payload.knownHosts) updateKnownHosts(payload.knownHosts);
      if (Array.isArray(payload.groupConfigs)) updateGroupConfigs(payload.groupConfigs);
    },
    [
      updateHosts,
      updateKeys,
      updateIdentities,
      updateSnippets,
      updateCustomGroups,
      updateSnippetPackages,
      updateKnownHosts,
      updateGroupConfigs,
    ],
  );

  const importDataFromString = useCallback(
    (jsonString: string) => {
      const data = JSON.parse(jsonString);
      importData(data);
    },
    [importData],
  );

  return {
    isInitialized,
    hosts,
    keys,
    identities,
    snippets,
    customGroups,
    snippetPackages,
    knownHosts,
    shellHistory,
    connectionLogs,
    managedSources,
    groupConfigs,
    updateHosts,
    updateKeys,
    updateIdentities,
    updateSnippets,
    updateSnippetPackages,
    updateCustomGroups,
    updateKnownHosts,
    updateManagedSources,
    updateGroupConfigs,
    addShellHistoryEntry,
    clearShellHistory,
    addConnectionLog,
    updateConnectionLog,
    toggleConnectionLogSaved,
    deleteConnectionLog,
    clearUnsavedConnectionLogs,
    updateHostDistro,
    updateHostLastConnected,
    convertKnownHostToHost,
    exportData,
    importDataFromString,
    clearVaultData,
  };
};
