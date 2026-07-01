import test from "node:test";
import assert from "node:assert/strict";

import type { SyncPayload } from "../domain/sync.ts";
import type { KnownHost } from "../domain/models.ts";
import type { SyncableVaultData } from "./syncPayload.ts";

type LocalStorageMock = {
  clear(): void;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

function installLocalStorage(): LocalStorageMock {
  const store = new Map<string, string>();
  const localStorage: LocalStorageMock = {
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
    removeItem(key: string) {
      store.delete(key);
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: localStorage,
    configurable: true,
  });
  return localStorage;
}

const localStorage = installLocalStorage();
const {
  applyLocalVaultPayload,
  applySyncPayload,
  buildLocalVaultPayload,
  buildCloudSyncPayload,
  buildSyncPayload,
  hasCloudSyncEntityData,
  hasMeaningfulCloudSyncData,
  shouldPromptCloudVaultRecovery,
  SYNCABLE_SETTING_STORAGE_KEYS,
} = await import("./syncPayload.ts");
const storageKeys = await import("../infrastructure/config/storageKeys.ts");

const knownHost = (id = "kh-1"): KnownHost => ({
  id,
  hostname: `${id}.example.com`,
  port: 22,
  keyType: "ssh-ed25519",
  publicKey: `SHA256:${id}`,
  discoveredAt: 1,
});

const vault = (knownHosts: KnownHost[] = [knownHost()]): SyncableVaultData => ({
  hosts: [],
  keys: [],
  identities: [],
  snippets: [],
  customGroups: [],
  snippetPackages: [],
  notes: [],
  noteGroups: [],
  knownHosts,
  groupConfigs: [],
});

test.beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(globalThis, "window", {
    value: {
      dispatchEvent: () => true,
    },
    configurable: true,
  });
});

test("buildSyncPayload treats known hosts as local-only data", () => {
  const payload = buildSyncPayload(vault([knownHost("kh-cloud")]));

  assert.equal("knownHosts" in payload, false);
});

test("buildSyncPayload includes reusable proxy profiles", () => {
  const proxyProfiles = [
    {
      id: "proxy-1",
      label: "Office Proxy",
      config: { type: "socks5", host: "proxy.example.com", port: 1080 },
      createdAt: 1,
      updatedAt: 1,
    },
  ];

  const payload = buildSyncPayload({
    ...vault(),
    proxyProfiles,
  } as SyncableVaultData & { proxyProfiles: typeof proxyProfiles });

  assert.deepEqual(payload.proxyProfiles, proxyProfiles);
});

test("buildCloudSyncPayload includes notes and note groups", async () => {
  const payload = await buildCloudSyncPayload({
    ...vault([]),
    notes: [{
      id: "note-1",
      title: "Runbook",
      content: "# Runbook",
      createdAt: 1,
      updatedAt: 1,
    }],
    noteGroups: ["Ops"],
  });

  assert.equal(payload.notes?.length, 1);
  assert.equal(payload.notes?.[0]?.title, "Runbook");
  assert.deepEqual(payload.noteGroups, ["Ops"]);
});

test("buildSyncPayload includes AI configuration settings", () => {
  const providers = [{
    id: "openai-main",
    providerId: "openai",
    name: "OpenAI",
    apiKey: "enc:v1:test",
    defaultModel: "gpt-test",
    enabled: true,
  }];
  const webSearch = {
    providerId: "tavily",
    apiKey: "enc:v1:web",
    enabled: true,
    maxResults: 7,
  };

  localStorage.setItem(storageKeys.STORAGE_KEY_AI_PROVIDERS, JSON.stringify(providers));
  localStorage.setItem(storageKeys.STORAGE_KEY_AI_ACTIVE_PROVIDER, "openai-main");
  localStorage.setItem(storageKeys.STORAGE_KEY_AI_ACTIVE_MODEL, "gpt-test");
  localStorage.setItem(storageKeys.STORAGE_KEY_AI_PERMISSION_MODE, "auto");
  localStorage.setItem(storageKeys.STORAGE_KEY_AI_TOOL_INTEGRATION_MODE, "skills");
  localStorage.setItem(storageKeys.STORAGE_KEY_AI_DEFAULT_AGENT, "codex");
  localStorage.setItem(storageKeys.STORAGE_KEY_AI_COMMAND_BLOCKLIST, JSON.stringify(["rm -rf"]));
  localStorage.setItem(storageKeys.STORAGE_KEY_AI_COMMAND_TIMEOUT, "120");
  localStorage.setItem(storageKeys.STORAGE_KEY_AI_MAX_ITERATIONS, "10");
  localStorage.setItem(storageKeys.STORAGE_KEY_AI_AGENT_MODEL_MAP, JSON.stringify({ codex: "gpt-test" }));
  localStorage.setItem(storageKeys.STORAGE_KEY_AI_AGENT_PROVIDER_MAP, JSON.stringify({ catty: "openai-main" }));
  localStorage.setItem(storageKeys.STORAGE_KEY_AI_WEB_SEARCH, JSON.stringify(webSearch));
  localStorage.setItem(storageKeys.STORAGE_KEY_AI_SHOW_TERMINAL_SELECTION_ACTION, "false");

  const payload = buildSyncPayload(vault([]));

  assert.deepEqual(payload.settings?.ai, {
    providers,
    activeProviderId: "openai-main",
    activeModelId: "gpt-test",
    globalPermissionMode: "auto",
    toolIntegrationMode: "skills",
    defaultAgentId: "codex",
    commandBlocklist: ["rm -rf"],
    commandTimeout: 120,
    maxIterations: 10,
    agentModelMap: { codex: "gpt-test" },
    agentProviderMap: { catty: "openai-main" },
    webSearchConfig: webSearch,
    showTerminalSelectionAction: false,
  });
});

