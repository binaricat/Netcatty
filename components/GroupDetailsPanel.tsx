import {
  Check,
  ChevronRight,
  Eye,
  EyeOff,
  Forward,
  Globe,
  Key,
  Link2,
  Palette,
  Plus,
  Settings2,
  ShieldAlert,
  TerminalSquare,
  Variable,
  Wifi,
  X,
} from "lucide-react";
import React, { useCallback, useMemo, useState } from "react";
import { useI18n } from "../application/i18n/I18nProvider";
import { customThemeStore } from "../application/state/customThemeStore";
import { cn } from "../lib/utils";
import {
  EnvVar,
  GroupConfig,
  Host,
  HostChainConfig,
  Identity,
  ProxyConfig,
  SSHKey,
} from "../types";
import ThemeSelectPanel from "./ThemeSelectPanel";
import {
  ChainPanel,
  EnvVarsPanel,
  ProxyPanel,
} from "./host-details";
import {
  AsidePanel,
  AsidePanelContent,
} from "./ui/aside-panel";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Combobox } from "./ui/combobox";
import { Input } from "./ui/input";

type SubPanel = "none" | "proxy" | "chain" | "env-vars" | "theme-select";

interface GroupDetailsPanelProps {
  groupPath: string;
  config: GroupConfig | undefined;
  availableKeys: SSHKey[];
  identities: Identity[];
  allHosts: Host[];
  terminalThemeId: string;
  terminalFontSize: number;
  onSave: (config: GroupConfig, newName?: string) => void;
  onCancel: () => void;
}

