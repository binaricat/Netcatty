/**
 * Settings AI Tab - AI provider configuration, agent CLI detection, and safety settings
 *
 * Sub-components live in ./ai/ directory:
 *   - ProviderCard, ProviderConfigForm, AddProviderDropdown
 *   - ModelSelector
 *   - CodexConnectionCard, ClaudeCodeCard, CodebuddyCard
 *   - SafetySettings
 */
import { AlertTriangle, Bot, FolderOpen, RefreshCcw } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AIPermissionMode,
  AIProviderId,
  AIToolIntegrationMode,
  ExternalAgentConfig,
  ProviderConfig,
  WebSearchConfig,
} from "../../../infrastructure/ai/types";
import type { ManagedAgentKey } from "../../../infrastructure/ai/managedAgents";
import { PROVIDER_PRESETS } from "../../../infrastructure/ai/types";
import { useI18n } from "../../../application/i18n/I18nProvider";
import { Button } from "../../ui/button";
import { Select, SettingCard, SettingsSection, SettingsTabContent, SettingRow } from "../settings-ui";
import { AgentIconBadge } from "../../ai/AgentIconBadge";
import { canSendWithAgent } from "../../ai/agentSendEligibility";

import type {
  AgentPathInfo,
  CodexIntegrationStatus,
  CodexLoginSession,
  UserSkillsStatusResult,
} from "./ai/types";
import {
  getBridge,
  normalizeCodexBridgeError,
} from "./ai/types";
import { ProviderCard } from "./ai/ProviderCard";
import { AddProviderDropdown } from "./ai/AddProviderDropdown";
import { CodexConnectionCard } from "./ai/CodexConnectionCard";
import { ClaudeCodeCard } from "./ai/ClaudeCodeCard";
import { CopilotCliCard } from "./ai/CopilotCliCard";
import { CodebuddyCard } from "./ai/CodebuddyCard";
import { SafetySettings } from "./ai/SafetySettings";
import { WebSearchSettings } from "./ai/WebSearchSettings";
import { QuickMessagesSettings } from "./ai/QuickMessagesSettings";
import type { AIQuickMessage } from "../../../infrastructure/ai/quickMessages";
import { encryptField } from "../../../infrastructure/persistence/secureFieldAdapter";
import { CursorSdkCard } from "./ai/CursorSdkCard";
import {
  areExternalAgentListsEqual,
  buildManagedAgentState,
  getInitialManagedAgentPaths,
  updateCodebuddyManagedEnv,
} from "./ai/managedAgentState";
import { splitClaudeEnv, buildClaudeEnv } from "./ai/claudeConfigEnv";
import { splitCodebuddyEnv } from "./ai/codebuddyConfigEnv";

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
  quickMessages: AIQuickMessage[];
  setQuickMessages: (value: AIQuickMessage[] | ((prev: AIQuickMessage[]) => AIQuickMessage[])) => void;
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
  quickMessages,
  setQuickMessages,
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

  const claudeManagedEnv = useMemo(
    () => externalAgents.find((a) => a.id === "discovered_claude")?.env,
    [externalAgents],
  );
  const {
    configDir: claudeConfigDir,
    settingsPath: claudeSettingsPath,
    envText: claudeEnvText,
  } = useMemo(() => splitClaudeEnv(claudeManagedEnv), [claudeManagedEnv]);

  const updateClaudeEnv = useCallback(
    (nextConfigDir: string, nextSettingsPath: string, nextEnvText: string) => {
      setExternalAgents((prev) =>
        prev.map((a) =>
          a.id === "discovered_claude"
            ? { ...a, env: buildClaudeEnv(a.env, nextConfigDir, nextSettingsPath, nextEnvText) }
            : a,
        ),
      );
    },
    [setExternalAgents],
  );

  const initialManagedPathsRef = useRef<{
    codex: string;
    claude: string;
    copilot: string;
    cursor: string;
    codebuddy: string;
  } | null>(null);
  if (!initialManagedPathsRef.current) {
    initialManagedPathsRef.current = getInitialManagedAgentPaths(externalAgents);
  }

  const [copilotPathInfo, setCopilotPathInfo] = useState<AgentPathInfo | null>(null);
  const [copilotCustomPath, setCopilotCustomPath] = useState("");
  const [isResolvingCopilot, setIsResolvingCopilot] = useState(false);

  const [cursorPathInfo, setCursorPathInfo] = useState<AgentPathInfo | null>(null);
  const [isResolvingCursor, setIsResolvingCursor] = useState(false);

  const [codebuddyPathInfo, setCodebuddyPathInfo] = useState<AgentPathInfo | null>(null);
  const [codebuddyCustomPath, setCodebuddyCustomPath] = useState("");
  const [isResolvingCodebuddy, setIsResolvingCodebuddy] = useState(false);

  const codebuddyManagedEnv = useMemo(
    () => externalAgents.find((a) => a.id === "discovered_codebuddy")?.env,
    [externalAgents],
  );
  const {
    internetEnv: codebuddyInternetEnv,
    envText: codebuddyEnvText,
  } = useMemo(() => splitCodebuddyEnv(codebuddyManagedEnv), [codebuddyManagedEnv]);
  const updateCodebuddyEnv = useCallback(
    (nextInternetEnv: string, nextEnvText: string) => {
      setExternalAgents((prev) =>
        updateCodebuddyManagedEnv(prev, nextInternetEnv, nextEnvText),
      );
    },
    [setExternalAgents],
  );
  const [userSkillsStatus, setUserSkillsStatus] = useState<UserSkillsStatusResult | null>(null);
  const [isLoadingUserSkills, setIsLoadingUserSkills] = useState(false);
  const cursorManagedAgent = useMemo(
    () => externalAgents.find((agent) => agent.id === "discovered_cursor"),
    [externalAgents],
  );
  const cursorApiKeyEncrypted = cursorManagedAgent?.apiKey;

  // Ref to read current defaultAgentId without adding it as a dependency.
  const defaultAgentIdRef = useRef(defaultAgentId);
  defaultAgentIdRef.current = defaultAgentId;

  const resolveAgentPath = useCallback(async (
    agentKey: ManagedAgentKey,
    customPath = "",
    options?: { apiKeyPresent?: boolean },
  ) => {
    const bridge = getBridge();
    if (!bridge?.aiResolveCli) return null;

    const setInfo = agentKey === "codex"
      ? setCodexPathInfo
      : agentKey === "claude"
        ? setClaudePathInfo
        : agentKey === "copilot"
          ? setCopilotPathInfo
          : agentKey === "cursor"
            ? setCursorPathInfo
            : setCodebuddyPathInfo;
    const setResolving = agentKey === "codex"
      ? setIsResolvingCodex
      : agentKey === "claude"
        ? setIsResolvingClaude
        : agentKey === "copilot"
          ? setIsResolvingCopilot
          : agentKey === "cursor"
            ? setIsResolvingCursor
            : setIsResolvingCodebuddy;

    setResolving(true);
    try {
      const result = await bridge.aiResolveCli({
        command: agentKey,
        customPath: customPath.trim(),
        refreshShellEnv: agentKey === "cursor",
        ...(agentKey === "cursor" ? { apiKeyPresent: Boolean(options?.apiKeyPresent ?? cursorApiKeyEncrypted) } : {}),
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
  }, [cursorApiKeyEncrypted, setExternalAgents, setDefaultAgentId]);

  useEffect(() => {
    void resolveAgentPath("codex", initialManagedPathsRef.current?.codex ?? "");
    void resolveAgentPath("claude", initialManagedPathsRef.current?.claude ?? "");
    void resolveAgentPath("copilot", initialManagedPathsRef.current?.copilot ?? "");
    void resolveAgentPath("cursor", initialManagedPathsRef.current?.cursor ?? "", { apiKeyPresent: Boolean(cursorApiKeyEncrypted) });
    void resolveAgentPath("codebuddy", initialManagedPathsRef.current?.codebuddy ?? "");
  }, [cursorApiKeyEncrypted, resolveAgentPath]);

  // Validate a custom path for an agent
  const handleCheckCustomPath = useCallback(async (agentKey: ManagedAgentKey) => {
    const customPath = agentKey === "codex"
      ? codexCustomPath
      : agentKey === "claude"
        ? claudeCustomPath
        : agentKey === "copilot"
          ? copilotCustomPath
          : agentKey === "codebuddy"
            ? codebuddyCustomPath
            : "";
    await resolveAgentPath(agentKey, customPath);
  }, [claudeCustomPath, codexCustomPath, copilotCustomPath, codebuddyCustomPath, resolveAgentPath]);

  const handleSaveCursorApiKey = useCallback(async (apiKey: string) => {
    const trimmed = apiKey.trim();
    const encrypted = trimmed ? await encryptField(trimmed) : undefined;
    const result = await resolveAgentPath("cursor", "", { apiKeyPresent: Boolean(trimmed) });
    setExternalAgents((prev) => {
      const existing = prev.find((agent) => agent.id === "discovered_cursor");
      const others = prev.filter((agent) => agent.id !== "discovered_cursor");
      if (!encrypted && !existing) return prev;
      if (!encrypted && existing && !result?.available) return others;
      const nextAgent: ExternalAgentConfig = {
        ...(existing ?? {
          id: "discovered_cursor",
          name: "Cursor",
          command: result?.path || cursorPathInfo?.path || "cursor",
          args: ["{prompt}"],
          icon: "cursor",
          sdkBackend: "cursor",
          enabled: false,
        }),
        apiKey: encrypted,
        command: result?.path || existing?.command || cursorPathInfo?.path || "cursor",
        available: Boolean(result?.available),
        enabled: result?.available ? (existing?.enabled ?? true) : false,
      };
      return [...others, nextAgent];
    });
  }, [cursorPathInfo?.path, resolveAgentPath, setExternalAgents]);

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
      .filter((a) => canSendWithAgent(a.id, externalAgents))
      .map((a) => ({ value: a.id, label: a.name, icon: <AgentIconBadge agent={a} size="xs" variant="plain" /> })),
  ], [externalAgents, t]);

  useEffect(() => {
    if (!agentOptions.some((option) => option.value === defaultAgentId)) {
      setDefaultAgentId("catty");
    }
  }, [agentOptions, defaultAgentId, setDefaultAgentId]);

  const refreshCodexIntegration = useCallback(async (opts?: { refreshShellEnv?: boolean }) => {
    const bridge = getBridge();
    if (!bridge?.aiCodexGetIntegration) return;

    setIsCodexLoading(true);
    setCodexError(null);
    try {
      const integration = await bridge.aiCodexGetIntegration(opts);
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

  const refreshUserSkillsStatus = useCallback(async () => {
    const bridge = getBridge();
    if (!bridge?.aiUserSkillsGetStatus) {
      setUserSkillsStatus({
        ok: false,
        error: t('ai.userSkills.unavailable'),
      });
      return;
    }

    setIsLoadingUserSkills(true);
    try {
      const result = await bridge.aiUserSkillsGetStatus();
      setUserSkillsStatus(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setUserSkillsStatus({ ok: false, error: message });
    } finally {
      setIsLoadingUserSkills(false);
    }
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    void refreshUserSkillsStatus().then(() => {
      if (cancelled) return;
    });
    return () => {
      cancelled = true;
    };
  }, [refreshUserSkillsStatus]);

  const reservedUserSkillSlugs = useMemo(
    () => (userSkillsStatus?.ok && userSkillsStatus.skills
      ? userSkillsStatus.skills
          .filter((skill) => skill.status === 'ready' && typeof skill.slug === 'string' && skill.slug.length > 0)
          .map((skill) => skill.slug)
      : []),
    [userSkillsStatus],
  );

  const handleOpenUserSkillsFolder = useCallback(async () => {
    const bridge = getBridge();
    if (!bridge?.aiUserSkillsOpenFolder) return;

    setIsLoadingUserSkills(true);
    try {
      const result = await bridge.aiUserSkillsOpenFolder();
      setUserSkillsStatus(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setUserSkillsStatus({ ok: false, error: message });
    } finally {
      setIsLoadingUserSkills(false);
    }
  }, []);

  return (
    <SettingsTabContent value="ai">
          <SettingsSection
            title={t('ai.providers')}
            actions={<AddProviderDropdown onAdd={handleAddProvider} />}
          >
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
          </SettingsSection>

          <SettingsSection
            title={t('ai.codex')}
            leading={<AgentIconBadge agent={{ id: "codex", icon: "openai", name: "Codex CLI" }} variant="plain" className="h-5 w-5 text-muted-foreground/90" />}
          >
            <CodexConnectionCard
              pathInfo={codexPathInfo}
              isResolvingPath={isResolvingCodex}
              customPath={codexCustomPath}
              onCustomPathChange={setCodexCustomPath}
              onRecheckPath={() => void handleCheckCustomPath("codex")}
              integration={codexIntegration}
              loginSession={codexLoginSession}
              isLoading={isCodexLoading}
              error={codexError}
              onRefresh={() => void refreshCodexIntegration({ refreshShellEnv: true })}
              onConnect={() => void handleStartCodexLogin()}
              onCancel={() => void handleCancelCodexLogin()}
              onOpenUrl={handleOpenCodexLoginUrl}
              onLogout={() => void handleCodexLogout()}
            />
          </SettingsSection>

          <SettingsSection
            title={t('ai.claude.title')}
            leading={<AgentIconBadge agent={{ id: "claude", icon: "claude", name: "Claude Code" }} variant="plain" className="h-5 w-5 text-muted-foreground/90" />}
          >
            <ClaudeCodeCard
              pathInfo={claudePathInfo}
              isResolvingPath={isResolvingClaude}
              customPath={claudeCustomPath}
              onCustomPathChange={setClaudeCustomPath}
              onRecheckPath={() => void handleCheckCustomPath("claude")}
              configDir={claudeConfigDir}
              onConfigDirChange={(v) => updateClaudeEnv(v, claudeSettingsPath, claudeEnvText)}
              settingsPath={claudeSettingsPath}
              onSettingsPathChange={(v) => updateClaudeEnv(claudeConfigDir, v, claudeEnvText)}
              envText={claudeEnvText}
              onEnvTextChange={(v) => updateClaudeEnv(claudeConfigDir, claudeSettingsPath, v)}
            />
          </SettingsSection>

          <SettingsSection
            title={t('ai.copilot.title')}
            leading={<AgentIconBadge agent={{ id: "copilot", icon: "copilot", name: "GitHub Copilot CLI" }} variant="plain" className="h-5 w-5 text-muted-foreground/90" />}
          >
            <CopilotCliCard
              pathInfo={copilotPathInfo}
              isResolvingPath={isResolvingCopilot}
              customPath={copilotCustomPath}
              onCustomPathChange={setCopilotCustomPath}
              onRecheckPath={() => void handleCheckCustomPath("copilot")}
            />
          </SettingsSection>

          <SettingsSection
            title={t('ai.cursor.title')}
            leading={<AgentIconBadge agent={{ id: "cursor", icon: "cursor", name: "Cursor" }} variant="plain" className="h-5 w-5 text-muted-foreground/90" />}
          >
            <CursorSdkCard
              pathInfo={cursorPathInfo}
              isResolvingPath={isResolvingCursor}
              encryptedApiKey={cursorApiKeyEncrypted}
              onSaveApiKey={handleSaveCursorApiKey}
              onRecheckPath={() => void handleCheckCustomPath("cursor")}
            />
          </SettingsSection>

          <SettingsSection
            title={t('ai.codebuddy.title')}
            leading={<AgentIconBadge agent={{ id: "codebuddy", icon: "codebuddy", name: "CodeBuddy Code" }} variant="plain" className="h-5 w-5 text-muted-foreground/90" />}
          >
            <CodebuddyCard
              pathInfo={codebuddyPathInfo}
              isResolvingPath={isResolvingCodebuddy}
              customPath={codebuddyCustomPath}
              onCustomPathChange={setCodebuddyCustomPath}
              onRecheckPath={() => void handleCheckCustomPath("codebuddy")}
              internetEnv={codebuddyInternetEnv}
              onInternetEnvChange={(v) => updateCodebuddyEnv(v, codebuddyEnvText)}
              envText={codebuddyEnvText}
              onEnvTextChange={(v) => updateCodebuddyEnv(codebuddyInternetEnv, v)}
            />
          </SettingsSection>

          {agentOptions.length > 1 && (
            <SettingsSection title={t('ai.defaultAgent')}>
              <SettingCard>
                <SettingRow description={t('ai.defaultAgent.description')}>
                  <Select
                    value={defaultAgentId}
                    options={agentOptions}
                    onChange={setDefaultAgentId}
                    className="w-64"
                  />
                </SettingRow>
              </SettingCard>
            </SettingsSection>
          )}

          <SettingsSection title={t('ai.toolAccess.title')}>
            <SettingCard>
              <SettingRow description={t('ai.toolAccess.description')}>
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
            </SettingCard>
          </SettingsSection>

          <SettingsSection
            title={t('ai.userSkills.title')}
            actions={(
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void refreshUserSkillsStatus()}
                  disabled={isLoadingUserSkills}
                >
                  <RefreshCcw size={14} className="mr-2" />
                  {t('ai.userSkills.reload')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleOpenUserSkillsFolder()}
                  disabled={isLoadingUserSkills}
                >
                  <FolderOpen size={14} className="mr-2" />
                  {t('ai.userSkills.openFolder')}
                </Button>
              </>
            )}
          >
            <SettingCard padded className="space-y-3">
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground/80 leading-5">
                  {t('ai.userSkills.description')}
                </p>
                {userSkillsStatus?.directoryPath ? (
                  <p className="text-xs text-muted-foreground/80">
                    {t('ai.userSkills.location')}:{" "}
                    <span className="font-mono">{userSkillsStatus.directoryPath}</span>
                  </p>
                ) : null}
              </div>

              <div className="text-xs text-muted-foreground/80">
                {isLoadingUserSkills
                  ? t('ai.userSkills.loading')
                  : userSkillsStatus?.ok
                    ? t('ai.userSkills.summary', {
                        ready: String(userSkillsStatus.readyCount ?? 0),
                        warnings: String(userSkillsStatus.warningCount ?? 0),
                      })
                    : userSkillsStatus?.error || t('ai.userSkills.unavailable')}
              </div>

              {userSkillsStatus?.ok && userSkillsStatus.skills && userSkillsStatus.skills.length > 0 ? (
                <div className="border-t border-border/60 divide-y divide-border/60">
                  {userSkillsStatus.skills.map((skill) => (
                    <div
                      key={skill.id}
                      className="py-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 space-y-1">
                          <div className="text-sm font-medium">{skill.name}</div>
                          <div className="text-xs text-muted-foreground leading-5">{skill.description}</div>
                          <div className="text-xs text-muted-foreground/80 font-mono break-all">
                            {skill.directoryName}
                          </div>
                        </div>
                        <span
                          className={
                            skill.status === "ready"
                              ? "text-xs font-medium text-emerald-500 shrink-0"
                              : "text-xs font-medium text-amber-500 shrink-0"
                          }
                        >
                          {skill.status === "ready"
                            ? t('ai.userSkills.status.ready')
                            : t('ai.userSkills.status.warning')}
                        </span>
                      </div>
                      {skill.warnings.length > 0 ? (
                        <div className="mt-2 space-y-1 text-xs text-amber-500">
                          {skill.warnings.map((warning, index) => (
                            <div key={`${skill.id}-${index}`} className="flex items-start gap-2">
                              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                              <span>{warning}</span>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : userSkillsStatus?.ok ? (
                <div className="border-t border-border/60 pt-3 text-sm text-muted-foreground">
                  {t('ai.userSkills.empty')}
                </div>
              ) : null}
            </SettingCard>
          </SettingsSection>

          <QuickMessagesSettings
            quickMessages={quickMessages}
            setQuickMessages={setQuickMessages}
            reservedUserSkillSlugs={reservedUserSkillSlugs}
          />

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
    </SettingsTabContent>
  );
};

export default SettingsAITab;