test("terminal selection AI preference is syncable for auto-sync detection", () => {
  assert.ok(
    (SYNCABLE_SETTING_STORAGE_KEYS as readonly string[]).includes(
      storageKeys.STORAGE_KEY_AI_SHOW_TERMINAL_SELECTION_ACTION,
    ),
  );
});

test("terminal side panel auto-open settings are syncable for auto-sync detection", () => {
  assert.ok(
    (SYNCABLE_SETTING_STORAGE_KEYS as readonly string[]).includes(
      storageKeys.STORAGE_KEY_TERMINAL_SIDE_PANEL_AUTO_OPEN,
    ),
  );
  assert.ok(
    (SYNCABLE_SETTING_STORAGE_KEYS as readonly string[]).includes(
      storageKeys.STORAGE_KEY_TERMINAL_SIDE_PANEL_AUTO_OPEN_TAB,
    ),
  );
});

test("buildSyncPayload includes host tree sidebar visibility setting", () => {
  localStorage.setItem(storageKeys.STORAGE_KEY_SHOW_HOST_TREE_SIDEBAR, "false");
  localStorage.setItem(storageKeys.STORAGE_KEY_TERMINAL_SIDE_PANEL_AUTO_OPEN, "true");
  localStorage.setItem(storageKeys.STORAGE_KEY_TERMINAL_SIDE_PANEL_AUTO_OPEN_TAB, "scripts");

  const payload = buildSyncPayload(vault([]));

  assert.equal(payload.settings?.showHostTreeSidebar, false);
  assert.equal(payload.settings?.terminalSidePanelAutoOpen, true);
  assert.equal(payload.settings?.terminalSidePanelAutoOpenTab, "scripts");
});

test("buildSyncPayload excludes externalAgents (device-local OS-bound config)", () => {
  localStorage.setItem(storageKeys.STORAGE_KEY_AI_EXTERNAL_AGENTS, JSON.stringify([
    { id: "codex", name: "Codex", command: "/opt/homebrew/bin/codex", enabled: true },
  ]));

  const payload = buildSyncPayload(vault([]));

  assert.equal("ai" in (payload.settings ?? {}), false);
});

test("buildSyncPayload omits device-bound encrypted AI API keys", () => {
  localStorage.setItem(storageKeys.STORAGE_KEY_AI_PROVIDERS, JSON.stringify([{
    id: "openai-main",
    providerId: "openai",
    name: "OpenAI",
    apiKey: "enc:v1:djEwAAAA",
    enabled: true,
  }]));
  localStorage.setItem(storageKeys.STORAGE_KEY_AI_WEB_SEARCH, JSON.stringify({
    providerId: "tavily",
    apiKey: "enc:v1:djEwAAAA",
    enabled: true,
  }));

  const payload = buildSyncPayload(vault([]));

  assert.equal("apiKey" in (payload.settings?.ai?.providers?.[0] ?? {}), false);
  assert.equal("apiKey" in (payload.settings?.ai?.webSearchConfig ?? {}), false);
});

test("buildCloudSyncPayload includes decrypted AI API keys for portable cloud sync", async () => {
  Object.defineProperty(globalThis, "window", {
    value: {
      netcatty: {
        credentialsDecrypt: async (value: string) => {
          if (value === "enc:v1:djEwPROVIDER") return "sk-provider";
          if (value === "enc:v1:djEwWEB") return "sk-web";
          return value;
        },
      },
    },
    configurable: true,
  });

  localStorage.setItem(storageKeys.STORAGE_KEY_AI_PROVIDERS, JSON.stringify([{
    id: "openai-main",
    providerId: "openai",
    name: "OpenAI",
    apiKey: "enc:v1:djEwPROVIDER",
    enabled: true,
  }]));
  localStorage.setItem(storageKeys.STORAGE_KEY_AI_WEB_SEARCH, JSON.stringify({
    providerId: "tavily",
    apiKey: "enc:v1:djEwWEB",
    enabled: true,
  }));

  const payload = await buildCloudSyncPayload(vault([]));

  assert.equal(payload.settings?.ai?.providers?.[0]?.apiKey, "sk-provider");
  assert.equal(payload.settings?.ai?.webSearchConfig?.apiKey, "sk-web");
});

