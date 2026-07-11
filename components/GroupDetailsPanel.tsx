import {
  AlertTriangle,
  Check,
  Eye,
  EyeOff,
  Globe,
  MoreHorizontal,
  Palette,
  Plus,
  Router,
  Settings2,
  Trash2,
} from "lucide-react";
import React, { useCallback, useMemo, useState } from "react";
import { useI18n } from "../application/i18n/I18nProvider";
import { customThemeStore } from "../application/state/customThemeStore";
import {
  hasManualGroupSshCredentials,
  hasManualGroupTelnetCredentials,
  resolveGroupDefaults,
  resolveGroupTerminalThemeId,
} from "../domain/groupConfig";
import {
  formatProxyConfigEndpoint,
  formatProxyConfigType,
  updateProxyConfigField,
} from "../domain/proxyProfiles";
import {
  EnvVar,
  GroupConfig,
  Host,
  Identity,
  ProxyConfig,
  ProxyProfile,
  SSHKey,
} from "../types";
import ThemeSelectPanel from "./ThemeSelectPanel";
import {
  ChainPanel,
  EnvVarsPanel,
  HostDetailsSection,
  HostDetailsSettingRow,
  HostDetailsOverrideReset,
  ProxyPanel,
} from "./host-details";
import {
  AsidePanel,
  AsidePanelContent,
  type AsidePanelLayout,
  type AsidePanelResizeProps,
} from "./ui/aside-panel";
import { Button } from "./ui/button";
import { Combobox } from "./ui/combobox";
import { Dropdown, DropdownContent, DropdownTrigger } from "./ui/dropdown";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import { TerminalFontSelect } from "./settings/TerminalFontSelect";
import { useAvailableFonts } from "../application/state/fontStore";
import { toast } from "./ui/toast";
import { GroupSshSettingsSection } from "./GroupSshSettingsSection";
import { prepareProxyConfigForSave } from "./HostDetailsPanel.helpers";
import { TerminalEncodingSelect } from "./TerminalEncodingSelect";

type SubPanel = "none" | "proxy" | "chain" | "env-vars" | "theme-select";

const ToggleRow: React.FC<{ label: string; hint?: React.ReactNode; enabled: boolean; onToggle: () => void }> = ({ label, hint, enabled, onToggle }) => {
  return (
    <HostDetailsSettingRow label={label} hint={hint}>
      <Switch checked={enabled} onCheckedChange={() => onToggle()} />
    </HostDetailsSettingRow>
  );
};

interface GroupDetailsPanelProps {
  groupPath: string;
  config: GroupConfig | undefined;
  availableKeys: SSHKey[];
  identities: Identity[];
  proxyProfiles?: ProxyProfile[];
  allHosts: Host[];
  groups: string[];
  terminalThemeId: string;
  groupConfigs?: GroupConfig[];
  terminalFontSize: number;
  onSave: (config: GroupConfig, newName?: string, newParent?: string | null) => void;
  onCancel: () => void;
  layout?: AsidePanelLayout;
}

type GroupDetailsPanelPropsWithResize = GroupDetailsPanelProps & AsidePanelResizeProps;

export const hasGroupTelnetFields = (c: Partial<GroupConfig>): boolean =>
  c.telnetPort !== undefined ||
  c.telnetIdentityId !== undefined ||
  c.telnetUsername !== undefined ||
  c.telnetPassword !== undefined ||
  c.telnetEnabled === true;

export const hasGroupSshFields = (c: Partial<GroupConfig>): boolean =>
  c.protocol === 'ssh' ||
  c.port !== undefined || !!c.username || !!c.password || !!c.identityFileId ||
  c.deviceType !== undefined ||
  c.agentForwarding !== undefined || c.authMethod !== undefined || c.identityId !== undefined ||
  !!c.proxyProfileId || !!c.proxyConfig || !!c.hostChain || !!c.startupCommand || c.startupCommandRunMode !== undefined || c.legacyAlgorithms !== undefined || c.skipEcdsaHostKey !== undefined || c.algorithms !== undefined || c.backspaceBehavior !== undefined ||
  Boolean(c.environmentVariables && c.environmentVariables.length > 0) ||
  c.moshEnabled !== undefined || !!c.moshServerPath ||
  c.etEnabled !== undefined || c.etPort !== undefined ||
  Boolean(c.identityFilePaths && c.identityFilePaths.length > 0);

