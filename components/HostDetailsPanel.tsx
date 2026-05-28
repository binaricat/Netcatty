import {
  Check,
  FolderPlus,
  Plus,
  Settings2,
  Tag,
  X,
} from "lucide-react";
import React, { useEffect, useMemo, useState, useCallback } from "react";
import { useI18n } from "../application/i18n/I18nProvider";
import { useApplicationBackend } from "../application/state/useApplicationBackend";
import { resolveGroupDefaults, resolveGroupTerminalThemeId } from "../domain/groupConfig";
import {
  getEffectiveHostDistro,
  normalizePrimaryTelnetState,
} from "../domain/host";
import { isCompleteProxyConfig, normalizeManualProxyConfig } from "../domain/proxyProfiles";
import { customThemeStore } from "../application/state/customThemeStore";
import {
  hasHostFontSizeOverride,
  hasHostThemeOverride,
  resolveHostTerminalFontSize,
  resolveHostTerminalThemeId,
} from "../domain/terminalAppearance";
import { EnvVar, GroupConfig, Host, Identity, ManagedSource, ProxyConfig, ProxyProfile, SSHKey } from "../types";
import { DISTRO_COLORS, DISTRO_LOGOS } from "./DistroAvatar";
import ThemeSelectPanel from "./ThemeSelectPanel";
import {
  AsidePanel,
  AsidePanelContent,
  AsidePanelFooter,
  type AsidePanelLayout,
} from "./ui/aside-panel";
import { HostDetailsAdvancedSections } from "./HostDetailsAdvancedSections";
import { HostDetailsConnectionSections } from "./HostDetailsConnectionSections";
import { LINUX_DISTRO_OPTION_IDS, parseOptionalPortInput, resolveDetailsTelnetPassword, resolveDetailsTelnetPort, resolveDetailsTelnetUsername } from "./HostDetailsPanel.helpers";
export { parseOptionalPortInput } from "./HostDetailsPanel.helpers";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Combobox, ComboboxOption, MultiCombobox } from "./ui/combobox";
import { Input } from "./ui/input";
import { toast } from "./ui/toast";

import {
  ChainPanel,
  CreateGroupPanel,
  EnvVarsPanel,
  ProxyPanel,
} from "./host-details";

type CredentialType = "sshid" | "key" | "certificate" | "localKeyFile" | null;
type SubPanel =
  | "none"
  | "create-group"
  | "proxy"
  | "chain"
  | "env-vars"
  | "theme-select"
  | "telnet-theme-select";

interface HostDetailsPanelProps {
  initialData?: Host | null;
  availableKeys: SSHKey[];
  identities: Identity[];
  proxyProfiles?: ProxyProfile[];
  groups: string[];
  managedSources?: ManagedSource[];
  allTags?: string[]; // All available tags for autocomplete
  allHosts?: Host[]; // All hosts for chain selection
  defaultGroup?: string | null; // Default group for new hosts (from current navigation)
  terminalThemeId: string;
  terminalFontSize: number;
  onSave: (host: Host) => void;
  onCancel: () => void;
  onCreateGroup?: (groupPath: string) => void; // Callback to create a new group
  onCreateTag?: (tag: string) => void; // Callback to create a new tag
  groupDefaults?: Partial<import('../domain/models').GroupConfig>;
  groupConfigs?: GroupConfig[];
  layout?: AsidePanelLayout;
  onImportKey?: (draft: Partial<SSHKey>) => SSHKey;
}

