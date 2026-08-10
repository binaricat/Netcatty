import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  hostsEqualForIdentityReuse,
  migrateHostsFromLegacyLineTimestamps,
  normalizeDistroId,
  sanitizeHost,
} from "../../domain/host";
import { isEncryptedCredentialPlaceholder } from "../../domain/credentials";
import { sanitizeGroupConfig } from "../../domain/groupConfig";
import { normalizeKnownHosts } from "../../domain/knownHosts";
import { normalizeNoteGroups, normalizeVaultNotes } from "../../domain/notes";
import {
  applyPluginImporterDestination,
  mergePluginImporterDrafts,
} from "../../domain/pluginImporter";
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
import {
  mergeGlobalHistoryOnAppend,
  removeGlobalHistoryEntry,
  sanitizeGlobalHistoryEntries,
} from "../../domain/globalHistory";
import {
  buildTerminalDataMapFromLogs,
  mergeConnectionLogsFromStorage,
  mergeTerminalDataIntoLogs,
  mergeTerminalDataMapsForStorage,
  type ConnectionLogTerminalDataMap,
} from "../../domain/connectionLogTerminalData";
import { getNextVaultOrder, normalizeVaultOrder } from "../../domain/vaultOrder";
import {
  deleteSelectedSnippetsFromVault,
  pruneHostsStaleSnippetBindings,
  rebaseSnippetVaultWrite,
} from "../../domain/snippetSelection";
import { loadSanitizedShellHistory } from "./shellHistoryPersistence";
import {
  publishConnectionLogsSnapshot,
  registerConnectionLogsActions,
} from "./connectionLogsStore";
import {
  publishNotesSnapshot,
  registerNotesActions,
} from "./notesStore";
import { commitVaultNotesWrite } from "./vaultNotesPersistence";
import { publishShellHistorySnapshot } from "./shellHistoryStore";
import { setVaultInitialized } from "./vaultInitStore";
import { notify } from "../notification";
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
import { pluginExtensionBridge } from "./pluginExtensionBridge";
import type { PluginImporterCommitRequest } from "./usePluginImporterCommit";
import {
  isVaultImportLockHeld,
  type VaultLockHandle,
  withVaultImportLock,
  withVaultImportLockIfNeeded,
} from "./vaultManagedImportLock";
import {
  persistVaultImportMetadata,
  readStoredArray,
} from "./vaultImportPersistence";
import {
  commitPluginImporterTransaction,
  recoverPluginImporterTransaction,
} from "./pluginImporterTransaction";

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

const PLUGIN_IMPORT_TRANSACTION_KEYS = new Set([
  STORAGE_KEY_HOSTS,
  STORAGE_KEY_KEYS,
  STORAGE_KEY_IDENTITIES,
  STORAGE_KEY_SNIPPETS,
  STORAGE_KEY_GROUPS,
  STORAGE_KEY_GROUP_CONFIGS,
  STORAGE_KEY_MANAGED_SOURCES,
]);