test("buildCloudSyncPayload fails instead of deleting API keys when decrypt fails", async () => {
  Object.defineProperty(globalThis, "window", {
    value: {
      netcatty: {
        credentialsDecrypt: async (value: string) => value,
      },
    },
    configurable: true,
  });

  localStorage.setItem(storageKeys.STORAGE_KEY_AI_PROVIDERS, JSON.stringify([{
    id: "openai-main",
    providerId: "openai",
    name: "OpenAI",
    apiKey: "enc:v1:djEwPROVIDER",
    enabled: true,
  }]));

  await assert.rejects(
    () => buildCloudSyncPayload(vault([])),
    /Unable to decrypt AI API key/,
  );
});

test("applySyncPayload restores AI configuration settings", async () => {
  const providers = [{
    id: "anthropic-main",
    providerId: "anthropic",
    name: "Anthropic",
    apiKey: "enc:v1:test",
    enabled: true,
  }];
  const webSearch = {
    providerId: "exa",
    apiKey: "enc:v1:web",
    enabled: true,
  };

  const payload: SyncPayload = {
    hosts: [],
    keys: [],
    identities: [],
    snippets: [],
    customGroups: [],
    settings: {
      ai: {
        providers,
        activeProviderId: "anthropic-main",
        activeModelId: "claude-test",
        globalPermissionMode: "observer",
        toolIntegrationMode: "mcp",
        defaultAgentId: "claude",
        commandBlocklist: ["shutdown"],
        commandTimeout: 30,
        maxIterations: 5,
        agentModelMap: { claude: "claude-test" },
        agentProviderMap: { catty: "anthropic-main" },
        webSearchConfig: webSearch,
        showTerminalSelectionAction: false,
      },
    },
    syncedAt: 1,
  } as SyncPayload;

  await applySyncPayload(payload, { importVaultData: () => {} });

  assert.deepEqual(JSON.parse(localStorage.getItem(storageKeys.STORAGE_KEY_AI_PROVIDERS)!), providers);
  assert.equal(localStorage.getItem(storageKeys.STORAGE_KEY_AI_ACTIVE_PROVIDER), "anthropic-main");
  assert.equal(localStorage.getItem(storageKeys.STORAGE_KEY_AI_ACTIVE_MODEL), "claude-test");
  assert.equal(localStorage.getItem(storageKeys.STORAGE_KEY_AI_PERMISSION_MODE), "observer");
  assert.equal(localStorage.getItem(storageKeys.STORAGE_KEY_AI_TOOL_INTEGRATION_MODE), "mcp");
  assert.equal(localStorage.getItem(storageKeys.STORAGE_KEY_AI_DEFAULT_AGENT), "claude");
  assert.deepEqual(JSON.parse(localStorage.getItem(storageKeys.STORAGE_KEY_AI_COMMAND_BLOCKLIST)!), ["shutdown"]);
  assert.equal(localStorage.getItem(storageKeys.STORAGE_KEY_AI_COMMAND_TIMEOUT), "30");
  assert.equal(localStorage.getItem(storageKeys.STORAGE_KEY_AI_MAX_ITERATIONS), "5");
  assert.deepEqual(JSON.parse(localStorage.getItem(storageKeys.STORAGE_KEY_AI_AGENT_MODEL_MAP)!), { claude: "claude-test" });
  assert.deepEqual(JSON.parse(localStorage.getItem(storageKeys.STORAGE_KEY_AI_AGENT_PROVIDER_MAP)!), { catty: "anthropic-main" });
  assert.deepEqual(JSON.parse(localStorage.getItem(storageKeys.STORAGE_KEY_AI_WEB_SEARCH)!), webSearch);
  assert.equal(localStorage.getItem(storageKeys.STORAGE_KEY_AI_SHOW_TERMINAL_SELECTION_ACTION), "false");
});