const GroupDetailsPanel: React.FC<GroupDetailsPanelProps> = ({
  groupPath,
  config,
  availableKeys,
  identities,
  allHosts,
  terminalThemeId,
  terminalFontSize,
  onSave,
  onCancel,
}) => {
  const { t } = useI18n();

  const originalName = groupPath.includes("/")
    ? groupPath.split("/").pop()!
    : groupPath;
  const parentPath = groupPath.includes("/")
    ? groupPath.substring(0, groupPath.lastIndexOf("/"))
    : "";

  const [form, setForm] = useState<Partial<GroupConfig>>(
    () => config || {},
  );
  const [groupName, setGroupName] = useState<string>(originalName);

  // Sub-panel state
  const [activeSubPanel, setActiveSubPanel] = useState<SubPanel>("none");

  // Password visibility state
  const [showPassword, setShowPassword] = useState(false);

  // Environment variables state
  const [newEnvName, setNewEnvName] = useState("");
  const [newEnvValue, setNewEnvValue] = useState("");

  const update = <K extends keyof GroupConfig>(key: K, value: GroupConfig[K] | undefined) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  // Proxy helpers
  const updateProxyConfig = useCallback(
    (field: keyof ProxyConfig, value: string | number) => {
      setForm((prev) => ({
        ...prev,
        proxyConfig: {
          type: prev.proxyConfig?.type || "http",
          host: prev.proxyConfig?.host || "",
          port: prev.proxyConfig?.port || 8080,
          ...prev.proxyConfig,
          [field]: value,
        },
      }));
    },
    [],
  );

  const clearProxyConfig = useCallback(() => {
    setForm((prev) => {
      const { proxyConfig: _proxyConfig, ...rest } = prev;
      return rest;
    });
  }, []);

  // Chain helpers
  const chainedHosts = useMemo(() => {
    const ids = form.hostChain?.hostIds || [];
    return ids
      .map((id) => allHosts.find((h) => h.id === id))
      .filter(Boolean) as Host[];
  }, [allHosts, form.hostChain?.hostIds]);

  const availableHostsForChain = useMemo(() => {
    const chainedIds = new Set(form.hostChain?.hostIds || []);
    return allHosts.filter((h) => !chainedIds.has(h.id));
  }, [allHosts, form.hostChain?.hostIds]);

  const addHostToChain = (hostId: string) => {
    setForm((prev) => ({
      ...prev,
      hostChain: {
        hostIds: [...(prev.hostChain?.hostIds || []), hostId],
      },
    }));
  };

  const removeHostFromChain = (index: number) => {
    setForm((prev) => ({
      ...prev,
      hostChain: {
        hostIds: (prev.hostChain?.hostIds || []).filter((_, i) => i !== index),
      },
    }));
  };

  const clearHostChain = useCallback(() => {
    setForm((prev) => {
      const { hostChain: _hostChain, ...rest } = prev;
      return rest;
    });
  }, []);

  // Env vars helpers
  const addEnvVar = () => {
    if (!newEnvName.trim()) return;
    const newVar: EnvVar = { name: newEnvName.trim(), value: newEnvValue };
    setForm((prev) => ({
      ...prev,
      environmentVariables: [...(prev.environmentVariables || []), newVar],
    }));
    setNewEnvName("");
    setNewEnvValue("");
  };

  const removeEnvVar = (index: number) => {
    setForm((prev) => ({
      ...prev,
      environmentVariables: (prev.environmentVariables || []).filter(
        (_, i) => i !== index,
      ),
    }));
  };

  // Key options for combobox
  const keyOptions = useMemo(() => {
    return availableKeys
      .filter((k) => k.category === "key")
      .map((k) => ({
        value: k.id,
        label: k.label,
        sublabel: `${k.type}${k.keySize ? ` ${k.keySize}` : ""}`,
        icon: <Key size={14} className="text-muted-foreground" />,
      }));
  }, [availableKeys]);

  // Effective theme
  const effectiveThemeId = form.theme || terminalThemeId;

  // Save handler
  const handleSubmit = () => {
    // Build the new path based on possible rename
    const newPath = parentPath
      ? `${parentPath}/${groupName.trim()}`
      : groupName.trim();

    const result: GroupConfig = {
      path: newPath,
      ...(form.username !== undefined && { username: form.username }),
      ...(form.password !== undefined && { password: form.password }),
      ...(form.savePassword !== undefined && { savePassword: form.savePassword }),
      ...(form.authMethod !== undefined && { authMethod: form.authMethod }),
      ...(form.identityId !== undefined && { identityId: form.identityId }),
      ...(form.identityFileId !== undefined && { identityFileId: form.identityFileId }),
      ...(form.port !== undefined && { port: form.port }),
      ...(form.protocol !== undefined && { protocol: form.protocol }),
      ...(form.agentForwarding !== undefined && { agentForwarding: form.agentForwarding }),
      ...(form.proxyConfig !== undefined && { proxyConfig: form.proxyConfig }),
      ...(form.hostChain !== undefined && { hostChain: form.hostChain }),
      ...(form.startupCommand !== undefined && { startupCommand: form.startupCommand }),
      ...(form.legacyAlgorithms !== undefined && { legacyAlgorithms: form.legacyAlgorithms }),
      ...(form.environmentVariables !== undefined && { environmentVariables: form.environmentVariables }),
      ...(form.charset !== undefined && { charset: form.charset }),
      ...(form.moshEnabled !== undefined && { moshEnabled: form.moshEnabled }),
      ...(form.moshServerPath !== undefined && { moshServerPath: form.moshServerPath }),
      ...(form.telnetPort !== undefined && { telnetPort: form.telnetPort }),
      ...(form.telnetUsername !== undefined && { telnetUsername: form.telnetUsername }),
      ...(form.telnetPassword !== undefined && { telnetPassword: form.telnetPassword }),
      ...(form.theme !== undefined && { theme: form.theme }),
      ...(form.themeOverride !== undefined && { themeOverride: form.themeOverride }),
      ...(form.fontFamily !== undefined && { fontFamily: form.fontFamily }),
      ...(form.fontFamilyOverride !== undefined && { fontFamilyOverride: form.fontFamilyOverride }),
      ...(form.fontSize !== undefined && { fontSize: form.fontSize }),
      ...(form.fontSizeOverride !== undefined && { fontSizeOverride: form.fontSizeOverride }),
    };

    const nameChanged = groupName.trim() !== originalName;
    onSave(result, nameChanged ? groupName.trim() : undefined);
  };

  // --- Sub-panel rendering ---

  if (activeSubPanel === "proxy") {
    return (
      <ProxyPanel
        proxyConfig={form.proxyConfig}
        onUpdateProxy={updateProxyConfig}
        onClearProxy={clearProxyConfig}
        onBack={() => setActiveSubPanel("none")}
        onCancel={onCancel}
      />
    );
  }

  if (activeSubPanel === "chain") {
    return (
      <ChainPanel
        formLabel={groupName}
        formHostname={groupPath}
        form={{ id: "", label: groupName, hostname: groupPath, port: 22, username: "", tags: [], os: "linux" }}
        chainedHosts={chainedHosts}
        availableHostsForChain={availableHostsForChain}
        onAddHost={addHostToChain}
        onRemoveHost={removeHostFromChain}
        onClearChain={clearHostChain}
        onBack={() => setActiveSubPanel("none")}
        onCancel={onCancel}
      />
    );
  }

  if (activeSubPanel === "env-vars") {
    return (
      <EnvVarsPanel
        hostLabel={groupName}
        hostHostname={groupPath}
        environmentVariables={form.environmentVariables || []}
        newEnvName={newEnvName}
        newEnvValue={newEnvValue}
        setNewEnvName={setNewEnvName}
        setNewEnvValue={setNewEnvValue}
        onAddEnvVar={addEnvVar}
        onRemoveEnvVar={removeEnvVar}
        onUpdateEnvVar={(index, field, value) => {
          const newVars = [...(form.environmentVariables || [])];
          newVars[index] = { ...newVars[index], [field]: value };
          setForm((prev) => ({ ...prev, environmentVariables: newVars }));
        }}
        onSave={() => {
          if (newEnvName.trim()) addEnvVar();
          setActiveSubPanel("none");
        }}
        onBack={() => setActiveSubPanel("none")}
        onCancel={onCancel}
      />
    );
  }

  if (activeSubPanel === "theme-select") {
    return (
      <ThemeSelectPanel
        open={true}
        selectedThemeId={effectiveThemeId}
        onSelect={(themeId) => {
          setForm((prev) => ({ ...prev, theme: themeId, themeOverride: true }));
          setActiveSubPanel("none");
        }}
        onClose={onCancel}
        onBack={() => setActiveSubPanel("none")}
        showBackButton={true}
      />
    );
  }

  // --- Main panel ---
  return (
    <AsidePanel
      open={true}
      onClose={onCancel}
      width="w-[420px]"
      title={t("vault.groups.details")}
      actions={
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={handleSubmit}
          disabled={!groupName.trim()}
        >
          <Check size={16} />
        </Button>
      }
    >
      <AsidePanelContent>
        {/* General Section */}
        <Card className="p-3 space-y-3 bg-card border-border/80">
          <div className="flex items-center gap-2">
            <Settings2 size={14} className="text-muted-foreground" />
            <p className="text-xs font-semibold">
              {t("vault.groups.details.general")}
            </p>
          </div>
          <Input
            placeholder={t("vault.groups.details.general")}
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            className="h-10"
          />
          <div className="flex items-center gap-2 text-sm">
            <span className="text-xs text-muted-foreground">
              {t("vault.groups.details.parentGroup")}:
            </span>
            <span className="text-xs truncate">
              {parentPath || t("vault.groups.details.none")}
            </span>
          </div>
        </Card>

        {/* SSH Section */}
        <Card className="p-3 space-y-3 bg-card border-border/80">
          <div className="flex items-center gap-2">
            <TerminalSquare size={14} className="text-muted-foreground" />
            <p className="text-xs font-semibold">
              {t("vault.groups.details.ssh")}
            </p>
          </div>

          {/* Protocol SSH + Port */}
          <div className="flex items-center gap-2">
            <div className="flex-1 min-w-0 h-10 flex items-center gap-2 bg-secondary/70 border border-border/70 rounded-md px-3">
              <span className="text-xs text-muted-foreground">SSH on</span>
              <div className="ml-auto w-1/2 min-w-0 flex items-center gap-2 justify-end">
                <Input
                  type="number"
                  placeholder="22"
                  value={form.port ?? ""}
                  onChange={(e) =>
                    update("port", e.target.value ? Number(e.target.value) : undefined)
                  }
                  className="h-8 flex-1 min-w-0 text-center"
                />
                <span className="text-xs text-muted-foreground">
                  {t("hostDetails.port")}
                </span>
              </div>
            </div>
          </div>

          {/* Username */}
          <Input
            placeholder={t("hostDetails.username.placeholder")}
            value={form.username || ""}
            onChange={(e) => update("username", e.target.value || undefined)}
            className="h-10"
          />

          {/* Password with eye toggle */}
          <div className="relative">
            <Input
              placeholder={t("hostDetails.password.placeholder")}
              type={showPassword ? "text" : "password"}
              value={form.password || ""}
              onChange={(e) => update("password", e.target.value || undefined)}
              className="h-10 pr-10"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>

          {/* SSH Key selector */}
          {form.identityFileId ? (
            <div className="flex items-center gap-2 p-2 rounded-md bg-secondary/50 border border-border/60">
              <Key size={14} className="text-primary" />
              <span className="text-sm flex-1 truncate">
                {availableKeys.find((k) => k.id === form.identityFileId)?.label || "Key"}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => {
                  update("identityFileId", undefined);
                  update("authMethod", undefined);
                }}
              >
                <X size={12} />
              </Button>
            </div>
          ) : (
            keyOptions.length > 0 && (
              <Combobox
                options={keyOptions}
                value={form.identityFileId}
                onValueChange={(val) => {
                  update("identityFileId", val);
                  update("authMethod", "key");
                }}
                placeholder={t("hostDetails.keys.search")}
                emptyText={t("hostDetails.keys.empty")}
                icon={<Key size={14} className="text-muted-foreground" />}
                className="w-full"
              />
            )
          )}

          {/* Agent Forwarding */}
          <ToggleRow
            label={t("hostDetails.agentForwarding")}
            enabled={!!form.agentForwarding}
            onToggle={() => update("agentForwarding", !form.agentForwarding)}
          />
        </Card>

        {/* Telnet Section */}
        <Card className="p-3 space-y-3 bg-card border-border/80">
          <div className="flex items-center gap-2">
            <Globe size={14} className="text-muted-foreground" />
            <p className="text-xs font-semibold">
              {t("vault.groups.details.telnet")}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex-1 min-w-0 h-10 flex items-center gap-2 bg-secondary/70 border border-border/70 rounded-md px-3">
              <span className="text-xs text-muted-foreground">Telnet on</span>
              <div className="ml-auto w-1/2 min-w-0 flex items-center gap-2 justify-end">
                <Input
                  type="number"
                  placeholder="23"
                  value={form.telnetPort ?? ""}
                  onChange={(e) =>
                    update("telnetPort", e.target.value ? Number(e.target.value) : undefined)
                  }
                  className="h-8 flex-1 min-w-0 text-center"
                />
                <span className="text-xs text-muted-foreground">
                  {t("hostDetails.port")}
                </span>
              </div>
            </div>
          </div>

          <Input
            placeholder={t("hostDetails.telnet.username")}
            value={form.telnetUsername || ""}
            onChange={(e) => update("telnetUsername", e.target.value || undefined)}
            className="h-10"
          />
          <Input
            placeholder={t("hostDetails.telnet.password")}
            type="password"
            value={form.telnetPassword || ""}
            onChange={(e) => update("telnetPassword", e.target.value || undefined)}
            className="h-10"
          />
        </Card>

        {/* Advanced Section */}
        <Card className="p-3 space-y-3 bg-card border-border/80">
          <div className="flex items-center gap-2">
            <Settings2 size={14} className="text-muted-foreground" />
            <p className="text-xs font-semibold">
              {t("vault.groups.details.advanced")}
            </p>
          </div>

          {/* Startup Command */}
          <Input
            placeholder={t("hostDetails.startupCommand.placeholder")}
            value={form.startupCommand || ""}
            onChange={(e) => update("startupCommand", e.target.value || undefined)}
            className="h-10"
          />

          {/* Charset */}
          <Input
            placeholder="UTF-8"
            value={form.charset || ""}
            onChange={(e) => update("charset", e.target.value || undefined)}
            className="h-10"
          />

          {/* Legacy Algorithms */}
          <ToggleRow
            label={t("hostDetails.legacyAlgorithms")}
            enabled={!!form.legacyAlgorithms}
            onToggle={() => update("legacyAlgorithms", !form.legacyAlgorithms)}
          />

          {/* Proxy row */}
          <button
            type="button"
            className="w-full flex items-center justify-between p-2 rounded-md bg-secondary/50 hover:bg-secondary transition-colors cursor-pointer"
            onClick={() => setActiveSubPanel("proxy")}
          >
            <div className="flex items-center gap-2">
              <Globe size={14} className="text-muted-foreground" />
              <span className="text-sm">{t("hostDetails.proxy")}</span>
            </div>
            <div className="flex items-center gap-2">
              {form.proxyConfig?.host && (
                <Badge variant="secondary" className="text-xs">
                  {form.proxyConfig.type?.toUpperCase()} {form.proxyConfig.host}:{form.proxyConfig.port}
                </Badge>
              )}
              <ChevronRight size={14} className="text-muted-foreground" />
            </div>
          </button>

          {/* Host Chaining row */}
          <button
            type="button"
            className="w-full flex items-center justify-between p-2 rounded-md bg-secondary/50 hover:bg-secondary transition-colors cursor-pointer"
            onClick={() => setActiveSubPanel("chain")}
          >
            <div className="flex items-center gap-2">
              <Link2 size={14} className="text-muted-foreground" />
              <span className="text-sm">{t("hostDetails.jumpHosts")}</span>
            </div>
            <div className="flex items-center gap-2">
              {chainedHosts.length > 0 && (
                <Badge variant="secondary" className="text-xs">
                  {t("hostDetails.jumpHosts.hops", { count: chainedHosts.length })}
                </Badge>
              )}
              <ChevronRight size={14} className="text-muted-foreground" />
            </div>
          </button>

          {/* Environment Variables row */}
          <button
            type="button"
            className="w-full flex items-center justify-between p-2 rounded-md bg-secondary/50 hover:bg-secondary transition-colors cursor-pointer"
            onClick={() => setActiveSubPanel("env-vars")}
          >
            <div className="flex items-center gap-2">
              <Variable size={14} className="text-muted-foreground" />
              <span className="text-sm">{t("hostDetails.envVars")}</span>
            </div>
            <div className="flex items-center gap-2">
              {(form.environmentVariables?.length || 0) > 0 && (
                <Badge variant="secondary" className="text-xs">
                  {form.environmentVariables!.length}
                </Badge>
              )}
              <ChevronRight size={14} className="text-muted-foreground" />
            </div>
          </button>
        </Card>

        {/* Mosh Section */}
        <Card className="p-3 space-y-3 bg-card border-border/80">
          <div className="flex items-center gap-2">
            <Wifi size={14} className="text-muted-foreground" />
            <p className="text-xs font-semibold">
              {t("vault.groups.details.mosh")}
            </p>
          </div>
          <ToggleRow
            label="Mosh"
            enabled={!!form.moshEnabled}
            onToggle={() => update("moshEnabled", !form.moshEnabled)}
          />
          {form.moshEnabled && (
            <Input
              placeholder={t("hostDetails.moshServerPath") || "mosh-server path"}
              value={form.moshServerPath || ""}
              onChange={(e) => update("moshServerPath", e.target.value || undefined)}
              className="h-10"
            />
          )}
        </Card>

        {/* Appearance Section */}
        <Card className="p-3 space-y-3 bg-card border-border/80">
          <div className="flex items-center gap-2">
            <Palette size={14} className="text-muted-foreground" />
            <p className="text-xs font-semibold">
              {t("vault.groups.details.appearance")}
            </p>
          </div>

          {/* Theme Selection */}
          <button
            type="button"
            className="w-full flex items-center gap-3 p-2 rounded-lg bg-secondary/50 hover:bg-secondary transition-colors text-left"
            onClick={() => setActiveSubPanel("theme-select")}
          >
            <div
              className="w-12 h-8 rounded-md border border-border/60 flex items-center justify-center text-[6px] font-mono overflow-hidden"
              style={{
                backgroundColor:
                  customThemeStore.getThemeById(effectiveThemeId)?.colors.background || "#100F0F",
                color:
                  customThemeStore.getThemeById(effectiveThemeId)?.colors.foreground || "#CECDC3",
              }}
            >
              <div className="p-0.5">
                <div
                  style={{
                    color: customThemeStore.getThemeById(effectiveThemeId)?.colors.green,
                  }}
                >
                  $
                </div>
              </div>
            </div>
            <span className="text-sm flex-1">
              {customThemeStore.getThemeById(effectiveThemeId)?.name || "Flexoki Dark"}
            </span>
          </button>
          {form.themeOverride && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start text-primary"
              onClick={() =>
                setForm((prev) => ({
                  ...prev,
                  theme: undefined,
                  themeOverride: undefined,
                }))
              }
            >
              {t("common.useGlobal")}
            </Button>
          )}

          {/* Font Family */}
          <Input
            placeholder={t("hostDetails.fontFamily") || "Font Family"}
            value={form.fontFamily || ""}
            onChange={(e) => {
              const val = e.target.value || undefined;
              setForm((prev) => ({
                ...prev,
                fontFamily: val,
                fontFamilyOverride: val ? true : undefined,
              }));
            }}
            className="h-10"
          />

          {/* Font Size */}
          <Input
            type="number"
            placeholder={String(terminalFontSize)}
            value={form.fontSize ?? ""}
            onChange={(e) => {
              const val = e.target.value ? parseInt(e.target.value) : undefined;
              setForm((prev) => ({
                ...prev,
                fontSize: val,
                fontSizeOverride: val !== undefined ? true : undefined,
              }));
            }}
            className="h-10"
          />
        </Card>
      </AsidePanelContent>
    </AsidePanel>
  );
};

// --- Internal Components ---

interface ToggleRowProps {
  label: string;
  enabled: boolean;
  onToggle: () => void;
}

const ToggleRow: React.FC<ToggleRowProps> = ({ label, enabled, onToggle }) => {
  const { t } = useI18n();
  return (
    <div className="flex items-center justify-between h-10 px-3 rounded-md border border-border/70 bg-secondary/70">
      <span className="text-sm">{label}</span>
      <Button
        variant={enabled ? "secondary" : "ghost"}
        size="sm"
        className={cn("h-8 min-w-[72px]", enabled && "bg-primary/20")}
        onClick={onToggle}
      >
        {enabled ? t("common.enabled") : t("common.disabled")}
      </Button>
    </div>
  );
};

export default GroupDetailsPanel;
