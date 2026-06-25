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
import { Select, SettingCard, SettingsSection, SettingsTabContent, SettingRow, Toggle } from "../settings-ui";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/tabs";
import { AgentIconBadge } from "../../ai/AgentIconBadge";
import { canSendWithAgent } from "../../ai/agentSendEligibility";
import { notifyUserSkillsStatusChanged } from "../../ai/userSkillsStatusEvents";

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
import { PermissionGrantsSettings } from "./ai/PermissionGrantsSettings";
import { useAIPermissionGrantsState } from "../../../application/state/useAIPermissionGrantsState";
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

type IdleWindow = Window & {
  requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
  cancelIdleCallback?: (handle: number) => void;
};

function scheduleAfterFirstPaint(callback: () => void, delayMs = 0): () => void {
  let cancelled = false;
  let idleHandle: number | null = null;
  const timeoutHandle = window.setTimeout(() => {
    if (cancelled) return;
    const idleWindow = window as IdleWindow;
    if (typeof idleWindow.requestIdleCallback === "function") {
      idleHandle = idleWindow.requestIdleCallback(() => {
        if (!cancelled) callback();
      }, { timeout: 1200 });
      return;
    }
    callback();
  }, delayMs);

  return () => {
    cancelled = true;
    window.clearTimeout(timeoutHandle);
    if (idleHandle !== null) {
      (window as IdleWindow).cancelIdleCallback?.(idleHandle);
    }
  };
}

type AISettingsSubTab = "providers" | "agents" | "tools" | "search" | "safety";

function getSavedManagedAgentPathInfo(
  agents: ExternalAgentConfig[],
  agentKey: ManagedAgentKey,
): AgentPathInfo | null {
  const managed = agents.find((agent) => agent.id === `discovered_${agentKey}`);
  const command = typeof managed?.command === "string" ? managed.command.trim() : "";
  if (!managed || !command) return null;
  const savedAvailable = managed.available === true || managed.enabled === true;

  return {
    path: command,
    binPath: command,
    version: null,
    available: savedAvailable,
    installed: true,
    authenticated: undefined,
    authSource: null,
  };
}

