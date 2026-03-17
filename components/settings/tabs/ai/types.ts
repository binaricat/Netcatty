/**
 * Shared types for AI settings sub-components
 */
import type {
  AIProviderId,
  ExternalAgentConfig,
} from "../../../../infrastructure/ai/types";

export type CodexIntegrationState =
  | "connected_chatgpt"
  | "connected_api_key"
  | "not_logged_in"
  | "unknown";

export interface CodexIntegrationStatus {
  state: CodexIntegrationState;
  isConnected: boolean;
  rawOutput: string;
  exitCode: number | null;
}

export type CodexLoginState = "running" | "success" | "error" | "cancelled";

export interface CodexLoginSession {
  sessionId: string;
  state: CodexLoginState;
  url: string | null;
  output: string;
  error: string | null;
  exitCode: number | null;
}

export interface AgentPathInfo {
  path: string | null;
  version: string | null;
  available: boolean;
}

export interface ProviderFormState {
  name: string;
  apiKey: string;
  baseURL: string;
  defaultModel: string;
  skipTLSVerify: boolean;
}

export interface FetchedModel {
  id: string;
  name?: string;
}

export interface FetchBridge {
  aiFetch?: (url: string, method?: string, headers?: Record<string, string>, body?: string, providerId?: string, skipHostCheck?: boolean, followRedirects?: boolean, skipTLSVerify?: boolean) => Promise<{ ok: boolean; data: string; error?: string }>;
  aiAllowlistAddHost?: (baseURL: string) => Promise<{ ok: boolean }>;
}

export interface NetcattyAiBridge {
  aiCodexGetIntegration?: () => Promise<CodexIntegrationStatus>;
  aiCodexStartLogin?: () => Promise<{ ok: boolean; session?: CodexLoginSession; error?: string }>;
  aiCodexGetLoginSession?: (sessionId: string) => Promise<{ ok: boolean; session?: CodexLoginSession; error?: string }>;
  aiCodexCancelLogin?: (sessionId: string) => Promise<{ ok: boolean; found?: boolean; session?: CodexLoginSession; error?: string }>;
  aiCodexLogout?: () => Promise<{ ok: boolean; state?: CodexIntegrationState; isConnected?: boolean; rawOutput?: string; logoutOutput?: string; error?: string }>;
  aiResolveCli?: (params: { command: string; customPath?: string }) => Promise<AgentPathInfo>;
  openExternal?: (url: string) => Promise<void>;
}

// Agent default configs for registration in externalAgents
export const AGENT_DEFAULTS: Record<string, Omit<ExternalAgentConfig, "id" | "command" | "enabled">> = {
  codex: {
    name: "Codex CLI",
    args: ["exec", "--full-auto", "--json", "{prompt}"],
    icon: "openai",
    acpCommand: "codex-acp",
    acpArgs: [],
  },
  claude: {
    name: "Claude Code",
    args: ["-p", "--output-format", "text", "{prompt}"],
    icon: "claude",
    acpCommand: "claude-code-acp",
    acpArgs: [],
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

export type SettingsIconId = AIProviderId | "claude";

export const SETTINGS_ICON_PATHS: Record<SettingsIconId, string> = {
  openai: "/ai/providers/openai.svg",
  anthropic: "/ai/providers/anthropic.svg",
  claude: "/ai/agents/claude.svg",
  google: "/ai/providers/google.svg",
  ollama: "/ai/providers/ollama.svg",
  openrouter: "/ai/providers/openrouter.svg",
  custom: "/ai/providers/custom.svg",
};

export const SETTINGS_ICON_COLORS: Record<SettingsIconId, string> = {
  openai: "bg-emerald-600",
  anthropic: "bg-orange-600",
  claude: "bg-orange-600",
  google: "bg-blue-600",
  ollama: "bg-purple-600",
  openrouter: "bg-pink-600",
  custom: "bg-zinc-600",
};
