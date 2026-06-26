import { useCallback, useEffect, useRef, useState } from "react";
import { migrateHostsFromLegacyLineTimestamps, normalizeDistroId, sanitizeHost } from "../../domain/host";
import { sanitizeGroupConfig } from "../../domain/groupConfig";
import { normalizeKnownHosts } from "../../domain/knownHosts";
import { normalizeNoteGroups, normalizeVaultNotes } from "../../domain/notes";
import {
  ConnectionLog,
  GroupConfig,
  Host,
  Identity,
  KeyCategory,
  KnownHost,
  ManagedSource,
  ProxyProfile,
  ShellHistoryEntry,
  Snippet,
  SSHKey,
  VaultNote,
} from "../../domain/models";
import {
  INITIAL_HOSTS,
  INITIAL_SNIPPETS,
} from "../../infrastructure/config/defaultData";
import {
  STORAGE_KEY_CONNECTION_LOGS,
  STORAGE_KEY_CONNECTION_LOG_TERMINAL_DATA,
  STORAGE_KEY_GROUP_CONFIGS,
  STORAGE_KEY_GROUPS,
  STORAGE_KEY_HOSTS,
  STORAGE_KEY_IDENTITIES,
  STORAGE_KEY_KEYS,
  STORAGE_KEY_KNOWN_HOSTS,
  STORAGE_KEY_LEGACY_KEYS,
  STORAGE_KEY_MANAGED_SOURCES,
  STORAGE_KEY_NOTE_GROUPS,
  STORAGE_KEY_NOTES,
  STORAGE_KEY_PROXY_PROFILES,
  STORAGE_KEY_SHELL_HISTORY,
  STORAGE_KEY_SNIPPET_PACKAGES,
  STORAGE_KEY_SNIPPETS,
  STORAGE_KEY_TERM_SETTINGS,
} from "../../infrastructure/config/storageKeys";
import { localStorageAdapter, LOCAL_STORAGE_ADAPTER_CHANGED_EVENT } from "../../infrastructure/persistence/localStorageAdapter";
import { mergeGlobalHistoryOnAppend, sanitizeGlobalHistoryEntries } from "../../domain/globalHistory";
import {
  buildTerminalDataMapFromLogs,
  mergeConnectionLogsFromStorage,
  mergeTerminalDataIntoLogs,
  mergeTerminalDataMapsForStorage,
  type ConnectionLogTerminalDataMap,
} from "../../domain/connectionLogTerminalData";
import { getNextVaultOrder, normalizeVaultOrder } from "../../domain/vaultOrder";
import { loadSanitizedShellHistory } from "./shellHistoryPersistence";
import {
  decryptGroupConfigs,
  decryptHosts,
  decryptIdentities,
  decryptKeys,
  decryptProxyProfiles,
  encryptGroupConfigs,
  encryptHosts,
  encryptIdentities,
  encryptKeys,
  encryptProxyProfiles,
} from "../../infrastructure/persistence/secureFieldAdapter";

type ExportableVaultData = {
  hosts: Host[];
  keys: SSHKey[];
  identities?: Identity[];
  proxyProfiles?: ProxyProfile[];
  snippets: Snippet[];
  customGroups: string[];
  snippetPackages?: string[];
  notes?: VaultNote[];
  noteGroups?: string[];
  knownHosts?: KnownHost[];
  groupConfigs?: GroupConfig[];
};

type LegacyKeyRecord = Record<string, unknown> & { id?: string; source?: string };

