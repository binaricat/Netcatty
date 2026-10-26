import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HelpCircle, RefreshCw } from "lucide-react";
import { useI18n } from "../../../../application/i18n/I18nProvider";
import {
  readExternalMcpApprovalAlertMode,
  readExternalMcpFocusOnHostOpen,
  readExternalMcpIdleTimeoutMinutes,
  readExternalMcpMode,
  readExternalMcpSilentSessions,
  readSessionIdleTimeoutMinutes,
  writeExternalMcpApprovalAlertMode,
  writeExternalMcpFocusOnHostOpen,
  writeExternalMcpIdleTimeoutMinutes,
  writeExternalMcpMode,
  writeExternalMcpSilentSessions,
  writeSessionIdleTimeoutMinutes,
  readExternalMcpHttpAllowCustomBind,
  readExternalMcpHttpClientHost,
  readExternalMcpHttpEnabled,
  readExternalMcpHttpListenAddress,
  readExternalMcpHttpPort,
  writeExternalMcpHttpAllowCustomBind,
  writeExternalMcpHttpClientHost,
  writeExternalMcpHttpEnabled,
  writeExternalMcpHttpListenAddress,
  writeExternalMcpHttpPort,
  type ExternalMcpApprovalAlertMode,
  type ExternalMcpHttpSettings,
  type ExternalMcpMode,
  useExternalMcpToggleState,
} from "../../../../application/state/useExternalMcpToggleState";
import { cn } from "../../../../lib/utils";
import { Button } from "../../../ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../ui/tooltip";
import { Select, SettingCard, SettingRow, Toggle } from "../../../settings/settings-ui";
import { ToolSettingsDialog } from "./ToolSettingsDialog";
import { useOptionalSettingsFocus } from "../../SettingsFocusContext";
import { SettingsAnchor } from "../../settings-ui";
import { CopyableCodeBlock } from "./CopyableCodeBlock";
import { ExternalMcpHttpSection, type ExternalMcpHttpViewStatus } from "./ExternalMcpHttpSection";
import { getBridge } from "./types";

type ExternalMcpClient = "codex" | "claude" | "grok" | "cursor" | "other";

const CLIENT_TABS: ExternalMcpClient[] = ["codex", "claude", "grok", "cursor", "other"];

type ExternalMcpStatus = {
  ok: boolean;
  enabled?: boolean;
  state?: string;
  host?: string;
  port?: number | null;
  discoveryPath?: string | null;
  launcherPath?: string | null;
  exposedSessionCount?: number;
  mode?: ExternalMcpMode;
  idleTimeoutMinutes?: number;
  sessionIdleTimeoutMinutes?: number;
  permissionMode?: string;
  error?: string | null;
  http?: ExternalMcpHttpViewStatus | null;
};

type ClientSetupStatus = {
  ok: boolean;
  state?: string;
  launcherPath?: string | null;
  command?: string;
  existingCommand?: string | null;
  error?: string | null;
};

type StatusView = {
  labelKey: string;
  className: string;
};

function getBridgeStatusView(status: ExternalMcpStatus | null, enabled: boolean): StatusView {
  if (!enabled) {
    return { labelKey: "ai.externalMcp.status.disabled", className: "text-muted-foreground" };
  }
  if (!status || !status.ok) {
    return { labelKey: "ai.externalMcp.status.unavailable", className: "text-amber-500" };
  }
  if (status.state === "running") {
    return { labelKey: "ai.externalMcp.status.running", className: "text-emerald-500" };
  }
  if (status.state === "starting") {
    return { labelKey: "ai.externalMcp.status.starting", className: "text-amber-500" };
  }
  if (status.state === "error") {
    return { labelKey: "ai.externalMcp.status.error", className: "text-destructive" };
  }
  return { labelKey: "ai.externalMcp.status.disabled", className: "text-muted-foreground" };
}

/** Map bridge permissionMode to a Safety i18n key for display. */
function getPermissionModeLabelKey(mode: string | null | undefined): string {
  switch (mode) {
    case "observer":
      return "ai.safety.permissionMode.observer";
    case "auto":
      return "ai.safety.permissionMode.auto";
    case "confirm":
      return "ai.safety.permissionMode.confirm";
    default:
      return "ai.externalMcp.permissionMode.unknown";
  }
}

function getPermissionModeToneClass(mode: string | null | undefined): string {
  switch (mode) {
    case "auto":
      return "text-emerald-500";
    case "observer":
      return "text-amber-500";
    case "confirm":
      return "text-foreground";
    default:
      return "text-muted-foreground";
  }
}

function getCodexStatusView(status: ClientSetupStatus | null): StatusView {
  switch (status?.state) {
    case "configured":
      return { labelKey: "ai.externalMcp.status.configured", className: "text-emerald-500" };
    case "not_configured":
      return { labelKey: "ai.externalMcp.status.notConfigured", className: "text-muted-foreground" };
    case "codex_not_found":
      return { labelKey: "ai.externalMcp.status.codexNotFound", className: "text-amber-500" };
    case "conflict":
      return { labelKey: "ai.externalMcp.status.conflict", className: "text-destructive" };
    case "error":
      return { labelKey: "ai.externalMcp.status.error", className: "text-destructive" };
    default:
      return { labelKey: "ai.externalMcp.status.checking", className: "text-muted-foreground" };
  }
}