test("applySyncPayload encrypts synced plaintext AI API keys before saving locally", async () => {
  Object.defineProperty(globalThis, "window", {
    value: {
      netcatty: {
        credentialsEncrypt: async (value: string) => `enc:v1:djEwLOCAL_${value}`,
      },
      dispatchEvent: () => true,
    },
    configurable: true,
  });

  const payload: SyncPayload = {
    hosts: [],
    keys: [],
    identities: [],
    snippets: [],
    customGroups: [],
    settings: {
      ai: {
        providers: [
          { id: "openai-main", providerId: "openai", name: "OpenAI", apiKey: "sk-provider", enabled: true },
        ],
        webSearchConfig: { providerId: "tavily", apiKey: "sk-web", enabled: true },
      },
    },
    syncedAt: 1,
  } as SyncPayload;

  await applySyncPayload(payload, { importVaultData: () => {} });

  const provider = JSON.parse(localStorage.getItem(storageKeys.STORAGE_KEY_AI_PROVIDERS)!)[0];
  const webSearch = JSON.parse(localStorage.getItem(storageKeys.STORAGE_KEY_AI_WEB_SEARCH)!);
  assert.equal(provider.apiKey, "enc:v1:djEwLOCAL_sk-provider");
  assert.equal(webSearch.apiKey, "enc:v1:djEwLOCAL_sk-web");
});

test("applySyncPayload restores host tree sidebar visibility setting", async () => {
  const payload: SyncPayload = {
    hosts: [],
    keys: [],
    identities: [],
    snippets: [],
    customGroups: [],
    settings: {
      showHostTreeSidebar: false,
      terminalSidePanelAutoOpen: true,
      terminalSidePanelAutoOpenTab: "scripts",
    },
    syncedAt: 1,
  } as SyncPayload;

  await applySyncPayload(payload, { importVaultData: () => {} });

  assert.equal(localStorage.getItem(storageKeys.STORAGE_KEY_SHOW_HOST_TREE_SIDEBAR), "false");
  assert.equal(localStorage.getItem(storageKeys.STORAGE_KEY_TERMINAL_SIDE_PANEL_AUTO_OPEN), "true");
  assert.equal(localStorage.getItem(storageKeys.STORAGE_KEY_TERMINAL_SIDE_PANEL_AUTO_OPEN_TAB), "scripts");
});

