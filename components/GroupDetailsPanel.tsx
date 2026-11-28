import { Check, FileText, FolderPlus, Settings2 } from "lucide-react";
import React, { useCallback, useMemo, useState } from "react";
import { useI18n } from "../application/i18n/I18nProvider";
import { useAvailableFonts } from "../application/state/fontStore";
import {
  hasManualGroupRdpCredentials,
  hasManualGroupSshCredentials,
  hasManualGroupTelnetCredentials,
  hasManualGroupVncCredentials,
  resolveGroupDefaults,
  resolveGroupTerminalThemeId,
} from "../domain/groupConfig";
import {
  formatProxyConfigEndpoint,
  formatProxyConfigType,
  updateProxyConfigField,
} from "../domain/proxyProfiles";
import {
  hasValidRdpFixedResolution,
  sanitizeRdpConfig,
  sanitizeVncConfig,
  type RdpResolutionDraft,
} from "../domain/remoteDesktop";
import { canServeAsSshJumpHost } from "../domain/terminalProtocol";
import {
  EnvVar,
  GroupConfig,
  Host,
  Identity,
  ProxyConfig,
  ProxyProfile,
  RdpConfig,
  SSHKey,
  VncConfig,
} from "../types";
import {
  GroupProtocolCredentialsSection,
  type GroupEditableProtocol,
  type GroupRemoteDesktopCredentialDraft,
} from "./GroupProtocolCredentialsSection";
import { GroupSshSettingsSection } from "./GroupSshSettingsSection";
import { mapProxySaveErrorKey, prepareProxyConfigForSave } from "./HostDetailsPanel.helpers";
import ThemeSelectPanel from "./ThemeSelectPanel";
import { HostNotesEditor } from "./host/HostNotesEditor";
import { ChainPanel, EnvVarsPanel, HostDetailsSection, ProxyPanel } from "./host-details";
import {
  AsidePanel,
  AsidePanelContent,
  AsidePanelFooter,
  type AsidePanelLayout,
  type AsidePanelResizeProps,
} from "./ui/aside-panel";
import { Button } from "./ui/button";
import { Combobox } from "./ui/combobox";
import { Input } from "./ui/input";
import { toast } from "./ui/toast";

type SubPanel = "none" | "proxy" | "chain" | "env-vars" | "theme-select";

