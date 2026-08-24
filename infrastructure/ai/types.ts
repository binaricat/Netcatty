// AI Provider types
import defaultCommandBlocklist from '../../lib/commandBlocklist.json';
import type { AgentActivity, AgentUsage } from '../../domain/agentActivity';
import type { ProviderContinuation } from './providerContinuation';

export type { AgentActivity, AgentUsage } from '../../domain/agentActivity';

export type AIProviderId =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'ollama'
  | 'openrouter'
  | 'qwen'
  | 'deepseek'
  | 'kimi'
  | 'zhipu'
  | 'doubao'
  | 'mimo'
  | 'custom';

/**
 * Wire-protocol family for a provider. Three are supported because every
 * Anthropic/OpenAI-compatible third party reduces to one of these.
 * `providerId` stays as the routing/display identity; `style` decides
 * which Vercel AI SDK client builds the request.
 */
export type ProviderStyle = 'openai' | 'anthropic' | 'google';

/**
 * OpenAI-compatible request format. Chat Completions (`/v1/chat/completions`)
 * is the default so existing providers and OpenAI-compat proxies keep working.
 * Responses (`/v1/responses`) is opt-in for relays that cache better on that
 * endpoint.
 */
export type OpenAIApiFormat = 'chat' | 'responses';

export interface ProviderAdvancedParams {
  maxTokens?: number;
  temperature?: number;       // 0–2
  topP?: number;              // 0–1
  frequencyPenalty?: number;  // -2–2
  presencePenalty?: number;   // -2–2
}

export interface ProviderConfig {
  id: string;
  providerId: AIProviderId;
  name: string;
  /** Override the wire-protocol family; defaults from `providerId` via {@link resolveProviderStyle}. */
  style?: ProviderStyle;
  /**
   * OpenAI-compatible endpoint family. Only used when style resolves to `openai`.
   * Defaults to Chat Completions via {@link resolveOpenAIApi}.
   */
  openaiApi?: OpenAIApiFormat;
  /** Built-in icon key (slug under public/ai/providers/), independent of providerId. */
  iconId?: string;
  /** User-supplied icon as a data URL (compressed to 64x64 webp at write time). Wins over iconId. */
  iconDataUrl?: string;
  apiKey?: string;           // encrypted via credentialBridge (enc:v1: prefix)
  baseURL?: string;          // custom endpoint URL
  defaultModel?: string;
  customHeaders?: Record<string, string>;
  enabled: boolean;
  skipTLSVerify?: boolean;   // skip TLS certificate verification (for self-signed certs)
  /** User override for the model context window, in tokens. Wins over discovered model metadata. */
  contextWindow?: number;
  /** Context windows discovered from provider model-list metadata, keyed by model id. */
  modelContextWindows?: Record<string, number>;
  advancedParams?: ProviderAdvancedParams;
}

/** Pick the protocol family for a provider config, falling back from providerId when style is unset. */
export function resolveProviderStyle(config: Pick<ProviderConfig, 'providerId' | 'style'>): ProviderStyle {
  if (config.style) return config.style;
  switch (config.providerId) {
    case 'anthropic':
      return 'anthropic';
    case 'google':
      return 'google';
    default:
      return 'openai';
  }
}

/** Pick the OpenAI request format. Missing or unknown values stay on Chat Completions. */
export function resolveOpenAIApi(config: Pick<ProviderConfig, 'openaiApi'>): OpenAIApiFormat {
  return config.openaiApi === 'responses' ? 'responses' : 'chat';
}

export interface ModelInfo {
  id: string;
  name: string;
  providerId: AIProviderId;
  contextWindow?: number;
  supportsTools?: boolean;
  supportsStreaming?: boolean;
}

// Chat types
export interface ChatMessageAttachment {
  base64Data: string;
  mediaType: string;
  filename?: string;
  filePath?: string;    // original filesystem path, when available
  terminalSelection?: boolean;
  previewText?: string;
  lineCount?: number;
}

export interface UploadedFile {
  id: string;
  filename: string;
  dataUrl: string;
  base64Data: string;
  mediaType: string;
  filePath?: string;
  terminalSelection?: boolean;
  previewText?: string;
  lineCount?: number;
}

