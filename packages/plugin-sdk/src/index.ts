import type {
  AuthenticationBeginPayload,
  AuthenticationResponsePayload,
  AuthenticationResult,
  ConnectionConfigurationPayload,
  ConnectionControlResult,
  ConnectionControlPayload,
  ConnectionOpenPayload,
  ConnectionOpenResult,
  ConnectionProbeResult,
  ConnectionResizePayload,
  ConnectionSignalPayload,
  ConnectionStatusResult,
  ConnectionValidateResult,
  CredentialRef,
  PluginNetworkRequest,
  PluginNetworkResponse,
  FeatureId,
  ImporterDetectPayload,
  ImporterDetectResult,
  ImporterParsePayload,
  ImporterParseResult,
  JsonValue,
  PluginErrorData,
  PluginErrorName,
  PluginId,
  ProviderKind,
  PluginWireErrorCode,
  RpcErrorObject,
  SecretLeaseRef,
  SecretRef,
  SemanticVersion,
  SyncCapabilitiesResult,
  SyncConnectPayload,
  SyncConnectResult,
  SyncDeleteObjectPayload,
  SyncDeleteObjectResult,
  SyncDisconnectPayload,
  SyncDisconnectResult,
  SyncGetAccountPayload,
  SyncGetAccountResult,
  SyncGetCapabilitiesPayload,
  SyncReadObjectPayload,
  SyncReadObjectResult,
  SyncWriteObjectPayload,
  SyncWriteObjectResult,
  TerminalSessionSnapshot,
  SharedTerminalSelection,
} from "@netcatty/plugin-contract";

export type * from "@netcatty/plugin-contract";

export interface Disposable {
  dispose(): void;
}

export type CancellationListener = () => void;

export interface CancellationToken {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: CancellationListener): Disposable;
}

export interface PluginLogger {
  debug(message: string, fields?: Readonly<Record<string, JsonValue>>): void;
  info(message: string, fields?: Readonly<Record<string, JsonValue>>): void;
  warn(message: string, fields?: Readonly<Record<string, JsonValue>>): void;
  error(message: string, fields?: Readonly<Record<string, JsonValue>>): void;
}

export interface PluginKeyValueStore {
  get<T extends JsonValue>(key: string): Promise<T | undefined>;
  set(key: string, value: JsonValue): Promise<void>;
  delete(key: string): Promise<void>;
  keys(options?: Readonly<{ prefix?: string }>): Promise<readonly string[]>;
}

