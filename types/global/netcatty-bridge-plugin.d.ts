declare global {
  interface NetcattyPluginRuntimeStatus {
    available: boolean;
    experimental: true;
    credentialStorageAvailable?: boolean;
  }

  interface NetcattyPluginCatalogSnapshot {
    entries: NetcattyPluginCatalogEntry[];
    source: "registry" | "cached" | "builtin";
    error: string | null;
  }

  interface NetcattyPluginCatalogEntry {
    selectionToken?: string;
    id: string;
    version: string;
    name: string;
    description: string;
    author: string;
    repository: string;
    commit: string;
    license: string;
    readme: string;
    manifest: import("@netcatty/plugin-contract").PluginManifest;
    artifact?: { url: string; sha256: string };
  }

  type NetcattyPluginAuthorRequest =
    | { kind: 'catalog'; pluginId: string; selectionToken: string; sourceId: string }
    | { kind: 'installed'; pluginId: string };
  interface NetcattyPluginAuthorPresentation {
    author: string;
    avatar: string | null;
    officialMaintained: boolean;
    sourceId: string;
    version: string;
    archiveSha256: string | null;
  }

  type PluginPermissionMode = 'allow' | 'ask' | 'deny';
  type NetcattyPluginPermissionPrompt = import('@netcatty/plugin-contract').PermissionRequest & {
    actionToken: string; resources: string[];
  };
  interface NetcattyPluginPermissionSnapshot {
    policyRevision?: string;
    policies?: Array<{ permission: string; resources: string[]; mode: PluginPermissionMode }>;
    grants: Array<{
      permission: string; resource: string; resourceKind: string;
      scope: 'always' | 'application' | 'session'; sessionId: string | null; grantedAt: number;
      matchesCurrentActivation: boolean;
    }>;
    audit: Array<{ event: string; createdAt: number; permission?: string; scope?: string; mode?: PluginPermissionMode; action?: string }>;
  }

  interface NetcattyPluginSource {
    id: string;
    kind: 'official' | 'third-party' | 'local' | 'github';
    name: string;
    origin: string | null;
    enabled?: boolean;
    tag?: string;
    commit?: string;
    assetId?: number;
  }
  interface NetcattyGitHubPluginPreview {
    token: string;
    source: NetcattyPluginSource;
    manifest: import("@netcatty/plugin-contract").PluginManifest;
    archiveSha256: string;
    assetName: string;
    size: number;
  }
  interface NetcattyInstalledPlugin {
    source?: NetcattyPluginSource;
    id: string;
    enabled: boolean;
    activeVersion: string | null;
    manifest: import("@netcatty/plugin-contract").PluginManifest | null;
    archiveSha256?: string | null;
    runtime: {
      status: string;
      kind: 'browser' | 'utility' | null;
      lastError: string | null;
      quarantinedAt: number | null;
    };
  }

  interface NetcattyExtensionProviderContribution {
    pluginId: string;
    pluginVersion: string;
    pluginDisplayName?: string;
    provider: import("@netcatty/plugin-contract").ProviderContribution;
  }

  interface NetcattyExtensionProviderRequest {
    providerId: string;
    kind: 'connection' | 'authentication' | 'importer';
    operation: string;
    requestId?: string;
    payload?: import("@netcatty/plugin-contract").JsonValue;
    deadlineMs?: number;
  }

  interface NetcattyPluginConnectionStartRequest {
    requestId?: string;
    sessionId: string;
    protocol?: string;
    hostLabel?: string;
    hostname?: string;
    providerId: string;
    configuration: import("@netcatty/plugin-contract").JsonValue;
    columns: number;
    rows: number;
    credential?: import("@netcatty/plugin-contract").CredentialRef | import("@netcatty/plugin-contract").SecretRef;
    authenticationProviderId?: string;
    sessionLog?: { enabled: boolean; directory: string; format: string; timestampsEnabled?: boolean };
    deadlineMs?: number;
  }

  interface NetcattyPluginImporterPreview {
    providerId: string;
    result: import("@netcatty/plugin-contract").ImporterParseResult;
    records: ReadonlyArray<import("@netcatty/plugin-contract").ImporterRecord>;
  }

  interface NetcattyPluginImporterProgressEvent {
    requestId: string;
    providerId: string;
    progress: Extract<import("@netcatty/plugin-contract").ImporterRecord, { type: "progress" }>;
  }

  interface NetcattyPluginAuthenticationChallengeOpenEvent {
    requestId: string;
    challengeRequestId: string;
    challenge: import("@netcatty/plugin-contract").AuthenticationChallenge;
  }

  interface NetcattyPluginAuthenticationChallengeCancelEvent {
    requestId: string;
    challengeRequestId: string;
    challengeId?: string;
    cancelled: true;
  }

  type NetcattyPluginAuthenticationChallengeEvent =
    | NetcattyPluginAuthenticationChallengeOpenEvent
    | NetcattyPluginAuthenticationChallengeCancelEvent;

  interface NetcattyPluginLogStatus {
    saveToDisk: boolean;
    verbose: boolean;
    droppedRecords: number;
    writeErrors: number;
    pendingBytes: number;
    maxBytes: number;
    retentionDays: number;
  }

  interface NetcattyBridge {
    getPluginLogStatus?(): Promise<NetcattyPluginLogStatus>;
    configurePluginLogs?(settings: { saveToDisk: boolean; verbose: boolean }): Promise<NetcattyPluginLogStatus>;
    openPluginLogFolder?(): Promise<NetcattyPluginLogStatus>;
    exportPluginLogs?(): Promise<NetcattyPluginLogStatus>;
    clearPluginLogs?(): Promise<NetcattyPluginLogStatus>;
    getPluginRuntimeStatus?(): Promise<NetcattyPluginRuntimeStatus>;
    getPluginSourceBinding?(pluginId: string): Promise<NetcattyPluginSource | null>;
    resetPluginSource?(pluginId: string, expectedSourceId: string): Promise<void>;
    listPluginSources?(): Promise<NetcattyPluginSource[]>;
    addPluginSource?(source: { name: string; address: string }): Promise<NetcattyPluginSource>;
    updatePluginSource?(source: { id: string; name: string; enabled: boolean }): Promise<NetcattyPluginSource>;
    removePluginSource?(id: string, disablePlugins: boolean): Promise<void>;
    listPluginCatalog?(sourceId?: string): Promise<NetcattyPluginCatalogSnapshot>;
    getPluginAuthorPresentation?(request: NetcattyPluginAuthorRequest): Promise<NetcattyPluginAuthorPresentation | null>;
    onPluginCatalogChanged?(callback: (event: { sourceId: string }) => void): () => void;
    getPluginCatalogReadme?(id: string, selectionToken?: string, sourceId?: string): Promise<string>;
    getPluginCatalogReadmeImages?(id: string, selectionToken?: string, sourceId?: string): Promise<Record<string, string>>;
    installCatalogPlugin?(id: string, selectionToken?: string, sourceId?: string, acceptedSourceId?: string): Promise<NetcattyInstalledPlugin>;
    setPluginAIHostReady?(ready: boolean): Promise<boolean>;
    setPluginAgentHostReady?(ready: boolean): Promise<boolean>;
    respondPluginAgentHost?(response: import("@netcatty/plugin-contract").PluginAgentHostResponse): Promise<boolean>;
    onPluginAgentHostRequest?(callback: (request: import("@netcatty/plugin-contract").PluginAgentHostRequest) => void): () => void;
    respondPluginAIHost?(response: import("@netcatty/plugin-contract").PluginAIHostResponse): Promise<boolean>;
    onPluginAIHostRequest?(callback: (request: import("@netcatty/plugin-contract").PluginAIHostRequest) => void): () => void;
    setPluginInteractionReady?(ready: boolean): Promise<boolean>;
    respondPluginInteraction?(response: import("@netcatty/plugin-contract").HostInteractionResponse): Promise<import("@netcatty/plugin-contract").HostInteractionReceipt>;
    onPluginInteraction?(callback: (event: import("@netcatty/plugin-contract").HostInteractionEvent) => void): () => void;
    listPlugins?(): Promise<NetcattyInstalledPlugin[]>;
    setPluginPermissionMode?(pluginId: string, permission: string, mode: PluginPermissionMode, policyRevision: string): Promise<boolean>;
    setPluginPermissionReady?(ready: boolean): Promise<boolean>;
    respondPluginPermission?(response: { requestId: string; actionToken: string; decision: 'allow' | 'deny' | 'cancel' }): Promise<boolean>;
    onPluginPermission?(callback: (event: NetcattyPluginPermissionPrompt | { requestId: string; closed: true }) => void): () => void;
    getPluginPermissions?(pluginId: string): Promise<NetcattyPluginPermissionSnapshot>;
    revokePluginPermissions?(pluginId: string): Promise<NetcattyInstalledPlugin>;
    installPluginPackage?(archivePath: string, options?: { enable?: boolean }): Promise<NetcattyInstalledPlugin>;
    prepareGitHubPlugin?(repository: string): Promise<NetcattyGitHubPluginPreview>;
    installGitHubPlugin?(token: string): Promise<NetcattyInstalledPlugin>;
    discardGitHubPlugin?(token: string): Promise<void>;
    setPluginEnabled?(pluginId: string, enabled: boolean): Promise<NetcattyInstalledPlugin>;
    restartPlugin?(pluginId: string): Promise<NetcattyInstalledPlugin>;
    uninstallPlugin?(pluginId: string): Promise<boolean>;
    setPluginTerminalTarget?(target: import("@netcatty/plugin-contract").HostTerminalTarget): Promise<boolean>;
    getPluginThemes?(): Promise<import("@netcatty/plugin-contract").ThemePackCatalog>;
    applyPluginTheme?(request: import("@netcatty/plugin-contract").ThemePackApplyRequest): Promise<import("@netcatty/plugin-contract").ThemePackCatalog>;
    onPluginThemesChanged?(callback: () => void): () => void;
    getPluginContributions?(options?: NetcattyPluginContributionQuery): Promise<NetcattyPluginContributionSnapshot>;
    getPluginBrandIcon?(pluginId: string): Promise<{ light: string; dark?: string } | null>;
    getPluginContributionIcon?(pluginId: string, icon: Extract<NetcattyPluginIconReference, { kind: 'package' }>): Promise<{ light: string; dark?: string }>;
    executePluginCommand?(command: string, args?: unknown, context?: Record<string, unknown>): Promise<unknown>;
    updatePluginSetting?(pluginId: string, settingId: string, value: unknown, scopeId?: string): Promise<{ restartRequired: boolean }>;
    resetPluginSetting?(pluginId: string, settingId: string, scopeId?: string): Promise<{ restartRequired: boolean }>;
    setPluginEnvironment?(environment: NetcattyPluginEnvironment): Promise<void>;
    listPluginTerminalProviders?(options: NetcattyTerminalProviderQuery): Promise<ReadonlyArray<NetcattyTerminalProviderContribution>>;
    providePluginTerminal?(request: NetcattyTerminalProviderRequest): Promise<ReadonlyArray<NetcattyTerminalProviderResult>>;
    cancelPluginTerminalRequest?(requestId: string): Promise<boolean>;
    publishPluginTerminalSessionEvent?(event: NetcattyTerminalSessionEvent): Promise<ReadonlyArray<{ pluginId: string; delivered: boolean }>>;
    listPluginExtensionProviders?(options: { kind: 'connection' | 'authentication' | 'importer' | 'sync'; locale?: string }): Promise<ReadonlyArray<NetcattyExtensionProviderContribution>>;
    updatePluginCredentialCatalog?(entries: ReadonlyArray<{ id: string; ciphertext: string }>): Promise<number>;
    invokePluginExtensionProvider?(request: NetcattyExtensionProviderRequest): Promise<import("@netcatty/plugin-contract").JsonValue>;
    cancelPluginExtensionRequest?(requestId: string): Promise<boolean>;
    pluginSyncConnect?(request: {
      requestId?: string;
      providerId: string;
      configuration?: unknown;
      credential?: unknown;
      deadlineMs?: number;
    }): Promise<{ account: { id: string; email?: string; name?: string; avatarUrl?: string } }>;
    pluginSyncDisconnect?(request: { requestId?: string; providerId: string; deadlineMs?: number }): Promise<null>;
    pluginSyncGetAccount?(request: { requestId?: string; providerId: string; deadlineMs?: number }): Promise<{
      account: { id: string; email?: string; name?: string; avatarUrl?: string } | null;
    }>;
    pluginSyncGetCapabilities?(request: { requestId?: string; providerId: string; deadlineMs?: number }): Promise<{
      revisions: boolean;
      conditionalWrites: boolean;
      atomicReplacement: boolean;
      maxObjectBytes?: number;
      maxObjects?: number;
    }>;
    pluginSyncReadObject?(request: {
      requestId?: string;
      providerId: string;
      key: string;
      preferStream?: boolean;
      deadlineMs?: number;
    }): Promise<{
      found: boolean;
      key: string;
      data?: Uint8Array | null;
      streamed?: boolean;
      transferId?: string;
      byteLength?: number;
      revision?: string;
      contentType?: string;
    }>;
    pluginSyncReadChunk?(request: {
      requestId: string;
      transferId: string;
      maxBytes?: number;
    }): Promise<{ chunk: Uint8Array; done: boolean }>;
    pluginSyncWriteObject?(request: {
      requestId?: string;
      providerId: string;
      key: string;
      data: Uint8Array;
      expectedRevision?: string | null;
      preferStream?: boolean;
      deadlineMs?: number;
    }): Promise<{ created: boolean; revision?: string }>;
    pluginSyncWriteBegin?(request: {
      requestId?: string;
      providerId: string;
      key: string;
      byteLength: number;
      expectedRevision?: string | null;
      deadlineMs?: number;
    }): Promise<{ transferId: string; windowBytes: number }>;
    pluginSyncWriteChunk?(request: {
      requestId: string;
      transferId: string;
      sequence: number;
      chunk: Uint8Array;
    }): Promise<{ accepted: number }>;
    pluginSyncWriteCommit?(request: {
      requestId: string;
      transferId: string;
    }): Promise<{ created: boolean; revision?: string }>;
    pluginSyncDeleteObject?(request: {
      requestId?: string;
      providerId: string;
      key: string;
      expectedRevision?: string;
      deadlineMs?: number;
    }): Promise<{ deleted: boolean }>;
    pluginSyncPutSecret?(request: {
      providerId: string;
      key: string;
      value: string;
    }): Promise<{ kind: 'secret'; id: string; key: string; created?: boolean }>;
    pluginSyncDeleteSecrets?(request: {
      providerId: string;
      keys?: string[];
    }): Promise<{ deleted: number }>;
    pluginSyncRestoreSecrets?(request: {
      providerId: string;
      keys: string[];
      discard?: boolean;
    }): Promise<{ restored: number; discarded?: number }>;
    collectPluginSyncSidecars?(): Promise<unknown>;
    applyPluginSyncSidecars?(bundle: unknown): Promise<{ applied: boolean; count?: number; entries?: unknown }>;
    pluginHostReady?(): boolean;
    startPluginConnection?(request: NetcattyPluginConnectionStartRequest): Promise<{ sessionId: string; providerId: string; status: 'connecting' | 'connected'; diagnostics: ReadonlyArray<import("@netcatty/plugin-contract").ProviderValidationIssue> }>;
    writePluginConnection?(sessionId: string, data: Uint8Array): Promise<void>;
    controlPluginConnection?(sessionId: string, operation: 'resize' | 'signal' | 'reconnect' | 'close' | 'getStatus', payload?: Record<string, unknown>): Promise<unknown>;
    detectPluginImporter?(request: { providerId: string; sample: Uint8Array; fileName?: string; mediaType?: string; deadlineMs?: number }): Promise<import("@netcatty/plugin-contract").ImporterDetectResult>;
    selectPluginImporterFile?(): Promise<{ selectionToken: string; fileName: string; sample: Uint8Array } | null>;
    releasePluginImporterFile?(selectionToken: string): Promise<boolean>;
    parsePluginImporterFile?(request: { requestId?: string; providerId: string; selectionToken: string; mediaType?: string; options?: import("@netcatty/plugin-contract").JsonValue; deadlineMs?: number }): Promise<NetcattyPluginImporterPreview>;
    onPluginImporterProgress?(callback: (event: NetcattyPluginImporterProgressEvent) => void): () => void;
    respondPluginAuthenticationChallenge?(response: {
      requestId: string;
      challengeRequestId: string;
      challengeId: string;
      response?: string | boolean | ReadonlyArray<string>;
      cancelled?: boolean;
    }): Promise<void>;
    onPluginAuthenticationChallenge?(callback: (event: NetcattyPluginAuthenticationChallengeEvent) => void): () => void;
    onPluginConnectionData?(callback: (event: { sessionId: string; data: Uint8Array }) => void): () => void;
    onPluginConnectionClosed?(callback: (event: { sessionId: string; reason: string }) => void): () => void;
    getPluginViewResource?(payload: import('@netcatty/plugin-contract').PluginViewResourceRequest): Promise<import('@netcatty/plugin-contract').PluginViewResourceResult>;
    openHostDrawnPluginView?(payload: NetcattyPluginViewOpenRequest): Promise<{ instanceId: string }>;
    closeHostDrawnPluginView?(instanceId: string): Promise<void>;
    sendHostDrawnPluginViewEvent?(instanceId: string, event: import('@netcatty/plugin-contract').HostDrawnViewEvent): Promise<void>;
    onHostDrawnPluginViewUpdate?(callback: (event: import('@netcatty/plugin-contract').HostDrawnViewMessage & { viewId: string }) => void): () => void;
    onPluginContributionsChanged?(callback: (event: { reason: string; pluginId: string | null; revision: number }) => void): () => void;
    onPluginViewClosed?(callback: (event: NetcattyPluginViewClosedEvent) => void): () => void;
    getPluginScopeCatalog?(): Promise<NetcattyPluginScopeCatalog>;
    setPluginScopeCatalog?(catalog: NetcattyPluginScopeCatalog): Promise<void>;
    onPluginScopeCatalogChanged?(callback: (catalog: NetcattyPluginScopeCatalog) => void): () => void;
  }

  interface NetcattyPluginContributionQuery {
    locale?: string;
    context?: Record<string, unknown>;
    menuContexts?: Partial<Record<string, Record<string, unknown>>>;
    scopeIds?: Partial<Record<'workspace' | 'host' | 'session' | 'device', string>>;
  }

  interface NetcattyPluginSettingContribution {
    group?: string;
    id: string;
    label: string;
    description?: string;
    placeholder?: string;
    control: string;
    scope: string;
    scopeId: string | null;
    value?: unknown;
    secret?: boolean;
    configured: boolean;
    visible: boolean;
    restartRequired?: boolean;
    required?: boolean;
    options?: ReadonlyArray<{ value: string; label: string; description?: string }>;
    minimum?: number;
    maximum?: number;
    step?: number;
    sortable?: boolean;
    valueSchema?: unknown;
  }

  type NetcattyPluginIconReference =
    | { kind: 'theme'; name: string }
    | { kind: 'package'; light: string; dark?: string };

  interface NetcattyPluginContributionSnapshot {
    locale: string;
    plugins: ReadonlyArray<{
      id: string;
      version: string;
      displayName: string;
      description: string;
      commands: ReadonlyArray<{ id: string; title: string; category?: string; description?: string; icon?: NetcattyPluginIconReference; enabled: boolean }>;
      keybindings: ReadonlyArray<{ command: string; key: string; mac?: string; linux?: string; windows?: string; args?: unknown; enabled: boolean }>;
      menus: ReadonlyArray<{
        id: string;
        command: string;
        alt?: string;
        location: string;
        title: string;
        visible: boolean;
        enabled: boolean;
        checked?: boolean;
        order?: number;
        group?: string;
        shortcut?: string;
        showKeybinding?: boolean;
        icon?: NetcattyPluginIconReference;
      }>;
      settings: ReadonlyArray<NetcattyPluginSettingContribution>;
      views: ReadonlyArray<{ id: string; title: string; location: string; icon?: NetcattyPluginIconReference; order?: number; visible: boolean }>;
    }>;
  }

  interface NetcattyPluginEnvironment {
    locale: string;
    theme: string;
    reducedMotion: boolean;
    highContrast: boolean;
    themeTokens?: Record<string, string>;
  }

  type NetcattyTerminalProviderKind =
    | 'terminal.completion'
    | 'terminal.decoration'
    | 'terminal.link'
    | 'terminal.hover'
    | 'terminal.matcher'
    | 'terminal.semantic'
    | 'terminal.prompt'
    | 'terminal.background'
    | 'terminal.theme';

  interface NetcattyTerminalProviderContribution {
    pluginId: string;
    pluginVersion: string;
    runtimeId?: string;
    pluginDisplayName: string;
    provider: {
      id: string;
      label: string;
      description?: string;
      kind: NetcattyTerminalProviderKind;
      capabilities?: ReadonlyArray<string>;
      configurationSchema?: unknown;
    };
  }

  interface NetcattyTerminalProviderQuery {
    kind: NetcattyTerminalProviderKind;
    locale?: string;
    preferredProviderIds?: ReadonlyArray<string>;
  }

  interface NetcattyTerminalSessionSnapshot {
    sessionId: string;
    hostId?: string;
    workspaceId?: string;
    protocol: string;
    status: 'connecting' | 'connected' | 'disconnected';
    cwd?: string;
    title?: string;
    shellType?: 'posix' | 'fish' | 'powershell' | 'cmd' | 'unknown';
    cols?: number;
    rows?: number;
    alternateScreen?: boolean;
  }

  interface NetcattyTerminalSessionEvent {
    type:
      | 'snapshot'
      | 'created'
      | 'connected'
      | 'reconnected'
      | 'cwdChanged'
      | 'titleChanged'
      | 'resized'
      | 'alternateScreenChanged'
      | 'commandSubmitted'
      | 'commandCompleted'
      | 'disconnected'
      | 'disposed';
    session: NetcattyTerminalSessionSnapshot;
    exitCode?: number;
  }

  interface NetcattyTerminalProviderRequest {
    requestId: string;
    kind: NetcattyTerminalProviderKind;
    operation: string;
    session: NetcattyTerminalSessionSnapshot;
    payload?: unknown;
    locale?: string;
    preferredProviderIds?: ReadonlyArray<string>;
    deadlineMs?: number;
  }

  type NetcattyTerminalProviderResult = {
    pluginId: string;
    pluginVersion: string;
    runtimeId?: string;
    providerId: string;
    kind: NetcattyTerminalProviderKind;
    requestId: string;
    status: 'ok';
    result: unknown;
  } | {
    pluginId: string;
    pluginVersion: string;
    runtimeId?: string;
    providerId: string;
    kind: NetcattyTerminalProviderKind;
    requestId: string;
    status: 'cancelled';
  } | {
    pluginId: string;
    pluginVersion: string;
    providerId: string;
    kind: NetcattyTerminalProviderKind;
    requestId: string;
    status: 'failed';
    error: { code: number; message: string; data?: unknown };
  };

  type NetcattyPluginViewOpenRequest = import('@netcatty/plugin-contract').HostDrawnViewOpenRequest;

  interface NetcattyPluginViewClosedEvent {
    instanceId: string;
    pluginId: string;
    viewId: string;
    reason: string;
  }

  type NetcattyPluginSettingScopeKind = 'workspace' | 'host' | 'session' | 'device';

  type NetcattyPluginScopeCatalog = Record<
    NetcattyPluginSettingScopeKind,
    ReadonlyArray<{ id: string; label: string }>
  >;

}

export {};