function getClaudeStatusView(status: ClientSetupStatus | null): StatusView {
  switch (status?.state) {
    case "configured":
      return { labelKey: "ai.externalMcp.status.configured", className: "text-emerald-500" };
    case "not_configured":
      return { labelKey: "ai.externalMcp.status.notConfigured", className: "text-muted-foreground" };
    case "claude_not_found":
      return { labelKey: "ai.externalMcp.status.claudeNotFound", className: "text-amber-500" };
    case "conflict":
      return { labelKey: "ai.externalMcp.status.conflict", className: "text-destructive" };
    case "error":
      return { labelKey: "ai.externalMcp.status.error", className: "text-destructive" };
    default:
      return { labelKey: "ai.externalMcp.status.checking", className: "text-muted-foreground" };
  }
}

function getGrokStatusView(status: ClientSetupStatus | null): StatusView {
  switch (status?.state) {
    case "configured":
      return { labelKey: "ai.externalMcp.status.configured", className: "text-emerald-500" };
    case "not_configured":
      return { labelKey: "ai.externalMcp.status.notConfigured", className: "text-muted-foreground" };
    case "grok_not_found":
      return { labelKey: "ai.externalMcp.status.grokNotFound", className: "text-amber-500" };
    case "conflict":
      return { labelKey: "ai.externalMcp.status.conflict", className: "text-destructive" };
    case "error":
      return { labelKey: "ai.externalMcp.status.error", className: "text-destructive" };
    default:
      return { labelKey: "ai.externalMcp.status.checking", className: "text-muted-foreground" };
  }
}