// Migration helper for old SSHKey format to new format
const migrateKey = (key: Partial<SSHKey>): SSHKey => {
  const id = key.id ?? crypto.randomUUID();
  const label = key.label ?? `Key ${id.slice(0, 8)}`;

  const source =
    key.source === "generated" || key.source === "imported" || key.source === "reference"
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
    filePath: key.filePath,
    order: key.order,
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

/**
 * Strip the bulky `terminalData` replay buffer from transient (unsaved)
 * connection logs before persisting. `terminalData` is the full terminal
 * scrollback for a session; with up to 500 logs it grew the
 * `netcatty_connection_logs_v1` localStorage blob to ~11 MB, and every
 * add/update re-serialized + wrote the whole thing synchronously
 * (50–73 ms on the main thread), causing freezes on connect/disconnect.
 *
 * The full `terminalData` stays in the in-memory React state (so in-session
 * replay still works); only explicitly *saved* logs keep it on disk. This
 * keeps the persisted blob small and writes fast.
 */
const pruneConnectionLogsForStorage = (logs: ConnectionLog[]): ConnectionLog[] => {
  let changed = false;
  const next = logs.map((log) => {
    if (log.saved || log.terminalData === undefined) return log;
    changed = true;
    const { terminalData: _omitted, ...rest } = log;
    return rest;
  });
  return changed ? next : logs;
};

const readLegacyLineTimestampsEnabled = (): boolean => {
  const stored = localStorageAdapter.read<Record<string, unknown>>(STORAGE_KEY_TERM_SETTINGS);
  return stored?.showLineTimestamps === true;
};

const readConnectionLogTerminalDataMap = (): ConnectionLogTerminalDataMap =>
  localStorageAdapter.read<ConnectionLogTerminalDataMap>(STORAGE_KEY_CONNECTION_LOG_TERMINAL_DATA) ?? {};

const readPersistedConnectionLogIds = (): Set<string> => {
  const stored = localStorageAdapter.read<ConnectionLog[]>(STORAGE_KEY_CONNECTION_LOGS) ?? [];
  return new Set(stored.map((log) => log.id));
};

const buildPersistedLogIds = (
  logs: ConnectionLog[],
  usePersistedLogIdsFromDisk: boolean,
): Set<string> => {
  const ids = new Set(logs.map((log) => log.id));
  if (usePersistedLogIdsFromDisk) {
    for (const id of readPersistedConnectionLogIds()) {
      ids.add(id);
    }
  }
  return ids;
};

const writeConnectionLogTerminalDataMap = (
  logs: ConnectionLog[],
  localMaps: ConnectionLogTerminalDataMap[],
  usePersistedLogIdsFromDisk: boolean,
): boolean => {
  const existing = readConnectionLogTerminalDataMap();
  const pruned = mergeTerminalDataMapsForStorage(
    logs,
    existing,
    localMaps,
    buildPersistedLogIds(logs, usePersistedLogIdsFromDisk),
  );
  if (JSON.stringify(existing) === JSON.stringify(pruned)) return true;
  return localStorageAdapter.write(STORAGE_KEY_CONNECTION_LOG_TERMINAL_DATA, pruned);
};

export const useVaultState = () => {
  const [isInitialized, setIsInitialized] = useState(false);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [keys, setKeys] = useState<SSHKey[]>([]);
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [proxyProfiles, setProxyProfiles] = useState<ProxyProfile[]>([]);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [customGroups, setCustomGroups] = useState<string[]>([]);
  const [snippetPackages, setSnippetPackages] = useState<string[]>([]);
  const [notes, setNotes] = useState<VaultNote[]>([]);
  const [noteGroups, setNoteGroups] = useState<string[]>([]);
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
  const proxyProfilesWriteVersion = useRef(0);
  const groupConfigsWriteVersion = useRef(0);

  // Read-sequence counters for cross-window storage events.  Each incoming
  // event bumps the counter; the async decrypt callback only applies state if
  // its sequence still matches, preventing stale decrypts from overwriting
  // newer data when multiple events arrive in quick succession.
  const hostsReadSeq = useRef(0);
  const keysReadSeq = useRef(0);
  const identitiesReadSeq = useRef(0);
  const proxyProfilesReadSeq = useRef(0);
  const groupConfigsReadSeq = useRef(0);
  const connectionLogTerminalDataRef = useRef<ConnectionLogTerminalDataMap>({});

  const syncConnectionLogTerminalDataMap = useCallback((
    logs: ConnectionLog[],
    options?: { usePersistedLogIdsFromDisk?: boolean },
  ) => {
    const usePersistedLogIdsFromDisk = options?.usePersistedLogIdsFromDisk ?? false;
    const localMaps = [
      connectionLogTerminalDataRef.current,
      buildTerminalDataMapFromLogs(logs),
    ];
    const existing = readConnectionLogTerminalDataMap();
    const merged = mergeTerminalDataMapsForStorage(
      logs,
      existing,
      localMaps,
      buildPersistedLogIds(logs, usePersistedLogIdsFromDisk),
    );
    const persisted = writeConnectionLogTerminalDataMap(
      logs,
      localMaps,
      usePersistedLogIdsFromDisk,
    );
    if (persisted) {
      connectionLogTerminalDataRef.current = merged;
    } else {
      connectionLogTerminalDataRef.current = {
        ...connectionLogTerminalDataRef.current,
        ...buildTerminalDataMapFromLogs(logs),
      };
    }
    return { map: connectionLogTerminalDataRef.current, persisted };
  }, []);

  const persistConnectionLogState = useCallback((
    logs: ConnectionLog[],
    options?: { pruneMainBlob?: boolean },
  ) => {
    const unsavedTerminalDataPending = logs.some(
      (log) => !log.saved && log.terminalData !== undefined,
    );

    let mainPersisted = true;
    if (options?.pruneMainBlob) {
      const prunedMain = pruneConnectionLogsForStorage(logs);
      mainPersisted = localStorageAdapter.write(STORAGE_KEY_CONNECTION_LOGS, prunedMain);
      if (!mainPersisted && unsavedTerminalDataPending) {
        mainPersisted = localStorageAdapter.write(STORAGE_KEY_CONNECTION_LOGS, logs);
      }
    }

    let sidePersisted = true;
    if (mainPersisted || !options?.pruneMainBlob) {
      ({ persisted: sidePersisted } = syncConnectionLogTerminalDataMap(logs, {
        usePersistedLogIdsFromDisk: Boolean(options?.pruneMainBlob && mainPersisted),
      }));
    }

    if (!options?.pruneMainBlob) {
      mainPersisted = localStorageAdapter.write(STORAGE_KEY_CONNECTION_LOGS, logs);
    }

    if (!mainPersisted && unsavedTerminalDataPending) {
      console.warn(
        "[useVaultState] Failed to persist connection log terminal replay data to localStorage.",
      );
    } else if (!sidePersisted && unsavedTerminalDataPending && options?.pruneMainBlob && mainPersisted) {
      console.warn(
        "[useVaultState] Failed to persist connection log terminal replay data side store.",
      );
    }
  }, [syncConnectionLogTerminalDataMap]);

  const applyConnectionLogsFromStorage = useCallback((
    prev: ConnectionLog[],
    storedLogs: ConnectionLog[],
    terminalDataMap: ConnectionLogTerminalDataMap,
  ) => {
    connectionLogTerminalDataRef.current = terminalDataMap;
    return mergeConnectionLogsFromStorage(prev, storedLogs, terminalDataMap);
  }, []);

  const updateHosts = useCallback((data: Host[]) => {
    const cleaned = normalizeVaultOrder(data.map(sanitizeHost));
    setHosts(cleaned);
    const ver = ++hostsWriteVersion.current;
    return encryptHosts(cleaned).then((enc) => {
      if (ver === hostsWriteVersion.current)
        localStorageAdapter.write(STORAGE_KEY_HOSTS, enc);
    });
  }, []);

  const updateKeys = useCallback((data: SSHKey[]) => {
    const cleaned = normalizeVaultOrder(data);
    setKeys(cleaned);
    const ver = ++keysWriteVersion.current;
    return encryptKeys(cleaned).then((enc) => {
      if (ver === keysWriteVersion.current)
        localStorageAdapter.write(STORAGE_KEY_KEYS, enc);
    });
  }, []);

  const importOrReuseKey = useCallback((draft: Partial<SSHKey>): SSHKey => {
    const existing = keys.find((k) => {
      if (draft.source === 'reference' && draft.filePath) {
        return k.source === 'reference' && k.filePath === draft.filePath;
      }
      if (draft.privateKey) {
        return k.privateKey === draft.privateKey;
      }
      return false;
    });
    if (existing) return existing;

    const newKey: SSHKey = {
      id: crypto.randomUUID(),
      label: draft.label || 'Imported Key',
      type: draft.type || 'ED25519',
      privateKey: draft.privateKey || '',
      publicKey: draft.publicKey,
      certificate: draft.certificate,
      passphrase: draft.passphrase,
      savePassphrase: draft.savePassphrase,
      source: draft.source || 'imported',
      category: (draft.category || 'key') as KeyCategory,
      created: Date.now(),
      filePath: draft.filePath,
      order: getNextVaultOrder(keys),
    };
    const updated = normalizeVaultOrder([...keys, newKey]);
    setKeys(updated);
    const ver = ++keysWriteVersion.current;
    void encryptKeys(updated).then((enc) => {
      if (ver === keysWriteVersion.current)
        localStorageAdapter.write(STORAGE_KEY_KEYS, enc);
    });
    return newKey;
  }, [keys]);

  const updateIdentities = useCallback((data: Identity[]) => {
    const cleaned = normalizeVaultOrder(data);
    setIdentities(cleaned);
    const ver = ++identitiesWriteVersion.current;
    return encryptIdentities(cleaned).then((enc) => {
      if (ver === identitiesWriteVersion.current)
        localStorageAdapter.write(STORAGE_KEY_IDENTITIES, enc);
    });
  }, []);

  const updateProxyProfiles = useCallback((data: ProxyProfile[]) => {
    const cleaned = normalizeVaultOrder(data);
    setProxyProfiles(cleaned);
    const ver = ++proxyProfilesWriteVersion.current;
    return encryptProxyProfiles(cleaned).then((enc) => {
      if (ver === proxyProfilesWriteVersion.current)
        localStorageAdapter.write(STORAGE_KEY_PROXY_PROFILES, enc);
    });
  }, []);

  const updateSnippets = useCallback((data: Snippet[]) => {
    const cleaned = normalizeVaultOrder(data);
    setSnippets(cleaned);
    localStorageAdapter.write(STORAGE_KEY_SNIPPETS, cleaned);
  }, []);

  const updateSnippetPackages = useCallback((data: string[]) => {
    setSnippetPackages(data);
    localStorageAdapter.write(STORAGE_KEY_SNIPPET_PACKAGES, data);
  }, []);

  const updateNotes = useCallback((data: Partial<VaultNote>[]) => {
    const cleaned = normalizeVaultNotes(data);
    setNotes(cleaned);
    localStorageAdapter.write(STORAGE_KEY_NOTES, cleaned);
  }, []);

  const updateNoteGroups = useCallback((data: unknown) => {
    const cleaned = normalizeNoteGroups(data);
    setNoteGroups(cleaned);
    localStorageAdapter.write(STORAGE_KEY_NOTE_GROUPS, cleaned);
  }, []);

  const updateCustomGroups = useCallback((data: string[]) => {
    setCustomGroups(data);
    localStorageAdapter.write(STORAGE_KEY_GROUPS, data);

    const groupOrderByPath = new Map<string, number>(
      data.map((path, index) => [path, (index + 1) * 1000]),
    );
    const existingConfigByPath = new Map<string, GroupConfig>(
      groupConfigs.map((config) => [config.path, config]),
    );
    const orderedConfigs = data.map((path) => {
      const existing = existingConfigByPath.get(path);
      const base: GroupConfig = existing ? { ...existing } : { path };
      return sanitizeGroupConfig({
        ...base,
        path,
        order: groupOrderByPath.get(path),
      });
    });
    const retainedConfigs = groupConfigs.filter((config) => !groupOrderByPath.has(config.path));
    const cleanedGroupConfigs = normalizeVaultOrder([
      ...orderedConfigs,
      ...retainedConfigs.map(sanitizeGroupConfig),
    ]);
    setGroupConfigs(cleanedGroupConfigs);
    const ver = ++groupConfigsWriteVersion.current;
    void encryptGroupConfigs(cleanedGroupConfigs).then((enc) => {
      if (ver === groupConfigsWriteVersion.current)
        localStorageAdapter.write(STORAGE_KEY_GROUP_CONFIGS, enc);
    });
  }, [groupConfigs]);

  const updateKnownHosts = useCallback((data: KnownHost[]) => {
    const cleaned = normalizeVaultOrder(data);
    setKnownHosts(cleaned);
    localStorageAdapter.write(STORAGE_KEY_KNOWN_HOSTS, cleaned);
  }, []);

  const updateManagedSources = useCallback((data: ManagedSource[]) => {
    setManagedSources(data);
    localStorageAdapter.write(STORAGE_KEY_MANAGED_SOURCES, data);
  }, []);

  const updateGroupConfigs = useCallback((data: GroupConfig[]) => {
    // Sanitize on the write path too — applySyncPayload / importVaultData
    // route legacy payloads through here, and without this step a saved
    // pingfang-sc / comic-sans-ms override from an older client would
    // sit in memory and re-persist with `fontFamilyOverride: true` until
    // the next reload. Mirrors updateHosts → sanitizeHost.
    const cleaned = normalizeVaultOrder(data.map(sanitizeGroupConfig));
    setGroupConfigs(cleaned);
    const ver = ++groupConfigsWriteVersion.current;
    return encryptGroupConfigs(cleaned).then((enc) => {
      if (ver === groupConfigsWriteVersion.current)
        localStorageAdapter.write(STORAGE_KEY_GROUP_CONFIGS, enc);
    });
  }, []);

  const clearVaultData = useCallback(() => {
    updateHosts([]);
    updateKeys([]);
    updateIdentities([]);
    updateProxyProfiles([]);
    updateSnippets([]);
    updateSnippetPackages([]);
    updateNotes([]);
    updateNoteGroups([]);
    updateCustomGroups([]);
    updateKnownHosts([]);
    updateManagedSources([]);
    updateGroupConfigs([]);
    localStorageAdapter.remove(STORAGE_KEY_LEGACY_KEYS);
  }, [
    updateHosts,
    updateKeys,
    updateIdentities,
    updateProxyProfiles,
    updateSnippets,
    updateSnippetPackages,
    updateNotes,
    updateNoteGroups,
    updateCustomGroups,
    updateKnownHosts,
    updateManagedSources,
    updateGroupConfigs,
  ]);

  const addShellHistoryEntry = useCallback(
    (entry: Omit<ShellHistoryEntry, "id" | "timestamp">) => {
      setShellHistory((prev) => {
        const updated = mergeGlobalHistoryOnAppend(prev, entry);
        if (updated === prev) return prev;
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
        persistConnectionLogState(final, { pruneMainBlob: true });
        return final;
      });
      return newLog.id;
    },
    [persistConnectionLogState],
  );

  const updateConnectionLog = useCallback(
    (id: string, updates: Partial<ConnectionLog>) => {
      setConnectionLogs((prev) => {
        const updated = prev.map((log) =>
          log.id === id ? { ...log, ...updates } : log
        );
        persistConnectionLogState(updated, { pruneMainBlob: true });
        return updated;
      });
    },
    [persistConnectionLogState],
  );

  const toggleConnectionLogSaved = useCallback((id: string) => {
    setConnectionLogs((prev) => {
      const updated = prev.map((log) =>
        log.id === id ? { ...log, saved: !log.saved } : log
      );
      persistConnectionLogState(updated, { pruneMainBlob: false });
      return updated;
    });
  }, [persistConnectionLogState]);

  const deleteConnectionLog = useCallback((id: string) => {
    setConnectionLogs((prev) => {
      const updated = prev.filter((log) => log.id !== id);
      const map = { ...connectionLogTerminalDataRef.current };
      delete map[id];
      connectionLogTerminalDataRef.current = map;
      persistConnectionLogState(updated, { pruneMainBlob: true });
      return updated;
    });
  }, [persistConnectionLogState]);

  const clearUnsavedConnectionLogs = useCallback(() => {
    setConnectionLogs((prev) => {
      const saved = prev.filter((log) => log.saved);
      persistConnectionLogState(saved, { pruneMainBlob: true });
      return saved;
    });
  }, [persistConnectionLogState]);

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
      order: getNextVaultOrder(hosts),
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
      const updated = normalizeVaultOrder([...prevHosts, sanitizeHost(newHost)]);
      const ver = ++hostsWriteVersion.current;
      encryptHosts(updated).then((enc) => {
        if (ver === hostsWriteVersion.current)
          localStorageAdapter.write(STORAGE_KEY_HOSTS, enc);
      });
      return updated;
    });

    return newHost;
  }, [hosts]);

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
            const sanitized = normalizeVaultOrder(
              migrateHostsFromLegacyLineTimestamps(
                decrypted.map(sanitizeHost),
                readLegacyLineTimestampsEnabled(),
              ),
            );
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
            const orderedKeys = normalizeVaultOrder(decryptedKeys);
            setKeys(orderedKeys);
            encryptKeys(orderedKeys).then((enc) => {
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
            const orderedIdentities = normalizeVaultOrder(decryptedIds);
            setIdentities(orderedIdentities);
            encryptIdentities(orderedIdentities).then((enc) => {
              if (idVer === identitiesWriteVersion.current)
                localStorageAdapter.write(STORAGE_KEY_IDENTITIES, enc);
            });
          }
        }

        const savedProxyProfiles =
          localStorageAdapter.read<ProxyProfile[]>(STORAGE_KEY_PROXY_PROFILES);
        if (savedProxyProfiles) {
          const proxyVer = ++proxyProfilesWriteVersion.current;
          const decryptedProfiles = await decryptProxyProfiles(savedProxyProfiles);
          if (proxyVer === proxyProfilesWriteVersion.current) {
            const orderedProfiles = normalizeVaultOrder(decryptedProfiles);
            setProxyProfiles(orderedProfiles);
            encryptProxyProfiles(orderedProfiles).then((enc) => {
              if (proxyVer === proxyProfilesWriteVersion.current)
                localStorageAdapter.write(STORAGE_KEY_PROXY_PROFILES, enc);
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
        const savedNotes = localStorageAdapter.read<VaultNote[]>(STORAGE_KEY_NOTES);
        const savedNoteGroups = localStorageAdapter.read<string[]>(STORAGE_KEY_NOTE_GROUPS);

        if (savedSnippets) {
          const orderedSnippets = normalizeVaultOrder(savedSnippets);
          setSnippets(orderedSnippets);
          localStorageAdapter.write(STORAGE_KEY_SNIPPETS, orderedSnippets);
        }
        else updateSnippets(INITIAL_SNIPPETS);

        if (savedGroups) setCustomGroups(savedGroups);
        if (savedSnippetPackages) setSnippetPackages(savedSnippetPackages);
        if (savedNotes) {
          const cleanedNotes = normalizeVaultNotes(savedNotes);
          setNotes(cleanedNotes);
          localStorageAdapter.write(STORAGE_KEY_NOTES, cleanedNotes);
        }
        if (savedNoteGroups) {
          const cleanedNoteGroups = normalizeNoteGroups(savedNoteGroups);
          setNoteGroups(cleanedNoteGroups);
          localStorageAdapter.write(STORAGE_KEY_NOTE_GROUPS, cleanedNoteGroups);
        }

        // Load known hosts. Records imported from `~/.ssh/known_hosts` and
        // records saved by older builds may be missing the `fingerprint` /
        // `keyType` fields the verifier compares against; backfill them now
        // so the next SSH connect can match without falling into the brittle
        // re-derivation path that caused the repeated "fingerprint changed"
        // warnings in #972.
        const savedKnownHosts = localStorageAdapter.read<KnownHost[]>(
          STORAGE_KEY_KNOWN_HOSTS,
        );
        if (savedKnownHosts) {
          const normalized = normalizeKnownHosts(savedKnownHosts);
          const orderedKnownHosts = normalizeVaultOrder(normalized);
          setKnownHosts(orderedKnownHosts);
          if (normalized !== savedKnownHosts || orderedKnownHosts !== normalized) {
            localStorageAdapter.write(STORAGE_KEY_KNOWN_HOSTS, orderedKnownHosts);
          }
        }

        // Load shell history
        const savedShellHistory = loadSanitizedShellHistory();
        if (savedShellHistory) {
          setShellHistory(savedShellHistory);
        }

        // Load connection logs
        const savedConnectionLogs = localStorageAdapter.read<ConnectionLog[]>(
          STORAGE_KEY_CONNECTION_LOGS,
        );
        const terminalDataMap = readConnectionLogTerminalDataMap();
        connectionLogTerminalDataRef.current = terminalDataMap;
        if (savedConnectionLogs) {
          setConnectionLogs(mergeTerminalDataIntoLogs(savedConnectionLogs, terminalDataMap));
        }

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
            const sanitizedGC = normalizeVaultOrder(decryptedGC.map(sanitizeGroupConfig));
            setGroupConfigs(sanitizedGC);
            encryptGroupConfigs(sanitizedGC).then((enc) => {
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
            setHosts(normalizeVaultOrder(dec.map(sanitizeHost)));
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
            setKeys(normalizeVaultOrder(dec));
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
            setIdentities(normalizeVaultOrder(dec));
        });
        return;
      }

      if (key === STORAGE_KEY_PROXY_PROFILES) {
        const next = safeParse<ProxyProfile[]>(event.newValue) ?? [];
        ++proxyProfilesWriteVersion.current;
        const seq = ++proxyProfilesReadSeq.current;
        const writeAtStart = proxyProfilesWriteVersion.current;
        decryptProxyProfiles(next).then((dec) => {
          if (seq === proxyProfilesReadSeq.current && writeAtStart === proxyProfilesWriteVersion.current)
            setProxyProfiles(normalizeVaultOrder(dec));
        });
        return;
      }

      if (key === STORAGE_KEY_SNIPPETS) {
        const next = safeParse<Snippet[]>(event.newValue) ?? [];
        setSnippets(normalizeVaultOrder(next));
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

      if (key === STORAGE_KEY_NOTES) {
        const next = safeParse<VaultNote[]>(event.newValue) ?? [];
        setNotes(normalizeVaultNotes(next));
        return;
      }

      if (key === STORAGE_KEY_NOTE_GROUPS) {
        const next = safeParse<string[]>(event.newValue) ?? [];
        setNoteGroups(normalizeNoteGroups(next));
        return;
      }

      if (key === STORAGE_KEY_KNOWN_HOSTS) {
        const next = safeParse<KnownHost[]>(event.newValue) ?? [];
        setKnownHosts(normalizeVaultOrder(normalizeKnownHosts(next)));
        return;
      }

      if (key === STORAGE_KEY_SHELL_HISTORY) {
        const next = sanitizeGlobalHistoryEntries(
          safeParse<ShellHistoryEntry[]>(event.newValue) ?? [],
        );
        setShellHistory(next);
        return;
      }

      if (key === STORAGE_KEY_CONNECTION_LOGS) {
        const next = safeParse<ConnectionLog[]>(event.newValue) ?? [];
        setConnectionLogs((prev) =>
          applyConnectionLogsFromStorage(prev, next, connectionLogTerminalDataRef.current),
        );
        return;
      }

      if (key === STORAGE_KEY_CONNECTION_LOG_TERMINAL_DATA) {
        const next = safeParse<ConnectionLogTerminalDataMap>(event.newValue) ?? {};
        connectionLogTerminalDataRef.current = next;
        setConnectionLogs((prev) => mergeConnectionLogsFromStorage(prev, prev, next));
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
            setGroupConfigs(normalizeVaultOrder(dec.map(sanitizeGroupConfig)));
        });
        return;
      }
    };

    const handleLocalStorageAdapterChanged = (event: Event) => {
      const key = (event as CustomEvent<{ key?: string }>).detail?.key;
      if (key === STORAGE_KEY_CONNECTION_LOGS) {
        const next = localStorageAdapter.read<ConnectionLog[]>(STORAGE_KEY_CONNECTION_LOGS) ?? [];
        setConnectionLogs((prev) =>
          applyConnectionLogsFromStorage(prev, next, connectionLogTerminalDataRef.current),
        );
        return;
      }
      if (key === STORAGE_KEY_CONNECTION_LOG_TERMINAL_DATA) {
        const next = readConnectionLogTerminalDataMap();
        connectionLogTerminalDataRef.current = next;
        setConnectionLogs((prev) => mergeConnectionLogsFromStorage(prev, prev, next));
      }
    };

    window.addEventListener("storage", handleStorage);
    window.addEventListener(LOCAL_STORAGE_ADAPTER_CHANGED_EVENT, handleLocalStorageAdapterChanged);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(LOCAL_STORAGE_ADAPTER_CHANGED_EVENT, handleLocalStorageAdapterChanged);
    };
  }, [applyConnectionLogsFromStorage]);

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
      proxyProfiles,
      snippets,
      customGroups,
      snippetPackages,
      notes,
      noteGroups,
      knownHosts,
      groupConfigs,
    }),
    [hosts, keys, identities, proxyProfiles, snippets, customGroups, snippetPackages, notes, noteGroups, knownHosts, groupConfigs],
  );

  const importData = useCallback(
    (payload: Partial<ExportableVaultData>): Promise<void> => {
      const encryptedWrites: Promise<void>[] = [];
      if (payload.hosts) encryptedWrites.push(updateHosts(payload.hosts));
      if (payload.keys) encryptedWrites.push(updateKeys(payload.keys));
      if (payload.identities) encryptedWrites.push(updateIdentities(payload.identities));
      if (Array.isArray(payload.proxyProfiles)) encryptedWrites.push(updateProxyProfiles(payload.proxyProfiles));
      if (payload.snippets) updateSnippets(payload.snippets);
      if (payload.customGroups) updateCustomGroups(payload.customGroups);
      if (payload.snippetPackages) updateSnippetPackages(payload.snippetPackages);
      if (payload.notes) updateNotes(payload.notes);
      if (payload.noteGroups) updateNoteGroups(payload.noteGroups);
      if (payload.knownHosts) updateKnownHosts(payload.knownHosts);
      if (Array.isArray(payload.groupConfigs)) encryptedWrites.push(updateGroupConfigs(payload.groupConfigs));
      return Promise.all(encryptedWrites).then(() => undefined);
    },
    [
      updateHosts,
      updateKeys,
      updateIdentities,
      updateProxyProfiles,
      updateSnippets,
      updateCustomGroups,
      updateSnippetPackages,
      updateNotes,
      updateNoteGroups,
      updateKnownHosts,
      updateGroupConfigs,
    ],
  );

  const importDataFromString = useCallback(
    (jsonString: string): Promise<void> => {
      const data = JSON.parse(jsonString);
      return importData(data);
    },
    [importData],
  );

  return {
    isInitialized,
    hosts,
    keys,
    identities,
    proxyProfiles,
    snippets,
    customGroups,
    snippetPackages,
    notes,
    noteGroups,
    knownHosts,
    shellHistory,
    connectionLogs,
    managedSources,
    groupConfigs,
    updateHosts,
    updateKeys,
    importOrReuseKey,
    updateIdentities,
    updateProxyProfiles,
    updateSnippets,
    updateSnippetPackages,
    updateNotes,
    updateNoteGroups,
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