const buildGroupConfigsForGroups = (
  groups: string[],
  currentConfigs: GroupConfig[],
): GroupConfig[] => {
  const groupOrderByPath = new Map<string, number>(
    groups.map((path, index) => [path, (index + 1) * 1000]),
  );
  const existingConfigByPath = new Map<string, GroupConfig>(
    currentConfigs.map((config) => [config.path, config]),
  );
  const orderedConfigs = groups.map((path) => {
    const existing = existingConfigByPath.get(path);
    return sanitizeGroupConfig({
      ...(existing ? { ...existing } : { path }),
      path,
      order: groupOrderByPath.get(path),
    });
  });
  return normalizeVaultOrder([
    ...orderedConfigs,
    ...currentConfigs
      .filter((config) => !groupOrderByPath.has(config.path))
      .map(sanitizeGroupConfig),
  ]);
};

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
  const customGroupsRef = useRef<string[]>([]);
  const managedSourcesRef = useRef<ManagedSource[]>([]);
  const hostsRef = useRef<Host[]>([]);
  const snippetsRef = useRef<Snippet[]>([]);
  const notesRef = useRef<VaultNote[]>([]);
  const noteGroupsRef = useRef<string[]>([]);
  const notesPersistFailureNotifiedAtRef = useRef(0);
  customGroupsRef.current = customGroups;
  managedSourcesRef.current = managedSources;
  hostsRef.current = hosts;
  snippetsRef.current = snippets;
  notesRef.current = notes;
  noteGroupsRef.current = noteGroups;

  // Write-version counters prevent out-of-order async writes from overwriting
  // newer data.  Each update bumps the counter; the .then() callback only
  // persists if its version still matches the latest.
  const hostsWriteVersion = useRef(0);
  const keysWriteVersion = useRef(0);
  const identitiesWriteVersion = useRef(0);
  const proxyProfilesWriteVersion = useRef(0);
  const snippetsWriteVersion = useRef(0);
  // Tracks the latest local updateSnippets schedule. Storage events also bump
  // snippetsWriteVersion (to invalidate naive writers), so queued saves must
  // key supersede checks off this owner instead of that shared counter.
  const snippetsWriteOwnerRef = useRef(0);
  // Last persisted ancestor for in-flight updateSnippets rebases. Superseded
  // saves must not advance this to an optimistic in-memory array that never
  // landed on disk — that would make a local add look like a concurrent delete.
  const snippetsWriteBaseRef = useRef<Snippet[] | null>(null);
  // Outstanding clear/restore/import replace must survive a superseding local
  // save. Otherwise the later owner rebases additively against the old disk
  // catalog and resurrects every pre-replacement snippet.
  const snippetsWriteReplaceRef = useRef(false);
  const customGroupsWriteVersion = useRef(0);
  const groupConfigsWriteVersion = useRef(0);
  // Encrypt-phase promises can always be awaited, even under the vault lock.
  // Full write promises include lock acquisition and must only be awaited when
  // this window does not already hold that lock (otherwise writers deadlock).
  const hostsEncryptPendingRef = useRef<Promise<unknown>>(Promise.resolve());
  const keysEncryptPendingRef = useRef<Promise<unknown>>(Promise.resolve());
  const identitiesEncryptPendingRef = useRef<Promise<unknown>>(Promise.resolve());
  const groupConfigsEncryptPendingRef = useRef<Promise<unknown>>(Promise.resolve());
  const hostsWritePendingRef = useRef<Promise<unknown>>(Promise.resolve());
  const keysWritePendingRef = useRef<Promise<unknown>>(Promise.resolve());
  const identitiesWritePendingRef = useRef<Promise<unknown>>(Promise.resolve());
  const groupConfigsWritePendingRef = useRef<Promise<unknown>>(Promise.resolve());
  const snippetsWritePendingRef = useRef<Promise<unknown>>(Promise.resolve());

  const waitForPendingVaultWrites = useCallback(async () => {
    while (true) {
      const encryptPending = [
        hostsEncryptPendingRef.current,
        keysEncryptPendingRef.current,
        identitiesEncryptPendingRef.current,
        groupConfigsEncryptPendingRef.current,
      ];
      await Promise.all(encryptPending);
      if (isVaultImportLockHeld("vault")) {
        if (
          encryptPending[0] === hostsEncryptPendingRef.current
          && encryptPending[1] === keysEncryptPendingRef.current
          && encryptPending[2] === identitiesEncryptPendingRef.current
          && encryptPending[3] === groupConfigsEncryptPendingRef.current
        ) return;
        continue;
      }
      const writePending = [
        hostsWritePendingRef.current,
        keysWritePendingRef.current,
        identitiesWritePendingRef.current,
        groupConfigsWritePendingRef.current,
        snippetsWritePendingRef.current,
      ];
      await Promise.all(writePending);
      if (
        writePending[0] === hostsWritePendingRef.current
        && writePending[1] === keysWritePendingRef.current
        && writePending[2] === identitiesWritePendingRef.current
        && writePending[3] === groupConfigsWritePendingRef.current
        && writePending[4] === snippetsWritePendingRef.current
        && encryptPending[0] === hostsEncryptPendingRef.current
        && encryptPending[1] === keysEncryptPendingRef.current
        && encryptPending[2] === identitiesEncryptPendingRef.current
        && encryptPending[3] === groupConfigsEncryptPendingRef.current
      ) return;
    }
  }, []);

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
  const pluginCredentialCatalogVersion = useRef(0);

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

  // Encrypt outside the lock, then under the lock prune script bindings against
  // the latest snippet catalog so a queued full-array write cannot restore
  // login/connect ids cleared by a concurrent bulk-delete in another window.
  const commitEncryptedHostsUnderVaultLock = useCallback(async (
    ver: number,
    hostsToPersist: Host[],
    encrypted: Awaited<ReturnType<typeof encryptHosts>>,
  ) => {
    return withVaultImportLock("vault", async () => {
      if (ver !== hostsWriteVersion.current) return "superseded" as const;
      const latestSnippets = normalizeVaultOrder(
        readStoredArray<Snippet>(
          STORAGE_KEY_SNIPPETS,
          localStorageAdapter.readString(STORAGE_KEY_SNIPPETS),
        ),
      );
      const pruned = pruneHostsStaleSnippetBindings(hostsToPersist, latestSnippets);
      let payload = encrypted;
      if (pruned !== hostsToPersist) {
        const normalized = normalizeVaultOrder(pruned);
        payload = await encryptHosts(normalized);
        if (ver !== hostsWriteVersion.current) return "superseded" as const;
        hostsRef.current = normalized;
        setHosts(normalized);
      }
      return localStorageAdapter.write(STORAGE_KEY_HOSTS, payload)
        ? "written" as const
        : "failed" as const;
    });
  }, []);

  const updateHosts = useCallback((data: Host[] | ((prev: Host[]) => Host[])) => {
    // Keep object identity for hosts that did not actually change. Callers that
    // do `hosts.map(h => h.id === id ? patch(h) : h)` already pass through
    // unchanged refs; re-running sanitizeHost on every host would allocate new
    // objects for the whole vault and re-render every open terminal.
    const prev = hostsRef.current;
    const raw = typeof data === "function" ? data(prev) : data;
    const prevById = new Map(prev.map((host) => [host.id, host]));
    const cleaned = normalizeVaultOrder(raw.map((host) => {
      if (prevById.get(host.id) === host) return host;
      const sanitized = sanitizeHost(host);
      const existing = prevById.get(sanitized.id);
      if (existing && hostsEqualForIdentityReuse(existing, sanitized)) {
        return existing;
      }
      return sanitized;
    }));
    if (
      cleaned.length === prev.length
      && cleaned.every((host, index) => host === prev[index])
    ) {
      return Promise.resolve("unchanged" as const);
    }
    hostsRef.current = cleaned;
    setHosts(cleaned);
    const ver = ++hostsWriteVersion.current;
    // Encrypt outside the lock so importers that hold the lock can still wait
    // for in-flight encryption without deadlocking on lock acquisition.
    const encryptPromise = encryptHosts(cleaned);
    hostsEncryptPendingRef.current = encryptPromise.then(() => undefined);
    const writePromise = encryptPromise.then(async (enc) => {
      if (ver !== hostsWriteVersion.current) return "superseded" as const;
      return commitEncryptedHostsUnderVaultLock(ver, cleaned, enc);
    });
    hostsWritePendingRef.current = writePromise;
    return writePromise;
  }, [commitEncryptedHostsUnderVaultLock]);

  const readPersistedHosts = useCallback(async (): Promise<Host[]> => {
    // Always drain what is safe to wait for. Under the vault lock this is only
    // the encrypt phase; outside the lock it also waits for locked disk writes.
    await waitForPendingVaultWrites();
    while (true) {
      const rawHosts = localStorageAdapter.readString(STORAGE_KEY_HOSTS);
      const storedHosts = readStoredArray<Host>(STORAGE_KEY_HOSTS, rawHosts);
      const decrypted = await decryptHosts(storedHosts);
      if (localStorageAdapter.readString(STORAGE_KEY_HOSTS) !== rawHosts) continue;
      return normalizeVaultOrder(decrypted.map((host) => sanitizeHost(host)));
    }
  }, [waitForPendingVaultWrites]);

  const updateKeys = useCallback((data: SSHKey[]) => {
    const cleaned = normalizeVaultOrder(data);
    setKeys(cleaned);
    const ver = ++keysWriteVersion.current;
    const encryptPromise = encryptKeys(cleaned);
    keysEncryptPendingRef.current = encryptPromise.then(() => undefined);
    const writePromise = encryptPromise.then(async (enc) => {
      if (ver !== keysWriteVersion.current) return;
      return withVaultImportLock("vault", async () => {
        if (ver === keysWriteVersion.current)
          localStorageAdapter.write(STORAGE_KEY_KEYS, enc);
      });
    });
    keysWritePendingRef.current = writePromise;
    return writePromise;
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
    const encryptPromise = encryptKeys(updated);
    keysEncryptPendingRef.current = encryptPromise.then(() => undefined);
    const writePromise = encryptPromise.then(async (enc) => {
      if (ver !== keysWriteVersion.current) return;
      return withVaultImportLock("vault", async () => {
        if (ver === keysWriteVersion.current)
          localStorageAdapter.write(STORAGE_KEY_KEYS, enc);
      });
    });
    keysWritePendingRef.current = writePromise;
    return newKey;
  }, [keys]);

  const updateIdentities = useCallback((data: Identity[]) => {
    const cleaned = normalizeVaultOrder(data);
    setIdentities(cleaned);
    const ver = ++identitiesWriteVersion.current;
    const encryptPromise = encryptIdentities(cleaned);
    identitiesEncryptPendingRef.current = encryptPromise.then(() => undefined);
    const writePromise = encryptPromise.then(async (enc) => {
      if (ver !== identitiesWriteVersion.current) return;
      return withVaultImportLock("vault", async () => {
        if (ver === identitiesWriteVersion.current)
          localStorageAdapter.write(STORAGE_KEY_IDENTITIES, enc);
      });
    });
    identitiesWritePendingRef.current = writePromise;
    return writePromise;
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

  const updateSnippets = useCallback((
    data: Snippet[],
    options?: { replace?: boolean },
  ) => {
    // Capture the pre-update snapshot for a 3-way rebase once we hold the lock.
    // Callers pass a full array derived from this window's view; a popup delete
    // (or another window's import) may land on disk before our write runs.
    // Keep the first outstanding ancestor across superseded local saves so a
    // second edit does not rebase against the first save's optimistic memory.
    const replace =
      options?.replace === true || snippetsWriteReplaceRef.current;
    const base = snippetsWriteBaseRef.current ?? snippetsRef.current;
    if (options?.replace === true) {
      snippetsWriteReplaceRef.current = true;
    }
    if (replace) {
      // Restore/import/clear must not keep an additive ancestor — storage events
      // would otherwise merge disk-only ids back into memory while replace waits.
      // Keep this cleared when a later create/edit supersedes the replacement
      // owner so that save stays in replace mode instead of capturing []/restored
      // memory as an additive rebase base against the stale disk catalog.
      snippetsWriteBaseRef.current = null;
    } else if (snippetsWriteBaseRef.current === null) {
      snippetsWriteBaseRef.current = base;
    }
    const cleaned = normalizeVaultOrder(data);
    const ver = ++snippetsWriteVersion.current;
    snippetsWriteOwnerRef.current = ver;
    // Keep live snapshot ahead of React commit so same-tick readers (delete,
    // agent bridge) do not observe a stale pre-write array.
    snippetsRef.current = cleaned;
    setSnippets(cleaned);
    // Serialize with deleteSelectedSnippets / plugin importer under the shared
    // vault lock, then rebase onto the latest persisted snapshot so a queued
    // full-array write cannot resurrect concurrently deleted snippets (or drop
    // concurrent additions). Explicit replace (clear / sync restore / import)
    // skips the additive rebase so a concurrent disk-only add cannot survive.
    const writePromise = withVaultImportLock("vault", async () => {
      if (snippetsWriteOwnerRef.current !== ver) return "superseded" as const;
      const rebased = normalizeVaultOrder(
        replace
          ? cleaned
          : rebaseSnippetVaultWrite({
              base,
              ours: cleaned,
              theirs: normalizeVaultOrder(
                readStoredArray<Snippet>(
                  STORAGE_KEY_SNIPPETS,
                  localStorageAdapter.readString(STORAGE_KEY_SNIPPETS),
                ),
              ),
            }),
      );
      const persisted = localStorageAdapter.write(STORAGE_KEY_SNIPPETS, rebased);
      if (!persisted) {
        // Keep the pre-update ancestor. Clearing it here would make the next
        // save rebase against the optimistic array while disk still lacks the
        // add, so rebase would treat the add as a concurrent delete.
        notify.error(
          "Snippets could not be saved. Free some local storage space and try again.",
          "Scripts",
        );
        return "failed" as const;
      }
      // Disk caught up; next save should treat this write as its ancestor.
      snippetsWriteBaseRef.current = null;
      snippetsWriteReplaceRef.current = false;
      if (snippetsWriteOwnerRef.current === ver) {
        snippetsRef.current = rebased;
        setSnippets(rebased);
      }
      return "written" as const;
    });
    snippetsWritePendingRef.current = writePromise;
    return writePromise;
  }, []);

  // Cross-window safe: merge binding cleanup into the latest persisted
  // hosts/snippets under the shared vault lock. Popup terminals own a separate
  // useVaultState instance — writing hostsRef from that window can discard a
  // main-window host edit, or a storage-event version bump can cancel the host
  // write after snippets were already removed.
  const deleteSelectedSnippets = useCallback(async (selectedSnippetIds: ReadonlySet<string>) => {
    if (selectedSnippetIds.size === 0) {
      return {
        snippets: snippetsRef.current,
        hosts: hostsRef.current,
        deletedCount: 0,
      };
    }

    while (true) {
      await waitForPendingVaultWrites();
      const attempt = await withVaultImportLock("vault", async () => {
        const writeVersions = {
          hosts: hostsWriteVersion.current,
          snippets: snippetsWriteVersion.current,
        };
        const rawHosts = localStorageAdapter.readString(STORAGE_KEY_HOSTS);
        const rawSnippets = localStorageAdapter.readString(STORAGE_KEY_SNIPPETS);
        const storedHosts = readStoredArray<Host>(STORAGE_KEY_HOSTS, rawHosts);
        const storedSnippets = readStoredArray<Snippet>(STORAGE_KEY_SNIPPETS, rawSnippets);
        const latestHosts = normalizeVaultOrder(
          (await decryptHosts(storedHosts)).map((host) => sanitizeHost(host)),
        );
        const latestSnippets = normalizeVaultOrder(storedSnippets);
        const result = deleteSelectedSnippetsFromVault(
          latestSnippets,
          latestHosts,
          selectedSnippetIds,
        );
        if (result.deletedCount === 0) return result;

        const encryptedHosts = await encryptHosts(result.hosts);
        const changedWhilePreparing = (
          writeVersions.hosts !== hostsWriteVersion.current
          || writeVersions.snippets !== snippetsWriteVersion.current
          || localStorageAdapter.readString(STORAGE_KEY_HOSTS) !== rawHosts
          || localStorageAdapter.readString(STORAGE_KEY_SNIPPETS) !== rawSnippets
        );
        if (changedWhilePreparing) return null;

        ++hostsWriteVersion.current;
        ++snippetsWriteVersion.current;
        // Journaled pair write: a partial hosts/snippets persist would drop
        // login/connect bindings on restart while leaving the snippets behind.
        // Callers fire-and-forget this promise after closing the confirm dialog,
        // so storage rejection must not become an unhandled rejection.
        try {
          commitPluginImporterTransaction(localStorageAdapter, [
            [STORAGE_KEY_HOSTS, encryptedHosts],
            [STORAGE_KEY_SNIPPETS, result.snippets],
          ]);
        } catch {
          notify.error(
            "Snippets could not be deleted. Free some local storage space and try again.",
            "Scripts",
          );
          return {
            snippets: latestSnippets,
            hosts: latestHosts,
            deletedCount: 0,
          };
        }
        hostsRef.current = result.hosts;
        snippetsRef.current = result.snippets;
        // Persisted delete is the new ancestor; drop any stale rebase base from
        // a superseded/queued updateSnippets that never landed.
        snippetsWriteBaseRef.current = null;
        snippetsWriteReplaceRef.current = false;
        setHosts(result.hosts);
        setSnippets(result.snippets);
        hostsWritePendingRef.current = Promise.resolve("unchanged" as const);
        snippetsWritePendingRef.current = Promise.resolve("unchanged" as const);
        return result;
      });
      if (attempt !== null) return attempt;
    }
  }, [waitForPendingVaultWrites]);

  const updateSnippetPackages = useCallback((data: string[]) => {
    setSnippetPackages(data);
    localStorageAdapter.write(STORAGE_KEY_SNIPPET_PACKAGES, data);
  }, []);

  const updateNotes = useCallback((data: Partial<VaultNote>[]) => {
    const { notes: cleaned, persisted } = commitVaultNotesWrite({
      data,
      write: (key, value) => localStorageAdapter.write(key, value),
    });
    // Keep the in-session catalog updated so an autosave quota failure does not
    // snap the editor back to stale props and discard the user's draft. Disk
    // may still be behind — surface that explicitly.
    notesRef.current = cleaned;
    setNotes(cleaned);
    publishNotesSnapshot({ notes: cleaned, noteGroups: noteGroupsRef.current });
    if (!persisted) {
      const now = Date.now();
      // Debounced autosave can hit quota repeatedly; avoid toast spam.
      if (now - notesPersistFailureNotifiedAtRef.current > 10_000) {
        notesPersistFailureNotifiedAtRef.current = now;
        notify.error(
          "Notes could not be saved. Free some local storage space and try again.",
          "Notes",
        );
      }
      return false;
    }
    return true;
  }, []);

  const updateNoteGroups = useCallback((data: unknown) => {
    const cleaned = normalizeNoteGroups(data);
    noteGroupsRef.current = cleaned;
    setNoteGroups(cleaned);
    localStorageAdapter.write(STORAGE_KEY_NOTE_GROUPS, cleaned);
    publishNotesSnapshot({ notes: notesRef.current, noteGroups: cleaned });
  }, []);

  const updateCustomGroups = useCallback((
    data: string[] | ((current: string[]) => string[]),
  ) => {
    // Functional updates must see the latest in-memory snapshot. Storage may
    // still hold an older value while an encrypt+locked write is in flight.
    const next = typeof data === "function" ? data(customGroupsRef.current) : data;
    customGroupsRef.current = next;
    const groupsVer = ++customGroupsWriteVersion.current;
    setCustomGroups(next);

    const cleanedGroupConfigs = buildGroupConfigsForGroups(next, groupConfigs);
    setGroupConfigs(cleanedGroupConfigs);
    const configsVer = ++groupConfigsWriteVersion.current;
    const encryptPromise = encryptGroupConfigs(cleanedGroupConfigs);
    groupConfigsEncryptPendingRef.current = encryptPromise.then(() => undefined);
    const writePromise = encryptPromise.then(async (enc) => {
      return withVaultImportLock("vault", async () => {
        if (groupsVer === customGroupsWriteVersion.current) {
          localStorageAdapter.write(STORAGE_KEY_GROUPS, next);
        }
        if (configsVer === groupConfigsWriteVersion.current)
          localStorageAdapter.write(STORAGE_KEY_GROUP_CONFIGS, enc);
      });
    });
    groupConfigsWritePendingRef.current = writePromise;
  }, [groupConfigs]);

  const updateKnownHosts = useCallback((data: KnownHost[]) => {
    const cleaned = normalizeVaultOrder(data);
    setKnownHosts(cleaned);
    localStorageAdapter.write(STORAGE_KEY_KNOWN_HOSTS, cleaned);
  }, []);

  const updateManagedSources = useCallback((
    data: ManagedSource[] | ((current: ManagedSource[]) => ManagedSource[]),
  ) => {
    const next = typeof data === "function" ? data(managedSourcesRef.current) : data;
    managedSourcesRef.current = next;
    setManagedSources(next);
    void withVaultImportLock("vault", async () => {
      // Latest ref wins if another update ran while waiting for the lock.
      if (managedSourcesRef.current !== next) return;
      localStorageAdapter.write(STORAGE_KEY_MANAGED_SOURCES, next);
    });
  }, []);

  const readPersistedManagedSources = useCallback((): ManagedSource[] => (
    readStoredArray<ManagedSource>(
      STORAGE_KEY_MANAGED_SOURCES,
      localStorageAdapter.readString(STORAGE_KEY_MANAGED_SOURCES),
    )
  ), []);

  const commitVaultImportTransaction = useCallback(async (
    nextHosts: Host[],
    updateGroups: (current: string[]) => string[],
    updateSources: (current: ManagedSource[]) => ManagedSource[],
    updateGroupConfigs?: (current: GroupConfig[]) => GroupConfig[],
    expectedHosts?: Host[],
    lock?: VaultLockHandle | null,
  ): Promise<
    | {
      status: "persisted";
      groups: string[];
      sources: ManagedSource[];
      groupConfigs: GroupConfig[];
    }
    | { status: "superseded" }
  > => {
    // Hold the shared lock for the entire check → encrypt → write path so no
    // ordinary vault save can interleave. Callers already inside withVaultImportLock
    // must pass the active lock handle to continue without re-acquiring.
    const runCommit = async (): Promise<
      | {
        status: "persisted";
        groups: string[];
        sources: ManagedSource[];
        groupConfigs: GroupConfig[];
      }
      | { status: "superseded" }
    > => {
      const version = hostsWriteVersion.current;
      const groupConfigsVersion = groupConfigsWriteVersion.current;
      const cleanedHosts = normalizeVaultOrder(nextHosts.map((host) => sanitizeHost(host)));
      const baselineRaw = new Map([
        [STORAGE_KEY_HOSTS, localStorageAdapter.readString(STORAGE_KEY_HOSTS)],
        [STORAGE_KEY_GROUPS, localStorageAdapter.readString(STORAGE_KEY_GROUPS)],
        [STORAGE_KEY_MANAGED_SOURCES, localStorageAdapter.readString(STORAGE_KEY_MANAGED_SOURCES)],
        [STORAGE_KEY_GROUP_CONFIGS, localStorageAdapter.readString(STORAGE_KEY_GROUP_CONFIGS)],
      ]);
      const groups = updateGroups(readStoredArray<string>(
        STORAGE_KEY_GROUPS,
        baselineRaw.get(STORAGE_KEY_GROUPS) ?? null,
      ));
      const sources = updateSources(readStoredArray<ManagedSource>(
        STORAGE_KEY_MANAGED_SOURCES,
        baselineRaw.get(STORAGE_KEY_MANAGED_SOURCES) ?? null,
      ));
      const storedGroupConfigs = readStoredArray<GroupConfig>(
        STORAGE_KEY_GROUP_CONFIGS,
        baselineRaw.get(STORAGE_KEY_GROUP_CONFIGS) ?? null,
      );
      const storedHosts = readStoredArray<Host>(
        STORAGE_KEY_HOSTS,
        baselineRaw.get(STORAGE_KEY_HOSTS) ?? null,
      );
      const [latestPersistedHosts, latestGroupConfigs] = await Promise.all([
        decryptHosts(storedHosts).then((decrypted) => (
          normalizeVaultOrder(decrypted.map((host) => sanitizeHost(host)))
        )),
        decryptGroupConfigs(storedGroupConfigs),
      ]);
      if (
        version !== hostsWriteVersion.current
        || groupConfigsVersion !== groupConfigsWriteVersion.current
      ) {
        return { status: "superseded" };
      }
      if (expectedHosts) {
        const normalizedExpectedHosts = normalizeVaultOrder(
          expectedHosts.map((host) => sanitizeHost(host)),
        );
        if (JSON.stringify(latestPersistedHosts) !== JSON.stringify(normalizedExpectedHosts)) {
          return { status: "superseded" };
        }
      }
      const nextGroupConfigs = buildGroupConfigsForGroups(
        groups,
        updateGroupConfigs?.(latestGroupConfigs) ?? latestGroupConfigs,
      );
      const [encryptedHosts, encryptedGroupConfigs] = await Promise.all([
        encryptHosts(cleanedHosts),
        encryptGroupConfigs(nextGroupConfigs),
      ]);
      if (
        version !== hostsWriteVersion.current
        || groupConfigsVersion !== groupConfigsWriteVersion.current
        || [...baselineRaw].some(([key, value]) => localStorageAdapter.readString(key) !== value)
      ) {
        return { status: "superseded" };
      }
      const result = persistVaultImportMetadata(
        localStorageAdapter,
        () => groups,
        () => sources,
        [
          [STORAGE_KEY_HOSTS, encryptedHosts],
          [STORAGE_KEY_GROUP_CONFIGS, encryptedGroupConfigs],
        ],
      );
      ++hostsWriteVersion.current;
      ++customGroupsWriteVersion.current;
      ++groupConfigsWriteVersion.current;
      customGroupsRef.current = result.groups;
      managedSourcesRef.current = result.sources;
      setHosts(cleanedHosts);
      setCustomGroups(result.groups);
      setManagedSources(result.sources);
      setGroupConfigs(nextGroupConfigs);
      return {
        status: "persisted",
        groups: result.groups,
        sources: result.sources,
        groupConfigs: nextGroupConfigs,
      };
    };

    return withVaultImportLockIfNeeded("vault", runCommit, lock);
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
    const encryptPromise = encryptGroupConfigs(cleaned);
    groupConfigsEncryptPendingRef.current = encryptPromise.then(() => undefined);
    const writePromise = encryptPromise.then(async (enc) => {
      if (ver !== groupConfigsWriteVersion.current) return;
      return withVaultImportLock("vault", async () => {
        if (ver === groupConfigsWriteVersion.current)
          localStorageAdapter.write(STORAGE_KEY_GROUP_CONFIGS, enc);
      });
    });
    groupConfigsWritePendingRef.current = writePromise;
    return writePromise;
  }, []);

  const clearVaultData = useCallback(() => {
    updateHosts([]);
    updateKeys([]);
    updateIdentities([]);
    updateProxyProfiles([]);
    updateSnippets([], { replace: true });
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

  // Keep store in sync for storage-event / external setShellHistory paths.
  // Append/clear/load also publish synchronously so History never flashes empty.
  useLayoutEffect(() => {
    publishShellHistorySnapshot(shellHistory);
  }, [shellHistory]);

  // Notes catalog for Notes / AI side panels — keep TerminalLayer off the hot path.
  useLayoutEffect(() => {
    publishNotesSnapshot({ notes, noteGroups });
  }, [notes, noteGroups]);

  useLayoutEffect(() => {
    registerNotesActions({ updateNotes, updateNoteGroups });
    return () => {
      registerNotesActions(null);
    };
  }, [updateNotes, updateNoteGroups]);

  const addShellHistoryEntry = useCallback(
    (entry: Omit<ShellHistoryEntry, "id" | "timestamp">) => {
      setShellHistory((prev) => {
        const updated = mergeGlobalHistoryOnAppend(prev, entry);
        if (updated === prev) return prev;
        // Persist immediately so crash between commit and layout effect cannot drop history.
        // Store republish is also done in useLayoutEffect for load/storage-event paths.
        localStorageAdapter.write(STORAGE_KEY_SHELL_HISTORY, updated);
        return updated;
      });
    },
    [],
  );

  const clearShellHistory = useCallback(() => {
    setShellHistory([]);
    localStorageAdapter.write(STORAGE_KEY_SHELL_HISTORY, []);
    publishShellHistorySnapshot([]);
  }, []);

  const removeShellHistoryEntry = useCallback((entryId: string) => {
    setShellHistory((prev) => {
      const updated = removeGlobalHistoryEntry(prev, entryId);
      if (updated === prev) return prev;
      localStorageAdapter.write(STORAGE_KEY_SHELL_HISTORY, updated);
      publishShellHistorySnapshot(updated);
      return updated;
    });
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

  // Connection logs for Vault logs section — keep App domain bags off session churn.
  useLayoutEffect(() => {
    publishConnectionLogsSnapshot({ connectionLogs });
  }, [connectionLogs]);

  useLayoutEffect(() => {
    registerConnectionLogsActions({
      updateConnectionLog,
      toggleConnectionLogSaved,
      deleteConnectionLog,
      clearUnsavedConnectionLogs,
    });
    return () => {
      registerConnectionLogsActions(null);
    };
  }, [
    updateConnectionLog,
    toggleConnectionLogSaved,
    deleteConnectionLog,
    clearUnsavedConnectionLogs,
  ]);

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
      const encryptPromise = encryptHosts(updated);
      hostsEncryptPendingRef.current = encryptPromise.then(() => undefined);
      const writePromise = encryptPromise.then(async (enc) => {
        if (ver !== hostsWriteVersion.current) return;
        return commitEncryptedHostsUnderVaultLock(ver, updated, enc);
      });
      hostsWritePendingRef.current = writePromise;
      return updated;
    });

    return newHost;
  }, [commitEncryptedHostsUnderVaultLock, hosts]);

  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      try {
        await withVaultImportLock("vault", async () => {
          recoverPluginImporterTransaction(localStorageAdapter, PLUGIN_IMPORT_TRANSACTION_KEYS);
        });
        if (cancelled) return;
        const savedHosts = localStorageAdapter.read<Host[]>(STORAGE_KEY_HOSTS);

        if (savedHosts) {
          // Capture version before the async gap so that any write occurring
          // during decryption (storage event, user edit) advances the counter
          // and causes this stale result to be discarded.
          const ver = ++hostsWriteVersion.current;
          const decrypted = await decryptHosts(savedHosts);
          if (cancelled) return;
          if (ver === hostsWriteVersion.current) {
            const sanitized = normalizeVaultOrder(
              migrateHostsFromLegacyLineTimestamps(
                decrypted.map((host) => sanitizeHost(host)),
                readLegacyLineTimestampsEnabled(),
              ),
            );
            hostsRef.current = sanitized;
            setHosts(sanitized);
            // Always re-encrypt the batch. Stale enc:v1 placeholders are left
            // unchanged by encryptCredentialValue (no double-wrap); plaintext
            // siblings still need encryption when safeStorage was previously
            // unavailable for some records. Route through the locked writer so
            // a concurrent snippet delete can prune login/connect bindings
            // before this migration blob lands.
            const encryptPromise = encryptHosts(sanitized);
            hostsEncryptPendingRef.current = encryptPromise.then(() => undefined);
            const writePromise = encryptPromise.then(async (enc) => {
              if (ver !== hostsWriteVersion.current) return;
              return commitEncryptedHostsUnderVaultLock(ver, sanitized, enc);
            });
            hostsWritePendingRef.current = writePromise;
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
          if (cancelled) return;
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
          if (cancelled) return;
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
          if (cancelled) return;
          if (proxyVer === proxyProfilesWriteVersion.current) {
            const orderedProfiles = normalizeVaultOrder(decryptedProfiles);
            setProxyProfiles(orderedProfiles);
            encryptProxyProfiles(orderedProfiles).then((enc) => {
              if (proxyVer === proxyProfilesWriteVersion.current)
                localStorageAdapter.write(STORAGE_KEY_PROXY_PROFILES, enc);
            });
          }
        }

        if (cancelled) return;

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
          snippetsRef.current = orderedSnippets;
          setSnippets(orderedSnippets);
          // Persist order backfill only when fields changed. Never rewrite the
          // pre-lock snapshot unlocked: another renderer can delete under the
          // vault lock after this read and before this write, resurrecting
          // snippets while host-binding cleanup stays committed. Re-normalize
          // the live disk catalog under the same lock as deleteSelectedSnippets.
          const needsOrderPersist = orderedSnippets.some(
            (snippet, index) => snippet !== savedSnippets[index],
          );
          if (needsOrderPersist) {
            const ver = ++snippetsWriteVersion.current;
            snippetsWriteOwnerRef.current = ver;
            const writePromise = withVaultImportLock("vault", async () => {
              if (snippetsWriteOwnerRef.current !== ver) return "superseded" as const;
              const latest = normalizeVaultOrder(
                readStoredArray<Snippet>(
                  STORAGE_KEY_SNIPPETS,
                  localStorageAdapter.readString(STORAGE_KEY_SNIPPETS),
                ),
              );
              const persisted = localStorageAdapter.write(STORAGE_KEY_SNIPPETS, latest);
              if (!persisted) {
                notify.error(
                  "Snippets could not be saved. Free some local storage space and try again.",
                  "Scripts",
                );
                return "failed" as const;
              }
              if (snippetsWriteOwnerRef.current === ver) {
                snippetsRef.current = latest;
                setSnippets(latest);
              }
              return "written" as const;
            });
            snippetsWritePendingRef.current = writePromise;
          }
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
          publishShellHistorySnapshot(savedShellHistory);
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
          if (cancelled) return;
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
        // StrictMode remount cancels the first init; only the surviving effect
        // may publish "vault ready" or terminals can boot against empty keys.
        if (!cancelled) {
          setIsInitialized(true);
          setVaultInitialized(true);
        }
      }
    };

    void init();
    return () => {
      cancelled = true;
    };
  }, [commitEncryptedHostsUnderVaultLock, updateHosts, updateSnippets]);

  useEffect(() => {
    if (!isInitialized) return;
    const version = ++pluginCredentialCatalogVersion.current;
    void pluginExtensionBridge.updateCredentialCatalog([]).then(async () => {
      if (version !== pluginCredentialCatalogVersion.current) return;
      const [encryptedIdentities, encryptedKeys] = await Promise.all([
        encryptIdentities(identities),
        encryptKeys(keys),
      ]);
      if (version !== pluginCredentialCatalogVersion.current) return;
      const catalog = new Map<string, string | null>();
      const addCredential = (id: string, ciphertext: string | undefined) => {
        if (id.length < 16 || id.length > 256 || !isEncryptedCredentialPlaceholder(ciphertext)) return;
        if (catalog.has(id)) catalog.set(id, null);
        else catalog.set(id, ciphertext);
      };
      for (const identity of encryptedIdentities) {
        addCredential(identity.id, identity.password);
      }
      for (const key of encryptedKeys) {
        addCredential(key.id, key.privateKey);
      }
      const entries = [...catalog.entries()].flatMap(([id, ciphertext]) => (
        ciphertext ? [{ id, ciphertext }] : []
      ));
      if (version === pluginCredentialCatalogVersion.current) {
        await pluginExtensionBridge.updateCredentialCatalog(entries);
      }
    }).catch(() => {
      // Plugin development mode and OS-backed encryption are both optional.
      // Clearing happens before asynchronous preparation so removed or stale
      // Vault credentials cannot remain usable if encryption/update fails.
    });
  }, [identities, isInitialized, keys]);

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
            setHosts(normalizeVaultOrder(dec.map((host) => sanitizeHost(host))));
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
        // StorageEvent.newValue is the value at fire time. A peer write can be
        // delivered only after this window's replace already committed and
        // cleared snippetsWriteReplaceRef — adopting that older payload would
        // resurrect the pre-replacement catalog in memory (and on the next edit).
        if (event.newValue !== localStorageAdapter.readString(STORAGE_KEY_SNIPPETS)) {
          return;
        }
        const next = normalizeVaultOrder(safeParse<Snippet[]>(event.newValue) ?? []);
        // Invalidate write-version readers, but do not clear snippetsWriteOwnerRef:
        // an in-flight updateSnippets rebases onto this disk snapshot under the
        // vault lock instead of being cancelled (which would drop local edits).
        ++snippetsWriteVersion.current;
        const pendingBase = snippetsWriteBaseRef.current;
        if (pendingBase !== null) {
          // A queued local save still owns an outstanding ancestor. Replacing
          // optimistic state with the remote snapshot (and clearing that base)
          // would make the next local edit derive from remote-only and drop the
          // first mutation when it supersedes the queued owner.
          const merged = normalizeVaultOrder(
            rebaseSnippetVaultWrite({
              base: pendingBase,
              ours: snippetsRef.current,
              theirs: next,
            }),
          );
          snippetsRef.current = merged;
          setSnippets(merged);
          return;
        }
        if (snippetsWriteReplaceRef.current) {
          // Clear/restore/import left base null while replace is outstanding.
          // Adopting the remote catalog here would pollute memory; a later local
          // edit would still run in replace mode and overwrite disk with the old
          // catalog plus that edit.
          return;
        }
        snippetsRef.current = next;
        setSnippets(next);
        return;
      }

      if (key === STORAGE_KEY_GROUPS) {
        const next = safeParse<string[]>(event.newValue) ?? [];
        ++customGroupsWriteVersion.current;
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
        publishShellHistorySnapshot(next);
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
      const idx = prev.findIndex((h) => h.id === hostId);
      if (idx < 0) return prev;
      const now = Date.now();
      if (prev[idx].lastConnectedAt === now) return prev;
      const next = prev.slice();
      next[idx] = { ...prev[idx], lastConnectedAt: now };
      const ver = ++hostsWriteVersion.current;
      const encryptPromise = encryptHosts(next);
      hostsEncryptPendingRef.current = encryptPromise.then(() => undefined);
      const writePromise = encryptPromise.then(async (enc) => {
        if (ver !== hostsWriteVersion.current) return;
        return commitEncryptedHostsUnderVaultLock(ver, next, enc);
      });
      hostsWritePendingRef.current = writePromise;
      return next;
    });
  }, [commitEncryptedHostsUnderVaultLock]);

  const updateHostDistro = useCallback((hostId: string, distro: string) => {
    const normalized = normalizeDistroId(distro);
    setHosts((prev) => {
      const next = prev.map((h) =>
        h.id === hostId ? { ...h, distro: normalized } : h,
      );
      const ver = ++hostsWriteVersion.current;
      const encryptPromise = encryptHosts(next);
      hostsEncryptPendingRef.current = encryptPromise.then(() => undefined);
      const writePromise = encryptPromise.then(async (enc) => {
        if (ver !== hostsWriteVersion.current) return;
        return commitEncryptedHostsUnderVaultLock(ver, next, enc);
      });
      hostsWritePendingRef.current = writePromise;
      return next;
    });
  }, [commitEncryptedHostsUnderVaultLock]);

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
      if (payload.snippets) {
        // Full-snapshot restore/import must replace, not additive-rebase; otherwise
        // a concurrent disk-only snippet survives and the restore looks incomplete.
        encryptedWrites.push(
          updateSnippets(payload.snippets, { replace: true }).then(() => undefined),
        );
      }
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

  const commitPluginImporterData = useCallback(async ({
    drafts,
    destination,
  }: PluginImporterCommitRequest): Promise<number> => {
    while (true) {
      // Drain in-flight encrypt work outside the lock so concurrent edits can
      // finish encrypting (and later write) without deadlocking on acquisition.
      await waitForPendingVaultWrites();
      const attempt = await withVaultImportLock("vault", async () => {
        const writeVersions = {
          hosts: hostsWriteVersion.current,
          keys: keysWriteVersion.current,
          identities: identitiesWriteVersion.current,
          snippets: snippetsWriteVersion.current,
          groups: customGroupsWriteVersion.current,
          groupConfigs: groupConfigsWriteVersion.current,
        };
        const raw = new Map(
          [...PLUGIN_IMPORT_TRANSACTION_KEYS].map((key) => [key, localStorageAdapter.readString(key)]),
        );
        const storedHosts = readStoredArray<Host>(
          STORAGE_KEY_HOSTS,
          raw.get(STORAGE_KEY_HOSTS) ?? null,
        );
        const storedKeys = readStoredArray<SSHKey>(
          STORAGE_KEY_KEYS,
          raw.get(STORAGE_KEY_KEYS) ?? null,
        );
        const storedIdentities = readStoredArray<Identity>(
          STORAGE_KEY_IDENTITIES,
          raw.get(STORAGE_KEY_IDENTITIES) ?? null,
        );
        const storedSnippets = readStoredArray<Snippet>(
          STORAGE_KEY_SNIPPETS,
          raw.get(STORAGE_KEY_SNIPPETS) ?? null,
        );
        const storedGroups = readStoredArray<string>(
          STORAGE_KEY_GROUPS,
          raw.get(STORAGE_KEY_GROUPS) ?? null,
        );
        const storedGroupConfigs = readStoredArray<GroupConfig>(
          STORAGE_KEY_GROUP_CONFIGS,
          raw.get(STORAGE_KEY_GROUP_CONFIGS) ?? null,
        );
        const [latestHosts, latestKeys, latestIdentities, latestGroupConfigs] = await Promise.all([
          decryptHosts(storedHosts),
          decryptKeys(storedKeys),
          decryptIdentities(storedIdentities),
          decryptGroupConfigs(storedGroupConfigs),
        ]);
        const merged = mergePluginImporterDrafts({
          hosts: normalizeVaultOrder(latestHosts.map((host) => sanitizeHost(host))),
          keys: normalizeVaultOrder(latestKeys),
          identities: normalizeVaultOrder(latestIdentities),
          snippets: normalizeVaultOrder(storedSnippets),
          customGroups: storedGroups,
        }, drafts);
        const committed = applyPluginImporterDestination(
          merged,
          latestHosts.length,
          destination,
          storedGroups,
          {
            identities: latestIdentities.length,
            keys: latestKeys.length,
          },
        );
        const nextHosts = normalizeVaultOrder(committed.hosts.map((host) => sanitizeHost(host)));
        const nextKeys = normalizeVaultOrder(committed.keys);
        const nextIdentities = normalizeVaultOrder(committed.identities);
        const nextSnippets = normalizeVaultOrder(committed.snippets);
        const nextGroups = [...committed.customGroups];
        const groupOrderByPath = new Map(
          nextGroups.map((groupPath, index) => [groupPath, (index + 1) * 1000]),
        );
        const existingConfigByPath = new Map(
          latestGroupConfigs.map((config) => [config.path, config]),
        );
        const nextGroupConfigs = normalizeVaultOrder([
          ...nextGroups.map((groupPath) => sanitizeGroupConfig({
            ...(existingConfigByPath.get(groupPath) ?? { path: groupPath }),
            path: groupPath,
            order: groupOrderByPath.get(groupPath),
          })),
          ...latestGroupConfigs
            .filter((config) => !groupOrderByPath.has(config.path))
            .map(sanitizeGroupConfig),
        ]);
        const [encryptedHosts, encryptedKeys, encryptedIdentities, encryptedGroupConfigs] = await Promise.all([
          encryptHosts(nextHosts),
          encryptKeys(nextKeys),
          encryptIdentities(nextIdentities),
          encryptGroupConfigs(nextGroupConfigs),
        ]);
        // Do not wait for pending writers here — they may be queued on this lock.
        const changedWhilePreparing = (
          writeVersions.hosts !== hostsWriteVersion.current
          || writeVersions.keys !== keysWriteVersion.current
          || writeVersions.identities !== identitiesWriteVersion.current
          || writeVersions.snippets !== snippetsWriteVersion.current
          || writeVersions.groups !== customGroupsWriteVersion.current
          || writeVersions.groupConfigs !== groupConfigsWriteVersion.current
          || [...PLUGIN_IMPORT_TRANSACTION_KEYS].some(
            (key) => localStorageAdapter.readString(key) !== raw.get(key),
          )
        );
        if (changedWhilePreparing) return null;

        ++hostsWriteVersion.current;
        ++keysWriteVersion.current;
        ++identitiesWriteVersion.current;
        ++snippetsWriteVersion.current;
        ++customGroupsWriteVersion.current;
        ++groupConfigsWriteVersion.current;
        commitPluginImporterTransaction(localStorageAdapter, [
          [STORAGE_KEY_HOSTS, encryptedHosts],
          [STORAGE_KEY_KEYS, encryptedKeys],
          [STORAGE_KEY_IDENTITIES, encryptedIdentities],
          [STORAGE_KEY_SNIPPETS, nextSnippets],
          [STORAGE_KEY_GROUPS, nextGroups],
          [STORAGE_KEY_GROUP_CONFIGS, encryptedGroupConfigs],
        ]);
        customGroupsRef.current = nextGroups;
        snippetsRef.current = nextSnippets;
        snippetsWriteBaseRef.current = null;
        snippetsWriteReplaceRef.current = false;
        setHosts(nextHosts);
        setKeys(nextKeys);
        setIdentities(nextIdentities);
        setSnippets(nextSnippets);
        setCustomGroups(nextGroups);
        setGroupConfigs(nextGroupConfigs);
        return committed.addedCount;
      });
      if (attempt !== null) return attempt;
      // Concurrent memory edits advanced write versions; release and retry so
      // their locked disk writes can complete first.
    }
  }, [waitForPendingVaultWrites]);

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
    readPersistedHosts,
    updateKeys,
    importOrReuseKey,
    updateIdentities,
    updateProxyProfiles,
    updateSnippets,
    deleteSelectedSnippets,
    updateSnippetPackages,
    updateNotes,
    updateNoteGroups,
    updateCustomGroups,
    updateKnownHosts,
    updateManagedSources,
    readPersistedManagedSources,
    commitVaultImportTransaction,
    updateGroupConfigs,
    addShellHistoryEntry,
    clearShellHistory,
    removeShellHistoryEntry,
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
    commitPluginImporterData,
    clearVaultData,
  };
};