function escapeTomlBasicString(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

function quoteShellArg(value: string) {
  if (!value) return '""';
  if (!/[\s"'\\]/.test(value)) return value;
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

export const EXTERNAL_MCP_DISCOVERY_ENV_VAR = "NETCATTY_EXTERNAL_MCP_DISCOVERY_FILE";

export function formatCodexAddCommand(launcherPath: string, discoveryPath?: string | null) {
  const envFlags = discoveryPath
    ? ` --env ${EXTERNAL_MCP_DISCOVERY_ENV_VAR}=${quoteShellArg(discoveryPath)}`
    : "";
  return `codex mcp add netcatty-external${envFlags} -- ${quoteShellArg(launcherPath)}`;
}

export function formatClaudeAddCommand(launcherPath: string, discoveryPath?: string | null) {
  const envFlags = discoveryPath
    ? ` -e ${EXTERNAL_MCP_DISCOVERY_ENV_VAR}=${quoteShellArg(discoveryPath)}`
    : "";
  return `claude mcp add -s user netcatty-external${envFlags} -- ${quoteShellArg(launcherPath)}`;
}

export function formatGrokAddCommand(launcherPath: string, discoveryPath?: string | null) {
  const envFlags = discoveryPath
    ? ` -e ${EXTERNAL_MCP_DISCOVERY_ENV_VAR}=${quoteShellArg(discoveryPath)}`
    : "";
  return `grok mcp add netcatty-external${envFlags} -- ${quoteShellArg(launcherPath)}`;
}

function buildTomlEnvBlock(discoveryPath?: string | null) {
  if (!discoveryPath) return "";
  return `\nenv = { ${EXTERNAL_MCP_DISCOVERY_ENV_VAR} = "${escapeTomlBasicString(discoveryPath)}" }`;
}

export function buildCodexTomlSnippet(launcherPath: string, discoveryPath?: string | null) {
  return `[mcp_servers.netcatty-external]
command = "${escapeTomlBasicString(launcherPath)}"
args = []${buildTomlEnvBlock(discoveryPath)}`;
}

export function buildGrokTomlSnippet(launcherPath: string, discoveryPath?: string | null) {
  return `[mcp_servers.netcatty-external]
command = "${escapeTomlBasicString(launcherPath)}"
args = []${buildTomlEnvBlock(discoveryPath)}`;
}

function buildJsonServerEntry(launcherPath: string, discoveryPath?: string | null) {
  const entry: {
    command: string;
    args: string[];
    env?: Record<string, string>;
  } = {
    command: launcherPath,
    args: [],
  };
  if (discoveryPath) {
    entry.env = { [EXTERNAL_MCP_DISCOVERY_ENV_VAR]: discoveryPath };
  }
  return entry;
}

export function buildClaudeSnippet(launcherPath: string, discoveryPath?: string | null) {
  return JSON.stringify({
    mcpServers: {
      "netcatty-external": buildJsonServerEntry(launcherPath, discoveryPath),
    },
  }, null, 2);
}

export function buildCursorSnippet(launcherPath: string, discoveryPath?: string | null) {
  return JSON.stringify({
    mcpServers: {
      "netcatty-external": buildJsonServerEntry(launcherPath, discoveryPath),
    },
  }, null, 2);
}

export const ExternalMcpCard: React.FC = () => {
  const { t } = useI18n();
  const [behaviorOpen, setBehaviorOpen] = useState(false);
  const focus = useOptionalSettingsFocus();
  useEffect(() => {
    if (focus?.request?.anchorId === "ai-external-mcp-approval-alert") setBehaviorOpen(true);
  }, [focus?.request]);
  const statusGeneration = useRef(0);
  useEffect(() => () => { statusGeneration.current += 1; }, []);
  const { enabled, setEnabled, error: configError } = useExternalMcpToggleState();
  const [mode, setModeRaw] = useState<ExternalMcpMode>(() => readExternalMcpMode());
  const [idleTimeoutMinutes, setIdleTimeoutRaw] = useState<number>(() => readExternalMcpIdleTimeoutMinutes());
  const [focusOnHostOpen, setFocusOnHostOpenRaw] = useState<boolean>(() => readExternalMcpFocusOnHostOpen());
  const [approvalAlert, setApprovalAlertRaw] = useState<ExternalMcpApprovalAlertMode>(
    () => readExternalMcpApprovalAlertMode(),
  );
  const [sessionIdleTimeoutMinutes, setSessionIdleTimeoutRaw] = useState<number>(() => readSessionIdleTimeoutMinutes());
  const [silentSessions, setSilentSessionsRaw] = useState<boolean>(() => readExternalMcpSilentSessions());
  const [httpSettings, setHttpSettings] = useState<ExternalMcpHttpSettings>(() => ({
    enabled: readExternalMcpHttpEnabled(),
    port: readExternalMcpHttpPort(),
    allowCustomBind: readExternalMcpHttpAllowCustomBind(),
    listenAddress: readExternalMcpHttpListenAddress(),
    clientHost: readExternalMcpHttpClientHost(),
  }));
  const [isRotatingHttpToken, setIsRotatingHttpToken] = useState(false);
  const [status, setStatus] = useState<ExternalMcpStatus | null>(null);
  const [manualFormat, setManualFormat] = useState("command");
  const [selectedClient, setSelectedClient] = useState<ExternalMcpClient>("codex");
  const [codexStatus, setCodexStatus] = useState<ClientSetupStatus | null>(null);
  const [claudeStatus, setClaudeStatus] = useState<ClientSetupStatus | null>(null);
  const [grokStatus, setGrokStatus] = useState<ClientSetupStatus | null>(null);
  const [universalSetupPrompt, setUniversalSetupPrompt] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isAddingCodex, setIsAddingCodex] = useState(false);
  const [isAddingClaude, setIsAddingClaude] = useState(false);
  const [isAddingGrok, setIsAddingGrok] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<{ tone: "error" | "warning" | "success"; text: string } | null>(null);
  const bridgeUnavailableMessage = t("ai.externalMcp.bridgeUnavailable");

  const pushConfig = useCallback((nextMode: ExternalMcpMode, nextIdle: number, nextSessionIdle: number) => {
    void getBridge()?.externalMcpSetConfig?.({
      mode: nextMode,
      idleTimeoutMinutes: nextIdle,
      sessionIdleTimeoutMinutes: nextSessionIdle,
    });
  }, []);

  const setMode = useCallback((nextMode: ExternalMcpMode) => {
    const normalized = writeExternalMcpMode(nextMode);
    setModeRaw(normalized);
    pushConfig(normalized, idleTimeoutMinutes, sessionIdleTimeoutMinutes);
  }, [idleTimeoutMinutes, pushConfig, sessionIdleTimeoutMinutes]);

  const setIdleTimeoutMinutes = useCallback((minutes: number) => {
    const normalized = writeExternalMcpIdleTimeoutMinutes(minutes);
    setIdleTimeoutRaw(normalized);
    pushConfig(mode, normalized, sessionIdleTimeoutMinutes);
  }, [mode, pushConfig, sessionIdleTimeoutMinutes]);

  const setSessionIdleTimeoutMinutes = useCallback((minutes: number) => {
    const normalized = writeSessionIdleTimeoutMinutes(minutes);
    setSessionIdleTimeoutRaw(normalized);
    pushConfig(mode, idleTimeoutMinutes, normalized);
  }, [idleTimeoutMinutes, mode, pushConfig]);

  const setFocusOnHostOpen = useCallback((nextFocusOnHostOpen: boolean) => {
    setFocusOnHostOpenRaw(nextFocusOnHostOpen);
    writeExternalMcpFocusOnHostOpen(nextFocusOnHostOpen);
  }, []);

  const setApprovalAlert = useCallback((next: ExternalMcpApprovalAlertMode) => {
    setApprovalAlertRaw(writeExternalMcpApprovalAlertMode(next));
  }, []);

  const setSilentSessions = useCallback((nextSilentSessions: boolean) => {
    setSilentSessionsRaw(nextSilentSessions);
    writeExternalMcpSilentSessions(nextSilentSessions);
  }, []);

  const applyHttpSettings = useCallback(async (next: ExternalMcpHttpSettings) => {
    const generation = ++statusGeneration.current;
    const normalized: ExternalMcpHttpSettings = {
      enabled: writeExternalMcpHttpEnabled(next.enabled),
      port: writeExternalMcpHttpPort(next.port),
      allowCustomBind: writeExternalMcpHttpAllowCustomBind(next.allowCustomBind),
      listenAddress: writeExternalMcpHttpListenAddress(next.listenAddress),
      clientHost: writeExternalMcpHttpClientHost(next.clientHost),
    };
    setHttpSettings(normalized);
    try {
    const nextStatus = await getBridge()?.externalMcpSetConfig?.({
      httpEnabled: normalized.enabled,
      httpPort: normalized.port,
      httpAllowCustomBind: normalized.allowCustomBind,
      httpListenAddress: normalized.listenAddress,
      httpClientHost: normalized.clientHost,
    });
    if (generation === statusGeneration.current && nextStatus && typeof nextStatus === "object") {
      setStatus(nextStatus as ExternalMcpStatus);
    }
    } catch (error) {
      if (generation === statusGeneration.current) setActionMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  const rotateHttpToken = useCallback(async () => {
    const bridge = getBridge();
    if (!bridge?.externalMcpSetConfig) return;
    const generation = ++statusGeneration.current;
    setIsRotatingHttpToken(true);
    setActionMessage(null);
    try {
      const nextStatus = await bridge.externalMcpSetConfig({ rotateHttpToken: true });
      if (generation === statusGeneration.current && nextStatus && typeof nextStatus === "object") {
        setStatus(nextStatus as ExternalMcpStatus);
      }
    } catch (error) {
      setActionMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setIsRotatingHttpToken(false);
    }
  }, []);

  const refreshStatus = useCallback(async (options?: { quiet?: boolean; clients?: boolean }) => {
    const generation = ++statusGeneration.current;
    const bridge = getBridge();
    const includeClients = options?.clients !== false;
    if (
      !bridge?.externalMcpGetStatus
      || !bridge?.externalMcpCodexGetStatus
      || !bridge?.externalMcpClaudeGetStatus
      || !bridge?.externalMcpGrokGetStatus
    ) {
      setStatus({
        ok: false,
        enabled,
        state: "unavailable",
        discoveryPath: null,
        launcherPath: null,
        exposedSessionCount: 0,
        // Bridge default when IPC is missing; keeps the permission row from
        // looking blank while Safety settings remain the source of truth.
        permissionMode: "confirm",
        error: bridgeUnavailableMessage,
      });
      const unavailableClientStatus: ClientSetupStatus = {
        ok: true,
        state: "error",
        launcherPath: null,
        command: "",
        existingCommand: null,
        error: bridgeUnavailableMessage,
      };
      setCodexStatus(unavailableClientStatus);
      setClaudeStatus(unavailableClientStatus);
      setGrokStatus(unavailableClientStatus);
      return;
    }

    if (!options?.quiet) setIsRefreshing(true);
    try {
      if (includeClients) {
        const [
          nextStatus,
          nextCodexStatus,
          nextClaudeStatus,
          nextGrokStatus,
          nextUniversalPrompt,
        ] = await Promise.all([
          bridge.externalMcpGetStatus(),
          bridge.externalMcpCodexGetStatus(),
          bridge.externalMcpClaudeGetStatus(),
          bridge.externalMcpGrokGetStatus(),
          bridge.externalMcpGetUniversalSetupPrompt?.()
            ?? Promise.resolve({ ok: false, prompt: "" }),
        ]);
        if (generation !== statusGeneration.current) return;
        setStatus(nextStatus as ExternalMcpStatus);
        if (enabled && nextStatus?.ok && !nextStatus.enabled) {
          setEnabled(false);
        }
        setCodexStatus(nextCodexStatus as ClientSetupStatus);
        setClaudeStatus(nextClaudeStatus as ClientSetupStatus);
        setGrokStatus(nextGrokStatus as ClientSetupStatus);
        setUniversalSetupPrompt(
          nextUniversalPrompt.ok && typeof nextUniversalPrompt.prompt === "string"
            ? nextUniversalPrompt.prompt
            : "",
        );
      } else {
        const nextStatus = await bridge.externalMcpGetStatus();
        if (generation !== statusGeneration.current) return;
        setStatus(nextStatus as ExternalMcpStatus);
        if (enabled && nextStatus?.ok && !nextStatus.enabled) {
          setEnabled(false);
        }
      }
    } finally {
      if (!options?.quiet) setIsRefreshing(false);
    }
  }, [bridgeUnavailableMessage, enabled, setEnabled]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (!enabled) return;
    // Quiet polling only refreshes bridge runtime status. Spawning Codex/Claude/Grok
    // CLIs every few seconds is too expensive for a settings page keep-alive.
    const intervalId = window.setInterval(() => {
      void refreshStatus({ quiet: true, clients: false });
    }, 3000);
    return () => window.clearInterval(intervalId);
  }, [enabled, refreshStatus]);

  useEffect(() => {
    pushConfig(mode, idleTimeoutMinutes, sessionIdleTimeoutMinutes);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- sync stored config once on mount

  const bridgeStatusView = useMemo(() => getBridgeStatusView(status, enabled), [enabled, status]);
  const exposedSessionCount = enabled ? status?.exposedSessionCount ?? 0 : 0;
  const codexStatusView = useMemo(() => getCodexStatusView(codexStatus), [codexStatus]);
  const claudeStatusView = useMemo(() => getClaudeStatusView(claudeStatus), [claudeStatus]);
  const grokStatusView = useMemo(() => getGrokStatusView(grokStatus), [grokStatus]);

  const launcherPath = status?.launcherPath
    || codexStatus?.launcherPath
    || claudeStatus?.launcherPath
    || grokStatus?.launcherPath
    || null;
  const discoveryPath = status?.discoveryPath || null;
  // Prefer backend status.command so desktop-resolved absolute CLI paths
  // (outside PATH) survive into the copyable setup command.
  const codexCommand = (codexStatus?.command || "").trim()
    || (launcherPath ? formatCodexAddCommand(launcherPath, discoveryPath) : "");
  const claudeCommand = (claudeStatus?.command || "").trim()
    || (launcherPath ? formatClaudeAddCommand(launcherPath, discoveryPath) : "");
  const grokCommand = (grokStatus?.command || "").trim()
    || (launcherPath ? formatGrokAddCommand(launcherPath, discoveryPath) : "");
  const codexTomlSnippet = launcherPath ? buildCodexTomlSnippet(launcherPath, discoveryPath) : "";
  const grokTomlSnippet = launcherPath ? buildGrokTomlSnippet(launcherPath, discoveryPath) : "";
  const claudeSnippet = launcherPath ? buildClaudeSnippet(launcherPath, discoveryPath) : "";
  const cursorSnippet = launcherPath ? buildCursorSnippet(launcherPath, discoveryPath) : "";
  const canAddToCodex = codexStatus?.state === "not_configured";
  const canAddToClaude = claudeStatus?.state === "not_configured";
  const canAddToGrok = grokStatus?.state === "not_configured";

  const copyText = useCallback(async (key: string, text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => {
        setCopied((current) => (current === key ? null : current));
      }, 1200);
    } catch {
      setActionMessage({ tone: "error", text: t("ai.externalMcp.copyFailed") });
    }
  }, [t]);

  const handleAddToCodex = useCallback(async () => {
    const bridge = getBridge();
    if (!bridge?.externalMcpCodexAdd) return;
    setActionMessage(null);
    setIsAddingCodex(true);
    try {
      const result = await bridge.externalMcpCodexAdd() as ClientSetupStatus;
      setCodexStatus(result);
      if (result.state === "configured") {
        setActionMessage({ tone: "success", text: t("ai.externalMcp.codexAdded") });
      } else if (result.state === "codex_not_found") {
        setActionMessage({ tone: "warning", text: t("ai.externalMcp.installCodex") });
      } else if (result.state === "conflict") {
        setActionMessage({ tone: "error", text: t("ai.externalMcp.conflict.description") });
      } else if (result.state === "error" && result.error) {
        setActionMessage({ tone: "error", text: result.error });
      }
      await refreshStatus({ quiet: true });
    } finally {
      setIsAddingCodex(false);
    }
  }, [refreshStatus, t]);

  const handleAddToClaude = useCallback(async () => {
    const bridge = getBridge();
    if (!bridge?.externalMcpClaudeAdd) return;
    setActionMessage(null);
    setIsAddingClaude(true);
    try {
      const result = await bridge.externalMcpClaudeAdd() as ClientSetupStatus;
      setClaudeStatus(result);
      if (result.state === "configured") {
        setActionMessage({ tone: "success", text: t("ai.externalMcp.claudeAdded") });
      } else if (result.state === "claude_not_found") {
        setActionMessage({ tone: "warning", text: t("ai.externalMcp.installClaude") });
      } else if (result.state === "conflict") {
        setActionMessage({ tone: "error", text: t("ai.externalMcp.conflict.description") });
      } else if (result.state === "error" && result.error) {
        setActionMessage({ tone: "error", text: result.error });
      }
      await refreshStatus({ quiet: true });
    } finally {
      setIsAddingClaude(false);
    }
  }, [refreshStatus, t]);

  const handleAddToGrok = useCallback(async () => {
    const bridge = getBridge();
    if (!bridge?.externalMcpGrokAdd) return;
    setActionMessage(null);
    setIsAddingGrok(true);
    try {
      const result = await bridge.externalMcpGrokAdd() as ClientSetupStatus;
      setGrokStatus(result);
      if (result.state === "configured") {
        setActionMessage({ tone: "success", text: t("ai.externalMcp.grokAdded") });
      } else if (result.state === "grok_not_found") {
        setActionMessage({ tone: "warning", text: t("ai.externalMcp.installGrok") });
      } else if (result.state === "conflict") {
        setActionMessage({ tone: "error", text: t("ai.externalMcp.conflict.description") });
      } else if (result.state === "error" && result.error) {
        setActionMessage({ tone: "error", text: result.error });
      }
      await refreshStatus({ quiet: true });
    } finally {
      setIsAddingGrok(false);
    }
  }, [refreshStatus, t]);

  const selectedClientMeta = useMemo(() => {
    if (selectedClient === "cursor" || selectedClient === "other") {
      return {
        kind: "snippet" as const,
        statusView: null as StatusView | null,
        command: "",
        snippet: cursorSnippet,
        canAdd: false,
        isAdding: false,
        addLabelKey: "",
        onAdd: null as (() => void) | null,
      };
    }
    if (selectedClient === "claude") {
      return {
        kind: "installable" as const,
        statusView: claudeStatusView,
        command: claudeCommand,
        snippet: claudeSnippet,
        canAdd: canAddToClaude,
        isAdding: isAddingClaude,
        addLabelKey: "ai.externalMcp.addToClaude",
        onAdd: () => { void handleAddToClaude(); },
      };
    }
    if (selectedClient === "grok") {
      return {
        kind: "installable" as const,
        statusView: grokStatusView,
        command: grokCommand,
        snippet: grokTomlSnippet,
        canAdd: canAddToGrok,
        isAdding: isAddingGrok,
        addLabelKey: "ai.externalMcp.addToGrok",
        onAdd: () => { void handleAddToGrok(); },
      };
    }
    return {
      kind: "installable" as const,
      statusView: codexStatusView,
      command: codexCommand,
      snippet: codexTomlSnippet,
      canAdd: canAddToCodex,
      isAdding: isAddingCodex,
      addLabelKey: "ai.externalMcp.addToCodex",
      onAdd: () => { void handleAddToCodex(); },
    };
  }, [
    canAddToClaude,
    canAddToCodex,
    canAddToGrok,
    claudeCommand,
    claudeSnippet,
    claudeStatusView,
    codexCommand,
    codexStatusView,
    codexTomlSnippet,
    cursorSnippet,
    grokCommand,
    grokStatusView,
    grokTomlSnippet,
    handleAddToClaude,
    handleAddToCodex,
    handleAddToGrok,
    isAddingClaude,
    isAddingCodex,
    isAddingGrok,
    selectedClient,
  ]);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex items-start gap-1.5">
          <p className="min-w-0 text-xs text-muted-foreground leading-5">
            {t("ai.externalMcp.description")}
          </p>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="relative -top-px mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                aria-label={t("ai.externalMcp.help.ariaLabel")}
              >
                <HelpCircle size={13} />
              </button>
            </TooltipTrigger>
            <TooltipContent
              side="bottom"
              align="start"
              className="max-w-[320px] space-y-1.5 bg-popover text-popover-foreground border border-border px-3 py-2.5 text-left text-xs leading-relaxed shadow-md"
            >
              <div className="font-medium text-foreground">{t("ai.externalMcp.usage.title")}</div>
              <p>{t("ai.externalMcp.usage.keepRunning")}</p>
              <p>{t("ai.externalMcp.usage.localhost")}</p>
              <p>{t("ai.externalMcp.usage.permissions")}</p>
              <p>{t("ai.externalMcp.usage.capabilities")}</p>
              <div className="pt-1 font-medium text-foreground">{t("ai.externalMcp.security")}</div>
              <p>{t("ai.externalMcp.security.description")}</p>
            </TooltipContent>
          </Tooltip>
        </div>
        <div className={cn("text-xs font-medium shrink-0", bridgeStatusView.className)}>
          {t(bridgeStatusView.labelKey)}
        </div>
      </div>

      <SettingCard divided>
      <div className="flex items-center justify-between gap-4 py-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">{t("ai.externalMcp.title")}</div>
          <div className="text-xs text-muted-foreground">
            {t("ai.externalMcp.sessionsExposed", { count: String(exposedSessionCount) })}
          </div>
        </div>
        <Toggle
          checked={enabled}
          ariaLabel={t("ai.externalMcp.title")}
          onChange={(nextEnabled) => {
            statusGeneration.current += 1;
            setActionMessage(null);
            void setEnabled(nextEnabled).then(() => refreshStatus());
          }}
        />
      </div>

      {/* Permission mode is controlled in Safety settings; surface it here so External MCP
          users see why write tools may still prompt (confirm) or run freely (auto). */}
      <div className="flex flex-wrap items-start justify-between gap-4 py-3">
        <div className="min-w-0 space-y-1">
          <div className="text-sm font-medium">{t("ai.externalMcp.permissionMode.label")}</div>
          <div className="text-xs text-muted-foreground leading-5">
            {t("ai.externalMcp.permissionMode.hint")}
          </div>
        </div>
        <div
          className={cn(
            "shrink-0 text-xs font-medium text-right max-w-[12rem]",
            getPermissionModeToneClass(status?.permissionMode),
          )}
          data-testid="external-mcp-permission-mode"
        >
          {t(getPermissionModeLabelKey(status?.permissionMode))}
        </div>
      </div>

      <SettingsAnchor anchorId="ai-external-mcp-approval-alert">
        <SettingRow label={t("ai.toolSettings.behavior")} description={t(mode === "persistent" ? "ai.externalMcp.mode.persistent" : "ai.externalMcp.mode.temporary")}>
          <ToolSettingsDialog title={t("ai.toolSettings.behavior")} triggerLabel={t("ai.toolSettings.configureBehavior")} immediate open={behaviorOpen} onOpenChange={setBehaviorOpen}>
      <SettingCard divided className="border-0 bg-transparent p-0">
        <SettingRow
          label={t("ai.externalMcp.approvalAlert")}
          description={t("ai.externalMcp.approvalAlert.description")}
        >
          <Select
            value={approvalAlert}
            options={[
              { value: "always", label: t("ai.externalMcp.approvalAlert.always") },
              { value: "unfocused", label: t("ai.externalMcp.approvalAlert.unfocused") },
              { value: "off", label: t("ai.externalMcp.approvalAlert.off") },
            ]}
            onChange={(value) => setApprovalAlert(
              value === "always" || value === "off" ? value : "unfocused",
            )}
            className="w-40"
          />
        </SettingRow>
        <SettingRow
          label={t("ai.externalMcp.mode")}
          description={t("ai.externalMcp.mode.description")}
        >
          <Select
            value={mode}
            options={[
              { value: "temporary", label: t("ai.externalMcp.mode.temporary") },
              { value: "persistent", label: t("ai.externalMcp.mode.persistent") },
            ]}
            onChange={(value) => setMode(value === "persistent" ? "persistent" : "temporary")}
            className="w-36"
          />
        </SettingRow>
        {mode === "temporary" ? (
          <SettingRow
            label={t("ai.externalMcp.idleTimeout")}
            description={t("ai.externalMcp.idleTimeout.description")}
          >
            <div className="flex items-center gap-2 shrink-0">
              <input
                type="number"
                aria-label={t("ai.externalMcp.idleTimeout")}
                min={1}
                max={24 * 60}
                value={idleTimeoutMinutes}
                onChange={(event) => {
                  const minutes = Number.parseInt(event.currentTarget.value, 10);
                  if (!Number.isFinite(minutes)) return;
                  setIdleTimeoutMinutes(minutes);
                }}
                className="w-20 rounded-md border border-border/60 bg-background px-2 py-1 text-sm"
              />
              <span className="text-xs text-muted-foreground">{t("ai.externalMcp.idleTimeout.minutes")}</span>
            </div>
          </SettingRow>
        ) : null}
        <SettingRow
          label={t("ai.externalMcp.focusOnHostOpen")}
          description={t("ai.externalMcp.focusOnHostOpen.description")}
        >
          <Toggle
            checked={focusOnHostOpen}
            onChange={setFocusOnHostOpen}
            ariaLabel={t("ai.externalMcp.focusOnHostOpen")}
          />
        </SettingRow>
        <SettingRow
          label={t("ai.externalMcp.silentSessions")}
          description={t("ai.externalMcp.silentSessions.description")}
        >
          <Toggle
            checked={silentSessions}
            onChange={setSilentSessions}
            ariaLabel={t("ai.externalMcp.silentSessions")}
          />
        </SettingRow>
        <SettingRow
          label={t("ai.externalMcp.sessionIdleTimeout")}
          description={t("ai.externalMcp.sessionIdleTimeout.description")}
        >
          <div className="flex items-center gap-2 shrink-0">
            <input
              type="number"
              aria-label={t("ai.externalMcp.sessionIdleTimeout")}
              min={1}
              max={24 * 60}
              value={sessionIdleTimeoutMinutes}
              onChange={(event) => {
                const minutes = Number.parseInt(event.currentTarget.value, 10);
                if (!Number.isFinite(minutes)) return;
                setSessionIdleTimeoutMinutes(minutes);
              }}
              className="w-20 rounded-md border border-border/60 bg-background px-2 py-1 text-sm"
            />
            <span className="text-xs text-muted-foreground">{t("ai.externalMcp.idleTimeout.minutes")}</span>
          </div>
        </SettingRow>
      </SettingCard>
          </ToolSettingsDialog>
        </SettingRow>
      </SettingsAnchor>
      </SettingCard>

      <ExternalMcpHttpSection
        externalMcpEnabled={enabled}
        settings={httpSettings}
        status={status?.http || null}
        copied={copied}
        rotating={isRotatingHttpToken}
        onCopy={copyText}
        onChange={(next) => { void applyHttpSettings(next); }}
        onRotateToken={() => { void rotateHttpToken(); }}
      />

      <SettingCard>
        <SettingRow label={t("ai.externalMcp.clientConfiguration")} description={t("ai.externalMcp.clientConfiguration.description")}>
          <ToolSettingsDialog title={t("ai.externalMcp.clientConfiguration")} triggerLabel={t("ai.toolSettings.configureClients")}>

      <div className="space-y-2">
        <div className="space-y-1">
          <div className="text-sm font-semibold text-foreground">
            {t("ai.externalMcp.clientConfiguration")}
          </div>
          <p className="text-xs text-muted-foreground leading-5">
            {t("ai.externalMcp.clientConfiguration.description")}
          </p>
        </div>

        <Tabs value={selectedClient} onValueChange={(value) => { setSelectedClient(value as ExternalMcpClient); setManualFormat(value === "other" || value === "cursor" ? "snippet" : "command"); setActionMessage(null); }}>
          <TabsList aria-label={t("ai.externalMcp.clientConfiguration")} className="flex h-auto flex-wrap justify-start">
            {CLIENT_TABS.map((client) => <TabsTrigger key={client} value={client}>{t(`ai.externalMcp.client.${client}`)}</TabsTrigger>)}
          </TabsList>
          <TabsContent value={selectedClient}>

        <div className="space-y-4">
          {selectedClientMeta.kind === "installable" && selectedClientMeta.statusView ? (
            <div className="flex items-center justify-between gap-3">
              <div className={cn("text-xs font-medium", selectedClientMeta.statusView.className)}>
                {t(selectedClientMeta.statusView.labelKey)}
              </div>
              <Button
                size="sm"
                disabled={
                  !selectedClientMeta.canAdd
                  || selectedClientMeta.isAdding
                  || !enabled
                  || !launcherPath
                }
                onClick={() => selectedClientMeta.onAdd?.()}
              >
                {t(selectedClientMeta.addLabelKey)}
              </Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground leading-5">
              {t(selectedClient === "other"
                ? "ai.externalMcp.other.description"
                : "ai.externalMcp.cursor.description")}
            </p>
          )}

          <details className="space-y-3">
            <summary className="cursor-pointer text-sm font-medium">{t("ai.toolSettings.manualSetup")}</summary>
            <label className="flex flex-wrap items-center justify-between gap-2 text-sm">
              {t("ai.toolSettings.format")}
              <select className="h-9 max-w-full rounded-md border border-input bg-background px-3 text-sm" value={manualFormat} onChange={(event) => setManualFormat(event.currentTarget.value)}>
                {selectedClientMeta.kind === "installable" ? <option value="command">{t("ai.externalMcp.cliCommand")}</option> : null}
                <option value="snippet">{t("ai.externalMcp.configSnippet")}</option>
                {selectedClient === "other" ? <option value="prompt">{t("ai.externalMcp.universalSetupPrompt")}</option> : null}
              </select>
            </label>
            <CopyableCodeBlock
              label={t(manualFormat === "command" ? "ai.externalMcp.cliCommand" : manualFormat === "prompt" ? "ai.externalMcp.universalSetupPrompt" : "ai.externalMcp.configSnippet")}
              value={manualFormat === "command" ? selectedClientMeta.command : manualFormat === "prompt" ? universalSetupPrompt : selectedClientMeta.snippet}
              copyKey={manualFormat}
              copied={copied}
              onCopy={copyText}
              copyLabel={t("ai.externalMcp.copy")}
              copiedLabel={t("ai.externalMcp.copied")}
              emptyLabel={t("ai.externalMcp.unavailable")}
            />
          </details>
        </div>
          </TabsContent>
        </Tabs>
      </div>
      <details className="space-y-3">
        <summary className="cursor-pointer text-sm font-medium">{t("ai.toolSettings.connectionDetails")}</summary>
        <div className="flex min-h-8 items-center justify-between gap-2">
          <div className="text-sm font-semibold text-foreground">{t("ai.externalMcp.discovery")}</div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refreshStatus()}
            disabled={isRefreshing}
          >
            <RefreshCw size={14} className={cn("mr-1.5", isRefreshing && "animate-spin")} />
            {t("ai.externalMcp.refresh")}
          </Button>
        </div>
        <div className="space-y-3">
          <CopyableCodeBlock
            label={t("ai.externalMcp.launcher")}
            value={launcherPath || ""}
            copyKey="launcher"
            copied={copied}
            onCopy={copyText}
            copyLabel={t("ai.externalMcp.copy")}
            copiedLabel={t("ai.externalMcp.copied")}
            emptyLabel={t("ai.externalMcp.unavailable")}
          />
          <CopyableCodeBlock
            label={t("ai.externalMcp.discovery")}
            value={status?.discoveryPath || ""}
            copyKey="discovery"
            copied={copied}
            onCopy={copyText}
            copyLabel={t("ai.externalMcp.copy")}
            copiedLabel={t("ai.externalMcp.copied")}
            emptyLabel={t("ai.externalMcp.unavailable")}
          />
          {!enabled ? (
            <p className="text-xs text-amber-500">{t("ai.externalMcp.enableForLauncher")}</p>
          ) : null}
        </div>
      </details>

            {actionMessage ? <p role={actionMessage.tone === "error" ? "alert" : "status"} className={cn("text-xs", actionMessage.tone === "error" ? "text-destructive" : "text-muted-foreground")}>{actionMessage.text}</p> : null}
          </ToolSettingsDialog>
        </SettingRow>
      </SettingCard>

      {actionMessage ? (
        <div
          className={cn(
            "text-xs",
            actionMessage.tone === "success" && "text-emerald-500",
            actionMessage.tone === "warning" && "text-amber-500",
            actionMessage.tone === "error" && "text-destructive",
          )}
        >
          {actionMessage.text}
        </div>
      ) : null}
      {configError || status?.error ? (
        <div role="alert" className="text-xs text-destructive">{configError || status?.error}</div>
      ) : null}
    </div>
  );
};
