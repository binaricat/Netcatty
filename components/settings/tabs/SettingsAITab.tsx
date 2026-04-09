/**
 * Settings AI Tab - AI provider configuration, agent CLI detection, and safety settings
 *
 * Sub-components live in ./ai/ directory:
 *   - ProviderCard, ProviderConfigForm, AddProviderDropdown
 *   - ModelSelector, ProviderIconBadge
 *   - CodexConnectionCard, ClaudeCodeCard
 *   - SafetySettings
 */
import { Bot, Globe } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AIPermissionMode,
  AIProviderId,
  AIToolIntegrationMode,
  ExternalAgentConfig,
  ProviderConfig,
  WebSearchConfig,
} from "../../../infrastructure/ai/types";
import {
  getManagedAgentStoredPath,
  matchesManagedAgentConfig,
  type ManagedAgentKey,
} from "../../../infrastructure/ai/managedAgents";
import { PROVIDER_PRESETS } from "../../../infrastructure/ai/types";
import { useI18n } from "../../../application/i18n/I18nProvider";
import { TabsContent } from "../../ui/tabs";
import { Select, SettingRow } from "../settings-ui";
import { AgentIconBadge } from "../../ai/AgentIconBadge";

import type {
  AgentPathInfo,
  CodexIntegrationStatus,
  CodexLoginSession,
} from "./ai/types";
import {
  AGENT_DEFAULTS,
  getBridge,
  normalizeCodexBridgeError,
} from "./ai/types";
import { ProviderIconBadge } from "./ai/ProviderIconBadge";
import { ProviderCard } from "./ai/ProviderCard";
import { AddProviderDropdown } from "./ai/AddProviderDropdown";
import { CodexConnectionCard } from "./ai/CodexConnectionCard";
import { ClaudeCodeCard } from "./ai/ClaudeCodeCard";
import { CopilotCliCard } from "./ai/CopilotCliCard";
import { SafetySettings } from "./ai/SafetySettings";
import { WebSearchSettings } from "./ai/WebSearchSettings";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SettingsAITabProps {
  providers: ProviderConfig[];
  addProvider: (provider: ProviderConfig) => void;
  updateProvider: (id: string, updates: Partial<ProviderConfig>) => void;
  removeProvider: (id: string) => void;
  activeProviderId: string;
  setActiveProviderId: (id: string) => void;
  activeModelId: string;
  setActiveModelId: (id: string) => void;
  globalPermissionMode: AIPermissionMode;
  setGlobalPermissionMode: (mode: AIPermissionMode) => void;
  toolIntegrationMode: AIToolIntegrationMode;
  setToolIntegrationMode: (mode: AIToolIntegrationMode) => void;
  externalAgents: ExternalAgentConfig[];
  setExternalAgents: (value: ExternalAgentConfig[] | ((prev: ExternalAgentConfig[]) => ExternalAgentConfig[])) => void;
  defaultAgentId: string;
  setDefaultAgentId: (id: string) => void;
  commandBlocklist: string[];
  setCommandBlocklist: (value: string[]) => void;
  commandTimeout: number;
  setCommandTimeout: (value: number) => void;
  maxIterations: number;
  setMaxIterations: (value: number) => void;
  webSearchConfig: WebSearchConfig | null;
  setWebSearchConfig: (config: WebSearchConfig | null) => void;
}