export interface PluginSecretStore {
  get(key: string): Promise<SecretRef | undefined>;
  /** Reads plaintext of a secret previously stored by this plugin in its own encrypted namespace. */
  getPlaintext(key: string): Promise<string | undefined>;
  /** Alias for getPlaintext(key); strictly scoped to this plugin's own secrets, never Netcatty Vault credentials. */
  readOwn(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<SecretRef>;
  delete(key: string): Promise<void>;
}

export interface PluginSettingOptions {
  readonly scopeId?: string;
}

export interface PluginSettingChangeEvent {
  readonly settingId: string;
  readonly scope: string;
  readonly scopeId: string;
  readonly source: "host" | "plugin";
}

export interface PluginSettings {
  get<T extends JsonValue | SecretRef>(settingId: string, options?: PluginSettingOptions): Promise<T | undefined>;
  update(settingId: string, value: JsonValue, options?: PluginSettingOptions): Promise<Readonly<{ restartRequired: boolean }>>;
  onDidChange(listener: (event: PluginSettingChangeEvent) => void): Disposable;
}

export interface PluginCommandInvocation {
  readonly source: "host" | "plugin" | string;
  readonly context?: Readonly<Record<string, JsonValue>>;
}

export type PluginCommandHandler = (args: JsonValue | undefined, invocation: PluginCommandInvocation) => JsonValue | void | Promise<JsonValue | void>;

export interface PluginCommands {
  registerCommand(commandId: string, handler: PluginCommandHandler): Disposable;
  executeCommand<T extends JsonValue = JsonValue>(commandId: string, args?: JsonValue): Promise<T>;
}

export interface PluginFileDialogFilter {
  readonly name: string;
  readonly extensions: readonly string[];
}

export interface PluginOpenFileOptions {
  readonly title?: string;
  readonly filters?: readonly PluginFileDialogFilter[];
  readonly readAs?: "bytes" | "utf8";
  readonly maxBytes?: number;
}

export type PluginOpenFileResult<TData extends Uint8Array | string = Uint8Array | string> =
  | Readonly<{ cancelled: true }>
  | Readonly<{
      cancelled: false;
      name: string;
      size: number;
      handleId: string;
      data: TData;
    }>;

export interface PluginSaveFileOptions {
  readonly title?: string;
  readonly defaultName?: string;
  readonly filters?: readonly PluginFileDialogFilter[];
  readonly data: Uint8Array | ArrayBuffer | string;
  readonly encoding?: "base64" | "utf8";
}

export type PluginSaveFileResult =
  | Readonly<{ cancelled: true }>
  | Readonly<{
      cancelled: false;
      name: string;
      size: number;
      handleId: string;
    }>;

export interface PluginFileHandleWriteResult {
  readonly bytesWritten: number;
  readonly totalSize: number;
}

export interface PluginHostUI {
  quickPick(title: string, items: readonly import("@netcatty/plugin-contract").HostQuickPickItem[]): Promise<string | undefined>;
  /** Single-line text. The host rejects CR/LF in initial values and submitted responses. */
  input(title: string, initialValue?: string): Promise<string | undefined>;
  /** Shows a native host confirmation dialog and returns true only if confirmed. */
  confirm(options: Omit<import("@netcatty/plugin-contract").HostConfirmRequest, "kind">): Promise<boolean>;
  /** Opens an HTTPS URL in the OS browser after explicit host confirmation. */
  openExternalUrl(options: Omit<import("@netcatty/plugin-contract").HostOpenExternalUrlRequest, "kind">): Promise<boolean>;
  /** Opens a native OS file picker and returns contents + a revocable per-runtime file handle. */
  openFile(options?: PluginOpenFileOptions & Readonly<{ readAs: "utf8" }>): Promise<PluginOpenFileResult<string>>;
  openFile(options?: PluginOpenFileOptions & Readonly<{ readAs?: "bytes" }>): Promise<PluginOpenFileResult<Uint8Array>>;
  openFile(options?: PluginOpenFileOptions): Promise<PluginOpenFileResult>;
  /** Opens a native OS save dialog and writes atomically, returning a revocable per-runtime file handle. */
  saveFile(options: PluginSaveFileOptions): Promise<PluginSaveFileResult>;
  /** Reads from a previously user-picked file handle without re-prompting. */
  readFileHandle(handleId: string, options: Readonly<{ readAs: "utf8" }>): Promise<string>;
  readFileHandle(handleId: string, options?: Readonly<{ readAs?: "bytes" }>): Promise<Uint8Array>;
  readFileHandle(handleId: string, options?: Readonly<{ readAs?: "bytes" | "utf8" }>): Promise<Uint8Array | string>;
  /** Atomically writes back to a previously user-picked file handle without re-prompting. */
  writeFileHandle(handleId: string, data: Uint8Array | ArrayBuffer | string, options?: Readonly<{ encoding?: "base64" | "utf8" }>): Promise<PluginFileHandleWriteResult>;
  /** Releases a user-picked file handle. */
  closeFileHandle(handleId: string): Promise<void>;
}

export interface PluginVaultSftp {
  listDir(params: import("@netcatty/plugin-contract").VaultHostSftpPathParams, cancellationToken?: CancellationToken): Promise<import("@netcatty/plugin-contract").VaultHostSftpListResult>;
  stat(params: import("@netcatty/plugin-contract").VaultHostSftpPathParams, cancellationToken?: CancellationToken): Promise<import("@netcatty/plugin-contract").VaultHostSftpStatResult>;
  readFile(params: import("@netcatty/plugin-contract").VaultHostSftpReadParams, cancellationToken?: CancellationToken): Promise<import("@netcatty/plugin-contract").VaultHostSftpReadResult>;
  writeFile(params: import("@netcatty/plugin-contract").VaultHostSftpWriteParams, cancellationToken?: CancellationToken): Promise<import("@netcatty/plugin-contract").VaultHostSftpWriteResult>;
  mkdir(params: import("@netcatty/plugin-contract").VaultHostSftpPathParams, cancellationToken?: CancellationToken): Promise<Readonly<{ created: boolean }>>;
  delete(params: import("@netcatty/plugin-contract").VaultHostSftpDeleteParams, cancellationToken?: CancellationToken): Promise<Readonly<{ deleted: boolean }>>;
}

export interface PluginPortForwarding {
  list(): Promise<import("@netcatty/plugin-contract").PortForwardListResult>;
  create(params: import("@netcatty/plugin-contract").PortForwardCreateParams): Promise<import("@netcatty/plugin-contract").PortForwardActionResult>;
  start(params: import("@netcatty/plugin-contract").PortForwardRuleIdParams): Promise<import("@netcatty/plugin-contract").PortForwardActionResult>;
  stop(params: import("@netcatty/plugin-contract").PortForwardRuleIdParams): Promise<import("@netcatty/plugin-contract").PortForwardActionResult>;
  delete(params: import("@netcatty/plugin-contract").PortForwardRuleIdParams): Promise<import("@netcatty/plugin-contract").PortForwardActionResult>;
}

export interface PluginSnippets {
  list(params?: import("@netcatty/plugin-contract").SnippetListParams): Promise<import("@netcatty/plugin-contract").SnippetListResult>;
  get(params: import("@netcatty/plugin-contract").SnippetGetParams): Promise<Readonly<{ found: boolean; snippet?: import("@netcatty/plugin-contract").SnippetSummary }>>;
  save(params: import("@netcatty/plugin-contract").SnippetSaveParams): Promise<Readonly<{ snippet: import("@netcatty/plugin-contract").SnippetSummary }>>;
  delete(params: import("@netcatty/plugin-contract").SnippetDeleteParams): Promise<Readonly<{ deleted: boolean }>>;
}

export interface PluginWorkspace {
  listTabs(): Promise<import("@netcatty/plugin-contract").WorkspaceListTabsResult>;
  focusTab(params: import("@netcatty/plugin-contract").WorkspaceFocusTabParams): Promise<Readonly<{ focused: boolean }>>;
}

/** Saved-host selection does not grant editing, connecting or session access.
 * Later actions follow the plugin's permission settings. Host drafts retain
 * the host editor; connections retain normal authentication. */
export interface PluginVault {
  selectHosts(params: import("@netcatty/plugin-contract").VaultSelectHostsParams): Promise<import("@netcatty/plugin-contract").VaultHostSelectionResult>;
  /** Managed SSH-config drafts require the full Vault host editor. */
  requestHostDraft(params: import("@netcatty/plugin-contract").VaultHostDraftParams): Promise<import("@netcatty/plugin-contract").VaultHostActionResult>;
  requestConnect(params: import("@netcatty/plugin-contract").VaultHostConnectParams): Promise<import("@netcatty/plugin-contract").VaultHostActionResult>;
  /** Refresh host metadata for previously bound durable host tokens without showing a prompt. */
  resolveHostBindings(params: import("@netcatty/plugin-contract").VaultResolveHostBindingsParams): Promise<import("@netcatty/plugin-contract").VaultResolveHostBindingsResult>;
  /** Execute a bounded SSH command on a durably bound Vault SSH server in the host process. */
  execHostCommand(params: import("@netcatty/plugin-contract").VaultHostExecParams, cancellationToken?: CancellationToken): Promise<import("@netcatty/plugin-contract").VaultHostExecResult>;
  /** Run a zero-credential reachability and RDP/VNC/SSH banner probe on a durably bound host. */
  probeHost(params: import("@netcatty/plugin-contract").VaultHostProbeParams, cancellationToken?: CancellationToken): Promise<import("@netcatty/plugin-contract").VaultHostProbeResult>;
  /** Bounded SFTP file operations over pooled SSH transports for durably bound hosts. */
  readonly sftp: PluginVaultSftp;
  /** List Vault groups and their host counts (non-secret metadata). */
  listGroups(): Promise<import("@netcatty/plugin-contract").VaultListGroupsResult>;
  /** Update non-secret notes on a durably bound Vault host. */
  updateHostNotes(params: import("@netcatty/plugin-contract").VaultUpdateHostNotesParams): Promise<Readonly<{ updated: boolean }>>;
  /** Update non-secret tags on a durably bound Vault host. */
  updateHostTags(params: import("@netcatty/plugin-contract").VaultUpdateHostTagsParams): Promise<Readonly<{ updated: boolean }>>;
  /** Revokes a previously remembered durable SSH host or tunnel binding token. */
  revokeHostBinding(hostBindingToken: string): Promise<Readonly<{ revoked: boolean }>>;
}

export interface PluginClipboard {
  /** The host previews text only after the user asks, then separately confirms sharing it. */
  readText(title: string): Promise<string | undefined>;
  /** The host shows the exact text and requires explicit confirmation before replacement. */
  writeText(text: string, title: string): Promise<boolean>;
}

export interface PluginContextKeys {
  set(key: string, value: JsonValue): Promise<void>;
}

export interface PluginViews {
  onDidReceiveMessage(viewId: string, listener: (message: JsonValue) => void): Disposable;
  postMessage(viewId: string, message: JsonValue): void;
  getState<T extends JsonValue = JsonValue>(viewId: string, scopeId: string): Promise<T | undefined>;
  setState(viewId: string, scopeId: string, state: JsonValue): Promise<void>;
  /** Sets or clears a notification badge on one of this plugin's declared vault-page or terminal-sidebar views. */
  setBadge(badge: import("@netcatty/plugin-contract").ViewBadgeParams): Promise<void>;
  setBadge(viewId: string, badge: Omit<import("@netcatty/plugin-contract").ViewBadgeParams, "viewId"> | null): Promise<void>;
}

export interface PluginProviderInvocation<TPayload extends JsonValue = JsonValue> {
  readonly providerId: string;
  readonly kind: ProviderKind;
  readonly operation: string;
  readonly requestId: string;
  readonly payload: TPayload | undefined;
  readonly deadlineMs: number | undefined;
  readonly cancellationToken: CancellationToken;
}

export type PluginProviderHandler<
  TPayload extends JsonValue = JsonValue,
  TResult extends JsonValue = JsonValue,
> = (invocation: PluginProviderInvocation<TPayload>) => TResult | void | Promise<TResult | void>;

type TypedPluginProviderInvocation<TPayload> = Omit<PluginProviderInvocation, "payload"> & {
  readonly payload: TPayload;
};

type ProviderHandlerForKind<
  K extends ProviderKind,
  TPayload extends JsonValue,
  TResult extends JsonValue,
> = K extends TerminalInterceptorKind
  ? TerminalInterceptorHandler
  : K extends OrdinaryTerminalProviderKind
    ? OrdinaryTerminalProviderHandler<K>
    : K extends "connection"
      ? ConnectionProviderHandler
      : K extends "authentication"
        ? AuthenticationProviderHandler
        : K extends "importer"
          ? ImporterProviderHandler
          : K extends "sync"
            ? SyncProviderHandler
    : PluginProviderHandler<TPayload, TResult>;

export interface PluginProviders {
  register<K extends OrdinaryTerminalProviderKind>(
    providerId: string,
    kind: K,
    handler: OrdinaryTerminalProviderHandler<K>,
  ): Disposable;
  register(
    providerId: string,
    kind: TerminalInterceptorKind,
    handler: TerminalInterceptorHandler,
  ): Disposable;
  register(
    providerId: string,
    kind: "connection",
    handler: ConnectionProviderHandler,
  ): Disposable;
  register(
    providerId: string,
    kind: "authentication",
    handler: AuthenticationProviderHandler,
  ): Disposable;
  register(
    providerId: string,
    kind: "importer",
    handler: ImporterProviderHandler,
  ): Disposable;
  register(
    providerId: string,
    kind: "sync",
    handler: SyncProviderHandler,
  ): Disposable;
  register<TPayload extends JsonValue = JsonValue, TResult extends JsonValue = JsonValue>(
    providerId: string,
    kind: Exclude<
      ProviderKind,
      TerminalInterceptorKind | OrdinaryTerminalProviderKind | "connection" | "authentication" | "importer" | "sync"
    >,
    handler: PluginProviderHandler<TPayload, TResult>,
  ): Disposable;
  register<
    K extends ProviderKind,
    TPayload extends JsonValue = JsonValue,
    TResult extends JsonValue = JsonValue,
  >(
    providerId: string,
    kind: K,
    handler: ProviderHandlerForKind<NoInfer<K>, TPayload, TResult>,
  ): Disposable;
}

export type TerminalInterceptorKind = "terminal.interceptor.input" | "terminal.interceptor.output";

export interface TerminalInterceptorInvocation {
  readonly providerId: string;
  readonly kind: TerminalInterceptorKind;
  readonly direction: "input" | "output";
  readonly sequence: number;
  readonly session: TerminalSessionSnapshot;
  /** UTF-8 terminal data. The buffer is owned by this invocation. */
  readonly data: Uint8Array;
}

export type TerminalInterceptorHandler = (
  invocation: TerminalInterceptorInvocation,
) => Uint8Array | ArrayBuffer | Promise<Uint8Array | ArrayBuffer>;

export interface TerminalSessionEvent {
  readonly type:
    | "snapshot"
    | "created"
    | "connected"
    | "reconnected"
    | "cwdChanged"
    | "titleChanged"
    | "resized"
    | "alternateScreenChanged"
    | "commandSubmitted"
    | "commandCompleted"
    | "disconnected"
    | "disposed";
  readonly session: TerminalSessionSnapshot;
  readonly exitCode?: number;
}

export interface TerminalProviderPayload {
  /** Immutable host snapshot bound to this exact invocation. */
  readonly session: TerminalSessionSnapshot;
}

export interface TerminalCompletionPayload extends TerminalProviderPayload {
  readonly input: string;
  readonly cursor: number;
  readonly hostOs: "linux" | "windows" | "macos";
  readonly cwdSource: "prompt" | "fallback" | "none" | null;
  readonly maximum: number;
}

export interface TerminalCompletionItem {
  readonly text: string;
  /** When supplied, it must equal text; the host always displays the inserted command. */
  readonly displayText?: string;
  readonly description?: string;
  readonly score?: number;
}

export interface TerminalCompletionResult {
  readonly items: readonly TerminalCompletionItem[];
}

export interface TerminalDecorationPayload extends TerminalProviderPayload {
  readonly reason: string;
}

export interface TerminalDecorationRule {
  readonly id: string;
  readonly label: string;
  readonly patterns: readonly string[];
  readonly color: string;
}

export interface TerminalDecorationResult {
  readonly rules: readonly TerminalDecorationRule[];
}

export interface TerminalTextRange {
  readonly start: number;
  readonly length: number;
}

export interface TerminalLinkItem extends TerminalTextRange {
  readonly uri: string;
  readonly label?: string;
}

export interface TerminalLineProviderPayload extends TerminalProviderPayload {
  readonly line: string;
  readonly bufferLineNumber: number;
}

export interface TerminalLinkResult {
  readonly links: readonly TerminalLinkItem[];
}

export interface TerminalHoverItem extends TerminalTextRange {
  readonly contents: string;
}

export interface TerminalHoverResult {
  readonly hovers: readonly TerminalHoverItem[];
}

export interface TerminalMatcherLine {
  readonly lineId: string;
  readonly line: string;
  readonly bufferLineNumber: number;
}

export interface TerminalMatcherPayload extends TerminalProviderPayload {
  readonly lines: readonly TerminalMatcherLine[];
}

export interface TerminalOutputMatchItem extends TerminalTextRange {
  /** Host-provided line identifier from the provideMatches request batch. */
  readonly lineId: string;
  readonly label: string;
  readonly severity?: "info" | "warning" | "error" | "success";
  readonly color?: string;
}

export interface TerminalMatcherResult {
  readonly matches: readonly TerminalOutputMatchItem[];
}

export interface TerminalAnnotationItem {
  readonly text: string;
  readonly color?: string;
}

export interface TerminalSemanticResult {
  readonly classification?: string;
  readonly description?: string;
  readonly destructive?: boolean;
  readonly idempotent?: boolean;
  readonly annotations?: readonly TerminalAnnotationItem[];
}

export interface TerminalSemanticPayload extends TerminalProviderPayload {
  readonly command: string;
}

export interface TerminalPromptPayload extends TerminalProviderPayload {
  readonly reason: "commandCompleted";
  readonly promptLine?: string;
  readonly bufferLineNumber?: number;
}

export interface TerminalPromptResult {
  readonly annotations: readonly TerminalAnnotationItem[];
}

export interface TerminalBackgroundLayer {
  readonly id: string;
  readonly color: string;
  /** Defaults to a host-owned safe opacity of 0.15. */
  readonly opacity?: number;
}

export interface TerminalBackgroundResult {
  readonly layers: readonly TerminalBackgroundLayer[];
  /** Optional bounded host refresh cadence. The host clamps this to 250-60000 ms. */
  readonly refreshAfterMs?: number;
}

export interface TerminalBackgroundPayload extends TerminalProviderPayload {
  readonly reason: string;
  readonly terminalBackground?: string;
}

export type TerminalThemeColorName =
  | "background" | "foreground" | "cursor" | "selection"
  | "black" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white"
  | "brightBlack" | "brightRed" | "brightGreen" | "brightYellow"
  | "brightBlue" | "brightMagenta" | "brightCyan" | "brightWhite";

export interface TerminalThemePayload extends TerminalProviderPayload {
  readonly reason: string;
  readonly currentTheme: {
    readonly type: "dark" | "light";
    readonly colors: Readonly<Record<TerminalThemeColorName, string>>;
  };
}

export interface TerminalThemeResult {
  readonly colors: Readonly<Partial<Record<TerminalThemeColorName, string>>>;
}

export interface OrdinaryTerminalProviderPayloadByKind {
  readonly "terminal.completion": TerminalCompletionPayload;
  readonly "terminal.decoration": TerminalDecorationPayload;
  readonly "terminal.link": TerminalLineProviderPayload;
  readonly "terminal.hover": TerminalLineProviderPayload;
  readonly "terminal.matcher": TerminalMatcherPayload;
  readonly "terminal.semantic": TerminalSemanticPayload;
  readonly "terminal.prompt": TerminalPromptPayload;
  readonly "terminal.background": TerminalBackgroundPayload;
  readonly "terminal.theme": TerminalThemePayload;
}

export interface OrdinaryTerminalProviderResultByKind {
  readonly "terminal.completion": TerminalCompletionResult;
  readonly "terminal.decoration": TerminalDecorationResult;
  readonly "terminal.link": TerminalLinkResult;
  readonly "terminal.hover": TerminalHoverResult;
  readonly "terminal.matcher": TerminalMatcherResult;
  readonly "terminal.semantic": TerminalSemanticResult;
  readonly "terminal.prompt": TerminalPromptResult;
  readonly "terminal.background": TerminalBackgroundResult;
  readonly "terminal.theme": TerminalThemeResult;
}

export interface OrdinaryTerminalProviderOperationByKind {
  readonly "terminal.completion": "provideCompletions";
  readonly "terminal.decoration": "provideDecorations";
  readonly "terminal.link": "provideLinks";
  readonly "terminal.hover": "provideHovers";
  readonly "terminal.matcher": "provideMatches";
  readonly "terminal.semantic": "provideSemantics";
  readonly "terminal.prompt": "provideAnnotations";
  readonly "terminal.background": "provideBackgrounds";
  readonly "terminal.theme": "provideTheme";
}

export type OrdinaryTerminalProviderKind = keyof OrdinaryTerminalProviderPayloadByKind;

export interface OrdinaryTerminalProviderInvocation<K extends OrdinaryTerminalProviderKind> {
  readonly providerId: string;
  readonly kind: K;
  readonly operation: OrdinaryTerminalProviderOperationByKind[K];
  readonly requestId: string;
  readonly payload: OrdinaryTerminalProviderPayloadByKind[K];
  readonly deadlineMs: number | undefined;
  readonly cancellationToken: CancellationToken;
}

export type OrdinaryTerminalProviderHandler<K extends OrdinaryTerminalProviderKind> = (
  invocation: OrdinaryTerminalProviderInvocation<K>,
) => OrdinaryTerminalProviderResultByKind[K] | Promise<OrdinaryTerminalProviderResultByKind[K]>;

export interface ConnectionProviderInvocationByOperation {
  readonly validateConfiguration: TypedPluginProviderInvocation<ConnectionConfigurationPayload> & {
    readonly kind: "connection";
    readonly operation: "validateConfiguration";
  };
  readonly probe: TypedPluginProviderInvocation<ConnectionConfigurationPayload> & {
    readonly kind: "connection";
    readonly operation: "probe";
  };
  readonly open: TypedPluginProviderInvocation<ConnectionOpenPayload> & {
    readonly kind: "connection";
    readonly operation: "open";
    readonly input: Promise<PluginReadableByteStream>;
    readonly output: PluginWritableByteStream;
  };
  readonly resize: TypedPluginProviderInvocation<ConnectionResizePayload> & {
    readonly kind: "connection";
    readonly operation: "resize";
  };
  readonly signal: TypedPluginProviderInvocation<ConnectionSignalPayload> & {
    readonly kind: "connection";
    readonly operation: "signal";
  };
  readonly reconnect: TypedPluginProviderInvocation<ConnectionControlPayload> & {
    readonly kind: "connection";
    readonly operation: "reconnect";
  };
  readonly close: TypedPluginProviderInvocation<ConnectionControlPayload> & {
    readonly kind: "connection";
    readonly operation: "close";
  };
  readonly getStatus: TypedPluginProviderInvocation<ConnectionControlPayload> & {
    readonly kind: "connection";
    readonly operation: "getStatus";
  };
}

export interface ConnectionProviderResultByOperation {
  readonly validateConfiguration: ConnectionValidateResult;
  readonly probe: ConnectionProbeResult;
  readonly open: ConnectionOpenResult;
  readonly resize: ConnectionControlResult;
  readonly signal: ConnectionControlResult;
  readonly reconnect: ConnectionControlResult;
  readonly close: ConnectionControlResult;
  readonly getStatus: ConnectionStatusResult;
}

export type ConnectionProviderOperation = keyof ConnectionProviderInvocationByOperation;

export type ConnectionProviderInvocation =
  ConnectionProviderInvocationByOperation[ConnectionProviderOperation];

export type ConnectionProviderResult =
  ConnectionProviderResultByOperation[ConnectionProviderOperation];

export type ConnectionProviderOperationHandler<TOperation extends ConnectionProviderOperation> = (
  invocation: ConnectionProviderInvocationByOperation[TOperation],
) => ConnectionProviderResultByOperation[TOperation] | Promise<ConnectionProviderResultByOperation[TOperation]>;

export type ConnectionProviderHandler = Readonly<{
  [TOperation in ConnectionProviderOperation]: ConnectionProviderOperationHandler<TOperation>;
}>;

export type AuthenticationProviderInvocation =
  | (TypedPluginProviderInvocation<AuthenticationBeginPayload> & {
      readonly kind: "authentication";
      readonly operation: "begin";
    })
  | (TypedPluginProviderInvocation<AuthenticationResponsePayload> & {
      readonly kind: "authentication";
      readonly operation: "respond";
    })
  | (TypedPluginProviderInvocation<Readonly<{ operationId: string }>> & {
      readonly kind: "authentication";
      readonly operation: "cancel";
    });

export type AuthenticationProviderHandler = (
  invocation: AuthenticationProviderInvocation,
) => AuthenticationResult | Promise<AuthenticationResult>;

export interface ImporterProviderInvocationByOperation {
  readonly detect: TypedPluginProviderInvocation<ImporterDetectPayload> & {
    readonly kind: "importer";
    readonly operation: "detect";
  };
  readonly parse: TypedPluginProviderInvocation<ImporterParsePayload> & {
    readonly kind: "importer";
    readonly operation: "parse";
    readonly input: Promise<PluginReadableByteStream>;
    readonly output: PluginWritableByteStream;
  };
}

export interface ImporterProviderResultByOperation {
  readonly detect: ImporterDetectResult;
  readonly parse: ImporterParseResult;
}

export type ImporterProviderOperation = keyof ImporterProviderInvocationByOperation;
export type ImporterProviderInvocation =
  ImporterProviderInvocationByOperation[ImporterProviderOperation];
export type ImporterProviderResult =
  ImporterProviderResultByOperation[ImporterProviderOperation];
export type ImporterProviderOperationHandler<TOperation extends ImporterProviderOperation> = (
  invocation: ImporterProviderInvocationByOperation[TOperation],
) => ImporterProviderResultByOperation[TOperation] | Promise<ImporterProviderResultByOperation[TOperation]>;
export type ImporterProviderHandler = Readonly<{
  [TOperation in ImporterProviderOperation]: ImporterProviderOperationHandler<TOperation>;
}>;

export interface SyncProviderInvocationByOperation {
  readonly connect: TypedPluginProviderInvocation<SyncConnectPayload> & {
    readonly kind: "sync";
    readonly operation: "connect";
  };
  readonly disconnect: TypedPluginProviderInvocation<SyncDisconnectPayload | undefined> & {
    readonly kind: "sync";
    readonly operation: "disconnect";
  };
  readonly getAccount: TypedPluginProviderInvocation<SyncGetAccountPayload | undefined> & {
    readonly kind: "sync";
    readonly operation: "getAccount";
  };
  readonly getCapabilities: TypedPluginProviderInvocation<SyncGetCapabilitiesPayload | undefined> & {
    readonly kind: "sync";
    readonly operation: "getCapabilities";
  };
  readonly readObject: TypedPluginProviderInvocation<SyncReadObjectPayload> & {
    readonly kind: "sync";
    readonly operation: "readObject";
    readonly output?: PluginWritableByteStream;
  };
  readonly writeObject: TypedPluginProviderInvocation<SyncWriteObjectPayload> & {
    readonly kind: "sync";
    readonly operation: "writeObject";
    readonly input?: Promise<PluginReadableByteStream>;
  };
  readonly deleteObject: TypedPluginProviderInvocation<SyncDeleteObjectPayload> & {
    readonly kind: "sync";
    readonly operation: "deleteObject";
  };
}

export interface SyncProviderResultByOperation {
  readonly connect: SyncConnectResult;
  readonly disconnect: SyncDisconnectResult;
  readonly getAccount: SyncGetAccountResult;
  readonly getCapabilities: SyncCapabilitiesResult;
  readonly readObject: SyncReadObjectResult;
  readonly writeObject: SyncWriteObjectResult;
  readonly deleteObject: SyncDeleteObjectResult;
}

export type SyncProviderOperation = keyof SyncProviderInvocationByOperation;
export type SyncProviderInvocation =
  SyncProviderInvocationByOperation[SyncProviderOperation];
export type SyncProviderResult =
  SyncProviderResultByOperation[SyncProviderOperation];
export type SyncProviderOperationHandler<TOperation extends SyncProviderOperation> = (
  invocation: SyncProviderInvocationByOperation[TOperation],
) => SyncProviderResultByOperation[TOperation] | Promise<SyncProviderResultByOperation[TOperation]>;
export type SyncProviderHandler = Readonly<{
  [TOperation in SyncProviderOperation]: SyncProviderOperationHandler<TOperation>;
}>;

export interface PluginTerminalSessions {
  /** Explicit host Preview then Share; no screen/history query or automatic read. */
  shareSelection(title: string): Promise<Readonly<SharedTerminalSelection> | undefined>;
  /** Opens a host-owned editable review only. Never writes to a terminal or sends Enter. */
  proposeInput(handle: string, text: string, title: string): Promise<boolean>;
  /** List open terminal sessions (requires terminal.session-control + terminal.metadata). */
  listSessions(): Promise<import("@netcatty/plugin-contract").TerminalListSessionsResult>;
  /** Read bounded visible/scrollback lines from a terminal session (requires terminal.session-control + terminal.output). */
  readScreen(params: import("@netcatty/plugin-contract").TerminalReadScreenParams): Promise<import("@netcatty/plugin-contract").TerminalReadScreenResult>;
  /** Send bounded input to an open terminal session (requires terminal.session-control + terminal.input). */
  sendInput(params: import("@netcatty/plugin-contract").TerminalSendInputParams): Promise<Readonly<{ sent: boolean }>>;
  /** Open a new local terminal tab (requires terminal.session-control + ui.interact). */
  openLocal(): Promise<import("@netcatty/plugin-contract").TerminalOpenResult>;
  onDidChange(listener: (event: TerminalSessionEvent) => void): Disposable;
}

export interface PluginEnvironmentChangeEvent {
  readonly locale: string;
  readonly theme: string;
  readonly reducedMotion: boolean;
  readonly highContrast: boolean;
  readonly themeTokens: Readonly<Record<string, string>>;
}

export interface PluginEnvironment extends PluginEnvironmentChangeEvent {
  onDidChange(listener: (event: PluginEnvironmentChangeEvent) => void): Disposable;
}

export interface PluginCredentialLeaseOptions {
  readonly operationId: string;
  readonly purpose: string;
  readonly ttlMs?: number;
}

export interface PluginCredentialBroker {
  createLease(credential: SecretRef | CredentialRef, options: PluginCredentialLeaseOptions): Promise<SecretLeaseRef>;
}

export type { PluginNetworkAuthorization, PluginNetworkRequest, PluginNetworkResponse } from "@netcatty/plugin-contract";

export interface PluginNetworkClient {
  /** Opens a destination through a user-selected saved SSH server after host review. */
  connectViaHost(request: import("@netcatty/plugin-contract").HostByteStreamConnectRequest, cancellationToken?: CancellationToken): Promise<PluginByteConnection>;
  request(request: PluginNetworkRequest): Promise<PluginNetworkResponse>;
  connect(request: import("@netcatty/plugin-contract").ByteStreamConnectRequest, cancellationToken?: CancellationToken): Promise<PluginByteConnection>;
}

export interface PluginAIClient {
  openChat(params: import("@netcatty/plugin-contract").PluginAIEmptyParams): Promise<import("@netcatty/plugin-contract").PluginAIChatResult>;
  startTurn(params: import("@netcatty/plugin-contract").PluginAIStartTurnParams): Promise<import("@netcatty/plugin-contract").PluginAITurnResult>;
  readTurn(params: import("@netcatty/plugin-contract").PluginAITurnRef): Promise<import("@netcatty/plugin-contract").PluginAIStreamEvent>;
  stopTurn(params: import("@netcatty/plugin-contract").PluginAITurnRef): Promise<import("@netcatty/plugin-contract").PluginAIBooleanResult>;
  closeChat(params: import("@netcatty/plugin-contract").PluginAIChatRef): Promise<import("@netcatty/plugin-contract").PluginAIBooleanResult>;
}

export interface PluginSelectedContextClient {
  list(params: import("@netcatty/plugin-contract").PluginAIEmptyParams): Promise<import("@netcatty/plugin-contract").PluginSelectedContextListResult>;
  read(params: import("@netcatty/plugin-contract").PluginSelectedContextRef): Promise<import("@netcatty/plugin-contract").PluginSelectedContextContent>;
}

/** Configurations, targets and native resume IDs stay in the trusted host. */
export interface PluginAgentClient {
  listBackends(params: import("@netcatty/plugin-contract").PluginAIEmptyParams): Promise<import("@netcatty/plugin-contract").PluginAgentBackendsResult>;
  selectTargets(params: import("@netcatty/plugin-contract").PluginAIEmptyParams): Promise<import("@netcatty/plugin-contract").PluginAgentTargetsResult>;
  listChats(params: import("@netcatty/plugin-contract").PluginAIEmptyParams): Promise<import("@netcatty/plugin-contract").PluginAgentChatsResult>;
  openChat(params: import("@netcatty/plugin-contract").PluginAgentOpenParams): Promise<import("@netcatty/plugin-contract").PluginAgentChatResult>;
  send(params: import("@netcatty/plugin-contract").PluginAgentSendParams): Promise<import("@netcatty/plugin-contract").PluginAgentTurnResult>;
  read(params: import("@netcatty/plugin-contract").PluginAgentTurnRef): Promise<import("@netcatty/plugin-contract").PluginAgentEvent>;
  history(params: import("@netcatty/plugin-contract").PluginAgentChatRef): Promise<import("@netcatty/plugin-contract").PluginAgentHistoryResult>;
  stop(params: import("@netcatty/plugin-contract").PluginAgentTurnRef): Promise<import("@netcatty/plugin-contract").PluginAIBooleanResult>;
  closeChat(params: import("@netcatty/plugin-contract").PluginAgentChatRef): Promise<import("@netcatty/plugin-contract").PluginAIBooleanResult>;
}

export interface PluginByteStreamUpgradeTlsOptions {
  readonly servername?: string;
  readonly allowSelfSigned?: boolean;
  readonly caPem?: string;
}

export interface PluginByteConnection extends Disposable {
  readonly endpoint: string;
  /** Present when connectViaHost created or reused a durable SSH tunnel binding. */
  readonly hostBindingToken?: string;
  readonly readable: PluginReadableByteStream;
  readonly writable: PluginWritableByteStream;
  /** Performs an in-band STARTTLS upgrade on an open plaintext byte stream. */
  upgradeTls(options?: PluginByteStreamUpgradeTlsOptions): Promise<import("@netcatty/plugin-contract").ByteStreamUpgradeTlsResult>;
  /** Closes both directions. Repeated calls on this handle are harmless. */
  close(): Promise<void>;
}

export interface PluginFilesystemEntry {
  readonly name: string;
  readonly kind: "file" | "directory" | "other";
}

export interface PluginFilesystemStat {
  readonly kind: "file" | "directory" | "other";
  readonly size: number;
  readonly modifiedAt: number;
}

export interface PluginFilesystemClient {
  readFile(path: string, options?: Readonly<{ encoding?: "utf8" | "base64"; maxBytes?: number }>): Promise<string>;
  writeFile(path: string, data: string, options: Readonly<{
    encoding?: "utf8" | "base64";
    overwrite: true;
  }>): Promise<void>;
  stat(path: string): Promise<PluginFilesystemStat>;
  /** Requires filesystem.directory-enumeration and an authorized filesystem.read directory. */
  readDirectory(path: string): Promise<readonly PluginFilesystemEntry[]>;
}

export interface PluginCompanionRequestOptions {
  readonly timeoutMs?: number;
  /**
   * Operation-bound one-use leases consumed by the host immediately before
   * dispatching this request to the isolated companion. When present, the
   * companion receives `{ payload, credentials }` instead of the raw params.
   */
  readonly credentialLeases?: Readonly<Record<string, SecretLeaseRef>>;
  readonly operationId?: string;
}

export interface PluginCompanionHandle extends Disposable {
  readonly id: string;
  request<T extends JsonValue = JsonValue>(
    method: string,
    params?: JsonValue,
    options?: PluginCompanionRequestOptions,
  ): Promise<T>;
  stop(): Promise<void>;
}

export interface PluginCompanionService {
  start(companionId: string): Promise<PluginCompanionHandle>;
}

export interface PluginReadableByteStream extends Disposable {
  readonly id: string;
  /**
   * Returns the next owned byte chunk or null after a normal end. Calling read
   * again releases receive credit for the previous chunk, so consumers should
   * finish processing one chunk before requesting the next.
   */
  read(): Promise<Uint8Array | null>;
  cancel(): void;
}

export interface PluginWritableByteStream extends Disposable {
  readonly id: string;
  write(data: Uint8Array | ArrayBuffer): Promise<void>;
  end(): Promise<void>;
  fail(error: Readonly<{ message: string }>): void;
  cancel(): void;
}

export interface PluginStreams {
  acceptReadable(streamId: string): Promise<PluginReadableByteStream>;
  openWritable(streamId: string, options?: Readonly<{ windowBytes?: number }>): Promise<PluginWritableByteStream>;
}

export interface PluginContext {
  readonly pluginId: PluginId;
  readonly netcattyVersion: SemanticVersion;
  readonly apiVersion: SemanticVersion;
  readonly enabledFeatures: ReadonlySet<FeatureId>;
  readonly subscriptions: DisposableStore;
  readonly storage: PluginKeyValueStore;
  readonly settings: PluginSettings;
  readonly commands: PluginCommands;
  readonly ui: PluginHostUI;
  readonly vault: PluginVault;
  readonly portForward: PluginPortForwarding;
  readonly snippets: PluginSnippets;
  readonly workspace: PluginWorkspace;
  readonly clipboard: PluginClipboard;
  readonly contextKeys: PluginContextKeys;
  readonly views: PluginViews;
  readonly providers: PluginProviders;
  readonly terminals: PluginTerminalSessions;
  readonly environment: PluginEnvironment;
  readonly secrets: PluginSecretStore;
  readonly credentials: PluginCredentialBroker;
  readonly network: PluginNetworkClient;
  readonly ai: PluginAIClient;
  readonly agent: PluginAgentClient;
  readonly selectedContext: PluginSelectedContextClient;
  readonly filesystem: PluginFilesystemClient;
  readonly companions: PluginCompanionService;
  readonly streams: PluginStreams;
  readonly logger: PluginLogger;
}

export interface NetcattyPlugin {
  activate(context: PluginContext): void | Disposable | Promise<void | Disposable>;
  deactivate?(): void | Promise<void>;
}

export type PluginErrorCode = PluginErrorName;

export const PLUGIN_ERROR_WIRE_CODES = {
  cancelled: -32001,
  unknown: -32002,
  invalid_argument: -32003,
  deadline_exceeded: -32004,
  not_found: -32005,
  already_exists: -32006,
  permission_denied: -32007,
  resource_exhausted: -32008,
  failed_precondition: -32009,
  aborted: -32010,
  out_of_range: -32011,
  unsupported: -32012,
  internal: -32013,
  unavailable: -32014,
  data_loss: -32015,
  unauthenticated: -32016,
} as const satisfies Readonly<Record<PluginErrorCode, PluginWireErrorCode>>;

export class PluginError extends Error {
  readonly code: PluginErrorCode;
  readonly details?: JsonValue;