export interface AIDraft {
  text: string;
  agentId: string;
  attachments: UploadedFile[];
  selectedUserSkillSlugs: string[];
  updatedAt: number;
}

export interface AISessionContextCompaction {
  /** Summary sent in place of the older conversation on later Catty turns. */
  summary: string;
  /** Number of persisted messages covered by the summary. */
  compactedMessageCount: number;
}

export type AIPanelView =
  | { mode: 'draft' }
  | { mode: 'session'; sessionId: string };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  attachments?: ChatMessageAttachment[];
  /** @deprecated Use attachments instead. Kept for backward compatibility with persisted sessions. */
  images?: ChatMessageAttachment[];
  thinking?: string;
  thinkingDurationMs?: number;
  providerContinuation?: ProviderContinuation;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  agentActivities?: AgentActivity[];
  usage?: AgentUsage;
  timestamp: number;
  model?: string;
  providerId?: AIProviderId;
  errorInfo?: {
    type: 'network' | 'auth' | 'timeout' | 'provider' | 'agent' | 'unknown';
    message: string;
    retryable: boolean;
  };
  /** Transient status text shown with shimmer effect (e.g. "Waiting for response...") */
  statusText?: string;
  executionStatus?: 'pending' | 'approved' | 'rejected' | 'running' | 'completed' | 'failed' | 'cancelled';
  pendingApproval?: {
    approvalId: string;
    toolCallId: string;
    toolName: string;
    toolArgs: Record<string, unknown>;
    status: 'pending' | 'approved' | 'denied';
  };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  /** Optional tool name carried by external SDK/MCP result streams. */
  toolName?: string;
  content: string;
  isError?: boolean;
}

export interface ChatParams {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

// Streaming events
export type ChatStreamEvent =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'error'; error: string }
  | { type: 'done'; usage?: { promptTokens: number; completionTokens: number } };

