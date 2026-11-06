export const PLUGIN_API_VERSION = "0.1.0-internal.1" as const;
export const PLUGIN_MANIFEST_FILE = "netcatty.plugin.json" as const;
export const PLUGIN_PACKAGE_EXTENSION = ".ncpkg" as const;

export type * from "./generated/plugin-contract.js";
export {
  PLUGIN_JSON_MAX_DEPTH,
  PLUGIN_JSON_MAX_NODES,
  assertJsonValue,
  serializeJsonValue,
} from "./jsonValue.js";
export {
  PLUGIN_HOST_INTERACTION_LIMITS,
  PLUGIN_BYTE_STREAM_LIMITS,
  PLUGIN_IMPORTER_MAX_INPUT_BYTES,
  PLUGIN_IMPORTER_MAX_OUTPUT_BYTES,
  PLUGIN_IMPORTER_MAX_RECORD_BYTES,
  PLUGIN_IMPORTER_MAX_RECORDS,
  PLUGIN_RPC_ERROR_CODES,
  PLUGIN_RPC_MAX_JSON_BYTES,
  PLUGIN_SYNC_INLINE_OBJECT_BYTES,
  PLUGIN_SYNC_MAX_OBJECT_BYTES,
  PLUGIN_SYNC_MAX_OBJECT_KEY_LENGTH,
  PLUGIN_SYNC_MAX_REVISION_LENGTH,
  PLUGIN_TERMINAL_INTERCEPTOR_MAX_CHUNK_BYTES,
  PLUGIN_TERMINAL_INTERCEPTOR_MAX_WINDOW_BYTES,
  PLUGIN_WIRE_MAX_SAFE_INTEGER,
} from "./generated/plugin-contract-limits.js";
export {
  COMPANION_STDIO_MAX_CONTENT_BYTES,
  COMPANION_STDIO_MAX_HEADER_BYTES,
  ContentLengthFrameDecoder,
  encodeContentLengthFrame,
  type ContentLengthFrameDecoderOptions,
} from "./stdioFraming.js";
export {
  PLUGIN_STREAM_MAX_CHUNK_BYTES,
  PLUGIN_STREAM_MAX_CREDIT_BYTES,
  PLUGIN_STREAM_MAX_FRAME_JSON_BYTES,
  PLUGIN_STREAM_MAX_ID_LENGTH,
  PLUGIN_STREAM_MAX_WINDOW_BYTES,
  PLUGIN_STREAM_MIN_WINDOW_BYTES,
  assertStreamChunkData,
  assertStreamFrame,
  createBase64StreamChunk,
  createJsonStreamChunk,
  createMessagePortStreamEnvelope,
  materializeStreamChunk,
  type MaterializedStreamChunk,
  type MessagePortStreamEnvelope,
} from "./streamTransport.js";

export { inspectPluginBrandIcon, PLUGIN_BRAND_ICON_FEATURE, PLUGIN_BRAND_ICON_MAX_BYTES, PLUGIN_BRAND_ICON_MAX_EDGE } from './brandIcon.js';

export const PLUGIN_NETWORK_CREDENTIAL_LEASE_FEATURE = "network.credential-lease" as const satisfies import("./generated/plugin-contract.js").NetworkCredentialLeaseFeature;
export const PLUGIN_BYTE_STREAM_FEATURE = "network.byte-streams" as const satisfies import("./generated/plugin-contract.js").ByteStreamFeature;
export const PLUGIN_AI_MODEL_INVOCATION_FEATURE = "ai.model-invocation" as const satisfies import("./generated/plugin-contract.js").PluginAIModelInvocationFeature;
export const PLUGIN_AGENT_SESSIONS_FEATURE = "ai.agent-sessions" as const satisfies import("./generated/plugin-contract.js").PluginAgentFeature;
export const PLUGIN_AGENT_CAPABILITIES = ["session.environment", "terminal.execute", "terminal.start", "terminal.poll", "terminal.stop", "harness.terminal.read_context"] as const satisfies import("./generated/plugin-contract.js").PluginAgentCapabilities;
export const PLUGIN_SELECTED_CONTEXT_FEATURE = "context.selected-read" as const satisfies import("./generated/plugin-contract.js").PluginSelectedContextFeature;

export const PLUGIN_HOST_INTERACTION_FEATURE = "host.interactions" as const satisfies import("./generated/plugin-contract.js").HostInteractionFeature;
export const PLUGIN_HOST_VAULT_FEATURE = "vault.host-actions" as const satisfies import("./generated/plugin-contract.js").HostVaultFeature;

export const PLUGIN_VAULT_PAGES_FEATURE = "views.vault-pages" as const satisfies import("./generated/plugin-contract.js").VaultPagesFeature;
export const PLUGIN_TERMINAL_SIDEBAR_FEATURE = "views.terminal-sidebar" as const satisfies import("./generated/plugin-contract.js").TerminalSidebarFeature;
export const PLUGIN_INTERACTIVE_COMMAND_FEATURE = "commands.interactive" as const satisfies import("./generated/plugin-contract.js").InteractiveCommandFeature;

export const PLUGIN_THEME_PACK_FEATURE = "appearance.theme-packs" as const satisfies import("./generated/plugin-contract.js").ThemePackFeature;

export const PLUGIN_TERMINAL_SELECTION_SHARING_FEATURE = "terminal.selection-sharing" as const satisfies import("./generated/plugin-contract.js").TerminalSelectionSharingFeature;

export const PLUGIN_TERMINAL_INPUT_DRAFT_FEATURE = "terminal.input-drafts" as const satisfies import("./generated/plugin-contract.js").TerminalInputDraftFeature;
export const PLUGIN_FILESYSTEM_DIRECTORY_ENUMERATION_FEATURE = "filesystem.directory-enumeration" as const satisfies import("./generated/plugin-contract.js").FilesystemDirectoryEnumerationFeature;