export const selectGroupSshIdentity = (
  form: Partial<GroupConfig>,
  identity: Identity | undefined,
  identityId = identity?.id || "",
  inheritedIdentityId?: string,
): Partial<GroupConfig> => {
  if (!identityId) {
    return {
      ...form,
      identityId: inheritedIdentityId ? "" : undefined,
      username: undefined,
      authMethod: undefined,
    };
  }
  if (!identity) return { ...form, identityId };
  return {
    ...form,
    identityId,
    username: identity.username,
    authMethod: identity.authMethod,
    password: undefined,
    savePassword: undefined,
    identityFileId: undefined,
    identityFilePaths: undefined,
  };
};

export const selectGroupTelnetIdentity = (
  form: Partial<GroupConfig>,
  identityId: string,
  inheritedIdentityId?: string,
): Partial<GroupConfig> => ({
  ...form,
  telnetIdentityId: identityId || (inheritedIdentityId ? "" : undefined),
  ...(identityId ? { telnetUsername: undefined, telnetPassword: undefined } : {}),
});

export const includeMissingIdentityOption = (
  options: Array<{ value: string; label: string; sublabel?: string }>,
  identityId: string | undefined,
  missingLabel: string,
): Array<{ value: string; label: string; sublabel?: string }> => {
  if (!identityId || options.some((option) => option.value === identityId)) return options;
  return [{ value: identityId, label: missingLabel }, ...options];
};

export const resolveGroupFormIdentityId = (
  form: Partial<GroupConfig>,
  inheritedIdentityId: string | undefined,
  protocol: "ssh" | "telnet",
): string | undefined => {
  const formIdentityId = protocol === "ssh" ? form.identityId : form.telnetIdentityId;
  if (formIdentityId !== undefined) return formIdentityId;
  const hasManualCredentials = protocol === "ssh"
    ? hasManualGroupSshCredentials(form)
    : hasManualGroupTelnetCredentials(form);
  return hasManualCredentials ? undefined : inheritedIdentityId;
};