const HostDetailsPanel: React.FC<HostDetailsPanelProps> = ({
  initialData,
  availableKeys,
  identities,
  proxyProfiles = [],
  groups,
  managedSources = [],
  allTags = [],
  allHosts = [],
  defaultGroup,
  terminalThemeId,
  terminalFontSize,
  onSave,
  onCancel,
  onCreateGroup,
  onCreateTag,
  groupDefaults,
  groupConfigs = [],
  layout = "overlay",
  onImportKey,
}) => {
  const { t } = useI18n();
  const { checkSshAgent } = useApplicationBackend();
  const [form, setForm] = useState<Host>(
    () =>
      (initialData ? normalizePrimaryTelnetState(initialData) : null) ||
      ({
        id: crypto.randomUUID(),
        label: "",
        hostname: "",
        port: groupDefaults?.port ? undefined : 22,
        username: groupDefaults?.username ? "" : "root",
        protocol: "ssh",
        tags: [],
        os: "linux",
        authMethod: "password",
        charset: groupDefaults?.charset ? undefined : "UTF-8",
        distroMode: "auto",
        createdAt: Date.now(),
        group: defaultGroup || undefined, // Pre-fill with current navigation group
      } as Host),
  );

  const [activeSubPanel, setActiveSubPanel] = useState<SubPanel>("none");

  const [credentialPopoverOpen, setCredentialPopoverOpen] = useState(false);
  const [selectedCredentialType, setSelectedCredentialType] =
    useState<CredentialType>(null);

  const [identitySuggestionsOpen, setIdentitySuggestionsOpen] = useState(false);

  const [showPassword, setShowPassword] = useState(false);
  const [showAlgorithmOverrides, setShowAlgorithmOverrides] = useState(false);

  const [newKeyFilePath, setNewKeyFilePath] = useState("");
  const [pendingReferenceKeyPath, setPendingReferenceKeyPath] = useState<string | null>(null);

  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupParent, setNewGroupParent] = useState("");

  const [sshAgentStatus, setSshAgentStatus] = useState<{
    running: boolean;
    startupType: string | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    if (form.agentForwarding) {
      checkSshAgent().then(setSshAgentStatus);
    } else {
      setSshAgentStatus(null);
    }
  }, [form.agentForwarding, checkSshAgent]);

  const [groupInputValue, setGroupInputValue] = useState(form.group || "");

  useEffect(() => {
    if (initialData) {
      setForm(normalizePrimaryTelnetState(initialData));
      setGroupInputValue(initialData.group || "");
      setPendingReferenceKeyPath(null);
      setShowPassword(false);
    }
  }, [initialData]);

  const update = <K extends keyof Host>(key: K, value: Host[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const addLocalKeyFilePath = useCallback((path: string) => {
    const trimmed = path.trim();
    if (!trimmed) return;
    setForm((prev) => ({
      ...prev,
      identityFilePaths: onImportKey ? [trimmed] : [...(prev.identityFilePaths || []), trimmed],
      identityFileId: undefined,
      authMethod: "key",
    }));
    setPendingReferenceKeyPath(onImportKey ? trimmed : null);
    setNewKeyFilePath("");
    setSelectedCredentialType(null);
  }, [onImportKey]);

  const effectiveGroupDefaults = useMemo(() => {
    const currentGroupPath = form.group || defaultGroup;
    if (currentGroupPath && groupConfigs.length > 0) {
      return resolveGroupDefaults(currentGroupPath, groupConfigs);
    }
    return groupDefaults;
  }, [defaultGroup, form.group, groupConfigs, groupDefaults]);

  const effectiveThemeId = useMemo(
    () => resolveHostTerminalThemeId(form, resolveGroupTerminalThemeId(effectiveGroupDefaults, terminalThemeId)),
    [effectiveGroupDefaults, form, terminalThemeId],
  );
  const effectiveFontSize = useMemo(
    () => resolveHostTerminalFontSize(form, terminalFontSize),
    [form, terminalFontSize],
  );
  const hasEffectiveThemeOverride = useMemo(
    () => hasHostThemeOverride(form),
    [form],
  );
  const hasEffectiveFontSizeOverride = useMemo(
    () => hasHostFontSizeOverride(form),
    [form],
  );
  const effectiveTelnetThemeId =
    form.protocols?.find((p) => p.protocol === "telnet")?.theme || effectiveThemeId;
  const effectiveTelnetPort = resolveDetailsTelnetPort(form, effectiveGroupDefaults);
  const effectiveTelnetUsername = resolveDetailsTelnetUsername(form, effectiveGroupDefaults);
  const effectiveTelnetPassword = resolveDetailsTelnetPassword(form, effectiveGroupDefaults);
  const distroOptions = useMemo(
    () =>
      LINUX_DISTRO_OPTION_IDS.map((value) => ({
        value,
        label: t(`hostDetails.distro.option.${value}`),
        icon: DISTRO_LOGOS[value],
        bgClass: DISTRO_COLORS[value] || DISTRO_COLORS.default,
      })),
    [t],
  );

  const getDistroOptionLabel = useCallback(
    (value?: string) =>
      distroOptions.find((option) => option.value === value)?.label ||
      value ||
      t("hostDetails.distro.pending"),
    [distroOptions, t],
  );

  const effectiveFormDistro = getEffectiveHostDistro(form);
  const selectedProxyProfile = useMemo(
    () => proxyProfiles.find((profile) => profile.id === form.proxyProfileId),
    [form.proxyProfileId, proxyProfiles],
  );
  const hasMissingProxyProfile = Boolean(form.proxyProfileId && !selectedProxyProfile);
  const proxySummaryType = hasMissingProxyProfile
    ? t("hostDetails.proxyPanel.missing")
    : (selectedProxyProfile?.config.type || form.proxyConfig?.type || "http").toUpperCase();
  const proxySummaryLabel = hasMissingProxyProfile
    ? t("hostDetails.proxyPanel.missingSaved")
    : selectedProxyProfile
      ? selectedProxyProfile.label
      : `${form.proxyConfig?.host}:${form.proxyConfig?.port}`;
  const proxySummaryTooltip = hasMissingProxyProfile
    ? t("hostDetails.proxyPanel.missingSaved")
    : selectedProxyProfile
      ? `${selectedProxyProfile.label} - ${selectedProxyProfile.config.host}:${selectedProxyProfile.config.port}`
      : `${form.proxyConfig?.type?.toUpperCase()} ${form.proxyConfig?.host}:${form.proxyConfig?.port}`;

  const handleDistroModeChange = useCallback((mode: "auto" | "manual") => {
    setForm((prev) => ({
      ...prev,
      distroMode: mode,
      manualDistro:
        mode === "manual"
          ? prev.manualDistro || getEffectiveHostDistro(prev) || "linux"
          : prev.manualDistro,
    }));
  }, []);

  const updateProxyConfig = useCallback(
    (field: keyof ProxyConfig, value: string | number) => {
      setForm((prev) => {
        const { proxyProfileId: _proxyProfileId, ...rest } = prev;
        return {
          ...rest,
          proxyConfig: {
            type: prev.proxyConfig?.type || "http",
            host: prev.proxyConfig?.host || "",
            port: prev.proxyConfig?.port || 8080,
            ...prev.proxyConfig,
            [field]: value,
          },
        } as Host;
      });
    },
    [],
  );

  const clearProxyConfig = useCallback(() => {
    setForm((prev) => {
      const { proxyConfig: _proxyConfig, proxyProfileId: _proxyProfileId, ...rest } = prev;
      return rest as Host;
    });
  }, []);

  const selectProxyProfile = useCallback((profileId: string | undefined) => {
    setForm((prev) => {
      const { proxyConfig: _proxyConfig, proxyProfileId: _proxyProfileId, ...rest } = prev;
      if (!profileId) return rest as Host;
      return { ...rest, proxyProfileId: profileId } as Host;
    });
  }, []);

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
      return rest as Host;
    });
  }, []);

  const [newEnvName, setNewEnvName] = useState("");
  const [newEnvValue, setNewEnvValue] = useState("");

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
    setForm((prev) => {
      const filtered = (prev.environmentVariables || []).filter((_, i) => i !== index);
      return { ...prev, environmentVariables: filtered.length > 0 ? filtered : undefined };
    });
  };

  const handleSubmit = () => {
    if (!form.hostname) return;
    const normalizedProxyConfig = normalizeManualProxyConfig(form.proxyConfig);
    if (normalizedProxyConfig && !isCompleteProxyConfig(normalizedProxyConfig)) {
      toast.error(
        normalizedProxyConfig.host ? t("proxyProfiles.error.port") : t("hostDetails.proxyPanel.error.required"),
      );
      setActiveSubPanel("proxy");
      return;
    }
    if (hasMissingProxyProfile) {
      toast.error(t("hostDetails.proxyPanel.missingSaved"));
      setActiveSubPanel("proxy");
      return;
    }
    let finalLabel = form.label?.trim() || form.hostname;
    const finalGroup = groupInputValue.trim() || form.group || "";

    const targetManagedSource = managedSources
      .filter(s => finalGroup === s.groupName || finalGroup.startsWith(s.groupName + "/"))
      .sort((a, b) => b.groupName.length - a.groupName.length)[0];

    const canBeManaged = !form.protocol || form.protocol === "ssh";

    if (targetManagedSource && canBeManaged) {
      finalLabel = finalLabel.replace(/\s/g, '');
    }

    let finalManagedSourceId: string | undefined;
    if (targetManagedSource && canBeManaged) {
      finalManagedSourceId = targetManagedSource.id;
    } else if (managedSources.length === 0 && form.managedSourceId && canBeManaged) {
      finalManagedSourceId = form.managedSourceId;
    } else {
      finalManagedSourceId = undefined;
    }

    const { proxyConfig: _draftProxyConfig, ...formWithoutProxyDraft } = form;
    const finalPort =
      form.protocol === "telnet"
        ? form.port
        : form.port ?? (groupDefaults?.port ? undefined : 22);
    let cleaned: Host = {
      ...formWithoutProxyDraft,
      ...(normalizedProxyConfig && { proxyConfig: normalizedProxyConfig }),
      label: finalLabel,
      group: finalGroup,
      tags: form.tags || [],
      port: finalPort,
      password: form.savePassword === false ? undefined : form.password,
      managedSourceId: finalManagedSourceId,
    };
    cleaned = normalizePrimaryTelnetState(cleaned);
    if (
      onImportKey &&
      pendingReferenceKeyPath &&
      cleaned.identityFilePaths?.includes(pendingReferenceKeyPath)
    ) {
      const fileName = pendingReferenceKeyPath.split('/').pop() || pendingReferenceKeyPath;
      const key = onImportKey({
        source: 'reference',
        filePath: pendingReferenceKeyPath,
        label: fileName,
        privateKey: '',
        category: 'key',
      });
      cleaned = {
        ...cleaned,
        identityFileId: key.id,
        identityFilePaths: [pendingReferenceKeyPath],
        authMethod: "key",
      };
    }
    const preserveLegacyTheme = initialData?.theme != null && cleaned.themeOverride !== false;
    const preserveLegacyFontFamily = initialData?.fontFamily != null && cleaned.fontFamilyOverride !== false;
    const preserveLegacyFontSize = initialData?.fontSize != null && cleaned.fontSizeOverride !== false;

    if (cleaned.themeOverride === false) {
      delete cleaned.theme;
    } else if (preserveLegacyTheme && cleaned.theme == null) {
      cleaned.theme = initialData?.theme;
    }

    if (cleaned.fontFamilyOverride === false) {
      delete cleaned.fontFamily;
    } else if (preserveLegacyFontFamily && cleaned.fontFamily == null) {
      cleaned.fontFamily = initialData?.fontFamily;
    }

    if (cleaned.fontSizeOverride === false) {
      delete cleaned.fontSize;
    } else if (preserveLegacyFontSize && cleaned.fontSize == null) {
      cleaned.fontSize = initialData?.fontSize;
    }

    if ((cleaned.protocol && cleaned.protocol !== "ssh") || cleaned.moshEnabled) {
      delete cleaned.x11Forwarding;
    }
    onSave(cleaned);
  };

  const handleCreateGroup = () => {
    if (!newGroupName.trim()) return;
    const fullPath = newGroupParent
      ? `${newGroupParent}/${newGroupName.trim()}`
      : newGroupName.trim();
    onCreateGroup?.(fullPath);
    setGroupInputValue(fullPath);
    update("group", fullPath);
    setNewGroupName("");
    setNewGroupParent("");
    setActiveSubPanel("none");
  };

  const availableHostsForChain = useMemo(() => {
    const chainedIds = new Set(form.hostChain?.hostIds || []);
    return allHosts.filter((h) => h.id !== form.id && !chainedIds.has(h.id));
  }, [allHosts, form.id, form.hostChain?.hostIds]);

  const chainedHosts = useMemo(() => {
    const ids = form.hostChain?.hostIds || [];
    return ids
      .map((id) => allHosts.find((h) => h.id === id))
      .filter(Boolean) as Host[];
  }, [allHosts, form.hostChain?.hostIds]);

  const groupOptions: ComboboxOption[] = useMemo(() => {
    return groups.map((g) => ({
      value: g,
      label: g.includes("/") ? g.split("/").pop()! : g,
      sublabel: g.includes("/") ? g : undefined,
    }));
  }, [groups]);

  const tagOptions: ComboboxOption[] = useMemo(() => {
    const allTagSet = new Set([...allTags, ...(form.tags || [])]);
    return Array.from(allTagSet).map((t) => ({ value: t, label: t }));
  }, [allTags, form.tags]);

  const keysByCategory = useMemo(() => {
    return {
      key: availableKeys.filter((k) => k.category === "key"),
      certificate: availableKeys.filter((k) => k.category === "certificate"),
      identity: availableKeys.filter((k) => k.category === "identity"),
    };
  }, [availableKeys]);

  const selectedIdentity = useMemo(() => {
    if (!form.identityId) return undefined;
    return identities.find((i) => i.id === form.identityId);
  }, [form.identityId, identities]);

  const filteredIdentitySuggestions = useMemo(() => {
    if (selectedIdentity) return [];
    const q = (form.username || "").toLowerCase().trim();
    const base = identities;
    const filtered = q
      ? base.filter(
        (i) =>
          i.label.toLowerCase().includes(q) ||
          i.username.toLowerCase().includes(q),
      )
      : base;
    return filtered.slice(0, 6);
  }, [form.username, identities, selectedIdentity]);

  useEffect(() => {
    if (!identitySuggestionsOpen) return;
    if (filteredIdentitySuggestions.length === 0) {
      setIdentitySuggestionsOpen(false);
    }
  }, [filteredIdentitySuggestions.length, identitySuggestionsOpen]);

  const applyIdentity = useCallback(
    (identity: Identity) => {
      setForm((prev) => ({
        ...prev,
        identityId: identity.id,
        username: identity.username,
        authMethod: identity.authMethod,
        password: undefined,
        identityFileId: undefined,
        identityFilePaths: undefined,
      }));
      setPendingReferenceKeyPath(null);
      setSelectedCredentialType(null);
      setCredentialPopoverOpen(false);
      setIdentitySuggestionsOpen(false);
    },
    [],
  );

  const clearIdentity = useCallback(() => {
    setForm((prev) => ({ ...prev, identityId: undefined }));
    setIdentitySuggestionsOpen(false);
  }, []);

  if (activeSubPanel === "create-group") {
    return (
      <CreateGroupPanel
        newGroupName={newGroupName}
        setNewGroupName={setNewGroupName}
        newGroupParent={newGroupParent}
        setNewGroupParent={setNewGroupParent}
        groups={groups}
        onSave={handleCreateGroup}
        onBack={() => setActiveSubPanel("none")}
        onCancel={onCancel}
        layout={layout}
      />
    );
  }

  if (activeSubPanel === "proxy") {
    return (
      <ProxyPanel
        proxyConfig={form.proxyConfig}
        proxyProfiles={proxyProfiles}
        selectedProxyProfileId={form.proxyProfileId}
        onUpdateProxy={updateProxyConfig}
        onSelectProxyProfile={selectProxyProfile}
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
        formLabel={form.label}
        formHostname={form.hostname}
        form={form}
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
        hostLabel={form.label}
        hostHostname={form.hostname}
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
          if (themeId === effectiveThemeId && !hasEffectiveThemeOverride) {
            setActiveSubPanel("none");
            return;
          }
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

  if (activeSubPanel === "telnet-theme-select") {
    return (
      <ThemeSelectPanel
        open={true}
        selectedThemeId={effectiveTelnetThemeId}
        onSelect={(themeId) => {
          const telnetConfig = form.protocols?.find(
            (p) => p.protocol === "telnet",
          );
          if (telnetConfig) {
            const newProtocols = form.protocols?.map((p) =>
              p.protocol === "telnet" ? { ...p, theme: themeId } : p,
            );
            setForm((prev) => ({ ...prev, protocols: newProtocols }));
          } else {
            const newProtocols = [
              ...(form.protocols || []),
              {
                protocol: "telnet" as const,
                port: effectiveTelnetPort,
                enabled: true,
                theme: themeId,
              },
            ];
            setForm((prev) => ({ ...prev, protocols: newProtocols }));
          }
          setActiveSubPanel("none");
        }}
        onClose={onCancel}
        onBack={() => setActiveSubPanel("none")}
        showBackButton={true}
        layout={layout}
      />
    );
  }

  return (
    <AsidePanel
      open={true}
      onClose={onCancel}
      width="w-[420px]"
      layout={layout}
      dataSection="host-details-panel"
      title={
        initialData ? t("hostDetails.title.details") : t("hostDetails.title.new")
      }
      actions={
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={handleSubmit}
          disabled={!form.hostname}
          aria-label={t("hostDetails.saveAria")}
        >
          <Check size={16} />
        </Button>
      }
    >
      <AsidePanelContent>
        <Card className="p-3 space-y-3 bg-card border-border/80">
          <div className="flex items-center gap-2">
            <Settings2 size={14} className="text-muted-foreground" />
            <p className="text-xs font-semibold">
              {t("hostDetails.section.general")}
            </p>
          </div>
          <Input
            placeholder={t("hostDetails.label.placeholder")}
            value={form.label}
            onChange={(e) => {
              let value = e.target.value;
              const targetGroup = groupInputValue.trim() || form.group || "";
              const willBeManaged = managedSources.some(s =>
                targetGroup === s.groupName || targetGroup.startsWith(s.groupName + "/")
              );
              const canBeManaged = !form.protocol || form.protocol === "ssh";
              if (willBeManaged && canBeManaged) {
                value = value.replace(/\s/g, '');
              }
              update("label", value);
            }}
            className="h-10"
          />

          <div className="flex items-center gap-2">
            <div className="h-10 w-10 rounded-lg bg-secondary/80 flex items-center justify-center shrink-0">
              <FolderPlus size={16} className="text-muted-foreground" />
            </div>
            <Combobox
              options={groupOptions}
              value={form.group || ""}
              onValueChange={(val) => {
                update("group", val);
                setGroupInputValue(val);
              }}
              placeholder={t("hostDetails.group.placeholder")}
              allowCreate={true}
              onCreateNew={(val) => {
                onCreateGroup?.(val);
                update("group", val);
                setGroupInputValue(val);
              }}
              createText="Create Group"
              triggerClassName="flex-1 h-10"
            />
          </div>

          <div className="flex items-center gap-2">
            <div className="h-10 w-10 rounded-lg bg-secondary/80 flex items-center justify-center shrink-0">
              <Tag size={16} className="text-muted-foreground" />
            </div>
            <MultiCombobox
              options={tagOptions}
              values={form.tags || []}
              onValuesChange={(vals) => update("tags", vals)}
              placeholder="Add tags..."
              allowCreate={true}
              onCreateNew={(val) => onCreateTag?.(val)}
              createText="Create Tag"
              triggerClassName="flex-1 min-h-10"
            />
          </div>
        </Card>

        <HostDetailsConnectionSections
          t={t}
          form={form}
          update={update}
          groupDefaults={groupDefaults}
          selectedIdentity={selectedIdentity}
          clearIdentity={clearIdentity}
          identities={identities}
          identitySuggestionsOpen={identitySuggestionsOpen}
          filteredIdentitySuggestions={filteredIdentitySuggestions}
          setIdentitySuggestionsOpen={setIdentitySuggestionsOpen}
          availableKeys={availableKeys}
          applyIdentity={applyIdentity}
          showPassword={showPassword}
          setShowPassword={setShowPassword}
          pendingReferenceKeyPath={pendingReferenceKeyPath}
          setPendingReferenceKeyPath={setPendingReferenceKeyPath}
          selectedCredentialType={selectedCredentialType}
          setSelectedCredentialType={setSelectedCredentialType}
          credentialPopoverOpen={credentialPopoverOpen}
          setCredentialPopoverOpen={setCredentialPopoverOpen}
          keysByCategory={keysByCategory}
          newKeyFilePath={newKeyFilePath}
          setNewKeyFilePath={setNewKeyFilePath}
          addLocalKeyFilePath={addLocalKeyFilePath}
          handleDistroModeChange={handleDistroModeChange}
          distroOptions={distroOptions}
          effectiveFormDistro={effectiveFormDistro}
          getDistroOptionLabel={getDistroOptionLabel}
        />

        <HostDetailsAdvancedSections
          t={t}
          form={form}
          setForm={setForm}
          update={update}
          effectiveThemeId={effectiveThemeId}
          hasEffectiveThemeOverride={hasEffectiveThemeOverride}
          effectiveFontSize={effectiveFontSize}
          hasEffectiveFontSizeOverride={hasEffectiveFontSizeOverride}
          sshAgentStatus={sshAgentStatus}
          effectiveGroupDefaults={effectiveGroupDefaults}
          showAlgorithmOverrides={showAlgorithmOverrides}
          setShowAlgorithmOverrides={setShowAlgorithmOverrides}
          chainedHosts={chainedHosts}
          setActiveSubPanel={setActiveSubPanel}
          clearHostChain={clearHostChain}
          proxySummaryType={proxySummaryType}
          proxySummaryLabel={proxySummaryLabel}
          proxySummaryTooltip={proxySummaryTooltip}
          clearProxyConfig={clearProxyConfig}
          groupDefaults={groupDefaults}
        />

        <div className="flex items-center gap-3 py-2">
          <div className="flex-1 h-px bg-border/60" />
          <span className="text-xs text-muted-foreground">{t("hostDetails.otherProtocols")}</span>
          <div className="flex-1 h-px bg-border/60" />
        </div>

        {form.telnetEnabled || form.protocol === "telnet" ? (
          <Card className="p-3 space-y-3 bg-card border-border/80">
            <div className="flex items-center justify-between">
              <div className="flex-1 min-w-0 h-10 flex items-center gap-2 bg-secondary/70 border border-border/70 rounded-md px-3">
                <span className="text-xs text-muted-foreground">{t("hostDetails.telnetOn")}</span>
                <div className="ml-auto w-1/2 min-w-0 flex items-center gap-2 justify-end">
	                  <Input
	                    type="number"
	                    value={effectiveTelnetPort}
	                    onChange={(e) => update("telnetPort", parseOptionalPortInput(e.target.value))}
	                    className="h-8 flex-1 min-w-0 text-center"
	                  />
                  <span className="text-xs text-muted-foreground">{t("hostDetails.port")}</span>
                </div>
              </div>
              {form.protocol !== "telnet" && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                  onClick={() => update("telnetEnabled", false)}
                >
                  <X size={14} />
                </Button>
              )}
            </div>

            <p className="text-xs font-semibold">{t("hostDetails.telnet.credentials")}</p>
	            <Input
	              placeholder={t("hostDetails.telnet.username")}
	              value={effectiveTelnetUsername}
	              onChange={(e) =>
	                update("telnetUsername" as keyof Host, e.target.value)
	              }
              className="h-10"
            />
            <Input
	              placeholder={t("hostDetails.telnet.password")}
	              type="password"
	              value={effectiveTelnetPassword}
	              onChange={(e) =>
	                update("telnetPassword" as keyof Host, e.target.value)
              }
              className="h-10"
            />

            <Input
              placeholder={groupDefaults?.charset || t("hostDetails.charset.placeholder")}
              value={form.charset || "UTF-8"}
              onChange={(e) => update("charset", e.target.value)}
              className="h-10"
            />

            <button
              type="button"
              className="w-full flex items-center gap-3 p-2 rounded-lg bg-secondary/50 hover:bg-secondary transition-colors text-left"
              onClick={() => setActiveSubPanel("telnet-theme-select")}
            >
              <div
                className="w-12 h-8 rounded-md border border-border/60 flex items-center justify-center text-[6px] font-mono overflow-hidden"
                style={{
                  backgroundColor:
                    customThemeStore.getThemeById(effectiveTelnetThemeId)?.colors.background || "#100F0F",
                  color:
                    customThemeStore.getThemeById(effectiveTelnetThemeId)?.colors.foreground || "#CECDC3",
                }}
              >
                <div className="p-0.5">
                  <div
                    style={{
                      color: customThemeStore.getThemeById(effectiveTelnetThemeId)?.colors.green,
                    }}
                  >
                    $
                  </div>
                </div>
              </div>
              <span className="text-sm flex-1">
                {customThemeStore.getThemeById(effectiveTelnetThemeId)?.name || "Flexoki Dark"}
              </span>
            </button>
          </Card>
        ) : (
          <Button
            variant="ghost"
            className="w-full h-10 justify-start gap-2 border border-dashed border-border/60"
            onClick={() => {
              update("telnetEnabled", true);
            }}
          >
            <Plus size={14} />
            {t("hostDetails.telnet.add")}
          </Button>
        )}
      </AsidePanelContent>
      <AsidePanelFooter>
        <Button
          className="w-full h-10"
          onClick={handleSubmit}
          disabled={!form.hostname}
        >
          {t("common.save")}
        </Button>
      </AsidePanelFooter>
    </AsidePanel>
  );
};


export default HostDetailsPanel;
