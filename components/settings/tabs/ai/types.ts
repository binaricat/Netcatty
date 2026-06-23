/**
 * Shared types for AI settings sub-components
 */
import type {
  AIProviderId,
  ExternalAgentConfig,
  ProviderAdvancedParams,
  ProviderStyle,
} from "../../../../infrastructure/ai/types";

export type CodexIntegrationState =
  | "connected_chatgpt"
  | "connected_api_key"
  | "connected_custom_config"
  | "not_logged_in"
  | "unknown";

export interface CodexCustomProviderConfig {
  providerName: string;
  displayName: string;
  baseUrl: string | null;
  envKey: string | null;
  envKeyPresent: boolean;
  hasHardcodedApiKey: boolean;
  model: string | null;
  authHash: string | null;
}

export interface CodexIntegrationStatus {
  state: CodexIntegrationState;
  isConnected: boolean;
  rawOutput: string;
  exitCode: number | null;
  customConfig?: CodexCustomProviderConfig | null;
}

export type CodexLoginState = "running" | "success" | "error" | "cancelled";

export interface CodexLoginSession {
  sessionId: string;
  state: CodexLoginState;
  url: string | null;
  output: string;
  error: string | null;
  exitCode: number | null;
  codexPath?: string | null;
}

export interface AgentPathInfo {
  path: string | null;
  binPath?: string | null;
  version: string | null;
  available: boolean;
  installed?: boolean;
  authenticated?: boolean;
  authSource?: string | null;
}

export interface UserSkillStatusItem {
  id: string;
  slug: string;
  directoryName: string;
  directoryPath: string;
  skillPath: string;
  name: string;
  description: string;
  status: "ready" | "warning";
  warnings: string[];
}

export interface UserSkillsStatusResult {
  ok: boolean;
  directoryPath?: string;
  readyCount?: number;
  warningCount?: number;
  skills?: UserSkillStatusItem[];
  warnings?: string[];
  error?: string;
}

export interface ProviderFormState {
  name: string;
  apiKey: string;
  baseURL: string;
  defaultModel: string;
  contextWindow: string;
  modelContextWindows: Record<string, number>;
  skipTLSVerify: boolean;
  advancedParams: ProviderAdvancedParams;
  style: ProviderStyle | "";  // "" means inherit-from-providerId
  iconId: string;             // "" means no built-in pick (fall back to providerId)
  iconDataUrl: string;        // "" means no upload override
}

export interface FetchedModel {
  id: string;
  name?: string;
  contextWindow?: number;
}

export interface FetchBridge {
  aiFetch?: (url: string, method?: string, headers?: Record<string, string>, body?: string, providerId?: string, skipHostCheck?: boolean, followRedirects?: boolean, skipTLSVerify?: boolean) => Promise<{ ok: boolean; data: string; error?: string }>;
  aiAllowlistAddHost?: (baseURL: string) => Promise<{ ok: boolean }>;
}

export interface NetcattyAiBridge {
  aiDiscoverAgents?: (options?: { refreshShellEnv?: boolean; apiKeyPresent?: boolean }) => Promise<Array<AgentPathInfo & { command: string }>>;
  aiPrewarmShellEnv?: () => Promise<{ ok: boolean; error?: string }>;
  aiCodexGetIntegration?: (options?: { refreshShellEnv?: boolean; validateChatGptAuth?: boolean; codexPath?: string }) => Promise<CodexIntegrationStatus>;
  aiCodexStartLogin?: (options?: { codexPath?: string }) => Promise<{ ok: boolean; session?: CodexLoginSession; error?: string }>;
  aiCodexGetLoginSession?: (sessionId: string) => Promise<{ ok: boolean; session?: CodexLoginSession; error?: string }>;
  aiCodexCancelLogin?: (sessionId: string) => Promise<{ ok: boolean; found?: boolean; session?: CodexLoginSession; error?: string }>;
  aiCodexLogout?: (options?: { codexPath?: string }) => Promise<{ ok: boolean; state?: CodexIntegrationState; isConnected?: boolean; rawOutput?: string; logoutOutput?: string; error?: string }>;
  aiResolveCli?: (params: { command: string; customPath?: string; refreshShellEnv?: boolean; apiKeyPresent?: boolean }) => Promise<AgentPathInfo>;
  aiUserSkillsGetStatus?: () => Promise<UserSkillsStatusResult>;
  aiUserSkillsOpenFolder?: () => Promise<UserSkillsStatusResult>;
  openExternal?: (url: string) => Promise<void>;
}