// AI Session types
export interface AISession {
  id: string;
  title: string;
  agentId: string;
  scope: AISessionScope;
  messages: ChatMessage[];
  contextCompaction?: AISessionContextCompaction;
  externalSessionId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AISessionScope {
  type: 'terminal' | 'workspace' | 'global';
  targetId?: string;        // sessionId or workspaceId
  hostIds?: string[];       // resolved host IDs in scope
}

// Permission model
export type AIPermissionMode = 'observer' | 'confirm' | 'auto';
export type AIToolIntegrationMode = 'mcp' | 'skills';

export interface HostAIPermission {
  hostId: string;
  mode: AIPermissionMode;
  allowedCommands?: string[];   // regex patterns
  blockedCommands?: string[];   // regex patterns
  allowFileWrite?: boolean;
  maxConcurrentCommands?: number;
}

// Agent types
export interface AgentInfo {
  id: string;
  name: string;
  type: 'builtin' | 'external';
  icon?: string;
  description?: string;
  command?: string;             // for external agents
  args?: string[];
  available: boolean;
}

// External agent config. Managed agents route through official SDK backends.
export type CodexRuntime = 'sdk' | 'app-server';
/** Grok Build turn transport: ACP (`grok agent stdio`) or headless streaming-json. */
export type GrokRuntime = 'acp' | 'streaming-json';
export type CursorAuthMode = 'api-key' | 'cli-login';

export interface ExternalAgentConfig {
  id: string;
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  apiKey?: string;           // encrypted via credentialBridge (enc:v1: prefix)
  icon?: string;
  enabled: boolean;
  available?: boolean;
  /** SDK backend key for managed agents (claude|codex|copilot|cursor|codebuddy|opencode|grok). */
  sdkBackend?: string;
  /** Cursor only: mutually exclusive auth — API key vs local `cursor-agent` CLI login. */
  cursorAuthMode?: CursorAuthMode;
  /** Experimental Codex transport. Missing values keep the existing SDK behavior. */
  codexRuntime?: CodexRuntime;
  /**
   * Grok Build transport. Missing values default to ACP (`grok agent stdio`).
   * `streaming-json` is the original headless `grok -p --output-format streaming-json` path.
   */
  grokRuntime?: GrokRuntime;
  /** Internal: whether the managed command was set manually or auto-detected. */
  commandSource?: "manual" | "auto";
  /**
   * Last probed CLI --version output for this agent binary (from settings
   * resolve-cli or discovery). Used to gate version-specific model presets
   * when the configured path is not on PATH discovery.
   */
  cliVersion?: string;
  /** @deprecated Legacy persisted field from the pre-SDK migration. Read only for compatibility. */
  acpCommand?: string;
  /** @deprecated Legacy persisted field from the pre-SDK migration. */
  acpArgs?: string[];
  /** Internal: disabled only because the managed CLI was unavailable. */
  autoDisabledUntilAvailable?: boolean;
  /** CodeBuddy-specific advanced options (SDK 0.3.230). */
  codebuddyOptions?: CodebuddyAdvancedOptions;
}

/** Advanced options specific to the CodeBuddy backend (SDK 0.3.230+). */
export interface CodebuddyAdvancedOptions {
  /** Effort level for model reasoning. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  /** Maximum conversation turns per request. */
  maxTurns?: number;
  /** Maximum budget in USD per request. */
  maxBudgetUsd?: number;
  /** Sandbox settings for tool execution. */
  sandbox?: { enabled?: boolean; autoAllowBashIfSandboxed?: boolean };
  /** Enable file checkpointing for rollback. */
  enableFileCheckpointing?: boolean;
  /** Fallback model when primary is unavailable. */
  fallbackModel?: string;
}

// Discovered agent from system PATH
export interface DiscoveredAgent {
  command: string;
  name: string;
  icon: string;
  description: string;
  args: string[];
  path: string;
  version: string;
  available: boolean;
  /** @deprecated Legacy discovery field from the pre-SDK migration. */
  acpCommand?: string;
  acpArgs?: string[];
  /** SDK backend key (claude|codex|copilot|cursor|codebuddy|opencode|grok) — the routing value. */
  sdkBackend?: 'claude' | 'codex' | 'copilot' | 'cursor' | 'codebuddy' | 'opencode' | 'grok';
  /** Absolute resolved CLI path (preferred over `path`). */
  binPath?: string;
  installed?: boolean;
  authenticated?: boolean;
  authSource?: string | null;
}

// Web Search types
export type WebSearchProviderId = 'tavily' | 'exa' | 'bocha' | 'zhipu' | 'searxng';

export interface WebSearchConfig {
  providerId: WebSearchProviderId;
  apiKey?: string;        // enc:v1: encrypted via credentialBridge
  apiHost?: string;       // custom API endpoint (required for SearXNG)
  enabled: boolean;
  maxResults?: number;    // default 5
}

export const WEB_SEARCH_PROVIDER_PRESETS: Record<WebSearchProviderId, { name: string; defaultApiHost: string; requiresApiKey: boolean }> = {
  tavily: { name: 'Tavily', defaultApiHost: 'https://api.tavily.com', requiresApiKey: true },
  exa: { name: 'Exa', defaultApiHost: 'https://api.exa.ai', requiresApiKey: true },
  bocha: { name: 'Bocha', defaultApiHost: 'https://api.bochaai.com', requiresApiKey: true },
  zhipu: { name: 'Zhipu', defaultApiHost: 'https://open.bigmodel.cn/api/paas/v4', requiresApiKey: true },
  searxng: { name: 'SearXNG', defaultApiHost: '', requiresApiKey: false },
};

/** Check if a WebSearchConfig is fully configured and ready to use. */
export function isWebSearchReady(config?: WebSearchConfig | null): boolean {
  if (!config?.enabled) return false;
  const preset = WEB_SEARCH_PROVIDER_PRESETS[config.providerId];
  if (preset?.requiresApiKey && !config.apiKey) return false;
  if (config.providerId === 'searxng' && !config.apiHost) return false;
  // Validate apiHost is a well-formed URL if provided
  if (config.apiHost) {
    try { new URL(config.apiHost); } catch { return false; }
  }
  return true;
}

// AI Settings (stored in localStorage)
export interface AISettings {
  providers: ProviderConfig[];
  activeProviderId: string;
  activeModelId: string;
  globalPermissionMode: AIPermissionMode;
  toolIntegrationMode: AIToolIntegrationMode;
  externalAgents: ExternalAgentConfig[];
  defaultAgentId: string;
  commandBlocklist: string[];    // global command blocklist patterns
  commandTimeout: number;        // seconds, default 60
  responseIdleTimeout: number;   // seconds without response data, default 120
  maxIterations: number;         // doom loop prevention, default 20
  webSearchConfig?: WebSearchConfig;
}

export const DEFAULT_COMMAND_BLOCKLIST = [
  ...defaultCommandBlocklist,
];

export const DEFAULT_COMMAND_TIMEOUT_SECONDS = 60;
export const MAX_COMMAND_TIMEOUT_SECONDS = 24 * 60 * 60;
export const DEFAULT_RESPONSE_IDLE_TIMEOUT_SECONDS = 2 * 60;
export const MAX_RESPONSE_IDLE_TIMEOUT_SECONDS = 24 * 60 * 60;

export function normalizeCommandTimeoutSeconds(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_COMMAND_TIMEOUT_SECONDS;
  return Math.min(MAX_COMMAND_TIMEOUT_SECONDS, Math.max(1, value));
}

export function normalizeResponseIdleTimeoutSeconds(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RESPONSE_IDLE_TIMEOUT_SECONDS;
  return Math.min(MAX_RESPONSE_IDLE_TIMEOUT_SECONDS, Math.max(1, value));
}

export const DEFAULT_AI_SETTINGS: AISettings = {
  providers: [],
  activeProviderId: '',
  activeModelId: '',
  globalPermissionMode: 'confirm',
  toolIntegrationMode: 'mcp',
  externalAgents: [],
  defaultAgentId: 'catty',
  commandBlocklist: [...DEFAULT_COMMAND_BLOCKLIST],
  commandTimeout: DEFAULT_COMMAND_TIMEOUT_SECONDS,
  responseIdleTimeout: DEFAULT_RESPONSE_IDLE_TIMEOUT_SECONDS,
  maxIterations: 20,
};

export interface ProviderPreset {
  name: string;
  defaultBaseURL: string;
  modelsEndpoint?: string;
  defaultModels?: readonly string[];
}

// Provider presets for quick setup
export const PROVIDER_PRESETS: Record<AIProviderId, ProviderPreset> = {
  openai: { name: 'OpenAI', defaultBaseURL: 'https://api.openai.com/v1', modelsEndpoint: '/models' },
  anthropic: { name: 'Anthropic', defaultBaseURL: 'https://api.anthropic.com', modelsEndpoint: '/v1/models' },
  google: { name: 'Google AI', defaultBaseURL: 'https://generativelanguage.googleapis.com/v1beta' },
  ollama: { name: 'Ollama', defaultBaseURL: 'http://localhost:11434/v1', modelsEndpoint: '/models' },
  openrouter: { name: 'OpenRouter', defaultBaseURL: 'https://openrouter.ai/api/v1', modelsEndpoint: '/models' },
  qwen: {
    name: 'Qwen',
    defaultBaseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    modelsEndpoint: '/models',
    defaultModels: [
      'qwen3.7-plus',
      'qwen3.7-max',
      'qwen3.6-plus',
      'qwen3.6-flash',
      'qwen3.6-max-preview',
      'qwen3.5-plus',
      'qwen3-coder-plus',
      'qwen3-coder-flash',
      'qwen-plus',
      'qwen-plus-latest',
    ],
  },
  deepseek: {
    name: 'DeepSeek',
    defaultBaseURL: 'https://api.deepseek.com/v1',
    modelsEndpoint: '/models',
    defaultModels: [
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'deepseek-chat',
      'deepseek-reasoner',
    ],
  },
  kimi: {
    name: 'Kimi',
    defaultBaseURL: 'https://api.moonshot.ai/v1',
    modelsEndpoint: '/models',
    defaultModels: [
      'kimi-k2.6',
      'kimi-k2.5',
      'moonshot-v1-128k',
      'moonshot-v1-32k',
      'moonshot-v1-8k',
    ],
  },
  zhipu: {
    name: 'Zhipu',
    defaultBaseURL: 'https://open.bigmodel.cn/api/paas/v4',
    modelsEndpoint: '/models',
    defaultModels: [
      'glm-5.1',
      'glm-5',
      'glm-5-turbo',
      'glm-4.7',
      'glm-4.7-flash',
      'glm-4.6',
      'glm-4.5',
      'glm-4.5-air',
    ],
  },
  doubao: {
    name: 'Doubao',
    defaultBaseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    modelsEndpoint: '/models',
    defaultModels: [
      'doubao-seed-2-0-pro-260215',
      'doubao-seed-2-0-lite-260215',
      'doubao-seed-2-0-mini-260215',
      'doubao-seed-2-0-code-preview-260215',
    ],
  },
  mimo: {
    name: 'Xiaomi MiMo',
    defaultBaseURL: 'https://api.xiaomimimo.com/v1',
    modelsEndpoint: '/models',
    defaultModels: [
      'mimo-v2.5-pro',
      'mimo-v2.5',
    ],
  },
  custom: { name: 'Custom', defaultBaseURL: '' },
};

// Agent model presets (hardcoded, same as 1code)
export interface AgentModelPreset {
  id: string;
  name: string;
  description?: string;
  /** Supported reasoning levels (renderer selection encoded as `id/thinking`). */
  thinkingLevels?: string[];
  /**
   * Default effort used when auto-selecting a model with thinkingLevels.
   * Must be one of `thinkingLevels` when set. Do not infer from array order —
   * UI lists levels low→high but catalog defaults are usually mid-range.
   */
  defaultThinkingLevel?: string;
  /**
   * When false, a stored bare model id stays unsuffixed so the driver can
   * apply its own settings-level effort. Defaults to true.
   */
  encodeDefaultThinking?: boolean;
  /**
   * Minimum agent CLI version that advertises this model (semver core).
   * Netcatty is BYO-CLI: the packaged SDK does not replace the user's binary.
   */
  minCliVersion?: string;
}

const CLAUDE_REASONING_LEVELS = ['low', 'medium', 'high', 'max'] as const;

export const CLAUDE_MODEL_PRESETS: AgentModelPreset[] = [
  {
    id: 'default',
    name: 'Opus 4.6',
    description: 'Recommended',
    thinkingLevels: [...CLAUDE_REASONING_LEVELS],
    defaultThinkingLevel: 'medium',
  },
  {
    id: 'sonnet',
    name: 'Sonnet 4.6',
    description: 'Everyday tasks',
    thinkingLevels: [...CLAUDE_REASONING_LEVELS],
    defaultThinkingLevel: 'medium',
  },
  {
    id: 'haiku',
    name: 'Haiku 4.5',
    description: 'Fastest',
    thinkingLevels: [...CLAUDE_REASONING_LEVELS],
    defaultThinkingLevel: 'low',
  },
];

// Curated codex model list (codex-sdk has no enumeration API). IDs/efforts
// mirror openai/codex `models-manager/models.json` and peer open-source presets
// (pi openai-codex.models, lobehub agencyConfig, paperclip codex_local, suna
// codex-models, cherry-studio openai-codex). GPT-5.6 needs CLI >= 0.144.0.
// The codex driver splits "<id>/<effort>" into model + modelReasoningEffort.
const CODEX_REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const;
// Sol/Terra advertise ultra; Luna stops at max (official catalog + lobehub).
const CODEX_REASONING_LEVELS_5_6 = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
const CODEX_REASONING_LEVELS_5_6_LUNA = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
/** Official catalog `minimal_client_version` for GPT-5.6 family. */
export const CODEX_GPT_5_6_MIN_CLI_VERSION = '0.144.0';

function codexPreset(
  id: string,
  name: string,
  thinkingLevels: readonly string[],
  defaultThinkingLevel: string,
  options?: { description?: string; minCliVersion?: string },
): AgentModelPreset {
  return {
    id,
    name,
    description: options?.description,
    thinkingLevels: [...thinkingLevels],
    defaultThinkingLevel,
    minCliVersion: options?.minCliVersion,
  };
}

export const CODEX_MODEL_PRESETS: AgentModelPreset[] = [
  // default_reasoning_level + minimal_client_version from openai/codex catalog
  codexPreset('gpt-5.6-sol', 'GPT-5.6 Sol', CODEX_REASONING_LEVELS_5_6, 'low', {
    description: 'Latest',
    minCliVersion: CODEX_GPT_5_6_MIN_CLI_VERSION,
  }),
  codexPreset('gpt-5.6-terra', 'GPT-5.6 Terra', CODEX_REASONING_LEVELS_5_6, 'medium', {
    description: 'Balanced',
    minCliVersion: CODEX_GPT_5_6_MIN_CLI_VERSION,
  }),
  codexPreset('gpt-5.6-luna', 'GPT-5.6 Luna', CODEX_REASONING_LEVELS_5_6_LUNA, 'medium', {
    description: 'Fast',
    minCliVersion: CODEX_GPT_5_6_MIN_CLI_VERSION,
  }),
  codexPreset('gpt-5.5', 'GPT-5.5', CODEX_REASONING_LEVELS, 'medium'),
  codexPreset('gpt-5.4', 'GPT-5.4', CODEX_REASONING_LEVELS, 'medium'),
  codexPreset('gpt-5.4-mini', 'GPT-5.4 Mini', CODEX_REASONING_LEVELS, 'medium', {
    description: 'Small & fast',
  }),
  // Still visibility:list in upstream catalog; keep selectable so stored
  // gpt-5.2/* selections are not silently forced onto Sol.
  codexPreset('gpt-5.2', 'GPT-5.2', CODEX_REASONING_LEVELS, 'medium'),
];

/** Extract `major.minor.patch` from CLI --version output (e.g. "codex-cli 0.144.1"). */
export function extractCliSemver(versionText: string | null | undefined): string | null {
  if (!versionText) return null;
  const match = String(versionText).match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

function compareSemverCore(a: string, b: string): number {
  const pa = a.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

/**
 * Drop presets whose minCliVersion exceeds the installed CLI.
 * When the CLI version is unknown (pre-discovery / probe failed), also drop
 * version-gated presets so old installs cannot auto-default to Sol before
 * discovery finishes. Older ungated presets keep the picker non-empty.
 */
export function filterAgentModelPresetsForCliVersion(
  presets: AgentModelPreset[],
  cliVersionText: string | null | undefined,
): AgentModelPreset[] {
  const cliSemver = extractCliSemver(cliVersionText);
  return presets.filter((preset) => {
    if (!preset.minCliVersion) return true;
    if (!cliSemver) return false;
    return compareSemverCore(cliSemver, preset.minCliVersion) >= 0;
  });
}

/** Resolve the model id (with optional /effort) for auto-selection. */
export function resolveAgentModelSelection(preset: AgentModelPreset): string {
  const levels = preset.thinkingLevels;
  if (!levels?.length) return preset.id;
  if (preset.encodeDefaultThinking === false) return preset.id;
  const preferred = preset.defaultThinkingLevel;
  if (preferred && levels.includes(preferred)) {
    return `${preset.id}/${preferred}`;
  }
  // Conservative fallback: first listed effort (usually the cheapest/fastest).
  return `${preset.id}/${levels[0]}`;
}

function looksLikeFilesystemPath(command: string): boolean {
  return /[\\/]/.test(command) || /^[A-Za-z]:/.test(command);
}

function normalizeCliPathKey(pathText: string): string {
  // Case-fold on Windows-style paths; keep POSIX case-sensitive otherwise.
  const trimmed = pathText.trim();
  if (/^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.includes('\\')) {
    return trimmed.replace(/\\/g, '/').toLowerCase();
  }
  return trimmed;
}

/** Match a configured agent to a discovery row to read its probed CLI version. */
export function resolveDiscoveredAgentCliVersion(
  agent: Pick<ExternalAgentConfig, 'command' | 'sdkBackend'> | null | undefined,
  discovered: Array<Pick<DiscoveredAgent, 'command' | 'path' | 'binPath' | 'sdkBackend' | 'version'>>,
): string | undefined {
  if (!agent || discovered.length === 0) return undefined;
  const command = (agent.command || '').trim();
  if (!command) return undefined;

  // Absolute/relative path configs must match the exact discovered binary —
  // basename-only matching would gate against PATH codex while the driver
  // launches a different manual binary.
  if (looksLikeFilesystemPath(command)) {
    const wanted = normalizeCliPathKey(command);
    const pathMatch = discovered.find((entry) => {
      const candidates = [entry.path, entry.binPath].filter(Boolean) as string[];
      return candidates.some((candidate) => normalizeCliPathKey(candidate) === wanted);
    });
    return pathMatch?.version || undefined;
  }

  const basename = command.split(/[\\/]/).pop()?.toLowerCase() ?? command.toLowerCase();
  const match = discovered.find((entry) => {
    if (agent.sdkBackend && entry.sdkBackend && agent.sdkBackend !== entry.sdkBackend) {
      return false;
    }
    return entry.command === basename || entry.command === command;
  });
  return match?.version || undefined;
}

/**
 * Prefer the version stored on the agent config (settings resolve-cli / enable),
 * then fall back to a matching discovery probe.
 */
export function resolveAgentCliVersion(
  agent: Pick<ExternalAgentConfig, 'command' | 'sdkBackend' | 'cliVersion'> | null | undefined,
  discovered: Array<Pick<DiscoveredAgent, 'command' | 'path' | 'binPath' | 'sdkBackend' | 'version'>>,
): string | undefined {
  const stored = agent?.cliVersion?.trim();
  if (stored) return stored;
  return resolveDiscoveredAgentCliVersion(agent, discovered);
}

const CURSOR_REASONING_LEVELS = ['low', 'medium', 'high'] as const;

export const CURSOR_MODEL_PRESETS: AgentModelPreset[] = [
  { id: 'auto', name: 'Auto', description: 'Recommended for CLI login / subscription quota' },
  { id: 'composer-2.5', name: 'Composer 2.5', description: 'Recommended for API key' },
  {
    id: 'gpt-5',
    name: 'GPT-5',
    thinkingLevels: [...CURSOR_REASONING_LEVELS],
    defaultThinkingLevel: 'medium',
  },
  {
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    thinkingLevels: [...CURSOR_REASONING_LEVELS],
    defaultThinkingLevel: 'medium',
  },
  {
    id: 'gpt-5.2',
    name: 'GPT-5.2',
    thinkingLevels: [...CURSOR_REASONING_LEVELS],
    defaultThinkingLevel: 'medium',
  },
  {
    id: 'gpt-5.1',
    name: 'GPT-5.1',
    thinkingLevels: [...CURSOR_REASONING_LEVELS],
    defaultThinkingLevel: 'medium',
  },
  {
    id: 'claude-opus-4.6',
    name: 'Claude Opus 4.6',
    thinkingLevels: [...CURSOR_REASONING_LEVELS],
    defaultThinkingLevel: 'medium',
  },
  {
    id: 'claude-sonnet-4.6',
    name: 'Claude Sonnet 4.6',
    thinkingLevels: [...CURSOR_REASONING_LEVELS],
    defaultThinkingLevel: 'medium',
  },
];

// CodeBuddy's SDK model enumeration can be empty depending on CLI/account
// state; keep a CLI-supported fallback list so users can still pass --model.
const CODEBUDDY_REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const;

function codebuddyPreset(id: string, name: string): AgentModelPreset {
  return {
    id,
    name,
    thinkingLevels: [...CODEBUDDY_REASONING_LEVELS],
    defaultThinkingLevel: 'medium',
    encodeDefaultThinking: false,
  };
}

export const CODEBUDDY_MODEL_PRESETS: AgentModelPreset[] = [
  codebuddyPreset('deepseek-v4-pro', 'DeepSeek V4 Pro'),
  codebuddyPreset('deepseek-v4-flash', 'DeepSeek V4 Flash'),
  codebuddyPreset('deepseek-v3-2-volc', 'DeepSeek V3.2'),
  codebuddyPreset('glm-5.1', 'GLM 5.1'),
  codebuddyPreset('glm-5.0', 'GLM 5.0'),
  codebuddyPreset('glm-5.0-turbo', 'GLM 5.0 Turbo'),
  codebuddyPreset('glm-5v-turbo', 'GLM 5V Turbo'),
  codebuddyPreset('glm-4.7', 'GLM 4.7'),
  codebuddyPreset('minimax-m3-pay', 'MiniMax M3'),
  codebuddyPreset('minimax-m2.7', 'MiniMax M2.7'),
  codebuddyPreset('kimi-k2.6', 'Kimi K2.6'),
  codebuddyPreset('hy3-preview', 'Hy3 Preview'),
];

export const OPENCODE_MODEL_PRESETS: AgentModelPreset[] = [
  { id: 'openai/gpt-5.1', name: 'OpenAI GPT-5.1' },
  { id: 'anthropic/claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat' },
  { id: 'openrouter/openai/gpt-5.1', name: 'OpenRouter GPT-5.1' },
  { id: 'ollama/llama3.3', name: 'Ollama Llama 3.3' },
];

// Curated Grok Build models when `grok models` is unavailable. IDs mirror the
// public Grok Build / xAI coding agent lineup; live discovery still overrides.
export const GROK_MODEL_PRESETS: AgentModelPreset[] = [
  {
    id: 'grok-4.5',
    name: 'Grok 4.5',
    description: 'Default',
    thinkingLevels: ['high', 'medium', 'low'],
    defaultThinkingLevel: 'high',
  },
  {
    id: 'grok-4.6',
    name: 'Grok 4.6',
    thinkingLevels: ['xhigh', 'high', 'medium', 'low'],
    defaultThinkingLevel: 'high',
  },
];

export function getAgentModelPresets(
  agentCommand?: string,
  sdkBackend?: string,
): AgentModelPreset[] {
  // Prefer sdkBackend: CLI login stores the real `cursor-agent` binary path,
  // which would otherwise yield an empty preset list without this hint.
  const backend = String(sdkBackend || '').trim().toLowerCase();
  if (backend === 'claude') return CLAUDE_MODEL_PRESETS;
  if (backend === 'codex') return CODEX_MODEL_PRESETS;
  if (backend === 'cursor') return CURSOR_MODEL_PRESETS;
  if (backend === 'codebuddy') return CODEBUDDY_MODEL_PRESETS;
  if (backend === 'opencode') return OPENCODE_MODEL_PRESETS;
  if (backend === 'grok') return GROK_MODEL_PRESETS;

  if (!agentCommand) return [];
  // Split on both POSIX (/) and Windows (\) separators so command paths like
  // "C:\\Users\\foo\\codex.cmd" resolve to the right basename. Splitting only
  // on "/" leaves the full path intact on Windows, which never matches the
  // preset prefixes below and yields an empty list (presets silently lost).
  const basename = agentCommand.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (basename.startsWith('claude')) return CLAUDE_MODEL_PRESETS;
  if (basename.startsWith('codex')) return CODEX_MODEL_PRESETS;
  // Cursor CLI login resolves to `cursor-agent` on PATH.
  if (
    basename.startsWith('cursor')
    || basename.startsWith('cursor-agent')
  ) {
    return CURSOR_MODEL_PRESETS;
  }
  if (basename.startsWith('codebuddy')) return CODEBUDDY_MODEL_PRESETS;
  if (basename.startsWith('opencode')) return OPENCODE_MODEL_PRESETS;
  if (basename.startsWith('grok')) return GROK_MODEL_PRESETS;
  return [];
}

export function formatThinkingLabel(level: string): string {
  if (level === 'xhigh') return 'Extra High';
  return level.charAt(0).toUpperCase() + level.slice(1);
}