function getManagedAgentCommandPath(
  agents: ExternalAgentConfig[],
  agentKey: ManagedAgentKey,
): string {
  const managed = agents.find((agent) => agent.id === `discovered_${agentKey}`);
  const command = typeof managed?.command === "string" ? managed.command.trim() : "";
  return command && (command.includes("/") || command.includes("\\")) ? command : "";
}

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
  showTerminalSelectionAIAction: boolean;
  setShowTerminalSelectionAIAction: (value: boolean | ((prev: boolean) => boolean)) => void;
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
  showTerminalSelectionAIAction,
  setShowTerminalSelectionAIAction,
}) => {
  const {
    permissionGrants,
    addGrant,
    updateGrant,
    removeGrant,
    importGrants,
    exportGrants,
  } = useAIPermissionGrantsState();
  const { t } = useI18n();
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [codexIntegration, setCodexIntegration] = useState<CodexIntegrationStatus | null>(null);
  const [codexLoginSession, setCodexLoginSession] = useState<CodexLoginSession | null>(null);
  const [isCodexLoading, setIsCodexLoading] = useState(false);
  const [codexError, setCodexError] = useState<string | null>(null);
  const initialManagedPathsRef = useRef<{
    codex: string;
    claude: string;
    copilot: string;
    cursor: string;
    codebuddy: string;
    opencode: string;
  } | null>(null);
  if (!initialManagedPathsRef.current) {
    initialManagedPathsRef.current = getInitialManagedAgentPaths(externalAgents);
  }

  // Path detection state
  const [codexPathInfo, setCodexPathInfo] = useState<AgentPathInfo | null>(
    () => getSavedManagedAgentPathInfo(externalAgents, "codex"),
  );
  const [codexCustomPath, setCodexCustomPath] = useState(() => initialManagedPathsRef.current?.codex ?? "");
  const [isResolvingCodex, setIsResolvingCodex] = useState(false);
  const [activeSubTab, setActiveSubTab] = useState<AISettingsSubTab>("providers");

  const [claudePathInfo, setClaudePathInfo] = useState<AgentPathInfo | null>(
    () => getSavedManagedAgentPathInfo(externalAgents, "claude"),
  );
  const [claudeCustomPath, setClaudeCustomPath] = useState(() => initialManagedPathsRef.current?.claude ?? "");
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

  const [copilotPathInfo, setCopilotPathInfo] = useState<AgentPathInfo | null>(
    () => getSavedManagedAgentPathInfo(externalAgents, "copilot"),
  );
  const [copilotCustomPath, setCopilotCustomPath] = useState(() => initialManagedPathsRef.current?.copilot ?? "");
  const [isResolvingCopilot, setIsResolvingCopilot] = useState(false);

  const [cursorPathInfo, setCursorPathInfo] = useState<AgentPathInfo | null>(
    () => getSavedManagedAgentPathInfo(externalAgents, "cursor"),
  );
  const [isResolvingCursor, setIsResolvingCursor] = useState(false);

  const [codebuddyPathInfo, setCodebuddyPathInfo] = useState<AgentPathInfo | null>(
    () => getSavedManagedAgentPathInfo(externalAgents, "codebuddy"),
  );
  const [codebuddyCustomPath, setCodebuddyCustomPath] = useState(() => initialManagedPathsRef.current?.codebuddy ?? "");
  const [isResolvingCodebuddy, setIsResolvingCodebuddy] = useState(false);

  const [opencodePathInfo, setOpencodePathInfo] = useState<AgentPathInfo | null>(
    () => getSavedManagedAgentPathInfo(externalAgents, "opencode"),
  );
  const [opencodeCustomPath, setOpencodeCustomPath] = useState(() => initialManagedPathsRef.current?.opencode ?? "");
  const [isResolvingOpencode, setIsResolvingOpencode] = useState(false);

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
  const autoResolvedAgentStateRef = useRef<Partial<Record<ManagedAgentKey, "pending" | "done">>>({});
  const codexIntegrationLoadedRef = useRef(false);
  const userSkillsLoadedRef = useRef(false);
  const mountedRef = useRef(true);
  const agentPathRequestIdRef = useRef<Partial<Record<ManagedAgentKey, number>>>({});
  const codexRequestIdRef = useRef(0);

  useEffect(() => () => {
    mountedRef.current = false;
    codexRequestIdRef.current += 1;
    for (const key of ["codex", "claude", "copilot", "cursor", "codebuddy", "opencode"] as ManagedAgentKey[]) {
      agentPathRequestIdRef.current[key] = (agentPathRequestIdRef.current[key] ?? 0) + 1;
    }
  }, []);

  const applyResolvedAgentPath = useCallback((
    agentKey: ManagedAgentKey,
    result: AgentPathInfo | null,
    commandSource: "manual" | "auto" = "auto",
  ) => {
    const setInfo = agentKey === "codex"
      ? setCodexPathInfo
      : agentKey === "claude"
        ? setClaudePathInfo
        : agentKey === "copilot"
          ? setCopilotPathInfo
          : agentKey === "cursor"
            ? setCursorPathInfo
            : agentKey === "codebuddy"
              ? setCodebuddyPathInfo
              : setOpencodePathInfo;

    setInfo(result);

    let nextDefaultId: string | null = null;
    setExternalAgents((prev) => {
      const state = buildManagedAgentState(prev, defaultAgentIdRef.current, agentKey, result, commandSource);
      if (state.defaultAgentId !== defaultAgentIdRef.current) {
        nextDefaultId = state.defaultAgentId;
        defaultAgentIdRef.current = state.defaultAgentId;
      }
      return areExternalAgentListsEqual(prev, state.agents) ? prev : state.agents;
    });
    if (nextDefaultId !== null) {
      setDefaultAgentId(nextDefaultId);
    }
  }, [setDefaultAgentId, setExternalAgents]);

  const resolveAgentPath = useCallback(async (
    agentKey: ManagedAgentKey,
    customPath = "",
    options?: {
      apiKeyPresent?: boolean;
      refreshShellEnv?: boolean;
      commandSource?: "manual" | "auto";
      removeUnavailableManualPath?: boolean;
    },
  ) => {
    const bridge = getBridge();
    if (!bridge?.aiResolveCli) return null;

    const setResolving = agentKey === "codex"
      ? setIsResolvingCodex
      : agentKey === "claude"
        ? setIsResolvingClaude
        : agentKey === "copilot"
          ? setIsResolvingCopilot
          : agentKey === "cursor"
            ? setIsResolvingCursor
            : agentKey === "codebuddy"
              ? setIsResolvingCodebuddy
              : setIsResolvingOpencode;

    setResolving(true);
    const requestId = (agentPathRequestIdRef.current[agentKey] ?? 0) + 1;
    agentPathRequestIdRef.current[agentKey] = requestId;
    const isCurrentRequest = () => (
      mountedRef.current
      && agentPathRequestIdRef.current[agentKey] === requestId
    );
    try {
      const result = await bridge.aiResolveCli({
        command: agentKey,
        customPath: customPath.trim(),
        refreshShellEnv: Boolean(options?.refreshShellEnv),
        ...(agentKey === "cursor" ? { apiKeyPresent: Boolean(options?.apiKeyPresent ?? cursorApiKeyEncrypted) } : {}),
      });
      if (!isCurrentRequest()) return null;
      if (
        options?.commandSource === "manual"
        && customPath.trim()
        && !result?.available
        && !options.removeUnavailableManualPath
      ) {
        const setInfo = agentKey === "codex"
          ? setCodexPathInfo
          : agentKey === "claude"
            ? setClaudePathInfo
            : agentKey === "copilot"
              ? setCopilotPathInfo
              : agentKey === "cursor"
                ? setCursorPathInfo
                : agentKey === "codebuddy"
                  ? setCodebuddyPathInfo
                  : setOpencodePathInfo;
        setInfo(result);
        return result;
      }
      applyResolvedAgentPath(agentKey, result, options?.commandSource ?? "auto");

      return result;
    } catch (err) {
      console.error("Path resolution failed:", err);
      return null;
    } finally {
      if (isCurrentRequest()) {
        setResolving(false);
      }
    }
  }, [applyResolvedAgentPath, cursorApiKeyEncrypted]);

  useEffect(() => {
    if (activeSubTab !== "agents") return;

    const initialPaths = initialManagedPathsRef.current;
    const tasks: Array<{
      key: ManagedAgentKey;
      delayMs: number;
      path: string;
      options?: { apiKeyPresent?: boolean };
    }> = [
      { key: "codex", delayMs: 160, path: initialPaths?.codex ?? "" },
      { key: "claude", delayMs: 440, path: initialPaths?.claude ?? "" },
      { key: "copilot", delayMs: 720, path: initialPaths?.copilot ?? "" },
      {
        key: "cursor",
        delayMs: 1000,
        path: initialPaths?.cursor ?? "",
        options: { apiKeyPresent: Boolean(cursorApiKeyEncrypted) },
      },
      { key: "codebuddy", delayMs: 1280, path: initialPaths?.codebuddy ?? "" },
      { key: "opencode", delayMs: 1560, path: initialPaths?.opencode ?? "" },
    ];
    const cancelTasks = tasks
      .filter((task) => !autoResolvedAgentStateRef.current[task.key])
      .map((task) => scheduleAfterFirstPaint(() => {
        autoResolvedAgentStateRef.current[task.key] = "pending";
        void resolveAgentPath(task.key, task.path, {
          ...task.options,
          commandSource: task.path ? "manual" : "auto",
          removeUnavailableManualPath: Boolean(task.path),
        }).finally(() => {
          autoResolvedAgentStateRef.current[task.key] = "done";
        });
      }, task.delayMs));
    return () => {
      for (const cancel of cancelTasks) cancel();
    };
  }, [activeSubTab, cursorApiKeyEncrypted, resolveAgentPath]);

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

  useEffect(() => {
    const bridge = getBridge();
    if (!bridge?.aiPrewarmShellEnv) return;
    return scheduleAfterFirstPaint(() => {
      void bridge.aiPrewarmShellEnv?.();
    }, 900);
  }, []);

  const refreshCodexIntegration = useCallback(async (opts?: { refreshShellEnv?: boolean; validateChatGptAuth?: boolean; codexPath?: string }) => {
    const bridge = getBridge();
    if (!bridge?.aiCodexGetIntegration) return;

    const requestId = codexRequestIdRef.current + 1;
    codexRequestIdRef.current = requestId;
    const isCurrentRequest = () => mountedRef.current && codexRequestIdRef.current === requestId;
    setIsCodexLoading(true);
    setCodexError(null);
    try {
      const integration = await bridge.aiCodexGetIntegration(opts);
      if (!isCurrentRequest()) return;
      setCodexIntegration(integration);
    } catch (err) {
      if (isCurrentRequest()) {
        setCodexError(normalizeCodexBridgeError(err));
      }
    } finally {
      if (isCurrentRequest()) {
        setIsCodexLoading(false);
      }
    }
  }, []);

  const codexCommittedPath = useMemo(
    () => getManagedAgentCommandPath(externalAgents, "codex") || codexPathInfo?.path || undefined,
    [externalAgents, codexPathInfo?.path],
  );
  const hasPendingCodexCustomPath = Boolean(
    codexCustomPath.trim()
    && codexCustomPath.trim() !== codexCommittedPath,
  );

  const getCodexPathOverride = useCallback(() => (
    codexCommittedPath
  ), [codexCommittedPath]);

  // Validate a custom path for an agent.
  const handleCheckCustomPath = useCallback(async (agentKey: ManagedAgentKey) => {
    const customPath = agentKey === "codex"
      ? codexCustomPath
      : agentKey === "claude"
        ? claudeCustomPath
        : agentKey === "copilot"
          ? copilotCustomPath
          : agentKey === "codebuddy"
            ? codebuddyCustomPath
            : agentKey === "opencode"
              ? opencodeCustomPath
              : "";
    const result = await resolveAgentPath(agentKey, customPath, {
      refreshShellEnv: true,
      commandSource: customPath.trim() ? "manual" : "auto",
    });
    if (agentKey === "codex") {
      await refreshCodexIntegration({
        refreshShellEnv: true,
        validateChatGptAuth: true,
        codexPath: result?.path || customPath.trim() || undefined,
      });
    }
  }, [claudeCustomPath, codexCustomPath, copilotCustomPath, codebuddyCustomPath, opencodeCustomPath, resolveAgentPath, refreshCodexIntegration]);

  const handleResetCustomPath = useCallback(async (agentKey: ManagedAgentKey) => {
    if (agentKey === "codex") {
      setCodexCustomPath("");
    } else if (agentKey === "claude") {
      setClaudeCustomPath("");
    } else if (agentKey === "copilot") {
      setCopilotCustomPath("");
    } else if (agentKey === "codebuddy") {
      setCodebuddyCustomPath("");
    } else if (agentKey === "opencode") {
      setOpencodeCustomPath("");
    }

    const result = await resolveAgentPath(agentKey, "", {
      refreshShellEnv: true,
      commandSource: "auto",
      ...(agentKey === "cursor" ? { apiKeyPresent: Boolean(cursorApiKeyEncrypted) } : {}),
    });
    if (agentKey === "codex") {
      await refreshCodexIntegration({
        refreshShellEnv: true,
        validateChatGptAuth: true,
        codexPath: result?.path || undefined,
      });
    }
  }, [cursorApiKeyEncrypted, resolveAgentPath, refreshCodexIntegration]);

  useEffect(() => {
    if (activeSubTab !== "agents") return;
    if (codexIntegrationLoadedRef.current) return;
    return scheduleAfterFirstPaint(() => {
      codexIntegrationLoadedRef.current = true;
      void refreshCodexIntegration({ codexPath: getCodexPathOverride() });
    }, 620);
  }, [activeSubTab, getCodexPathOverride, refreshCodexIntegration]);

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
            void refreshCodexIntegration({
              validateChatGptAuth: true,
              codexPath: result.session.codexPath || getCodexPathOverride(),
            });
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
  }, [codexLoginSession, getCodexPathOverride, refreshCodexIntegration]);

  const handleStartCodexLogin = useCallback(async () => {
    const bridge = getBridge();
    if (!bridge?.aiCodexStartLogin) return;

    const requestId = codexRequestIdRef.current + 1;
    codexRequestIdRef.current = requestId;
    const isCurrentRequest = () => mountedRef.current && codexRequestIdRef.current === requestId;
    setCodexError(null);
    setIsCodexLoading(true);
    try {
      const result = await bridge.aiCodexStartLogin({ codexPath: getCodexPathOverride() });
      if (!isCurrentRequest()) return;
      if (!result.ok || !result.session) {
        throw new Error(result.error || "Failed to start Codex login");
      }
      setCodexLoginSession(result.session);
    } catch (err) {
      if (isCurrentRequest()) {
        setCodexError(normalizeCodexBridgeError(err));
      }
    } finally {
      if (isCurrentRequest()) {
        setIsCodexLoading(false);
      }
    }
  }, [getCodexPathOverride]);

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

    const requestId = codexRequestIdRef.current + 1;
    codexRequestIdRef.current = requestId;
    const isCurrentRequest = () => mountedRef.current && codexRequestIdRef.current === requestId;
    setCodexError(null);
    setIsCodexLoading(true);
    try {
      const result = await bridge.aiCodexLogout({ codexPath: getCodexPathOverride() });
      if (!isCurrentRequest()) return;
      if (!result.ok) {
        throw new Error(result.error || "Failed to log out from Codex");
      }
      setCodexLoginSession(null);
      await refreshCodexIntegration({ refreshShellEnv: true, validateChatGptAuth: true, codexPath: getCodexPathOverride() });
    } catch (err) {
      if (isCurrentRequest()) {
        setCodexError(normalizeCodexBridgeError(err));
      }
    } finally {
      if (isCurrentRequest()) {
        setIsCodexLoading(false);
      }
    }
  }, [getCodexPathOverride, refreshCodexIntegration]);

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
      notifyUserSkillsStatusChanged();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setUserSkillsStatus({ ok: false, error: message });
    } finally {
      setIsLoadingUserSkills(false);
    }
  }, [t]);

  useEffect(() => {
    if (activeSubTab !== "tools") return;
    if (userSkillsLoadedRef.current) return;
    return scheduleAfterFirstPaint(() => {
      userSkillsLoadedRef.current = true;
      void refreshUserSkillsStatus();
    }, 520);
  }, [activeSubTab, refreshUserSkillsStatus]);

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
      notifyUserSkillsStatusChanged();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setUserSkillsStatus({ ok: false, error: message });
    } finally {
      setIsLoadingUserSkills(false);
    }
  }, []);

  return (
    <SettingsTabContent value="ai">
      <Tabs value={activeSubTab} onValueChange={(value) => setActiveSubTab(value as AISettingsSubTab)} className="space-y-5">
        <TabsList className="h-auto flex-wrap justify-start bg-muted/50">
          <TabsTrigger value="providers">{t('ai.providers')}</TabsTrigger>
          <TabsTrigger value="agents">{t('ai.agents')}</TabsTrigger>
          <TabsTrigger value="tools">{t('ai.toolAccess.title')}</TabsTrigger>
          <TabsTrigger value="search">{t("ai.webSearch.title")}</TabsTrigger>
          <TabsTrigger value="safety">{t('ai.safety.title')}</TabsTrigger>
        </TabsList>

        <TabsContent value="providers" className="m-0 space-y-6">
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
                        setActiveProviderId(provider.id);
                        if (provider.defaultModel) {
                          setActiveModelId(provider.defaultModel);
                        }
                        for (const p of providers) {
                          if (p.id === provider.id) {
                            if (!p.enabled) updateProvider(p.id, { enabled: true });
                          } else if (p.enabled) {
                            updateProvider(p.id, { enabled: false });
                          }
                        }
                      } else {
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
        </TabsContent>

        <TabsContent value="agents" className="m-0 space-y-6">
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
              onResetPath={() => void handleResetCustomPath("codex")}
              integration={codexIntegration}
              loginSession={codexLoginSession}
              isLoading={isCodexLoading}
              hasPendingCustomPath={hasPendingCodexCustomPath}
              error={codexError}
              onRefresh={() => void refreshCodexIntegration({ refreshShellEnv: true, validateChatGptAuth: true, codexPath: getCodexPathOverride() })}
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
              onResetPath={() => void handleResetCustomPath("claude")}
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
              onResetPath={() => void handleResetCustomPath("copilot")}
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
              onResetPath={() => void handleResetCustomPath("codebuddy")}
              internetEnv={codebuddyInternetEnv}
              onInternetEnvChange={(v) => updateCodebuddyEnv(v, codebuddyEnvText)}
              envText={codebuddyEnvText}
              onEnvTextChange={(v) => updateCodebuddyEnv(codebuddyInternetEnv, v)}
            />
          </SettingsSection>

          <SettingsSection
            title={t('ai.opencode.title')}
            leading={<AgentIconBadge agent={{ id: "opencode", icon: "opencode", name: "OpenCode" }} variant="plain" className="h-5 w-5 text-muted-foreground/90" />}
          >
            <CopilotCliCard
              pathInfo={opencodePathInfo}
              isResolvingPath={isResolvingOpencode}
              customPath={opencodeCustomPath}
              onCustomPathChange={setOpencodeCustomPath}
              onRecheckPath={() => void handleCheckCustomPath("opencode")}
              onResetPath={() => void handleResetCustomPath("opencode")}
              i18nPrefix="ai.opencode"
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
        </TabsContent>

        <TabsContent value="tools" className="m-0 space-y-6">
          <SettingsSection title={t('ai.chatShortcuts.title')}>
            <SettingCard divided>
              <SettingRow
                label={t('ai.chatShortcuts.selectionAction')}
                description={t('ai.chatShortcuts.selectionAction.description')}
              >
                <Toggle
                  checked={showTerminalSelectionAIAction}
                  onChange={setShowTerminalSelectionAIAction}
                  ariaLabel={t('ai.chatShortcuts.selectionAction')}
                />
              </SettingRow>
            </SettingCard>
          </SettingsSection>

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
                    <div key={skill.id} className="py-3">
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
        </TabsContent>

        <TabsContent value="search" className="m-0 space-y-6">
          <WebSearchSettings
            webSearchConfig={webSearchConfig}
            setWebSearchConfig={setWebSearchConfig}
          />
        </TabsContent>

        <TabsContent value="safety" className="m-0 space-y-6">
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
          <PermissionGrantsSettings
            grants={permissionGrants}
            addGrant={addGrant}
            updateGrant={updateGrant}
            removeGrant={removeGrant}
            importGrants={importGrants}
            exportGrants={exportGrants}
          />
        </TabsContent>
      </Tabs>
    </SettingsTabContent>
  );
};

export default SettingsAITab;