test("applySyncPayload dispatches a same-window AI-state-changed event so the open chat panel rehydrates", async () => {
  // Without this nudge, the apply path writes to localStorage but
  // `useAIState` (listening for `storage` events) never sees the changes
  // in the calling window — mounted UI keeps showing pre-sync data.
  const dispatched: Array<{ type: string; detail: unknown }> = [];
  const fakeWindow = {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent(event: Event) {
      dispatched.push({
        type: event.type,
        detail: (event as CustomEvent).detail,
      });
      return true;
    },
  };
  Object.defineProperty(globalThis, "window", { value: fakeWindow, configurable: true });
  try {
    localStorage.setItem(storageKeys.STORAGE_KEY_AI_AGENT_PROVIDER_MAP, JSON.stringify({ catty: "deepseek-local" }));
    localStorage.setItem(storageKeys.STORAGE_KEY_AI_AGENT_MODEL_MAP, JSON.stringify({ catty: "deepseek-v4-flash" }));

    const payload: SyncPayload = {
      hosts: [],
      keys: [],
      identities: [],
      snippets: [],
      customGroups: [],
      settings: {
        ai: {
          providers: [{ id: "openai-main", providerId: "openai", name: "OpenAI", enabled: true }],
        },
      },
      syncedAt: 1,
    } as SyncPayload;

    await applySyncPayload(payload, { importVaultData: () => {} });

    const events = dispatched.filter((e) => e.type === "netcatty:ai-state-changed");
    const keys = events.map((e) => (e.detail as { key?: string })?.key);
    assert.ok(keys.includes(storageKeys.STORAGE_KEY_AI_PROVIDERS), "providers nudge");
    assert.ok(keys.includes(storageKeys.STORAGE_KEY_AI_AGENT_PROVIDER_MAP), "agentProviderMap nudge");
    assert.ok(keys.includes(storageKeys.STORAGE_KEY_AI_AGENT_MODEL_MAP), "agentModelMap nudge");
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});

test("applySyncPayload prunes per-agent bindings that reference providers absent from the synced set", async () => {
  // Local state has Catty bound to a provider the incoming sync no longer
  // ships — both the per-agent provider override and the saved model should
  // be cleared so we don't dispatch a ghost provider id (or its now-orphan
  // model name) to the wrong endpoint.
  localStorage.setItem(storageKeys.STORAGE_KEY_AI_AGENT_PROVIDER_MAP, JSON.stringify({
    catty: "deepseek-local",
    codex: "openai-main",
  }));
  localStorage.setItem(storageKeys.STORAGE_KEY_AI_AGENT_MODEL_MAP, JSON.stringify({
    catty: "deepseek-v4-flash",
    codex: "gpt-test",
  }));

  const syncedProviders = [
    { id: "openai-main", providerId: "openai", name: "OpenAI", enabled: true },
  ];

  const payload: SyncPayload = {
    hosts: [],
    keys: [],
    identities: [],
    snippets: [],
    customGroups: [],
    settings: {
      ai: {
        providers: syncedProviders,
        // Intentionally omit agentProviderMap — exercises the reconcile path.
      },
    },
    syncedAt: 1,
  } as SyncPayload;

  await applySyncPayload(payload, { importVaultData: () => {} });

  assert.deepEqual(
    JSON.parse(localStorage.getItem(storageKeys.STORAGE_KEY_AI_AGENT_PROVIDER_MAP)!),
    { codex: "openai-main" },
  );
  // Catty's saved model belonged to the now-missing deepseek-local — drop it.
  // Codex's binding stays, so its saved model stays.
  assert.deepEqual(
    JSON.parse(localStorage.getItem(storageKeys.STORAGE_KEY_AI_AGENT_MODEL_MAP)!),
    { codex: "gpt-test" },
  );
});

test("applySyncPayload preserves local externalAgents and ignores legacy payload field", async () => {
  const localAgents = [
    { id: "codex", name: "Codex", command: "/usr/local/bin/codex", enabled: true },
  ];
  localStorage.setItem(storageKeys.STORAGE_KEY_AI_EXTERNAL_AGENTS, JSON.stringify(localAgents));

  const payload = {
    hosts: [],
    keys: [],
    identities: [],
    snippets: [],
    customGroups: [],
    settings: {
      ai: {
        // Legacy snapshot still carries externalAgents; current code must ignore it.
        externalAgents: [
          { id: "claude", name: "Claude", command: "C:\\Tools\\claude.exe", enabled: true },
        ],
      },
    },
    syncedAt: 1,
  } as unknown as SyncPayload;

  await applySyncPayload(payload, { importVaultData: () => {} });

  assert.deepEqual(
    JSON.parse(localStorage.getItem(storageKeys.STORAGE_KEY_AI_EXTERNAL_AGENTS)!),
    localAgents,
  );
});

test("applySyncPayload preserves local AI provider apiKeys when synced payload omits them", async () => {
  const localProviders = [
    {
      id: "openai-main",
      providerId: "openai",
      name: "OpenAI",
      apiKey: "enc:v1:djEwLOCAL",
      enabled: true,
    },
    {
      id: "anthropic-main",
      providerId: "anthropic",
      name: "Anthropic",
      apiKey: "enc:v1:djEwANTHROPIC",
      enabled: true,
    },
  ];
  localStorage.setItem(storageKeys.STORAGE_KEY_AI_PROVIDERS, JSON.stringify(localProviders));

  // Synced payload mirrors what `collectSyncableSettings` produces on another device:
  // metadata is preserved but encrypted device-bound apiKeys are stripped.
  const syncedProviders = [
    { id: "openai-main", providerId: "openai", name: "OpenAI (renamed)", enabled: true },
    { id: "anthropic-main", providerId: "anthropic", name: "Anthropic", enabled: false },
  ];

  const payload: SyncPayload = {
    hosts: [],
    keys: [],
    identities: [],
    snippets: [],
    customGroups: [],
    settings: { ai: { providers: syncedProviders } },
    syncedAt: 1,
  } as SyncPayload;

  await applySyncPayload(payload, { importVaultData: () => {} });

  const stored = JSON.parse(localStorage.getItem(storageKeys.STORAGE_KEY_AI_PROVIDERS)!);
  assert.deepEqual(stored, [
    {
      id: "openai-main",
      providerId: "openai",
      name: "OpenAI (renamed)",
      apiKey: "enc:v1:djEwLOCAL",
      enabled: true,
    },
    {
      id: "anthropic-main",
      providerId: "anthropic",
      name: "Anthropic",
      apiKey: "enc:v1:djEwANTHROPIC",
      enabled: false,
    },
  ]);
});

test("applySyncPayload prefers explicit synced apiKey over local apiKey", async () => {
  localStorage.setItem(storageKeys.STORAGE_KEY_AI_PROVIDERS, JSON.stringify([
    { id: "openai-main", providerId: "openai", name: "OpenAI", apiKey: "enc:v1:djEwLOCAL", enabled: true },
  ]));

  const payload: SyncPayload = {
    hosts: [],
    keys: [],
    identities: [],
    snippets: [],
    customGroups: [],
    settings: {
      ai: {
        providers: [
          { id: "openai-main", providerId: "openai", name: "OpenAI", apiKey: "plaintext-from-other-device", enabled: true },
        ],
      },
    },
    syncedAt: 1,
  } as SyncPayload;

  await applySyncPayload(payload, { importVaultData: () => {} });

  const stored = JSON.parse(localStorage.getItem(storageKeys.STORAGE_KEY_AI_PROVIDERS)!);
  assert.equal(stored[0].apiKey, "plaintext-from-other-device");
});

test("applySyncPayload preserves local web-search apiKey when synced config omits it", async () => {
  localStorage.setItem(storageKeys.STORAGE_KEY_AI_WEB_SEARCH, JSON.stringify({
    providerId: "tavily",
    apiKey: "enc:v1:djEwWEB",
    enabled: true,
    maxResults: 7,
  }));

  const payload: SyncPayload = {
    hosts: [],
    keys: [],
    identities: [],
    snippets: [],
    customGroups: [],
    settings: {
      ai: {
        webSearchConfig: { providerId: "tavily", enabled: false, maxResults: 12 },
      },
    },
    syncedAt: 1,
  } as SyncPayload;

  await applySyncPayload(payload, { importVaultData: () => {} });

  const stored = JSON.parse(localStorage.getItem(storageKeys.STORAGE_KEY_AI_WEB_SEARCH)!);
  assert.deepEqual(stored, {
    providerId: "tavily",
    apiKey: "enc:v1:djEwWEB",
    enabled: false,
    maxResults: 12,
  });
});

test("applySyncPayload drops local web-search apiKey when synced config switches provider", async () => {
  localStorage.setItem(storageKeys.STORAGE_KEY_AI_WEB_SEARCH, JSON.stringify({
    providerId: "tavily",
    apiKey: "enc:v1:djEwWEB",
    enabled: true,
  }));

  const payload: SyncPayload = {
    hosts: [],
    keys: [],
    identities: [],
    snippets: [],
    customGroups: [],
    settings: {
      ai: {
        webSearchConfig: { providerId: "exa", enabled: true },
      },
    },
    syncedAt: 1,
  } as SyncPayload;

  await applySyncPayload(payload, { importVaultData: () => {} });

  const stored = JSON.parse(localStorage.getItem(storageKeys.STORAGE_KEY_AI_WEB_SEARCH)!);
  assert.equal("apiKey" in stored, false);
  assert.equal(stored.providerId, "exa");
});

test("buildSyncPayload includes syncable terminal options from settings", () => {
  localStorage.setItem(storageKeys.STORAGE_KEY_TERM_FOLLOW_APP_THEME, "true");
  localStorage.setItem(storageKeys.STORAGE_KEY_TERM_SETTINGS, JSON.stringify({
    terminalEmulationType: "vt100",
    altAsMeta: true,
    middleClickBehavior: "context-menu",
    fontSmoothing: false,
    showServerStats: false,
    serverStatsRefreshInterval: 12,
    rendererType: "dom",
    localShell: "/bin/zsh",
  }));

  const payload = buildSyncPayload(vault([]));

  assert.equal(payload.settings?.followAppTerminalTheme, true);
  assert.deepEqual(payload.settings?.terminalSettings, {
    terminalEmulationType: "vt100",
    altAsMeta: true,
    middleClickBehavior: "context-menu",
    fontSmoothing: false,
    showServerStats: false,
    serverStatsRefreshInterval: 12,
    rendererType: "dom",
  });
});

test("hasMeaningfulCloudSyncData ignores legacy cloud known hosts", () => {
  assert.equal(
    hasMeaningfulCloudSyncData({
      hosts: [],
      keys: [],
      identities: [],
      snippets: [],
      customGroups: [],
      knownHosts: [knownHost("kh-only")],
      syncedAt: 1,
    }),
    false,
  );
});

test("hasCloudSyncEntityData ignores settings-only payloads for empty-vault recovery", () => {
  assert.equal(
    hasCloudSyncEntityData({
      hosts: [],
      keys: [],
      identities: [],
      snippets: [],
      customGroups: [],
      settings: { theme: "system", terminalTheme: "default" },
      syncedAt: 1,
    }),
    false,
  );
});

test("shouldPromptCloudVaultRecovery ignores settings-only remote payloads", () => {
  const settingsOnlyPayload: SyncPayload = {
    hosts: [],
    keys: [],
    identities: [],
    snippets: [],
    customGroups: [],
    settings: { theme: "system", terminalTheme: "default" },
    syncedAt: 1,
  };

  assert.equal(
    shouldPromptCloudVaultRecovery(settingsOnlyPayload, settingsOnlyPayload),
    false,
  );
});

test("buildLocalVaultPayload preserves known hosts for local backups", () => {
  const payload = buildLocalVaultPayload(vault([knownHost("kh-local")]));

  assert.deepEqual(payload.knownHosts, [knownHost("kh-local")]);
});

test("buildLocalVaultPayload preserves local AI API keys for protective backups", () => {
  localStorage.setItem(storageKeys.STORAGE_KEY_AI_PROVIDERS, JSON.stringify([{
    id: "openai-main",
    providerId: "openai",
    name: "OpenAI",
    apiKey: "enc:v1:djEwPROVIDER",
    enabled: true,
  }]));
  localStorage.setItem(storageKeys.STORAGE_KEY_AI_WEB_SEARCH, JSON.stringify({
    providerId: "tavily",
    apiKey: "enc:v1:djEwWEB",
    enabled: true,
  }));

  const payload = buildLocalVaultPayload(vault([]));

  assert.equal(payload.settings?.ai?.providers?.[0]?.apiKey, "enc:v1:djEwPROVIDER");
  assert.equal(payload.settings?.ai?.webSearchConfig?.apiKey, "enc:v1:djEwWEB");
});

test("applySyncPayload ignores legacy cloud known hosts", async () => {
  let imported: Record<string, unknown> | null = null;
  const proxyProfiles = [
    {
      id: "proxy-1",
      label: "Office Proxy",
      config: { type: "socks5", host: "proxy.example.com", port: 1080 },
      createdAt: 1,
      updatedAt: 1,
    },
  ];
  const payload: SyncPayload = {
    hosts: [],
    keys: [],
    identities: [],
    snippets: [],
    customGroups: [],
    knownHosts: [knownHost("kh-legacy")],
    proxyProfiles,
    syncedAt: 1,
  } as SyncPayload & { proxyProfiles: typeof proxyProfiles };

  await applySyncPayload(payload, {
    importVaultData: (json) => {
      imported = JSON.parse(json);
    },
  });

  assert.ok(imported);
  assert.equal("knownHosts" in imported, false);
  assert.deepEqual(imported.proxyProfiles, proxyProfiles);
});

test("applySyncPayload keeps missing proxy references visible to connection guards", async () => {
  let imported: Record<string, unknown> | null = null;
  const payload: SyncPayload = {
    hosts: [{
      id: "host-1",
      label: "Host",
      hostname: "example.com",
      username: "root",
      tags: [],
      os: "linux",
      proxyProfileId: "missing-proxy",
    }],
    keys: [],
    identities: [],
    proxyProfiles: [],
    snippets: [],
    customGroups: [],
    groupConfigs: [{ path: "prod", proxyProfileId: "missing-proxy" }],
    syncedAt: 1,
  };

  await applySyncPayload(payload, {
    importVaultData: (json) => {
      imported = JSON.parse(json);
    },
  });

  assert.ok(imported);
  assert.equal((imported.hosts as SyncPayload["hosts"])[0]?.proxyProfileId, "missing-proxy");
  assert.equal((imported.groupConfigs as SyncPayload["groupConfigs"])?.[0]?.proxyProfileId, "missing-proxy");
});

test("applySyncPayload preserves host proxy references when group configs are absent", async () => {
  let imported: Record<string, unknown> | null = null;
  const payload: SyncPayload = {
    hosts: [{
      id: "host-1",
      label: "Host",
      hostname: "example.com",
      username: "root",
      tags: [],
      os: "linux",
      proxyProfileId: "missing-proxy",
    }],
    keys: [],
    identities: [],
    proxyProfiles: [],
    snippets: [],
    customGroups: [],
    syncedAt: 1,
  };

  await applySyncPayload(payload, {
    importVaultData: (json) => {
      imported = JSON.parse(json);
    },
  });

  assert.ok(imported);
  assert.equal((imported.hosts as SyncPayload["hosts"])[0]?.proxyProfileId, "missing-proxy");
  assert.equal("groupConfigs" in imported, false);
});

test("applySyncPayload migrates legacy global line timestamps onto hosts", async () => {
  let imported: Record<string, unknown> | null = null;
  const payload: SyncPayload = {
    hosts: [
      {
        id: "host-1",
        label: "Inherited",
        hostname: "example.com",
        username: "root",
        tags: [],
        os: "linux",
      },
      {
        id: "host-2",
        label: "Explicit",
        hostname: "example.net",
        username: "root",
        tags: [],
        os: "linux",
        showLineTimestamps: false,
      },
    ],
    keys: [],
    identities: [],
    proxyProfiles: [],
    snippets: [],
    customGroups: [],
    syncedAt: 1,
    settings: { terminalSettings: { showLineTimestamps: true } },
  };

  await applySyncPayload(payload, {
    importVaultData: (json) => {
      imported = JSON.parse(json);
    },
  });

  assert.ok(imported);
  const hosts = imported.hosts as SyncPayload["hosts"];
  assert.equal(hosts[0]?.showLineTimestamps, true);
  assert.equal(hosts[1]?.showLineTimestamps, false);
});

test("applySyncPayload waits for async vault imports", async () => {
  let finished = false;
  const payload: SyncPayload = {
    hosts: [],
    keys: [],
    identities: [],
    snippets: [],
    customGroups: [],
    syncedAt: 1,
  };

  const promise = applySyncPayload(payload, {
    importVaultData: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      finished = true;
    },
  });

  assert.equal(finished, false);
  await promise;
  assert.equal(finished, true);
});

