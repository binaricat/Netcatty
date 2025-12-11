import { useCallback, useEffect, useState } from "react";
import { normalizeDistroId, sanitizeHost } from "../../domain/host";
import {
  Host,
  KeyCategory,
  KeySource,
  KnownHost,
  ShellHistoryEntry,
  Snippet,
  SSHKey,
} from "../../domain/models";
import {
  INITIAL_HOSTS,
  INITIAL_SNIPPETS,
} from "../../infrastructure/config/defaultData";
import {
  STORAGE_KEY_GROUPS,
  STORAGE_KEY_HOSTS,
  STORAGE_KEY_KEYS,
  STORAGE_KEY_KNOWN_HOSTS,
  STORAGE_KEY_SHELL_HISTORY,
  STORAGE_KEY_SNIPPET_PACKAGES,
  STORAGE_KEY_SNIPPETS,
} from "../../infrastructure/config/storageKeys";
import { localStorageAdapter } from "../../infrastructure/persistence/localStorageAdapter";

type ExportableVaultData = {
  hosts: Host[];
  keys: SSHKey[];
  snippets: Snippet[];
  customGroups: string[];
  knownHosts?: KnownHost[];
};

// Migration helper for old SSHKey format to new format
const migrateKey = (
  key: Partial<SSHKey> & { id: string; label: string },
): SSHKey => {
  return {
    id: key.id,
    label: key.label,
    type: key.type || "ED25519",
    privateKey: key.privateKey || "",
    publicKey: key.publicKey,
    certificate: key.certificate,
    passphrase: key.passphrase,
    savePassphrase: key.savePassphrase,
    source:
      key.source || ((key.privateKey ? "imported" : "generated") as KeySource),
    category:
      key.category ||
      ((key.certificate ? "certificate" : "key") as KeyCategory),
    credentialId: key.credentialId,
    rpId: key.rpId,
    created: key.created || Date.now(),
  };
};

export const useVaultState = () => {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [keys, setKeys] = useState<SSHKey[]>([]);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [customGroups, setCustomGroups] = useState<string[]>([]);
  const [snippetPackages, setSnippetPackages] = useState<string[]>([]);
  const [knownHosts, setKnownHosts] = useState<KnownHost[]>([]);
  const [shellHistory, setShellHistory] = useState<ShellHistoryEntry[]>([]);

  const updateHosts = useCallback((data: Host[]) => {
    const cleaned = data.map(sanitizeHost);
    setHosts(cleaned);
    localStorageAdapter.write(STORAGE_KEY_HOSTS, cleaned);
  }, []);

  const updateKeys = useCallback((data: SSHKey[]) => {
    setKeys(data);
    localStorageAdapter.write(STORAGE_KEY_KEYS, data);
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
      localStorageAdapter.write(STORAGE_KEY_HOSTS, updated);
      return updated;
    });

    return newHost;
  }, []);

  useEffect(() => {
    const savedHosts = localStorageAdapter.read<Host[]>(STORAGE_KEY_HOSTS);
    const savedKeys =
      localStorageAdapter.read<Partial<SSHKey>[]>(STORAGE_KEY_KEYS);
    const savedGroups = localStorageAdapter.read<string[]>(STORAGE_KEY_GROUPS);
    const savedSnippets =
      localStorageAdapter.read<Snippet[]>(STORAGE_KEY_SNIPPETS);
    const savedSnippetPackages = localStorageAdapter.read<string[]>(
      STORAGE_KEY_SNIPPET_PACKAGES,
    );

    if (savedHosts?.length) {
      const sanitized = savedHosts.map(sanitizeHost);
      setHosts(sanitized);
      localStorageAdapter.write(STORAGE_KEY_HOSTS, sanitized);
    } else {
      updateHosts(INITIAL_HOSTS);
    }

    // Migrate old keys to new format with source/category fields
    if (savedKeys?.length) {
      const migratedKeys = savedKeys.map((k) =>
        migrateKey(k as Partial<SSHKey>),
      );
      setKeys(migratedKeys);
      // Persist migrated keys
      localStorageAdapter.write(STORAGE_KEY_KEYS, migratedKeys);
    }

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
  }, [updateHosts, updateSnippets]);

  const updateHostDistro = useCallback((hostId: string, distro: string) => {
    const normalized = normalizeDistroId(distro);
    setHosts((prev) => {
      const next = prev.map((h) =>
        h.id === hostId ? { ...h, distro: normalized } : h,
      );
      localStorageAdapter.write(STORAGE_KEY_HOSTS, next);
      return next;
    });
  }, []);

  const exportData = useCallback(
    (): ExportableVaultData => ({
      hosts,
      keys,
      snippets,
      customGroups,
      knownHosts,
    }),
    [hosts, keys, snippets, customGroups, knownHosts],
  );

  const importData = useCallback(
    (payload: Partial<ExportableVaultData>) => {
      if (payload.hosts) updateHosts(payload.hosts);
      if (payload.keys) updateKeys(payload.keys);
      if (payload.snippets) updateSnippets(payload.snippets);
      if (payload.customGroups) updateCustomGroups(payload.customGroups);
      if (payload.knownHosts) updateKnownHosts(payload.knownHosts);
    },
    [
      updateHosts,
      updateKeys,
      updateSnippets,
      updateCustomGroups,
      updateKnownHosts,
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
    hosts,
    keys,
    snippets,
    customGroups,
    snippetPackages,
    knownHosts,
    shellHistory,
    updateHosts,
    updateKeys,
    updateSnippets,
    updateSnippetPackages,
    updateCustomGroups,
    updateKnownHosts,
    addShellHistoryEntry,
    clearShellHistory,
    updateHostDistro,
    convertKnownHostToHost,
    exportData,
    importDataFromString,
  };
};
