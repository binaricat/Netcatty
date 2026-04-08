import {
  Check,
  ChevronRight,
  Eye,
  EyeOff,
  FileKey,
  FolderOpen,
  Globe,
  Key,
  Link2,
  MoreHorizontal,
  Palette,
  Plus,
  Settings2,
  Shield,
  TerminalSquare,
  Trash2,
  Variable,
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
  type AsidePanelLayout,
} from "./ui/aside-panel";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Combobox } from "./ui/combobox";
import { Dropdown, DropdownContent, DropdownTrigger } from "./ui/dropdown";
import { Input } from "./ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { TerminalFontSelect } from "./settings/TerminalFontSelect";
import { useAvailableFonts } from "../application/state/fontStore";

type SubPanel = "none" | "proxy" | "chain" | "env-vars" | "theme-select";

interface GroupDetailsPanelProps {
  groupPath: string;
  config: GroupConfig | undefined;
  availableKeys: SSHKey[];
  identities: Identity[];
  allHosts: Host[];
  groups: string[];
  terminalThemeId: string;
  terminalFontSize: number;
  onSave: (config: GroupConfig, newName?: string, newParent?: string | null) => void;
  onCancel: () => void;
  layout?: AsidePanelLayout;
}

const GroupDetailsPanel: React.FC<GroupDetailsPanelProps> = ({
  groupPath,
  config,
  availableKeys,
  identities: _identities,
  allHosts,
  groups,
  terminalThemeId,
  terminalFontSize,
  onSave,
  onCancel,
  layout = "overlay",
}) => {
  const { t } = useI18n();
  const availableFonts = useAvailableFonts();

  const originalName = groupPath.includes("/")
    ? groupPath.split("/").pop()!
    : groupPath;
  const originalParent = groupPath.includes("/")
    ? groupPath.substring(0, groupPath.lastIndexOf("/"))
    : "";

  const [form, setForm] = useState<Partial<GroupConfig>>(
    () => config || {},
  );
  const [groupName, setGroupName] = useState<string>(originalName);
  const [parentGroup, setParentGroup] = useState<string>(originalParent);
  const [nameError, setNameError] = useState<string | null>(null);

  // Protocol sections enabled state
  const hasSshFields = (c: Partial<GroupConfig>) =>
    c.protocol === 'ssh' ||
    c.port !== undefined || !!c.username || !!c.password || !!c.identityFileId ||
    c.agentForwarding !== undefined || c.authMethod !== undefined || !!c.identityId ||
    !!c.proxyConfig || !!c.hostChain || !!c.startupCommand || c.legacyAlgorithms !== undefined || c.backspaceBehavior !== undefined ||
    (c.environmentVariables && c.environmentVariables.length > 0) ||
    c.moshEnabled !== undefined || !!c.moshServerPath ||
    (c.identityFilePaths && c.identityFilePaths.length > 0);
  const hasTelnetFields = (c: Partial<GroupConfig>) =>
    c.telnetPort !== undefined || !!c.telnetUsername || !!c.telnetPassword || c.telnetEnabled === true;

  const [sshEnabled, setSshEnabled] = useState(() => hasSshFields(config || {}));
  const [telnetEnabled, setTelnetEnabled] = useState(() => hasTelnetFields(config || {}));

  // Sub-panel state
  const [activeSubPanel, setActiveSubPanel] = useState<SubPanel>("none");

  // Password visibility state
  const [showPassword, setShowPassword] = useState(false);
  const [showTelnetPassword, setShowTelnetPassword] = useState(false);
  const [addProtocolOpen, setAddProtocolOpen] = useState(false);

  // Credential selection state
  const [credentialPopoverOpen, setCredentialPopoverOpen] = useState(false);
  const [selectedCredentialType, setSelectedCredentialType] =
    useState<'key' | 'certificate' | 'localKeyFile' | null>(null);
  const [newKeyFilePath, setNewKeyFilePath] = useState('');

  // Environment variables state
  const [newEnvName, setNewEnvName] = useState("");
  const [newEnvValue, setNewEnvValue] = useState("");

  const update = <K extends keyof GroupConfig>(key: K, value: GroupConfig[K] | undefined) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  // Remove SSH protocol section
  const removeSsh = () => {
    setSshEnabled(false);
    setSelectedCredentialType(null);
    setNewKeyFilePath('');
    setForm((prev) => {
      const next = { ...prev };
      delete next.port;
      delete next.username;
      delete next.password;
      delete next.savePassword;
      delete next.authMethod;
      delete next.identityId;
      delete next.identityFileId;
      delete next.identityFilePaths;
      delete next.agentForwarding;
      delete next.startupCommand;
      delete next.legacyAlgorithms;
      delete next.backspaceBehavior;
      delete next.proxyConfig;
      delete next.hostChain;
      delete next.environmentVariables;
      delete next.protocol;
      delete next.moshEnabled;
      delete next.moshServerPath;
      return next;
    });
  };

  // Remove Telnet protocol section
  const removeTelnet = () => {
    setTelnetEnabled(false);
    setForm((prev) => {
      const next = { ...prev };
      delete next.telnetEnabled;
      delete next.telnetPort;
      delete next.telnetUsername;
      delete next.telnetPassword;
      return next;
    });
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
    setForm((prev) => {
      const ids = (prev.hostChain?.hostIds || []).filter((_, i) => i !== index);
      return { ...prev, hostChain: ids.length > 0 ? { hostIds: ids } : undefined };
    });
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

  // Available keys by category
  const keysByCategory = useMemo(() => {
    return {
      key: availableKeys.filter((k) => k.category === "key"),
      certificate: availableKeys.filter((k) => k.category === "certificate"),
    };
  }, [availableKeys]);

  // Parent group options — exclude self and children
  const parentGroupOptions = useMemo(() => {
    const selfPath = groupPath;
    return [
      { value: "__root__", label: t("vault.groups.details.none") },
      ...groups
        .filter((g) => g !== selfPath && !g.startsWith(selfPath + "/"))
        .map((g) => ({ value: g, label: g })),
    ];
  }, [groups, groupPath, t]);

  // Effective theme
  const effectiveThemeId = form.theme || terminalThemeId;

  // Save handler
  const handleSubmit = () => {
    const trimmedName = groupName.trim();
    if (!trimmedName) return;
    if (trimmedName.includes('/') || trimmedName.includes('\\')) {
      setNameError(t("vault.groups.errors.invalidChars"));
      return;
    }
    setNameError(null);

    const newPath = parentGroup
      ? `${parentGroup}/${trimmedName}`
      : trimmedName;

    const result: GroupConfig = {
      path: newPath,
      // Only include SSH fields if SSH section is enabled
      ...(sshEnabled && {
        protocol: 'ssh' as const,
        ...(form.port !== undefined && { port: form.port }),
        ...(form.username !== undefined && { username: form.username }),
        ...(form.password !== undefined && { password: form.password }),
        ...(form.savePassword !== undefined && { savePassword: form.savePassword }),
        ...(form.authMethod !== undefined && { authMethod: form.authMethod }),
        ...(form.identityId !== undefined && { identityId: form.identityId }),
        ...(form.identityFileId !== undefined && { identityFileId: form.identityFileId }),
        ...(form.identityFilePaths !== undefined && { identityFilePaths: form.identityFilePaths }),
        ...(form.agentForwarding !== undefined && { agentForwarding: form.agentForwarding }),
        ...(form.startupCommand !== undefined && { startupCommand: form.startupCommand }),
        ...(form.legacyAlgorithms !== undefined && { legacyAlgorithms: form.legacyAlgorithms }),
        ...(form.backspaceBehavior !== undefined && { backspaceBehavior: form.backspaceBehavior }),
        ...(form.proxyConfig !== undefined && { proxyConfig: form.proxyConfig }),
        ...(form.hostChain !== undefined && { hostChain: form.hostChain }),
        ...(form.environmentVariables !== undefined && { environmentVariables: form.environmentVariables }),
        ...(form.moshEnabled !== undefined && { moshEnabled: form.moshEnabled }),
        ...(form.moshServerPath !== undefined && { moshServerPath: form.moshServerPath }),
      }),
      // Only include Telnet fields if Telnet section is enabled
      ...(telnetEnabled && {
        telnetEnabled: true,
        ...(form.telnetPort !== undefined && { telnetPort: form.telnetPort }),
        ...(form.telnetUsername !== undefined && { telnetUsername: form.telnetUsername }),
        ...(form.telnetPassword !== undefined && { telnetPassword: form.telnetPassword }),
      }),
      // Shared fields (always saved)
      ...(form.charset !== undefined && { charset: form.charset }),
      ...(form.theme !== undefined && { theme: form.theme }),
      ...(form.themeOverride !== undefined && { themeOverride: form.themeOverride }),
      ...(form.fontFamily !== undefined && { fontFamily: form.fontFamily }),
      ...(form.fontFamilyOverride !== undefined && { fontFamilyOverride: form.fontFamilyOverride }),
      ...(form.fontSize !== undefined && { fontSize: form.fontSize }),
      ...(form.fontSizeOverride !== undefined && { fontSizeOverride: form.fontSizeOverride }),
      ...(form.fontWeight !== undefined && { fontWeight: form.fontWeight }),
      ...(form.fontWeightOverride !== undefined && { fontWeightOverride: form.fontWeightOverride }),
    };

    const nameChanged = trimmedName !== originalName;
    const parentChanged = parentGroup !== originalParent;
    onSave(
      result,
      nameChanged ? trimmedName : undefined,
      parentChanged ? (parentGroup || null) : undefined,
    );
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
        layout={layout}
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
        layout={layout}
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
        layout={layout}
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
        layout={layout}
      />
    );
  }

  // Available protocols to add
  const addableProtocols: { key: string; label: string }[] = [];
  if (!sshEnabled) addableProtocols.push({ key: "ssh", label: "SSH" });
  if (!telnetEnabled) addableProtocols.push({ key: "telnet", label: "Telnet" });

  // --- Main panel ---
  return (
    <AsidePanel
      open={true}
      onClose={onCancel}
      width="w-[380px]"
      dataSection="group-details-panel"
      title={t("vault.groups.details")}
      layout={layout}
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
            placeholder={t("vault.groups.field.name")}
            value={groupName}
            onChange={(e) => {
              setGroupName(e.target.value);
              if (nameError) setNameError(null);
            }}
            className="h-10"
          />
          {nameError && (
            <p className="text-xs text-destructive">{nameError}</p>
          )}
          <Combobox
            options={parentGroupOptions}
            value={parentGroup || "__root__"}
            onValueChange={(val) => setParentGroup(val === "__root__" ? "" : val)}
            placeholder={t("vault.groups.details.parentGroup")}
            className="w-full"
          />
        </Card>

        {/* SSH Section (if enabled) */}
        {sshEnabled && (
          <Card className="p-3 space-y-3 bg-card border-border/80 overflow-hidden">
            <div className="flex items-center gap-2">
              <TerminalSquare size={14} className="text-muted-foreground" />
              <p className="text-xs font-semibold flex-1">
                {t("vault.groups.details.ssh")}
              </p>
              <Dropdown>
                <DropdownTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-6 w-6">
                    <MoreHorizontal size={14} />
                  </Button>
                </DropdownTrigger>
                <DropdownContent align="end" className="min-w-[160px]">
                  <button
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-destructive hover:bg-secondary rounded-md transition-colors"
                    onClick={removeSsh}
                  >
                    <Trash2 size={14} />
                    {t("vault.groups.details.removeProtocol")}
                  </button>
                </DropdownContent>
              </Dropdown>
            </div>

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

            <Input
              placeholder={t("hostDetails.username.placeholder")}
              value={form.username || ""}
              onChange={(e) => update("username", e.target.value || undefined)}
              className="h-10"
            />

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

            {/* Selected credential display */}
            {form.identityFileId && (
              <div className="flex items-center gap-2 p-2 rounded-md bg-secondary/50 border border-border/60">
                {form.authMethod === "certificate" ? (
                  <Shield size={14} className="text-primary" />
                ) : (
                  <Key size={14} className="text-primary" />
                )}
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
                    setSelectedCredentialType(null);
                  }}
                >
                  <X size={12} />
                </Button>
              </div>
            )}

            {/* Local key file paths display */}
            {!form.identityFileId && form.identityFilePaths && form.identityFilePaths.length > 0 && (
              <div className="space-y-1">
                {form.identityFilePaths.map((keyPath, idx) => (
                  <div key={idx} className="flex items-center gap-2 h-8 px-2 rounded-md bg-secondary/50 border border-border/60" style={{ maxWidth: '100%' }}>
                    <FileKey size={12} className="text-muted-foreground shrink-0" />
                    <span className="text-xs font-mono truncate" style={{ maxWidth: '320px' }}>{keyPath}</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 shrink-0"
                      onClick={() => {
                        const paths = (form.identityFilePaths || []).filter((_, i) => i !== idx);
                        update("identityFilePaths", paths.length > 0 ? paths : undefined);
                        if (paths.length === 0) update("authMethod", undefined);
                      }}
                    >
                      <X size={10} />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {/* Credential type selection with inline popover - hidden when credential is selected */}
            {!form.identityFileId &&
              !selectedCredentialType && (
                <Popover
                  open={credentialPopoverOpen}
                  onOpenChange={setCredentialPopoverOpen}
                >
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors py-1"
                    >
                      <Plus size={12} />
                      <span>{t("hostDetails.credential.keyCertificate")}</span>
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    className="w-[200px] p-1"
                    align="start"
                    sideOffset={4}
                  >
                    <div className="space-y-0.5">
                      <button
                        type="button"
                        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-secondary/80 transition-colors text-left"
                        onClick={() => {
                          setSelectedCredentialType("key");
                          setCredentialPopoverOpen(false);
                        }}
                      >
                        <Key size={16} className="text-muted-foreground" />
                        <span className="text-sm font-medium">
                          {t("hostDetails.credential.key")}
                        </span>
                      </button>

                      <button
                        type="button"
                        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-secondary/80 transition-colors text-left"
                        onClick={() => {
                          setSelectedCredentialType("certificate");
                          setCredentialPopoverOpen(false);
                        }}
                      >
                        <Shield size={16} className="text-muted-foreground" />
                        <span className="text-sm font-medium">
                          {t("hostDetails.credential.certificate")}
                        </span>
                      </button>

                      <button
                        type="button"
                        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-secondary/80 transition-colors text-left"
                        onClick={() => {
                          setSelectedCredentialType("localKeyFile");
                          setCredentialPopoverOpen(false);
                        }}
                      >
                        <FileKey size={16} className="text-muted-foreground" />
                        <span className="text-sm font-medium">
                          {t("hostDetails.credential.localKeyFile")}
                        </span>
                      </button>
                    </div>
                  </PopoverContent>
                </Popover>
              )}

            {/* Key selection combobox - appears after selecting "Key" type */}
            {selectedCredentialType === "key" &&
              !form.identityFileId && (
                <div className="flex items-center gap-1">
                  <Combobox
                    options={keysByCategory.key.map((k) => ({
                      value: k.id,
                      label: k.label,
                      sublabel: `${k.type}${k.keySize ? ` ${k.keySize}` : ""}`,
                      icon: <Key size={14} className="text-muted-foreground" />,
                    }))}
                    value={form.identityFileId}
                    onValueChange={(val) => {
                      update("identityFileId", val);
                      update("authMethod", "key");
                      setSelectedCredentialType(null);
                    }}
                    placeholder={t("hostDetails.keys.search")}
                    emptyText={t("hostDetails.keys.empty")}
                    icon={<Key size={14} className="text-muted-foreground" />}
                    className="flex-1"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    onClick={() => setSelectedCredentialType(null)}
                  >
                    <X size={14} />
                  </Button>
                </div>
              )}

            {/* Certificate selection combobox - appears after selecting "Certificate" type */}
            {selectedCredentialType === "certificate" &&
              !form.identityFileId && (
                <div className="flex items-center gap-1">
                  <Combobox
                    options={keysByCategory.certificate.map((k) => ({
                      value: k.id,
                      label: k.label,
                      icon: (
                        <Shield size={14} className="text-muted-foreground" />
                      ),
                    }))}
                    value={form.identityFileId}
                    onValueChange={(val) => {
                      update("identityFileId", val);
                      update("authMethod", "certificate");
                      setSelectedCredentialType(null);
                    }}
                    placeholder={t("hostDetails.certs.search")}
                    emptyText={t("hostDetails.certs.empty")}
                    icon={
                      <Shield size={14} className="text-muted-foreground" />
                    }
                    className="flex-1"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    onClick={() => setSelectedCredentialType(null)}
                  >
                    <X size={14} />
                  </Button>
                </div>
              )}

            {/* Local key file path input - appears after selecting "Local Key File" type */}
            {!form.identityFileId && selectedCredentialType === "localKeyFile" && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-1 w-full">
                  <input
                    type="text"
                    className="flex-1 w-0 h-8 px-2 text-xs font-mono bg-background border border-border/60 rounded-md focus:outline-none focus:ring-1 focus:ring-ring"
                    placeholder={t("hostDetails.credential.localKeyFilePlaceholder")}
                    value={newKeyFilePath}
                    onChange={(e) => setNewKeyFilePath(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && newKeyFilePath.trim()) {
                        e.preventDefault();
                        const paths = [...(form.identityFilePaths || []), newKeyFilePath.trim()];
                        update("identityFilePaths", paths);
                        update("identityFileId", undefined);
                        update("authMethod", "key");
                        setNewKeyFilePath("");
                      }
                    }}
                  />
                  <Button
                    variant="secondary"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    title={t("hostDetails.credential.browseKeyFile")}
                    onClick={async () => {
                      const bridge = (window as unknown as { netcatty?: NetcattyBridge }).netcatty;
                      if (!bridge?.selectFile) return;
                      const filePath = await bridge.selectFile(
                        "Select SSH Private Key",
                        undefined,
                        [{ name: "All Files", extensions: ["*"] }]
                      );
                      if (filePath) {
                        const paths = [...(form.identityFilePaths || []), filePath];
                        update("identityFilePaths", paths);
                        update("identityFileId", undefined);
                        update("authMethod", "key");
                      }
                    }}
                  >
                    <FolderOpen size={14} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    onClick={() => setSelectedCredentialType(null)}
                  >
                    <X size={14} />
                  </Button>
                </div>
              </div>
            )}

            <ToggleRow
              label={t("hostDetails.agentForwarding")}
              enabled={!!form.agentForwarding}
              onToggle={() => update("agentForwarding", !form.agentForwarding)}
            />

            {/* Startup Command */}
            <Input
              placeholder={t("hostDetails.startupCommand.placeholder")}
              value={form.startupCommand || ""}
              onChange={(e) => update("startupCommand", e.target.value || undefined)}
              className="h-10"
            />

            {/* Legacy Algorithms */}
            <ToggleRow
              label={t("hostDetails.legacyAlgorithms")}
              enabled={!!form.legacyAlgorithms}
              onToggle={() => update("legacyAlgorithms", !form.legacyAlgorithms)}
            />

            {/* Backspace behavior */}
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">{t("hostDetails.backspaceBehavior")}</p>
              <select
                className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                value={form.backspaceBehavior ?? ""}
                onChange={(e) => update("backspaceBehavior", e.target.value || undefined)}
              >
                <option value="">{t("hostDetails.backspaceBehavior.default")}</option>
                <option value="ctrl-h">^H (0x08)</option>
              </select>
            </div>

            {/* Proxy */}
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

            {/* Host Chaining */}
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

            {/* Environment Variables */}
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

            {/* Mosh */}
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
        )}

        {/* Telnet Section (if enabled) */}
        {telnetEnabled && (
          <Card className="p-3 space-y-3 bg-card border-border/80">
            <div className="flex items-center gap-2">
              <Globe size={14} className="text-muted-foreground" />
              <p className="text-xs font-semibold flex-1">
                {t("vault.groups.details.telnet")}
              </p>
              <Dropdown>
                <DropdownTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-6 w-6">
                    <MoreHorizontal size={14} />
                  </Button>
                </DropdownTrigger>
                <DropdownContent align="end" className="min-w-[160px]">
                  <button
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-destructive hover:bg-secondary rounded-md transition-colors"
                    onClick={removeTelnet}
                  >
                    <Trash2 size={14} />
                    {t("vault.groups.details.removeProtocol")}
                  </button>
                </DropdownContent>
              </Dropdown>
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
              placeholder={t("hostDetails.username.placeholder")}
              value={form.telnetUsername || ""}
              onChange={(e) => update("telnetUsername", e.target.value || undefined)}
              className="h-10"
            />
            <div className="relative">
              <Input
                placeholder={t("hostDetails.password.placeholder")}
                type={showTelnetPassword ? "text" : "password"}
                value={form.telnetPassword || ""}
                onChange={(e) => update("telnetPassword", e.target.value || undefined)}
                className="h-10 pr-10"
              />
              <button
                type="button"
                onClick={() => setShowTelnetPassword(!showTelnetPassword)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
              >
                {showTelnetPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </Card>
        )}

        {/* Charset & Appearance — only when at least one protocol is added */}
        {(sshEnabled || telnetEnabled) && (<>
        <Card className="p-3 space-y-3 bg-card border-border/80">
          <div className="flex items-center gap-2">
            <Globe size={14} className="text-muted-foreground" />
            <p className="text-xs font-semibold">
              {t("vault.groups.details.advanced")}
            </p>
          </div>
          <Input
            placeholder="UTF-8"
            value={form.charset || ""}
            onChange={(e) => update("charset", e.target.value || undefined)}
            className="h-10"
          />
        </Card>

        {/* Appearance Section */}
        <Card className="p-3 space-y-3 bg-card border-border/80">
          <div className="flex items-center gap-2">
            <Palette size={14} className="text-muted-foreground" />
            <p className="text-xs font-semibold">
              {t("vault.groups.details.appearance")}
            </p>
          </div>

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
                  themeOverride: false,
                }))
              }
            >
              {t("common.useGlobal")}
            </Button>
          )}

          <TerminalFontSelect
            value={form.fontFamily || availableFonts[0]?.id || ""}
            fonts={availableFonts}
            onChange={(id) => {
              setForm((prev) => ({
                ...prev,
                fontFamily: id,
                fontFamilyOverride: true,
              }));
            }}
            className="w-full"
          />
          {form.fontFamilyOverride && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start text-primary"
              onClick={() =>
                setForm((prev) => ({
                  ...prev,
                  fontFamily: undefined,
                  fontFamilyOverride: false,
                }))
              }
            >
              {t("common.useGlobal")}
            </Button>
          )}

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
        </>)}

        {/* Add Protocol Button — always at the bottom */}
        {addableProtocols.length > 0 && (
          <Dropdown open={addProtocolOpen} onOpenChange={setAddProtocolOpen}>
            <DropdownTrigger asChild>
              <Button
                variant="outline"
                className="w-full gap-2 h-10 border-dashed"
              >
                <Plus size={14} />
                {t("vault.groups.details.addProtocol")}
              </Button>
            </DropdownTrigger>
            <DropdownContent align="center" className="min-w-[160px]">
              {addableProtocols.map(({ key, label }) => (
                <button
                  key={key}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-secondary rounded-md transition-colors"
                  onClick={() => {
                    if (key === "ssh") setSshEnabled(true);
                    if (key === "telnet") setTelnetEnabled(true);
                    setAddProtocolOpen(false);
                  }}
                >
                  {label}
                </button>
              ))}
            </DropdownContent>
          </Dropdown>
        )}
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