interface GroupDetailsPanelProps {
  groupPath: string;
  config: GroupConfig | undefined;
  availableKeys: SSHKey[];
  identities: Identity[];
  onCreateIdentity?: (identity: Identity) => void;
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

export const hasGroupRdpFields = (c: Partial<GroupConfig>): boolean =>
  Boolean(c.rdpConfig && Object.keys(c.rdpConfig).length > 0);

export const hasGroupVncFields = (c: Partial<GroupConfig>): boolean =>
  Boolean(c.vncConfig && Object.keys(c.vncConfig).length > 0);

const hasExclusiveGroupSshFields = (c: Partial<GroupConfig>): boolean =>
  c.protocol === "ssh" ||
  c.port !== undefined ||
  !!c.username ||
  !!c.password ||
  !!c.identityFileId ||
  c.deviceType !== undefined ||
  c.agentForwarding !== undefined ||
  c.x11Forwarding !== undefined ||
  c.authMethod !== undefined ||
  c.identityId !== undefined ||
  c.legacyAlgorithms !== undefined ||
  c.skipEcdsaHostKey !== undefined ||
  c.algorithms !== undefined ||
  c.backspaceBehavior !== undefined ||
  Boolean(c.environmentVariables && c.environmentVariables.length > 0) ||
  c.moshEnabled !== undefined ||
  !!c.moshServerPath ||
  c.etEnabled !== undefined ||
  c.etPort !== undefined ||
  Boolean(c.identityFilePaths && c.identityFilePaths.length > 0);

export const hasGroupSshFields = (c: Partial<GroupConfig>): boolean => {
  if (hasExclusiveGroupSshFields(c)) return true;
  // Shared fields (proxy / jump chain / startup command) imply SSH only for
  // legacy groups that do not configure RDP, VNC, or Telnet.
  const hasOtherProtocol =
    hasGroupRdpFields(c) || hasGroupVncFields(c) || hasGroupTelnetFields(c);
  if (hasOtherProtocol) return false;
  return Boolean(
    c.proxyProfileId ||
      c.proxyConfig ||
      c.hostChain ||
      c.startupCommand ||
      c.startupCommandRunMode !== undefined,
  );
};

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

export const selectGroupRdpIdentity = (
  form: Partial<GroupConfig>,
  identity: Identity | undefined,
  identityId = identity?.id || "",
  inheritedIdentityId?: string,
): Partial<GroupConfig> => {
  const prev = form.rdpConfig ?? {};
  if (!identityId) {
    return {
      ...form,
      rdpConfig: {
        ...prev,
        enabled: true,
        identityId: inheritedIdentityId ? "" : undefined,
      },
    };
  }
  return {
    ...form,
    rdpConfig: {
      ...prev,
      enabled: true,
      useHostCredentials: false,
      identityId,
      username: undefined,
      ...(identity?.domain ? { domain: identity.domain } : {}),
    },
  };
};

export const selectGroupVncIdentity = (
  form: Partial<GroupConfig>,
  identity: Identity | undefined,
  identityId = identity?.id || "",
  inheritedIdentityId?: string,
): Partial<GroupConfig> => {
  const prev = form.vncConfig ?? {};
  if (!identityId) {
    return {
      ...form,
      vncConfig: {
        ...prev,
        enabled: true,
        identityId: inheritedIdentityId ? "" : undefined,
      },
    };
  }
  return {
    ...form,
    vncConfig: {
      ...prev,
      enabled: true,
      useHostCredentials: false,
      identityId,
      username: undefined,
    },
  };
};

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
  protocol: "ssh" | "telnet" | "rdp" | "vnc",
): string | undefined => {
  const formIdentityId =
    protocol === "ssh"
      ? form.identityId
      : protocol === "telnet"
        ? form.telnetIdentityId
        : protocol === "rdp"
          ? form.rdpConfig?.identityId
          : form.vncConfig?.identityId;
  if (formIdentityId !== undefined) return formIdentityId || undefined;
  const hasManualCredentials =
    protocol === "ssh"
      ? hasManualGroupSshCredentials(form)
      : protocol === "telnet"
        ? hasManualGroupTelnetCredentials(form)
        : protocol === "rdp"
          ? hasManualGroupRdpCredentials(form.rdpConfig)
          : hasManualGroupVncCredentials(form.vncConfig);
  return hasManualCredentials ? undefined : (inheritedIdentityId || undefined);
};

const getInitialProtocolTab = (config: Partial<GroupConfig>): GroupEditableProtocol => {
  if (hasGroupSshFields(config)) return "ssh";
  if (hasGroupRdpFields(config)) return "rdp";
  if (hasGroupVncFields(config)) return "vnc";
  if (hasGroupTelnetFields(config)) return "telnet";
  return "ssh";
};