const GroupDetailsPanel: React.FC<GroupDetailsPanelPropsWithResize> = ({
  groupPath,
  config,
  availableKeys,
  identities,
  proxyProfiles = [],
  allHosts,
  groups,
  terminalThemeId,
  groupConfigs = [],
  terminalFontSize,
  onSave,
  onCancel,
  layout = "overlay",
  resizable,
  persistWidthStorageKey,
  resizeAriaLabel,
}) => {
  const { t } = useI18n();
  const asideResizeProps = {
    resizable,
    persistWidthStorageKey,
    resizeAriaLabel,
  };
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
  const [sshEnabled, setSshEnabled] = useState(() => hasGroupSshFields(config || {}));
  const [telnetEnabled, setTelnetEnabled] = useState(() => hasGroupTelnetFields(config || {}));

  // Sub-panel state
  const [activeSubPanel, setActiveSubPanel] = useState<SubPanel>("none");

  // Password visibility state
  const [showPassword, setShowPassword] = useState(false);
  const [showTelnetPassword, setShowTelnetPassword] = useState(false);
  const [showAlgorithmOverrides, setShowAlgorithmOverrides] = useState(false);
  const [addProtocolOpen, setAddProtocolOpen] = useState(false);

  // Credential selection state
  const [credentialPopoverOpen, setCredentialPopoverOpen] = useState(false);
  const [selectedCredentialType, setSelectedCredentialType] =
    useState<'key' | 'certificate' | 'localKeyFile' | null>(null);
  const [newKeyFilePath, setNewKeyFilePath] = useState('');

  // Environment variables state
  const [newEnvName, setNewEnvName] = useState("");
  const [newEnvValue, setNewEnvValue] = useState("");
  const selectedProxyProfile = useMemo(
    () => proxyProfiles.find((profile) => profile.id === form.proxyProfileId),
    [form.proxyProfileId, proxyProfiles],
  );
  const hasMissingProxyProfile = Boolean(form.proxyProfileId && !selectedProxyProfile);
  const proxySummaryLabel = hasMissingProxyProfile
    ? t("hostDetails.proxyPanel.missingSaved")
    : selectedProxyProfile
      ? selectedProxyProfile.label
      : `${formatProxyConfigType(form.proxyConfig)} ${formatProxyConfigEndpoint(form.proxyConfig)}`;

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
      delete next.deviceType;
      delete next.agentForwarding;
      delete next.startupCommand;
      delete next.startupCommandRunMode;
      delete next.legacyAlgorithms;
      delete next.skipEcdsaHostKey;
      delete next.algorithms;
      delete next.backspaceBehavior;
      delete next.proxyProfileId;
      delete next.proxyConfig;
      delete next.hostChain;
      delete next.environmentVariables;
      delete next.protocol;
      delete next.moshEnabled;
      delete next.moshServerPath;
      delete next.etEnabled;
      delete next.etPort;
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
      delete next.telnetIdentityId;
      delete next.telnetUsername;
      delete next.telnetPassword;
      return next;
    });
  };

  // Proxy helpers
  const updateProxyConfig = useCallback(
    (field: keyof ProxyConfig, value: ProxyConfig[keyof ProxyConfig]) => {
      setForm((prev) => {
        const { proxyProfileId: _proxyProfileId, ...rest } = prev;
        return {
          ...rest,
          proxyConfig: updateProxyConfigField(prev.proxyConfig, field, value),
        };
      });
    },
    [],
  );

  const clearProxyConfig = useCallback(() => {
    setForm((prev) => {
      const { proxyConfig: _proxyConfig, proxyProfileId: _proxyProfileId, ...rest } = prev;
      return rest;
    });
  }, []);

  const selectProxyProfile = useCallback((profileId: string | undefined) => {
    setForm((prev) => {
      const { proxyConfig: _proxyConfig, proxyProfileId: _proxyProfileId, ...rest } = prev;
      if (!profileId) return rest;
      return { ...rest, proxyProfileId: profileId };
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

  const identityOptions = useMemo(
    () => identities.map((identity) => ({
      value: identity.id,
      label: identity.label,
      sublabel: identity.username,
    })),
    [identities],
  );

  const inheritedConnectionDefaults = useMemo(() => {
    if (!parentGroup || groupConfigs.length === 0) return {};
    return resolveGroupDefaults(parentGroup, groupConfigs);
  }, [groupConfigs, parentGroup]);
  const effectiveSshIdentityId = resolveGroupFormIdentityId(
    form,
    inheritedConnectionDefaults.identityId,
    "ssh",
  );
  const effectiveTelnetIdentityId = resolveGroupFormIdentityId(
    form,
    inheritedConnectionDefaults.telnetIdentityId,
    "telnet",
  );
  const sshIdentityOptions = useMemo(
    () => includeMissingIdentityOption(
      identityOptions,
      effectiveSshIdentityId,
      t("hostDetails.identity.missing"),
    ),
    [effectiveSshIdentityId, identityOptions, t],
  );
  const telnetIdentityOptions = useMemo(
    () => includeMissingIdentityOption(
      identityOptions,
      effectiveTelnetIdentityId,
      t("hostDetails.identity.missing"),
    ),
    [effectiveTelnetIdentityId, identityOptions, t],
  );

  const updateSshIdentity = useCallback((identityId: string) => {
    setForm((prev) => selectGroupSshIdentity(
      prev,
      identities.find((item) => item.id === identityId),
      identityId,
      inheritedConnectionDefaults.identityId,
    ));
    setSelectedCredentialType(null);
    setCredentialPopoverOpen(false);
  }, [identities, inheritedConnectionDefaults.identityId]);

  const updateTelnetIdentity = useCallback((identityId: string) => {
    setForm((prev) => selectGroupTelnetIdentity(
      prev,
      identityId,
      inheritedConnectionDefaults.telnetIdentityId,
    ));
  }, [inheritedConnectionDefaults.telnetIdentityId]);

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
  const inheritedThemeId = useMemo(() => {
    if (!parentGroup || groupConfigs.length === 0) return terminalThemeId;
    return resolveGroupTerminalThemeId(resolveGroupDefaults(parentGroup, groupConfigs), terminalThemeId);
  }, [groupConfigs, parentGroup, terminalThemeId]);

  // Effective `legacyAlgorithms` for this group, considering inheritance
  // from the parent chain. Used by the algorithm-overrides editor so the
  // seed reflects what hosts in this group would actually advertise — if
  // the parent group already turned legacy mode on, the editor should
  // include legacy algorithms in its default list even when this group
  // itself hasn't set the flag.
  const inheritedLegacyAlgorithms = useMemo(() => {
    if (!parentGroup || groupConfigs.length === 0) return false;
    return !!resolveGroupDefaults(parentGroup, groupConfigs).legacyAlgorithms;
  }, [groupConfigs, parentGroup]);

  // Same idea for the algorithm-override lists themselves: surface what
  // this group would inherit from its parent so the editor can warn that
  // a local Reset falls back to the parent's lists, not NetCatty's
  // defaults.
  const inheritedAlgorithmOverrides = useMemo(() => {
    if (!parentGroup || groupConfigs.length === 0) return undefined;
    return resolveGroupDefaults(parentGroup, groupConfigs).algorithms;
  }, [groupConfigs, parentGroup]);

  // And for the per-flag toggles below — if the parent already turned
  // a flag on, the runtime applies it to hosts in this group via
  // `applyGroupDefaults`, so the local toggle must reflect that. Without
  // this, a child group would show the flag as off while connections
  // still negotiated with it.
  const inheritedSkipEcdsaHostKey = useMemo(() => {
    if (!parentGroup || groupConfigs.length === 0) return false;
    return !!resolveGroupDefaults(parentGroup, groupConfigs).skipEcdsaHostKey;
  }, [groupConfigs, parentGroup]);
  const inheritedStartupCommandRunMode = useMemo(() => {
    if (!parentGroup || groupConfigs.length === 0) return "paste";
    return resolveGroupDefaults(parentGroup, groupConfigs).startupCommandRunMode ?? "paste";
  }, [groupConfigs, parentGroup]);
  const inheritedDeviceType = useMemo(() => {
    if (!parentGroup || groupConfigs.length === 0) return undefined;
    return resolveGroupDefaults(parentGroup, groupConfigs).deviceType;
  }, [groupConfigs, parentGroup]);
  const effectiveDeviceType = form.deviceType ?? inheritedDeviceType;
  const effectiveThemeId = form.themeOverride === false
    ? inheritedThemeId
    : (form.theme || inheritedThemeId);
  const hasActiveThemeOverride = form.themeOverride === true || (form.theme != null && form.themeOverride !== false);

  // Save handler
  const handleSubmit = () => {
    const trimmedName = groupName.trim();
    if (!trimmedName) return;
    if (trimmedName.includes('/') || trimmedName.includes('\\')) {
      setNameError(t("vault.groups.errors.invalidChars"));
      return;
    }
    const proxySave = sshEnabled
      ? prepareProxyConfigForSave({
        proxyConfig: form.proxyConfig,
        proxyProfileId: form.proxyProfileId,
        proxyProfiles,
        identities,
      })
      : null;
    if (proxySave?.error) {
      const messageKey = proxySave.error === "port"
        ? "proxyProfiles.error.port"
        : proxySave.error === "required"
          ? "hostDetails.proxyPanel.error.required"
          : proxySave.error === "missingSaved"
            ? "hostDetails.proxyPanel.missingSaved"
            : proxySave.error === "missingIdentity"
              ? "hostDetails.proxyPanel.missingIdentity"
              : proxySave.error === "incompleteIdentity"
                ? "hostDetails.proxyPanel.incompleteIdentity"
                : "hostDetails.proxyPanel.unreadableIdentity";
      toast.error(t(messageKey));
      setActiveSubPanel("proxy");
      return;
    }
    const normalizedProxyConfig = proxySave?.normalizedProxyConfig;
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
        ...(form.deviceType !== undefined && { deviceType: form.deviceType }),
        ...(form.agentForwarding !== undefined && { agentForwarding: form.agentForwarding }),
        ...(form.startupCommand !== undefined && { startupCommand: form.startupCommand }),
        ...(form.startupCommandRunMode !== undefined && { startupCommandRunMode: form.startupCommandRunMode }),
        ...(form.legacyAlgorithms !== undefined && { legacyAlgorithms: form.legacyAlgorithms }),
        ...(form.skipEcdsaHostKey !== undefined && { skipEcdsaHostKey: form.skipEcdsaHostKey }),
        ...(form.algorithms !== undefined && { algorithms: form.algorithms }),
        ...(form.backspaceBehavior !== undefined && { backspaceBehavior: form.backspaceBehavior }),
        ...(form.proxyProfileId !== undefined && { proxyProfileId: form.proxyProfileId }),
        ...(normalizedProxyConfig !== undefined && { proxyConfig: normalizedProxyConfig }),
        ...(form.hostChain !== undefined && { hostChain: form.hostChain }),
        ...(form.environmentVariables !== undefined && { environmentVariables: form.environmentVariables }),
        ...(form.moshEnabled !== undefined && { moshEnabled: form.moshEnabled }),
        ...(form.moshServerPath !== undefined && { moshServerPath: form.moshServerPath }),
        ...(form.etEnabled !== undefined && { etEnabled: form.etEnabled }),
        ...(form.etPort !== undefined && { etPort: form.etPort }),
      }),
      // Only include Telnet fields if Telnet section is enabled
      ...(telnetEnabled && {
        telnetEnabled: true,
        ...(form.telnetPort !== undefined && { telnetPort: form.telnetPort }),
        ...(form.telnetIdentityId !== undefined && { telnetIdentityId: form.telnetIdentityId }),
        ...(form.telnetUsername !== undefined && { telnetUsername: form.telnetUsername }),
        ...(form.telnetPassword !== undefined && { telnetPassword: form.telnetPassword }),
      }),
      // Shared fields (always saved)
      ...(form.charset !== undefined && { charset: form.charset }),
      ...((form.themeOverride !== false && form.theme !== undefined) && { theme: form.theme }),
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
        proxyProfiles={proxyProfiles}
        identities={identities}
        selectedProxyProfileId={form.proxyProfileId}
        onUpdateProxy={updateProxyConfig}
        onSelectProxyProfile={selectProxyProfile}
        onClearProxy={clearProxyConfig}
        onBack={() => setActiveSubPanel("none")}
        onCancel={onCancel}
        layout={layout}
        {...asideResizeProps}
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
        {...asideResizeProps}
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
        {...asideResizeProps}
      />
    );
  }

  if (activeSubPanel === "theme-select") {
    return (
      <ThemeSelectPanel
        open={true}
        selectedThemeId={effectiveThemeId}
        onSelect={(themeId) => {
          if (themeId === effectiveThemeId && !hasActiveThemeOverride) {
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
        {...asideResizeProps}
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
      {...asideResizeProps}
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
        <HostDetailsSection
          icon={<Settings2 size={14} className="text-muted-foreground" />}
          title={t("vault.groups.details.general")}
        >
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
        </HostDetailsSection>

        <GroupSshSettingsSection
          sshEnabled={sshEnabled}
          t={t}
          removeSsh={removeSsh}
          form={form}
          update={update}
          showPassword={showPassword}
          setShowPassword={setShowPassword}
          availableKeys={availableKeys}
          identities={identities}
          identityOptions={sshIdentityOptions}
          updateSshIdentity={updateSshIdentity}
          effectiveSshIdentityId={effectiveSshIdentityId}
          setSelectedCredentialType={setSelectedCredentialType}
          selectedCredentialType={selectedCredentialType}
          credentialPopoverOpen={credentialPopoverOpen}
          setCredentialPopoverOpen={setCredentialPopoverOpen}
          keysByCategory={keysByCategory}
          newKeyFilePath={newKeyFilePath}
          setNewKeyFilePath={setNewKeyFilePath}
          inheritedLegacyAlgorithms={inheritedLegacyAlgorithms}
          inheritedSkipEcdsaHostKey={inheritedSkipEcdsaHostKey}
          inheritedStartupCommandRunMode={inheritedStartupCommandRunMode}
          showAlgorithmOverrides={showAlgorithmOverrides}
          setShowAlgorithmOverrides={setShowAlgorithmOverrides}
          inheritedAlgorithmOverrides={inheritedAlgorithmOverrides}
          proxySummaryLabel={proxySummaryLabel}
          setActiveSubPanel={setActiveSubPanel}
          chainedHosts={chainedHosts}
        />

        {sshEnabled && (!form.protocol || form.protocol === "ssh") && !form.moshEnabled && !form.etEnabled && (
          <HostDetailsSection
            icon={<Router size={14} className="text-muted-foreground" />}
            title={t("hostDetails.section.deviceType")}
          >
            <ToggleRow
              label={t("hostDetails.deviceType")}
              hint={t("hostDetails.deviceType.desc")}
              enabled={effectiveDeviceType === "network"}
              onToggle={() => update("deviceType", effectiveDeviceType === "network" ? "general" : "network")}
            />
            {effectiveDeviceType === "network" && (
              <div className="flex items-start gap-2 p-2 rounded-md bg-yellow-500/10 border border-yellow-500/20">
                <AlertTriangle size={14} className="text-yellow-500 mt-0.5 flex-shrink-0" />
                <p className="text-xs text-yellow-600 dark:text-yellow-400 break-words">
                  {t("hostDetails.deviceType.warning")}
                </p>
              </div>
            )}
          </HostDetailsSection>
        )}

        {/* Telnet Section (if enabled) */}
        {telnetEnabled && (
          <HostDetailsSection
            icon={<Globe size={14} className="text-muted-foreground" />}
            title={t("vault.groups.details.telnet")}
            action={
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
            }
          >

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

            {(identities.length > 0 || effectiveTelnetIdentityId) && (
              <Combobox
                options={telnetIdentityOptions}
                value={effectiveTelnetIdentityId || ""}
                onValueChange={updateTelnetIdentity}
                placeholder={t("hostDetails.identity.suggestions")}
                emptyText={t("common.noResultsFound")}
                className="w-full"
              />
            )}
            {!effectiveTelnetIdentityId && (<>
              <Input
                placeholder={t("hostDetails.username.placeholder")}
                value={form.telnetUsername || ""}
                onChange={(e) => update("telnetUsername", e.target.value)}
                className="h-10"
              />
              <div className="relative">
                <Input
                  placeholder={t("hostDetails.password.placeholder")}
                  type={showTelnetPassword ? "text" : "password"}
                  value={form.telnetPassword || ""}
                  onChange={(e) => update("telnetPassword", e.target.value)}
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
            </>)}
          </HostDetailsSection>
        )}

        {/* Charset & Appearance — only when at least one protocol is added */}
        {(sshEnabled || telnetEnabled) && (<>
        <HostDetailsSection
          icon={<Globe size={14} className="text-muted-foreground" />}
          title={t("vault.groups.details.advanced")}
        >
          <TerminalEncodingSelect
            value={form.charset}
            inheritedValue={inheritedConnectionDefaults.charset}
            onValueChange={(value) => update("charset", value)}
          />
        </HostDetailsSection>

        {/* Appearance Section */}
        <HostDetailsSection
          icon={<Palette size={14} className="text-muted-foreground" />}
          title={t("vault.groups.details.appearance")}
        >

          <div className="flex w-full items-center gap-1 rounded-lg bg-secondary/50 p-2 transition-colors hover:bg-secondary">
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-3 text-left"
              onClick={() => setActiveSubPanel("theme-select")}
            >
              <div
                className="w-12 h-8 rounded-md border border-border/60 flex items-center justify-center text-[6px] font-mono overflow-hidden shrink-0"
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
              <span className="text-sm flex-1 truncate">
                {customThemeStore.getThemeById(effectiveThemeId)?.name || "Flexoki Dark"}
              </span>
            </button>
            {hasActiveThemeOverride && (
              <HostDetailsOverrideReset
                label={t("common.useGlobal")}
                onClick={(event) => {
                  event.stopPropagation();
                  setForm((prev) => ({
                    ...prev,
                    theme: undefined,
                    themeOverride: false,
                  }));
                }}
              />
            )}
          </div>

          <div className="flex items-center gap-2">
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
              className="min-w-0 flex-1"
            />
            {form.fontFamilyOverride && (
              <HostDetailsOverrideReset
                label={t("common.useGlobal")}
                onClick={() =>
                  setForm((prev) => ({
                    ...prev,
                    fontFamily: undefined,
                    fontFamilyOverride: false,
                  }))
                }
              />
            )}
          </div>

          {/* Font Size */}
          <HostDetailsSettingRow label="Font Size">
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
              className="h-8 w-24 text-center"
            />
          </HostDetailsSettingRow>
        </HostDetailsSection>
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

export default GroupDetailsPanel;