// Agent default configs for registration in externalAgents
export const AGENT_DEFAULTS: Record<string, Omit<ExternalAgentConfig, "id" | "command" | "enabled">> = {
  codex: {
    name: "Codex CLI",
    args: ["exec", "--full-auto", "--json", "{prompt}"],
    icon: "openai",
    sdkBackend: "codex",
  },
  claude: {
    name: "Claude Code",
    args: ["-p", "--output-format", "text", "{prompt}"],
    icon: "claude",
    sdkBackend: "claude",
  },
  copilot: {
    name: "GitHub Copilot CLI",
    args: ["-p", "{prompt}"],
    icon: "copilot",
    sdkBackend: "copilot",
  },
  cursor: {
    name: "Cursor",
    args: ["{prompt}"],
    icon: "cursor",
    sdkBackend: "cursor",
  },
  codebuddy: {
    name: "CodeBuddy Code",
    args: [],
    icon: "codebuddy",
    sdkBackend: "codebuddy",
  },
  opencode: {
    name: "OpenCode",
    args: [],
    icon: "opencode",
    sdkBackend: "opencode",
  },
};

// ---------------------------------------------------------------------------
// Bridge helpers
// ---------------------------------------------------------------------------

export function getBridge(): NetcattyAiBridge | undefined {
  return (window as unknown as { netcatty?: NetcattyAiBridge }).netcatty;
}

export function getFetchBridge(): FetchBridge | undefined {
  return (window as unknown as { netcatty?: FetchBridge }).netcatty;
}

export function normalizeCodexBridgeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("No handler registered for 'netcatty:ai:codex:")) {
    return "Codex main-process handlers are not loaded yet. Fully restart Netcatty, or restart the Electron dev process, then try again.";
  }
  return message;
}

// ---------------------------------------------------------------------------
// Provider icon helper
// ---------------------------------------------------------------------------

export type SettingsIconId = AIProviderId | "claude" | "copilot" | "codebuddy" | "opencode";

export const SETTINGS_ICON_PATHS: Record<SettingsIconId, string> = {
  openai: "/ai/providers/openai.svg",
  anthropic: "/ai/providers/anthropic.svg",
  claude: "/ai/agents/claude.svg",
  copilot: "/ai/agents/copilot.svg",
  codebuddy: "/ai/agents/codebuddy.svg",
  opencode: "/ai/agents/opencode.svg",
  google: "/ai/providers/google.svg",
  ollama: "/ai/providers/ollama.svg",
  openrouter: "/ai/providers/openrouter.svg",
  qwen: "/ai/providers/qwen.svg",
  deepseek: "/ai/providers/deepseek.svg",
  kimi: "/ai/providers/kimi.svg",
  zhipu: "/ai/providers/zhipu.svg",
  doubao: "/ai/providers/doubao.svg",
  mimo: "/ai/providers/xiaomi.svg",
  custom: "/ai/providers/custom.svg",
};

export const SETTINGS_ICON_COLORS: Record<SettingsIconId, string> = {
  openai: "bg-emerald-600",
  anthropic: "bg-orange-600",
  claude: "bg-orange-600",
  copilot: "border border-zinc-300 bg-white",
  codebuddy: "bg-indigo-600",
  opencode: "bg-teal-600",
  google: "bg-blue-600",
  ollama: "bg-purple-600",
  openrouter: "bg-pink-600",
  qwen: "bg-[#615CED]",
  deepseek: "bg-[#4D6BFE]",
  kimi: "bg-zinc-800",
  zhipu: "bg-[#3859FF]",
  doubao: "bg-[#0066FF]",
  mimo: "bg-[#FF6900]",
  custom: "bg-zinc-600",
};