test("buildSyncPayload includes fallbackFont when present in TERM_SETTINGS", () => {
  localStorage.setItem(
    storageKeys.STORAGE_KEY_TERM_SETTINGS,
    JSON.stringify({ scrollback: 5000, fallbackFont: "PingFang SC", fontLigatures: true }),
  );

  const payload = buildSyncPayload(vault());
  const termSettings = (payload.settings?.terminalSettings ?? {}) as Record<string, unknown>;
  assert.equal(termSettings.fallbackFont, "PingFang SC");
});

test("buildSyncPayload omits fallbackFont when TERM_SETTINGS does not set it", () => {
  localStorage.setItem(
    storageKeys.STORAGE_KEY_TERM_SETTINGS,
    JSON.stringify({ scrollback: 5000, fontLigatures: true }),
  );

  const payload = buildSyncPayload(vault());
  const termSettings = (payload.settings?.terminalSettings ?? {}) as Record<string, unknown>;
  assert.equal("fallbackFont" in termSettings, false);
});

test("applySyncPayload writes incoming fallbackFont into local TERM_SETTINGS", async () => {
  const payload: SyncPayload = {
    hosts: [],
    keys: [],
    identities: [],
    snippets: [],
    customGroups: [],
    syncedAt: 1,
    settings: { terminalSettings: { fallbackFont: "Sarasa Mono SC" } },
  };

  await applySyncPayload(payload, {
    importVaultData: () => {},
  });

  const raw = localStorage.getItem(storageKeys.STORAGE_KEY_TERM_SETTINGS);
  assert.ok(raw, "TERM_SETTINGS should be written");
  const parsed = JSON.parse(raw!);
  assert.equal(parsed.fallbackFont, "Sarasa Mono SC");
});