  constructor(code: PluginErrorCode, message: string, details?: JsonValue) {
    super(message);
    this.name = "PluginError";
    this.code = code;
    this.details = details;
  }
}

export function pluginErrorToRpcError(error: PluginError): RpcErrorObject {
  const data: PluginErrorData = error.details === undefined
    ? { pluginCode: error.code }
    : { pluginCode: error.code, details: error.details };
  return {
    code: PLUGIN_ERROR_WIRE_CODES[error.code],
    message: error.message,
    data,
  };
}

export class CancellationError extends PluginError {
  constructor(message = "The operation was cancelled") {
    super("cancelled", message);
    this.name = "CancellationError";
  }
}

export class DisposableStore implements Disposable {
  readonly #items = new Set<Disposable>();
  #isDisposed = false;

  get isDisposed(): boolean {
    return this.#isDisposed;
  }

  add<T extends Disposable>(disposable: T): T {
    if (this.#isDisposed) {
      disposable.dispose();
      throw new PluginError("unavailable", "Cannot add to a disposed DisposableStore");
    }
    this.#items.add(disposable);
    return disposable;
  }

  delete(disposable: Disposable): boolean {
    return this.#items.delete(disposable);
  }

  clear(): void {
    const items = [...this.#items];
    this.#items.clear();
    const errors: unknown[] = [];
    for (const item of items) {
      try {
        item.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "One or more plugin disposables failed");
    }
  }

  dispose(): void {
    if (this.#isDisposed) return;
    this.#isDisposed = true;
    this.clear();
  }
}

class MutableCancellationToken implements CancellationToken {
  readonly #listeners = new Set<CancellationListener>();
  #isCancellationRequested = false;

  get isCancellationRequested(): boolean {
    return this.#isCancellationRequested;
  }

  onCancellationRequested(listener: CancellationListener): Disposable {
    if (this.#isCancellationRequested) {
      queueMicrotask(listener);
      return { dispose() {} };
    }
    this.#listeners.add(listener);
    return {
      dispose: () => {
        this.#listeners.delete(listener);
      },
    };
  }

  cancel(): void {
    if (this.#isCancellationRequested) return;
    this.#isCancellationRequested = true;
    const listeners = [...this.#listeners];
    this.#listeners.clear();
    const errors: unknown[] = [];
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "One or more cancellation listeners failed");
    }
  }

  dispose(): void {
    this.#listeners.clear();
  }
}

export class CancellationTokenSource implements Disposable {
  readonly #token = new MutableCancellationToken();
  #isDisposed = false;

  get token(): CancellationToken {
    return this.#token;
  }

  cancel(): void {
    if (!this.#isDisposed) this.#token.cancel();
  }

  dispose(cancel = false): void {
    if (this.#isDisposed) return;
    try {
      if (cancel) this.#token.cancel();
    } finally {
      this.#token.dispose();
      this.#isDisposed = true;
    }
  }
}

export function definePlugin<T extends NetcattyPlugin>(plugin: T): T {
  return plugin;
}

export function throwIfCancellationRequested(token: CancellationToken): void {
  if (token.isCancellationRequested) throw new CancellationError();
}

export { PLUGIN_NETWORK_CREDENTIAL_LEASE_FEATURE } from "@netcatty/plugin-contract";
export { PLUGIN_BYTE_STREAM_FEATURE, PLUGIN_HOST_BYTE_STREAM_FEATURE, PLUGIN_BYTE_STREAM_LIMITS } from "@netcatty/plugin-contract";
export { PLUGIN_AI_MODEL_INVOCATION_FEATURE, PLUGIN_SELECTED_CONTEXT_FEATURE } from "@netcatty/plugin-contract";

export { PLUGIN_HOST_INTERACTION_FEATURE } from "@netcatty/plugin-contract";
export { PLUGIN_HOST_VAULT_FEATURE } from "@netcatty/plugin-contract";
export { PLUGIN_VAULT_PAGES_FEATURE } from "@netcatty/plugin-contract";
export { PLUGIN_TERMINAL_SIDEBAR_FEATURE } from "@netcatty/plugin-contract";
export { PLUGIN_INTERACTIVE_COMMAND_FEATURE } from "@netcatty/plugin-contract";

export { PLUGIN_THEME_PACK_FEATURE } from "@netcatty/plugin-contract";

export { PLUGIN_TERMINAL_SELECTION_SHARING_FEATURE } from "@netcatty/plugin-contract";

export { PLUGIN_TERMINAL_INPUT_DRAFT_FEATURE } from "@netcatty/plugin-contract";
export { PLUGIN_FILESYSTEM_DIRECTORY_ENUMERATION_FEATURE } from "@netcatty/plugin-contract";