// ---------------------------------------------------------------------------
// Extra brand icons (lobe-icons subset, MIT) for ProviderConfig.iconId
// See public/ai/providers/NOTICE.md for attribution.
// ---------------------------------------------------------------------------

export interface BuiltinProviderIcon {
  /** Identifier stored as ProviderConfig.iconId. */
  id: string;
  /** Display label shown in the icon picker. */
  label: string;
  /** Suggested display name when picking this preset (auto-fills ProviderConfig.name). */
  name: string;
  /** Absolute URL of the SVG asset. */
  path: string;
  /** Background tint applied behind the monochrome glyph. */
  bgColor: string;
}

export const BUILTIN_PROVIDER_ICONS: BuiltinProviderIcon[] = [
  { id: "anthropic", label: "Anthropic", name: "Anthropic", path: "/ai/providers/anthropic.svg", bgColor: "bg-orange-600" },
  { id: "openai", label: "OpenAI", name: "OpenAI", path: "/ai/providers/openai.svg", bgColor: "bg-emerald-600" },
  { id: "google", label: "Google", name: "Google", path: "/ai/providers/google.svg", bgColor: "bg-blue-600" },
  { id: "ollama", label: "Ollama", name: "Ollama", path: "/ai/providers/ollama.svg", bgColor: "bg-purple-600" },
  { id: "openrouter", label: "OpenRouter", name: "OpenRouter", path: "/ai/providers/openrouter.svg", bgColor: "bg-pink-600" },
  { id: "deepseek", label: "DeepSeek", name: "DeepSeek", path: "/ai/providers/deepseek.svg", bgColor: "bg-[#4D6BFE]" },
  { id: "moonshot", label: "Moonshot", name: "Moonshot", path: "/ai/providers/moonshot.svg", bgColor: "bg-zinc-800" },
  { id: "kimi", label: "Kimi", name: "Kimi", path: "/ai/providers/kimi.svg", bgColor: "bg-zinc-800" },
  { id: "qwen", label: "Qwen / 通义", name: "Qwen", path: "/ai/providers/qwen.svg", bgColor: "bg-[#615CED]" },
  { id: "zhipu", label: "Zhipu / 智谱", name: "Zhipu", path: "/ai/providers/zhipu.svg", bgColor: "bg-[#3859FF]" },
  { id: "doubao", label: "Doubao / 豆包", name: "Doubao", path: "/ai/providers/doubao.svg", bgColor: "bg-[#0066FF]" },
  { id: "xiaomi", label: "Xiaomi / 小米", name: "Xiaomi MiMo", path: "/ai/providers/xiaomi.svg", bgColor: "bg-[#FF6900]" },
  { id: "mistral", label: "Mistral", name: "Mistral", path: "/ai/providers/mistral.svg", bgColor: "bg-[#FA520F]" },
  { id: "cohere", label: "Cohere", name: "Cohere", path: "/ai/providers/cohere.svg", bgColor: "bg-[#39594D]" },
  { id: "grok", label: "Grok / xAI", name: "Grok", path: "/ai/providers/grok.svg", bgColor: "bg-zinc-900" },
  { id: "perplexity", label: "Perplexity", name: "Perplexity", path: "/ai/providers/perplexity.svg", bgColor: "bg-[#1F8A8C]" },
  { id: "groq", label: "Groq", name: "Groq", path: "/ai/providers/groq.svg", bgColor: "bg-[#F55036]" },
  { id: "huggingface", label: "Hugging Face", name: "Hugging Face", path: "/ai/providers/huggingface.svg", bgColor: "bg-[#FF9D00]" },
];

export const BUILTIN_PROVIDER_ICON_BY_ID: Record<string, BuiltinProviderIcon> =
  Object.fromEntries(BUILTIN_PROVIDER_ICONS.map((icon) => [icon.id, icon]));