test("applySyncPayload lets legacy middle-click paste update the new middle-click behavior", async () => {
  localStorage.setItem(
    storageKeys.STORAGE_KEY_TERM_SETTINGS,
    JSON.stringify({
      scrollback: 2000,
      middleClickBehavior: "paste",
      middleClickPaste: true,
    }),
  );

  const payload: SyncPayload = {
    hosts: [],
    keys: [],
    identities: [],
    snippets: [],
    customGroups: [],
    syncedAt: 1,
    settings: {
      terminalSettings: {
        middleClickPaste: false,
      },
    },
  } as SyncPayload;

  await applySyncPayload(payload, {
    importVaultData: () => {},
  });

  const raw = localStorage.getItem(storageKeys.STORAGE_KEY_TERM_SETTINGS);
  assert.ok(raw, "TERM_SETTINGS should be written");
  const parsed = JSON.parse(raw!);
  assert.equal(parsed.scrollback, 2000);
  assert.equal(parsed.middleClickBehavior, "disabled");
  assert.equal(parsed.middleClickPaste, false);
});

test("applySyncPayload from legacy client (no fallbackFont) preserves local value", async () => {
  localStorage.setItem(
    storageKeys.STORAGE_KEY_TERM_SETTINGS,
    JSON.stringify({ scrollback: 5000, fallbackFont: "Microsoft YaHei UI" }),
  );

  const payload: SyncPayload = {
    hosts: [],
    keys: [],
    identities: [],
    snippets: [],
    customGroups: [],
    syncedAt: 1,
    settings: { terminalSettings: { scrollback: 9999 } },
  };

  await applySyncPayload(payload, {
    importVaultData: () => {},
  });

  const raw = localStorage.getItem(storageKeys.STORAGE_KEY_TERM_SETTINGS);
  const parsed = JSON.parse(raw!);
  assert.equal(parsed.fallbackFont, "Microsoft YaHei UI", "legacy payload must not wipe local fallbackFont");
  assert.equal(parsed.scrollback, 9999);
});

test("applyLocalVaultPayload restores known hosts from local backups", async () => {
  let imported: Record<string, unknown> | null = null;
  const payload: SyncPayload = {
    hosts: [],
    keys: [],
    identities: [],
    snippets: [],
    customGroups: [],
    knownHosts: [knownHost("kh-backup")],
    syncedAt: 1,
  };

  await applyLocalVaultPayload(payload, {
    importVaultData: (json) => {
      imported = JSON.parse(json);
    },
  });

  assert.ok(imported);
  assert.deepEqual(imported.knownHosts, [knownHost("kh-backup")]);
});
