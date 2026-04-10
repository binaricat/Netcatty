// AI Provider types
export type AIProviderId = 'openai' | 'anthropic' | 'google' | 'ollama' | 'openrouter' | 'custom';

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
  apiKey?: string;           // encrypted via credentialBridge (enc:v1: prefix)
  baseURL?: string;          // custom endpoint URL
  defaultModel?: string;
  customHeaders?: Record<string, string>;
  enabled: boolean;
  skipTLSVerify?: boolean;   // skip TLS certificate verification (for self-signed certs)
  advancedParams?: ProviderAdvancedParams;
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
  filePath?: string;    // original filesystem path (for ACP agents to read directly)
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  attachments?: ChatMessageAttachment[];
  /** @deprecated Use attachments instead. Kept for backward compatibility with persisted sessions. */
  images?: ChatMessageAttachment[];
  thinking?: string;
  thinkingDurationMs?: number;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
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
export type AIPermissionMode = 'observer' | 'confirm' | 'autonomous';
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

// External Agent (ACP) config
export interface ExternalAgentConfig {
  id: string;
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  icon?: string;
  enabled: boolean;
  /** ACP command (e.g. 'codex-acp', 'claude-agent-acp', 'gemini --experimental-acp') */
  acpCommand?: string;
  acpArgs?: string[];
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
  /** ACP command if agent supports ACP protocol */
  acpCommand?: string;
  acpArgs?: string[];
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
  maxIterations: number;         // doom loop prevention, default 20
  webSearchConfig?: WebSearchConfig;
}

export const DEFAULT_COMMAND_BLOCKLIST = [
  // rm with recursive+force in any order/form targeting root
  '\\brm\\s+(-[a-zA-Z]*r[a-zA-Z]*\\s+(-[a-zA-Z]*f[a-zA-Z]*\\s+)?|-[a-zA-Z]*f[a-zA-Z]*\\s+(-[a-zA-Z]*r[a-zA-Z]*\\s+)?|--recursive\\s+|--force\\s+){1,}',
  '\\bmkfs\\.',
  '\\bdd\\s+if=.*\\s+of=/dev/',
  '\\b(shutdown|reboot|poweroff|halt)\\b',
  ':\\(\\)\\{\\s*:\\|:\\&\\s*\\};:',  // fork bomb
  '>\\s*/dev/sd',
  '\\bchmod\\s+(-[a-zA-Z]*R[a-zA-Z]*|--recursive)\\s+777\\s+/',
  '\\bmv\\s+/\\s',
  ':\\s*>\\s*/etc/',
  '\\bcurl\\s+.*\\|\\s*\\bsudo\\s+\\bbash\\b',  // piped install with sudo
  '\\bwget\\s+.*\\|\\s*\\bsudo\\s+\\bbash\\b',
  // Common bypass techniques (defense-in-depth, not a security boundary)
  'base64.*\\|.*(?:ba)?sh',                    // base64 decode piped to shell
  '\\beval\\b',                                // eval usage
  '\\$\\(',                                    // command substitution abuse
  '`.+`',                                     // backtick command substitution
];

export const DEFAULT_AI_SETTINGS: AISettings = {
  providers: [],
  activeProviderId: '',
  activeModelId: '',
  globalPermissionMode: 'confirm',
  toolIntegrationMode: 'mcp',
  externalAgents: [],
  defaultAgentId: 'catty',
  commandBlocklist: [...DEFAULT_COMMAND_BLOCKLIST],
  commandTimeout: 60,
  maxIterations: 20,
};

// Provider presets for quick setup
export const PROVIDER_PRESETS: Record<AIProviderId, { name: string; defaultBaseURL: string; modelsEndpoint?: string }> = {
  openai: { name: 'OpenAI', defaultBaseURL: 'https://api.openai.com/v1', modelsEndpoint: '/models' },
  anthropic: { name: 'Anthropic', defaultBaseURL: 'https://api.anthropic.com', modelsEndpoint: '/v1/models' },
  google: { name: 'Google AI', defaultBaseURL: 'https://generativelanguage.googleapis.com/v1beta' },
  ollama: { name: 'Ollama', defaultBaseURL: 'http://localhost:11434/v1', modelsEndpoint: '/models' },
  openrouter: { name: 'OpenRouter', defaultBaseURL: 'https://openrouter.ai/api/v1', modelsEndpoint: '/models' },
  custom: { name: 'Custom', defaultBaseURL: '' },
};

// Agent model presets (hardcoded, same as 1code)
export interface AgentModelPreset {
  id: string;
  name: string;
  description?: string;
  /** Codex thinking levels (model ID sent as `id/thinking`) */
  thinkingLevels?: string[];
}

export const CLAUDE_MODEL_PRESETS: AgentModelPreset[] = [
  { id: 'default', name: 'Opus 4.6', description: 'Recommended' },
  { id: 'sonnet', name: 'Sonnet 4.6', description: 'Everyday tasks' },
  { id: 'haiku', name: 'Haiku 4.5', description: 'Fastest' },
];

export const CODEX_MODEL_PRESETS: AgentModelPreset[] = [
  { id: 'gpt-5.4', name: 'GPT 5.4', description: 'Latest', thinkingLevels: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'gpt-5.3-codex', name: 'Codex 5.3', thinkingLevels: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'gpt-5.2-codex', name: 'Codex 5.2', thinkingLevels: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'gpt-5.1-codex-max', name: 'Codex 5.1 Max', thinkingLevels: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'gpt-5.1-codex-mini', name: 'Codex 5.1 Mini', description: 'Fast', thinkingLevels: ['medium', 'high'] },
  { id: 'o3', name: 'o3', description: 'Reasoning' },
  { id: 'o4-mini', name: 'o4-mini', description: 'Fast reasoning' },
];

export function getAgentModelPresets(agentCommand?: string): AgentModelPreset[] {
  if (!agentCommand) return [];
  const basename = agentCommand.split('/').pop()?.toLowerCase() ?? '';
  if (basename.startsWith('claude')) return CLAUDE_MODEL_PRESETS;
  if (basename.startsWith('codex')) return CODEX_MODEL_PRESETS;
  return [];
}

export function formatThinkingLabel(level: string): string {
  if (level === 'xhigh') return 'Extra High';
  return level.charAt(0).toUpperCase() + level.slice(1);
}