const GroupDetailsPanel: React.FC<GroupDetailsPanelPropsWithResize> = ({
  groupPath,
  config,
  availableKeys,
  identities,
  onCreateIdentity,
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

  const [form, setForm] = useState<Partial<GroupConfig>>(() => config || {});
  const [groupName, setGroupName] = useState<string>(originalName);
  const [parentGroup, setParentGroup] = useState<string>(originalParent);
  const [nameError, setNameError] = useState<string | null>(null);

  // Protocol sections enabled state
  const [sshEnabled, setSshEnabled] = useState(() => hasGroupSshFields(config || {}));
  const [rdpEnabled, setRdpEnabled] = useState(() => hasGroupRdpFields(config || {}));
  const [vncEnabled, setVncEnabled] = useState(() => hasGroupVncFields(config || {}));
  const [telnetEnabled, setTelnetEnabled] = useState(() => hasGroupTelnetFields(config || {}));
  const [activeProtocolTab, setActiveProtocolTab] = useState<GroupEditableProtocol>(() =>
    getInitialProtocolTab(config || {}),
  );

  // Sub-panel state
  const [activeSubPanel, setActiveSubPanel] = useState<SubPanel>("none");

  // Password visibility state
  const [showPassword, setShowPassword] = useState(false);
  const [showTelnetPassword, setShowTelnetPassword] = useState(false);
  const [showAlgorithmOverrides, setShowAlgorithmOverrides] = useState(false);

  // Remote desktop drafts (manual password -> Keychain Identity on save; fixed resolution input)
  const [rdpResolutionDraft, setRdpResolutionDraft] = useState<RdpResolutionDraft>({});
  const [remoteDesktopCredentialDrafts, setRemoteDesktopCredentialDrafts] = useState<{
    rdp?: GroupRemoteDesktopCredentialDraft;
    vnc?: GroupRemoteDesktopCredentialDraft;
  }>({});

  // Credential selection state
  const [credentialPopoverOpen, setCredentialPopoverOpen] = useState(false);
  const [selectedCredentialType, setSelectedCredentialType] =
    useState<"key" | "certificate" | "localKeyFile" | null>(null);
  const [newKeyFilePath, setNewKeyFilePath] = useState("");

  // Environment variables state
  const [newEnvName, setNewEnvName] = useState("");
  const [newEnvValue, setNewEnvValue] = useState("");

  const enabledProtocols: Record<GroupEditableProtocol, boolean> = {
    ssh: sshEnabled,
    rdp: rdpEnabled,
    vnc: vncEnabled,
    telnet: telnetEnabled,
  };
  const isCurrentTabEnabled = enabledProtocols[activeProtocolTab];

  const selectedProxyProfile = useMemo(
    () => proxyProfiles.find((profile) => profile.id === form.proxyProfileId),
    [form.proxyProfileId, proxyProfiles],
  );
  const hasMissingProxyProfile = Boolean(form.proxyProfileId && !selectedProxyProfile);
  const hasProxyConfig = Boolean(
    form.proxyConfig?.host || form.proxyConfig?.command || form.proxyProfileId,
  );
  const proxySummaryType = hasMissingProxyProfile
    ? t("hostDetails.proxyPanel.missing")
    : formatProxyConfigType(selectedProxyProfile?.config || form.proxyConfig) || "HTTP";
  const proxySummaryLabel = hasMissingProxyProfile
    ? t("hostDetails.proxyPanel.missingSaved")
    : selectedProxyProfile
      ? selectedProxyProfile.label
      : formatProxyConfigEndpoint(form.proxyConfig);
  const proxySummaryTooltip = hasMissingProxyProfile
    ? t("hostDetails.proxyPanel.missingSaved")
    : selectedProxyProfile
      ? `${selectedProxyProfile.label} - ${formatProxyConfigEndpoint(selectedProxyProfile.config)}`
      : `${formatProxyConfigType(form.proxyConfig)} ${formatProxyConfigEndpoint(form.proxyConfig)}`;

  const update = <K extends keyof GroupConfig>(key: K, value: GroupConfig[K] | undefined) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const updateRdpConfig = useCallback((patch: Partial<RdpConfig>) => {
    setForm((prev) => ({
      ...prev,
      rdpConfig: {
        ...(prev.rdpConfig ?? {}),
        enabled: true,
        ...patch,
      },
    }));
  }, []);

  const updateVncConfig = useCallback((patch: Partial<VncConfig>) => {
    setForm((prev) => ({
      ...prev,
      vncConfig: {
        ...(prev.vncConfig ?? {}),
        enabled: true,
        ...patch,
      },
    }));
  }, []);

  const handleEnableProtocol = useCallback((protocol: GroupEditableProtocol) => {
    setActiveProtocolTab(protocol);
    if (protocol === "ssh") {
      setSshEnabled(true);
    } else if (protocol === "rdp") {
      setRdpEnabled(true);
      setForm((prev) => ({
        ...prev,
        rdpConfig: { ...(prev.rdpConfig ?? {}), enabled: true },
      }));
    } else if (protocol === "vnc") {
      setVncEnabled(true);
      setForm((prev) => ({
        ...prev,
        vncConfig: { ...(prev.vncConfig ?? {}), enabled: true },
      }));
    } else if (protocol === "telnet") {
      setTelnetEnabled(true);
    }
  }, []);

  const handleRemoveProtocol = useCallback(
    (protocol: GroupEditableProtocol) => {
      const remaining = {
        ssh: protocol === "ssh" ? false : sshEnabled,
        rdp: protocol === "rdp" ? false : rdpEnabled,
        vnc: protocol === "vnc" ? false : vncEnabled,
        telnet: protocol === "telnet" ? false : telnetEnabled,
      };
      const hasAnyRoutingProtocol = remaining.ssh || remaining.rdp || remaining.vnc;
      const hasAnyProtocol = hasAnyRoutingProtocol || remaining.telnet;

      if (protocol === "ssh") {
        setSshEnabled(false);
        setSelectedCredentialType(null);
        setNewKeyFilePath("");
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
          delete next.x11Forwarding;
          delete next.legacyAlgorithms;
          delete next.skipEcdsaHostKey;
          delete next.algorithms;
          delete next.backspaceBehavior;
          delete next.environmentVariables;
          delete next.protocol;
          delete next.moshEnabled;
          delete next.moshServerPath;
          delete next.etEnabled;
          delete next.etPort;
          if (!remaining.telnet) {
            delete next.startupCommand;
            delete next.startupCommandRunMode;
          }
          if (!hasAnyRoutingProtocol) {
            delete next.hostChain;
          }
          if (!hasAnyProtocol) {
            delete next.proxyProfileId;
            delete next.proxyConfig;
          }
          return next;
        });
      } else if (protocol === "rdp") {
        setRdpEnabled(false);
        setRdpResolutionDraft({});
        setRemoteDesktopCredentialDrafts((prev) => ({ ...prev, rdp: undefined }));
        setForm((prev) => {
          const next = { ...prev };
          delete next.rdpConfig;
          if (!hasAnyRoutingProtocol) {
            delete next.hostChain;
          }
          if (!hasAnyProtocol) {
            delete next.proxyProfileId;
            delete next.proxyConfig;
          }
          return next;
        });
      } else if (protocol === "vnc") {
        setVncEnabled(false);
        setRemoteDesktopCredentialDrafts((prev) => ({ ...prev, vnc: undefined }));
        setForm((prev) => {
          const next = { ...prev };
          delete next.vncConfig;
          if (!hasAnyRoutingProtocol) {
            delete next.hostChain;
          }
          if (!hasAnyProtocol) {
            delete next.proxyProfileId;
            delete next.proxyConfig;
          }
          return next;
        });
      } else if (protocol === "telnet") {
        setTelnetEnabled(false);
        setForm((prev) => {
          const next = { ...prev };
          delete next.telnetEnabled;
          delete next.telnetPort;
          delete next.telnetIdentityId;
          delete next.telnetUsername;
          delete next.telnetPassword;
          if (!remaining.ssh) {
            delete next.startupCommand;
            delete next.startupCommandRunMode;
          }
          if (!hasAnyProtocol) {
            delete next.proxyProfileId;
            delete next.proxyConfig;
          }
          return next;
        });
      }
    },
    [rdpEnabled, sshEnabled, telnetEnabled, vncEnabled],
  );

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
    return allHosts.filter((h) => !chainedIds.has(h.id) && canServeAsSshJumpHost(h));
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
      environmentVariables: (prev.environmentVariables || []).filter((_, i) => i !== index),
    }));
  };

  const keysByCategory = useMemo(
    () => ({
      key: availableKeys.filter((k) => k.category === "key"),
      certificate: availableKeys.filter((k) => k.category === "certificate"),
    }),
    [availableKeys],
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
  const effectiveRdpIdentityId = resolveGroupFormIdentityId(
    form,
    inheritedConnectionDefaults.rdpConfig?.identityId,
    "rdp",
  );
  const effectiveVncIdentityId = resolveGroupFormIdentityId(
    form,
    inheritedConnectionDefaults.vncConfig?.identityId,
    "vnc",
  );

  const updateSshIdentity = useCallback(
    (identityId: string) => {
      setForm((prev) =>
        selectGroupSshIdentity(
          prev,
          identities.find((item) => item.id === identityId),
          identityId,
          inheritedConnectionDefaults.identityId,
        ),
      );
      setSelectedCredentialType(null);
      setCredentialPopoverOpen(false);
    },
    [identities, inheritedConnectionDefaults.identityId],
  );

  const updateTelnetIdentity = useCallback(
    (identityId: string) => {
      setForm((prev) =>
        selectGroupTelnetIdentity(
          prev,
          identityId,
          inheritedConnectionDefaults.telnetIdentityId,
        ),
      );
    },
    [inheritedConnectionDefaults.telnetIdentityId],
  );

  const updateRdpIdentity = useCallback(
    (identity: Identity | undefined, identityId?: string) => {
      setForm((prev) =>
        selectGroupRdpIdentity(
          prev,
          identity,
          identityId,
          inheritedConnectionDefaults.rdpConfig?.identityId,
        ),
      );
    },
    [inheritedConnectionDefaults.rdpConfig?.identityId],
  );

  const updateVncIdentity = useCallback(
    (identity: Identity | undefined, identityId?: string) => {
      setForm((prev) =>
        selectGroupVncIdentity(
          prev,
          identity,
          identityId,
          inheritedConnectionDefaults.vncConfig?.identityId,
        ),
      );
    },
    [inheritedConnectionDefaults.vncConfig?.identityId],
  );

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

  const inheritedThemeId = useMemo(() => {
    if (!parentGroup || groupConfigs.length === 0) return terminalThemeId;
    return resolveGroupTerminalThemeId(inheritedConnectionDefaults, terminalThemeId);
  }, [groupConfigs.length, inheritedConnectionDefaults, parentGroup, terminalThemeId]);

  const inheritedLegacyAlgorithms = !!inheritedConnectionDefaults.legacyAlgorithms;
  const inheritedAlgorithmOverrides = inheritedConnectionDefaults.algorithms;
  const inheritedSkipEcdsaHostKey = !!inheritedConnectionDefaults.skipEcdsaHostKey;
  const inheritedX11Forwarding = !!inheritedConnectionDefaults.x11Forwarding;
  const inheritedStartupCommandRunMode = inheritedConnectionDefaults.startupCommandRunMode ?? "paste";
  const effectiveDeviceType = form.deviceType ?? inheritedConnectionDefaults.deviceType;
  const effectiveThemeId =
    form.themeOverride === false ? inheritedThemeId : form.theme || inheritedThemeId;
  const hasActiveThemeOverride =
    form.themeOverride === true || (form.theme != null && form.themeOverride !== false);

  const handleRdpResolutionDraftChange = useCallback((dimension: "width" | "height", value: string) => {
    setRdpResolutionDraft((prev) => ({ ...prev, [dimension]: value }));
  }, []);

  const handleRemoteDesktopCredentialDraftChange = useCallback(
    (
      protocol: "rdp" | "vnc",
      draft:
        | GroupRemoteDesktopCredentialDraft
        | undefined
        | ((prev: GroupRemoteDesktopCredentialDraft | undefined) => GroupRemoteDesktopCredentialDraft | undefined),
    ) => {
      setRemoteDesktopCredentialDrafts((prev) => ({
        ...prev,
        [protocol]: typeof draft === "function" ? draft(prev[protocol]) : draft,
      }));
    },
    [],
  );

  // Save handler
  const handleSubmit = () => {
    const trimmedName = groupName.trim();
    if (!trimmedName) return;
    if (trimmedName.includes("/") || trimmedName.includes("\\")) {
      setNameError(t("vault.groups.errors.invalidChars"));
      return;
    }

    const newPath = parentGroup ? `${parentGroup}/${trimmedName}` : trimmedName;
    if (newPath !== groupPath && groups.includes(newPath)) {
      setNameError(t("vault.groups.errors.duplicatePath"));
      return;
    }

    if (rdpEnabled) {
      const effectiveRdpForValidation: RdpConfig = {
        ...(inheritedConnectionDefaults.rdpConfig ?? {}),
        ...(form.rdpConfig ?? {}),
      };
      if (!hasValidRdpFixedResolution(effectiveRdpForValidation, rdpResolutionDraft)) {
        setActiveProtocolTab("rdp");
        toast.error(t("hostDetails.rdp.dimensionHint"));
        return;
      }
    }

    const anyProtocolEnabled = sshEnabled || rdpEnabled || vncEnabled || telnetEnabled;
    const anyRoutingProtocolEnabled = sshEnabled || rdpEnabled || vncEnabled;
    const proxySave = anyProtocolEnabled
      ? prepareProxyConfigForSave({
          proxyConfig: form.proxyConfig,
          proxyProfileId: form.proxyProfileId,
          proxyProfiles,
          identities,
        })
      : null;
    if (proxySave?.error) {
      toast.error(t(mapProxySaveErrorKey(proxySave.error)));
      setActiveSubPanel("proxy");
      return;
    }
    const normalizedProxyConfig = proxySave?.normalizedProxyConfig;
    setNameError(null);

    let finalRdpConfig: RdpConfig | undefined;
    if (rdpEnabled) {
      const sanitizedRdp = sanitizeRdpConfig({
        ...(form.rdpConfig ?? {}),
        enabled: true,
      });
      finalRdpConfig = {
        ...(sanitizedRdp ?? {}),
        enabled: true,
        ...(form.rdpConfig?.identityId === "" ? { identityId: "" } : {}),
      };
      const rdpDraft = remoteDesktopCredentialDrafts.rdp;
      if (
        onCreateIdentity &&
        rdpDraft &&
        rdpDraft.password.length > 0 &&
        !finalRdpConfig.useHostCredentials &&
        !finalRdpConfig.identityId
      ) {
        const identity: Identity = {
          id: crypto.randomUUID(),
          label: `${trimmedName} RDP`,
          username: (rdpDraft.username || finalRdpConfig.username || "").trim(),
          ...(finalRdpConfig.domain ? { domain: finalRdpConfig.domain } : {}),
          authMethod: "password",
          password: rdpDraft.password,
          created: Date.now(),
        };
        onCreateIdentity(identity);
        finalRdpConfig = {
          ...finalRdpConfig,
          useHostCredentials: false,
          identityId: identity.id,
          username: undefined,
        };
      }
    }

    let finalVncConfig: VncConfig | undefined;
    if (vncEnabled) {
      const sanitizedVnc = sanitizeVncConfig({
        ...(form.vncConfig ?? {}),
        enabled: true,
      });
      finalVncConfig = {
        ...(sanitizedVnc ?? {}),
        enabled: true,
        ...(form.vncConfig?.identityId === "" ? { identityId: "" } : {}),
      };
      const vncDraft = remoteDesktopCredentialDrafts.vnc;
      if (
        onCreateIdentity &&
        vncDraft &&
        vncDraft.password.length > 0 &&
        !finalVncConfig.useHostCredentials &&
        !finalVncConfig.identityId
      ) {
        const identity: Identity = {
          id: crypto.randomUUID(),
          label: `${trimmedName} VNC`,
          username: (vncDraft.username || finalVncConfig.username || "").trim(),
          authMethod: "password",
          password: vncDraft.password,
          created: Date.now(),
        };
        onCreateIdentity(identity);
        finalVncConfig = {
          ...finalVncConfig,
          useHostCredentials: false,
          identityId: identity.id,
          username: undefined,
        };
      }
    }

    const result: GroupConfig = {
      path: newPath,
      ...(config?.order !== undefined && { order: config.order }),
      notes: form.notes?.trim() || undefined,
      ...(sshEnabled && {
        protocol: "ssh" as const,
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
        ...(form.x11Forwarding !== undefined && { x11Forwarding: form.x11Forwarding }),
        ...(form.legacyAlgorithms !== undefined && { legacyAlgorithms: form.legacyAlgorithms }),
        ...(form.skipEcdsaHostKey !== undefined && { skipEcdsaHostKey: form.skipEcdsaHostKey }),
        ...(form.algorithms !== undefined && { algorithms: form.algorithms }),
        ...(form.backspaceBehavior !== undefined && { backspaceBehavior: form.backspaceBehavior }),
        ...(form.environmentVariables !== undefined && { environmentVariables: form.environmentVariables }),
        ...(form.moshEnabled !== undefined && { moshEnabled: form.moshEnabled }),
        ...(form.moshServerPath !== undefined && { moshServerPath: form.moshServerPath }),
        ...(form.etEnabled !== undefined && { etEnabled: form.etEnabled }),
        ...(form.etPort !== undefined && { etPort: form.etPort }),
      }),
      ...(telnetEnabled && {
        telnetEnabled: true,
        ...(form.telnetPort !== undefined && { telnetPort: form.telnetPort }),
        ...(form.telnetIdentityId !== undefined && { telnetIdentityId: form.telnetIdentityId }),
        ...(form.telnetUsername !== undefined && { telnetUsername: form.telnetUsername }),
        ...(form.telnetPassword !== undefined && { telnetPassword: form.telnetPassword }),
      }),
      ...((sshEnabled || telnetEnabled) && {
        ...(form.startupCommand !== undefined && { startupCommand: form.startupCommand }),
        ...(form.startupCommandRunMode !== undefined && {
          startupCommandRunMode: form.startupCommandRunMode,
        }),
      }),
      ...(finalRdpConfig && { rdpConfig: finalRdpConfig }),
      ...(finalVncConfig && { vncConfig: finalVncConfig }),
      ...(anyProtocolEnabled && {
        ...(form.proxyProfileId !== undefined && { proxyProfileId: form.proxyProfileId }),
        ...(normalizedProxyConfig !== undefined && { proxyConfig: normalizedProxyConfig }),
      }),
      ...(anyRoutingProtocolEnabled && {
        ...(form.hostChain !== undefined && { hostChain: form.hostChain }),
      }),
      // Shared terminal fields
      ...(form.charset !== undefined && { charset: form.charset }),
      ...(form.themeOverride !== false && form.theme !== undefined && { theme: form.theme }),
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
      parentChanged ? parentGroup || null : undefined,
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
        form={{
          id: "",
          label: groupName,
          hostname: groupPath,
          port: 22,
          username: "",
          tags: [],
          os: "linux",
        }}
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

  // --- Main panel (unified with HostDetailsPanel) ---
  return (
    <AsidePanel
      open={true}
      onClose={onCancel}
      width="w-[420px]"
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
          aria-label={t("hostDetails.saveAria")}
        >
          <Check size={16} />
        </Button>
      }
    >
      <AsidePanelContent>
        {/* General Section — matches HostDetailsPanel General card */}
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
          {nameError && <p className="text-xs text-destructive">{nameError}</p>}
          <div className="flex items-center gap-2">
            <div className="h-10 w-10 rounded-lg border border-border/60 bg-transparent flex items-center justify-center shrink-0">
              <FolderPlus size={16} className="text-muted-foreground" />
            </div>
            <Combobox
              options={parentGroupOptions}
              value={parentGroup || "__root__"}
              onValueChange={(val) => setParentGroup(val === "__root__" ? "" : val)}
              placeholder={t("vault.groups.details.parentGroup")}
              triggerClassName="flex-1 h-10"
            />
          </div>
        </HostDetailsSection>

        {/* Unified 4-Protocol Tabs & Credentials — matches HostDetailsConnectionSections */}
        <GroupProtocolCredentialsSection
          t={t}
          activeProtocolTab={activeProtocolTab}
          onSelectProtocolTab={setActiveProtocolTab}
          enabledProtocols={enabledProtocols}
          onEnableProtocol={handleEnableProtocol}
          onRemoveProtocol={handleRemoveProtocol}
          form={form}
          inheritedDefaults={inheritedConnectionDefaults}
          update={update}
          updateRdpConfig={updateRdpConfig}
          updateVncConfig={updateVncConfig}
          availableKeys={availableKeys}
          identities={identities}
          keysByCategory={keysByCategory}
          effectiveSshIdentityId={effectiveSshIdentityId}
          effectiveTelnetIdentityId={effectiveTelnetIdentityId}
          effectiveRdpIdentityId={effectiveRdpIdentityId}
          effectiveVncIdentityId={effectiveVncIdentityId}
          onSelectSshIdentity={updateSshIdentity}
          onSelectTelnetIdentity={updateTelnetIdentity}
          onSelectRdpIdentity={updateRdpIdentity}
          onSelectVncIdentity={updateVncIdentity}
          showPassword={showPassword}
          setShowPassword={setShowPassword}
          showTelnetPassword={showTelnetPassword}
          setShowTelnetPassword={setShowTelnetPassword}
          selectedCredentialType={selectedCredentialType}
          setSelectedCredentialType={setSelectedCredentialType}
          credentialPopoverOpen={credentialPopoverOpen}
          setCredentialPopoverOpen={setCredentialPopoverOpen}
          newKeyFilePath={newKeyFilePath}
          setNewKeyFilePath={setNewKeyFilePath}
          remoteDesktopCredentialDrafts={remoteDesktopCredentialDrafts}
          onRemoteDesktopCredentialDraftChange={handleRemoteDesktopCredentialDraftChange}
        />

        {/* Protocol-specific & network sections — matches HostDetailsAdvancedSections + RemoteDesktopOptionsSection */}
        <GroupSshSettingsSection
          t={t}
          activeProtocolTab={activeProtocolTab}
          isCurrentTabEnabled={isCurrentTabEnabled}
          form={form}
          setForm={setForm}
          update={update}
          updateRdpConfig={updateRdpConfig}
          updateVncConfig={updateVncConfig}
          inheritedDefaults={inheritedConnectionDefaults}
          effectiveThemeId={effectiveThemeId}
          hasActiveThemeOverride={hasActiveThemeOverride}
          availableFonts={availableFonts}
          terminalFontSize={terminalFontSize}
          effectiveDeviceType={effectiveDeviceType}
          inheritedLegacyAlgorithms={inheritedLegacyAlgorithms}
          inheritedSkipEcdsaHostKey={inheritedSkipEcdsaHostKey}
          inheritedX11Forwarding={inheritedX11Forwarding}
          inheritedStartupCommandRunMode={inheritedStartupCommandRunMode}
          showAlgorithmOverrides={showAlgorithmOverrides}
          setShowAlgorithmOverrides={setShowAlgorithmOverrides}
          inheritedAlgorithmOverrides={inheritedAlgorithmOverrides}
          proxySummaryType={proxySummaryType}
          proxySummaryLabel={proxySummaryLabel}
          proxySummaryTooltip={proxySummaryTooltip}
          hasProxyConfig={hasProxyConfig}
          clearProxyConfig={clearProxyConfig}
          chainedHosts={chainedHosts}
          clearHostChain={clearHostChain}
          setActiveSubPanel={setActiveSubPanel}
          rdpResolutionDraft={rdpResolutionDraft}
          onRdpResolutionDraftChange={handleRdpResolutionDraftChange}
        />

        {/* Notes Section — matches HostDetailsPanel card chrome */}
        <HostDetailsSection
          icon={<FileText size={14} className="text-muted-foreground shrink-0" />}
          title={t("hostDetails.notes.label")}
          hint={t("hostDetails.notes.help")}
        >
          <HostNotesEditor
            panelKey={groupPath}
            value={form.notes ?? ""}
            onChange={(notes) => update("notes", notes)}
            showHeader={false}
          />
        </HostDetailsSection>
      </AsidePanelContent>
      <AsidePanelFooter>
        <Button
          className="w-full h-10"
          onClick={handleSubmit}
          disabled={!groupName.trim()}
        >
          {t("common.save")}
        </Button>
      </AsidePanelFooter>
    </AsidePanel>
  );
};

export default GroupDetailsPanel;