function areExternalAgentListsEqual(
  left: ExternalAgentConfig[],
  right: ExternalAgentConfig[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((agent, index) => JSON.stringify(agent) === JSON.stringify(right[index]));
}

function buildManagedAgentState(
  prevAgents: ExternalAgentConfig[],
  defaultAgentId: string,
  agentKey: ManagedAgentKey,
  pathInfo: AgentPathInfo | null,
): { agents: ExternalAgentConfig[]; defaultAgentId: string } {
  const managedId = `discovered_${agentKey}`;
  const managedAgents = prevAgents.filter((agent) => matchesManagedAgentConfig(agent, agentKey));
  const otherAgents = prevAgents.filter((agent) => !matchesManagedAgentConfig(agent, agentKey));
  const storedPath = getManagedAgentStoredPath(prevAgents, agentKey);

  if (!pathInfo?.available || !pathInfo.path) {
    return {
      agents: storedPath ? prevAgents : otherAgents,
      defaultAgentId: storedPath
        ? defaultAgentId
        : managedAgents.some((agent) => agent.id === defaultAgentId)
          ? "catty"
          : defaultAgentId,
    };
  }

  const existingManaged = managedAgents.find((agent) => agent.id === managedId);
  const defaults = AGENT_DEFAULTS[agentKey];
  const nextManagedAgent: ExternalAgentConfig = {
    ...existingManaged,
    ...defaults,
    id: managedId,
    command: pathInfo.path,
    enabled: managedAgents.length === 0 ? true : managedAgents.some((agent) => agent.enabled),
  };

  return {
    agents: [...otherAgents, nextManagedAgent],
    defaultAgentId: managedAgents.some((agent) => agent.id === defaultAgentId)
      ? managedId
      : defaultAgentId,
  };
}

// ---------------------------------------------------------------------------
// Main Tab Component
// ---------------------------------------------------------------------------

const SettingsAITab: React.FC<SettingsAITabProps> = ({
  providers,
  addProvider,
  updateProvider,
  removeProvider,
  activeProviderId,
  setActiveProviderId,
  activeModelId: _activeModelId,
  setActiveModelId,
  globalPermissionMode,
  setGlobalPermissionMode,
  toolIntegrationMode,
  setToolIntegrationMode,
  externalAgents,
  setExternalAgents,
  defaultAgentId,
  setDefaultAgentId,
  commandBlocklist,
  setCommandBlocklist,
  commandTimeout,
  setCommandTimeout,
  maxIterations,
  setMaxIterations,
  webSearchConfig,
  setWebSearchConfig,
}) => {
  const { t } = useI18n();
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [codexIntegration, setCodexIntegration] = useState<CodexIntegrationStatus | null>(null);
  const [codexLoginSession, setCodexLoginSession] = useState<CodexLoginSession | null>(null);
  const [isCodexLoading, setIsCodexLoading] = useState(false);
  const [codexError, setCodexError] = useState<string | null>(null);

  // Path detection state
  const [codexPathInfo, setCodexPathInfo] = useState<AgentPathInfo | null>(null);
  const [codexCustomPath, setCodexCustomPath] = useState("");
  const [isResolvingCodex, setIsResolvingCodex] = useState(false);

  const [claudePathInfo, setClaudePathInfo] = useState<AgentPathInfo | null>(null);
  const [claudeCustomPath, setClaudeCustomPath] = useState("");
  const [isResolvingClaude, setIsResolvingClaude] = useState(false);
  const initialManagedPathsRef = useRef<{
    codex: string;
    claude: string;
    copilot: string;
  } | null>(null);
  if (!initialManagedPathsRef.current) {
    initialManagedPathsRef.current = {
      codex: getManagedAgentStoredPath(externalAgents, "codex") ?? "",
      claude: getManagedAgentStoredPath(externalAgents, "claude") ?? "",
      copilot: getManagedAgentStoredPath(externalAgents, "copilot") ?? "",
    };
  }

  const [copilotPathInfo, setCopilotPathInfo] = useState<AgentPathInfo | null>(null);
  const [copilotCustomPath, setCopilotCustomPath] = useState("");
  const [isResolvingCopilot, setIsResolvingCopilot] = useState(false);

  // Ref to read current defaultAgentId without adding it as a dependency.
  const defaultAgentIdRef = useRef(defaultAgentId);
  defaultAgentIdRef.current = defaultAgentId;

  const resolveAgentPath = useCallback(async (
    agentKey: ManagedAgentKey,
    customPath = "",
  ) => {
    const bridge = getBridge();
    if (!bridge?.aiResolveCli) return null;

    const setInfo = agentKey === "codex"
      ? setCodexPathInfo
      : agentKey === "claude"
        ? setClaudePathInfo
        : setCopilotPathInfo;
    const setResolving = agentKey === "codex"
      ? setIsResolvingCodex
      : agentKey === "claude"
        ? setIsResolvingClaude
        : setIsResolvingCopilot;

    setResolving(true);
    try {
      const result = await bridge.aiResolveCli({
        command: agentKey,
        customPath: customPath.trim(),
      });
      setInfo(result);

      // Consolidate managed agent entries using the callback form of
      // setExternalAgents so we never depend on externalAgents directly.
      // All three agents resolve concurrently on mount — React runs
      // state updater callbacks sequentially, so updating the ref inside
      // ensures later calls see earlier defaultAgentId changes.
      let nextDefaultId: string | null = null;
      setExternalAgents((prev) => {
        const state = buildManagedAgentState(prev, defaultAgentIdRef.current, agentKey, result);
        if (state.defaultAgentId !== defaultAgentIdRef.current) {
          nextDefaultId = state.defaultAgentId;
          defaultAgentIdRef.current = state.defaultAgentId;
        }
        return areExternalAgentListsEqual(prev, state.agents) ? prev : state.agents;
      });
      if (nextDefaultId !== null) {
        setDefaultAgentId(nextDefaultId);
      }

      return result;
    } catch (err) {
      console.error("Path resolution failed:", err);
      return null;
    } finally {
      setResolving(false);
    }
  }, [setExternalAgents, setDefaultAgentId]);

  useEffect(() => {
    void resolveAgentPath("codex", initialManagedPathsRef.current?.codex ?? "");
    void resolveAgentPath("claude", initialManagedPathsRef.current?.claude ?? "");
    void resolveAgentPath("copilot", initialManagedPathsRef.current?.copilot ?? "");
  }, [resolveAgentPath]);

  // Validate a custom path for an agent
  const handleCheckCustomPath = useCallback(async (agentKey: ManagedAgentKey) => {
    const customPath = agentKey === "codex"
      ? codexCustomPath
      : agentKey === "claude"
        ? claudeCustomPath
        : copilotCustomPath;
    await resolveAgentPath(agentKey, customPath);
  }, [claudeCustomPath, codexCustomPath, copilotCustomPath, resolveAgentPath]);

  // Add a new provider from preset
  const handleAddProvider = useCallback(
    (providerId: AIProviderId) => {
      const preset = PROVIDER_PRESETS[providerId];
      const id = `provider_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      addProvider({
        id,
        providerId,
        name: preset.name,
        baseURL: preset.defaultBaseURL,
        enabled: false,
      });
      // Auto-open config form
      setEditingProviderId(id);
    },
    [addProvider],
  );

  // Remove provider with confirmation
  const handleRemoveProvider = useCallback(
    (id: string) => {
      const provider = providers.find((p) => p.id === id);
      const name = provider?.name || id;
      const ok = window.confirm(
        t('confirm.removeProvider', { name }),
      );
      if (!ok) return;
      removeProvider(id);
      if (editingProviderId === id) {
        setEditingProviderId(null);
      }
    },
    [removeProvider, editingProviderId, providers, t],
  );

  // Agent options for default agent
  const agentOptions = useMemo(() => [
    { value: "catty", label: t('ai.defaultAgent.catty'), icon: <AgentIconBadge agent={{ id: "catty", type: "builtin" }} size="xs" variant="plain" /> },
    ...externalAgents
      .filter((a) => a.enabled)
      .map((a) => ({ value: a.id, label: a.name, icon: <AgentIconBadge agent={a} size="xs" variant="plain" /> })),
  ], [externalAgents, t]);

  const hasOpenAiProviderKey = providers.some(
    (provider) => provider.providerId === "openai" && provider.enabled && !!provider.apiKey,
  );

  const refreshCodexIntegration = useCallback(async () => {
    const bridge = getBridge();
    if (!bridge?.aiCodexGetIntegration) return;

    setIsCodexLoading(true);
    setCodexError(null);
    try {
      const integration = await bridge.aiCodexGetIntegration();
      setCodexIntegration(integration);
    } catch (err) {
      setCodexError(normalizeCodexBridgeError(err));
    } finally {
      setIsCodexLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshCodexIntegration();
  }, [refreshCodexIntegration]);

  useEffect(() => {
    if (!codexLoginSession || codexLoginSession.state !== "running") {
      return;
    }

    const bridge = getBridge();
    if (!bridge?.aiCodexGetLoginSession) {
      return;
    }

    let cancelled = false;
    const intervalId = window.setInterval(() => {
      void bridge.aiCodexGetLoginSession?.(codexLoginSession.sessionId).then((result) => {
        if (cancelled || !result?.ok || !result.session) return;

        setCodexLoginSession(result.session);
        if (result.session.state !== "running") {
          if (result.session.state === "success") {
            void refreshCodexIntegration();
          }
        }
      }).catch((err) => {
        if (!cancelled) {
          setCodexError(normalizeCodexBridgeError(err));
        }
      });
    }, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [codexLoginSession, refreshCodexIntegration]);

  const handleStartCodexLogin = useCallback(async () => {
    const bridge = getBridge();
    if (!bridge?.aiCodexStartLogin) return;

    setCodexError(null);
    setIsCodexLoading(true);
    try {
      const result = await bridge.aiCodexStartLogin();
      if (!result.ok || !result.session) {
        throw new Error(result.error || "Failed to start Codex login");
      }
      setCodexLoginSession(result.session);
    } catch (err) {
      setCodexError(normalizeCodexBridgeError(err));
    } finally {
      setIsCodexLoading(false);
    }
  }, []);

  const handleCancelCodexLogin = useCallback(async () => {
    const bridge = getBridge();
    if (!bridge?.aiCodexCancelLogin || !codexLoginSession) return;

    setCodexError(null);
    try {
      const result = await bridge.aiCodexCancelLogin(codexLoginSession.sessionId);
      if (result.session) {
        setCodexLoginSession(result.session);
      }
    } catch (err) {
      setCodexError(normalizeCodexBridgeError(err));
    }
  }, [codexLoginSession]);

  const handleOpenCodexLoginUrl = useCallback(() => {
    const bridge = getBridge();
    const url = codexLoginSession?.url;
    if (!bridge?.openExternal || !url) return;
    // Only allow https:// URLs to prevent opening arbitrary protocols
    if (!url.startsWith("https://")) return;
    void bridge.openExternal(url);
  }, [codexLoginSession]);

  const handleCodexLogout = useCallback(async () => {
    const bridge = getBridge();
    if (!bridge?.aiCodexLogout) return;

    setCodexError(null);
    setIsCodexLoading(true);
    try {
      const result = await bridge.aiCodexLogout();
      if (!result.ok) {
        throw new Error(result.error || "Failed to log out from Codex");
      }
      setCodexLoginSession(null);
      await refreshCodexIntegration();
    } catch (err) {
      setCodexError(normalizeCodexBridgeError(err));
    } finally {
      setIsCodexLoading(false);
    }
  }, [refreshCodexIntegration]);

  return (
    <TabsContent
      value="ai"
      className="data-[state=inactive]:hidden h-full flex flex-col"
    >
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-8 py-6">
        <div className="max-w-2xl space-y-8">
          {/* Header */}
          <div>
            <h2 className="text-xl font-semibold">{t('ai.title')}</h2>
            <p className="text-sm text-muted-foreground mt-1">
              {t('ai.description')}
            </p>
          </div>

          {/* -- Providers Section -- */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Globe size={18} className="text-muted-foreground" />
                <h3 className="text-base font-medium">{t('ai.providers')}</h3>
              </div>
              <AddProviderDropdown onAdd={handleAddProvider} />
            </div>

            {providers.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border/60 p-6 text-center">
                <Bot size={24} className="mx-auto text-muted-foreground mb-2" />
                <p className="text-sm text-muted-foreground">
                  {t('ai.providers.empty')}
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {providers.map((provider) => (
                  <ProviderCard
                    key={provider.id}
                    provider={provider}
                    isActive={provider.id === activeProviderId}
                    onToggleEnabled={(enabled) => {
                      if (enabled) {
                        // Activate this provider, deactivate all others
                        setActiveProviderId(provider.id);
                        if (provider.defaultModel) {
                          setActiveModelId(provider.defaultModel);
                        }
                        for (const p of providers) {
                          if (p.id === provider.id) {
                            if (!p.enabled) updateProvider(p.id, { enabled: true });
                          } else {
                            if (p.enabled) updateProvider(p.id, { enabled: false });
                          }
                        }
                      } else {
                        // Deactivate this provider
                        if (activeProviderId === provider.id) {
                          setActiveProviderId("");
                          setActiveModelId("");
                        }
                        updateProvider(provider.id, { enabled: false });
                      }
                    }}
                    onEdit={() =>
                      setEditingProviderId(
                        editingProviderId === provider.id ? null : provider.id,
                      )
                    }
                    onRemove={() => handleRemoveProvider(provider.id)}
                    onUpdate={(updates) => {
                      updateProvider(provider.id, updates);
                      // If this is the active provider and model changed, update activeModelId
                      if (provider.id === activeProviderId && updates.defaultModel !== undefined) {
                        setActiveModelId(updates.defaultModel || "");
                      }
                    }}
                    isEditing={editingProviderId === provider.id}
                    onCancelEdit={() => setEditingProviderId(null)}
                  />
                ))}
              </div>
            )}
          </div>

          {/* -- Codex Section -- */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <ProviderIconBadge providerId="openai" size="sm" />
              <h3 className="text-base font-medium">{t('ai.codex')}</h3>
            </div>

            <CodexConnectionCard
              pathInfo={codexPathInfo}
              isResolvingPath={isResolvingCodex}
              customPath={codexCustomPath}
              onCustomPathChange={setCodexCustomPath}
              onRecheckPath={() => void handleCheckCustomPath("codex")}
              integration={codexIntegration}
              loginSession={codexLoginSession}
              isLoading={isCodexLoading}
              hasOpenAiProviderKey={hasOpenAiProviderKey}
              error={codexError}
              onRefresh={() => void refreshCodexIntegration()}
              onConnect={() => void handleStartCodexLogin()}
              onCancel={() => void handleCancelCodexLogin()}
              onOpenUrl={handleOpenCodexLoginUrl}
              onLogout={() => void handleCodexLogout()}
            />
          </div>

          {/* -- Claude Code Section -- */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <ProviderIconBadge providerId="claude" size="sm" />
              <h3 className="text-base font-medium">{t('ai.claude.title')}</h3>
            </div>

            <ClaudeCodeCard
              pathInfo={claudePathInfo}
              isResolvingPath={isResolvingClaude}
              customPath={claudeCustomPath}
              onCustomPathChange={setClaudeCustomPath}
              onRecheckPath={() => void handleCheckCustomPath("claude")}
            />
          </div>

          {/* -- GitHub Copilot CLI Section -- */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <ProviderIconBadge providerId="copilot" size="sm" />
              <h3 className="text-base font-medium">{t('ai.copilot.title')}</h3>
            </div>

            <CopilotCliCard
              pathInfo={copilotPathInfo}
              isResolvingPath={isResolvingCopilot}
              customPath={copilotCustomPath}
              onCustomPathChange={setCopilotCustomPath}
              onRecheckPath={() => void handleCheckCustomPath("copilot")}
            />
          </div>

          {/* -- Default Agent Section -- */}
          {agentOptions.length > 1 && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Bot size={18} className="text-muted-foreground" />
                <h3 className="text-base font-medium">{t('ai.defaultAgent')}</h3>
              </div>

              <div className="bg-muted/30 rounded-lg p-4">
                <SettingRow
                  label={t('ai.defaultAgent')}
                  description={t('ai.defaultAgent.description')}
                >
                  <Select
                    value={defaultAgentId}
                    options={agentOptions}
                    onChange={setDefaultAgentId}
                    className="w-64"
                  />
                </SettingRow>
              </div>
            </div>
          )}

          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Bot size={18} className="text-muted-foreground" />
              <h3 className="text-base font-medium">{t('ai.toolAccess.title')}</h3>
            </div>

            <div className="bg-muted/30 rounded-lg p-4">
              <SettingRow
                label={t('ai.toolAccess.mode')}
                description={t('ai.toolAccess.description')}
              >
                <Select
                  value={toolIntegrationMode}
                  options={[
                    { value: 'mcp', label: t('ai.toolAccess.mode.mcp') },
                    { value: 'skills', label: t('ai.toolAccess.mode.skills') },
                  ]}
                  onChange={(value) => setToolIntegrationMode(value as AIToolIntegrationMode)}
                  className="w-48"
                />
              </SettingRow>
            </div>
          </div>

          {/* -- Web Search Section -- */}
          <WebSearchSettings
            webSearchConfig={webSearchConfig}
            setWebSearchConfig={setWebSearchConfig}
          />

          {/* -- Safety Section -- */}
          <SafetySettings
            globalPermissionMode={globalPermissionMode}
            setGlobalPermissionMode={setGlobalPermissionMode}
            commandBlocklist={commandBlocklist}
            setCommandBlocklist={setCommandBlocklist}
            commandTimeout={commandTimeout}
            setCommandTimeout={setCommandTimeout}
            maxIterations={maxIterations}
            setMaxIterations={setMaxIterations}
          />
        </div>
      </div>
    </TabsContent>
  );
};

export default SettingsAITab;
