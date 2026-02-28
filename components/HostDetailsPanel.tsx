import {
  AlertTriangle,
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  FolderLock,
  FolderPlus,
  Forward,
  Globe,
  Key,
  KeyRound,
  Link2,
  MapPin,
  Palette,
  Plus,
  Settings2,
  Shield,
  ShieldAlert,
  Tag,
  TerminalSquare,
  User,
  Variable,
  Wifi,
  X,
} from "lucide-react";
import React, { useEffect, useMemo, useState, useCallback } from "react";
import { useI18n } from "../application/i18n/I18nProvider";
import { useApplicationBackend } from "../application/state/useApplicationBackend";
import { TERMINAL_THEMES } from "../infrastructure/config/terminalThemes";
import { MIN_FONT_SIZE, MAX_FONT_SIZE } from "../infrastructure/config/fonts";
import { cn } from "../lib/utils";
import { EnvVar, Host, Identity, ManagedSource, ProxyConfig, SSHKey } from "../types";
import { DistroAvatar } from "./DistroAvatar";
import ThemeSelectPanel from "./ThemeSelectPanel";
import {
  AsidePanel,
  AsidePanelContent,
  AsidePanelFooter,
} from "./ui/aside-panel";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Switch } from "./ui/switch";
import { Card } from "./ui/card";
import { Combobox, ComboboxOption, MultiCombobox } from "./ui/combobox";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { ScrollArea } from "./ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

// Import host-details sub-panels
import {
  ChainPanel,
  CreateGroupPanel,
  EnvVarsPanel,
  ProxyPanel,
} from "./host-details";

type CredentialType = "sshid" | "key" | "certificate" | null;
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
  groups: string[];
  managedSources?: ManagedSource[];
  allTags?: string[]; // All available tags for autocomplete
  allHosts?: Host[]; // All hosts for chain selection
  defaultGroup?: string | null; // Default group for new hosts (from current navigation)
  onSave: (host: Host) => void;
  onCancel: () => void;
  onCreateGroup?: (groupPath: string) => void; // Callback to create a new group
  onCreateTag?: (tag: string) => void; // Callback to create a new tag
}

const HostDetailsPanel: React.FC<HostDetailsPanelProps> = ({
  initialData,
  availableKeys,
  identities,
  groups,
  managedSources = [],
  allTags = [],
  allHosts = [],
  defaultGroup,
  onSave,
  onCancel,
  onCreateGroup,
  onCreateTag,
}) => {
  const { t } = useI18n();
  const { checkSshAgent } = useApplicationBackend();
  const [form, setForm] = useState<Host>(
    () =>
      initialData ||
      ({
        id: crypto.randomUUID(),
        label: "",
        hostname: "",
        port: 22,
        username: "root",
        protocol: "ssh",
        tags: [],
        os: "linux",
        authMethod: "password",
        charset: "UTF-8",
        theme: "Flexoki Dark",
        createdAt: Date.now(),
        group: defaultGroup || undefined, // Pre-fill with current navigation group
      } as Host),
  );

  // Sub-panel state
  const [activeSubPanel, setActiveSubPanel] = useState<SubPanel>("none");

  // Credential selection state
  const [credentialPopoverOpen, setCredentialPopoverOpen] = useState(false);
  const [selectedCredentialType, setSelectedCredentialType] =
    useState<CredentialType>(null);

  // Identity suggestion dropdown state (popover anchored to username input)
  const [identitySuggestionsOpen, setIdentitySuggestionsOpen] = useState(false);

  // Password visibility state
  const [showPassword, setShowPassword] = useState(false);

  // New group creation state
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupParent, setNewGroupParent] = useState("");

  // SSH Agent status for Windows (only checked when agentForwarding is enabled)
  const [sshAgentStatus, setSshAgentStatus] = useState<{
    running: boolean;
    startupType: string | null;
    error: string | null;
  } | null>(null);

  // Check SSH Agent status when agentForwarding is toggled on (Windows only)
  useEffect(() => {
    if (form.agentForwarding) {
      checkSshAgent().then(setSshAgentStatus);
    } else {
      setSshAgentStatus(null);
    }
  }, [form.agentForwarding, checkSshAgent]);

  // Group input state for inline creation suggestion
  const [groupInputValue, setGroupInputValue] = useState(form.group || "");

  // Check if the entered group is new (doesn't exist)
  // Reserved for future use: showing inline "create new group" suggestion
  const _isNewGroup = useMemo(() => {
    const trimmed = groupInputValue.trim();
    return trimmed.length > 0 && !groups.includes(trimmed);
  }, [groupInputValue, groups]);

  useEffect(() => {
    if (initialData) {
      // Ensure telnetEnabled is set when protocol is telnet
      const updatedData = { ...initialData };
      if (initialData.protocol === "telnet" && !initialData.telnetEnabled) {
        updatedData.telnetEnabled = true;
        updatedData.telnetPort =
          initialData.telnetPort || initialData.port || 23;
      }
      setForm(updatedData);
      setGroupInputValue(initialData.group || "");
      // Reset password visibility when host changes for privacy
      setShowPassword(false);
    }
  }, [initialData]);

  const update = <K extends keyof Host>(key: K, value: Host[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

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
      return rest as Host;
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
      return rest as Host;
    });
  }, []);

  // Environment variables state
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
    setForm((prev) => ({
      ...prev,
      environmentVariables: (prev.environmentVariables || []).filter(
        (_, i) => i !== index,
      ),
    }));
  };

  const handleSubmit = () => {
    if (!form.hostname) return;
    // If label is empty, use hostname as label
    let finalLabel = form.label?.trim() || form.hostname;
    const finalGroup = groupInputValue.trim() || form.group || "";

    // Find the most specific (deepest) managed source that matches the group path
    // This handles nested managed groups correctly by preferring exact matches
    // and longer paths over shorter prefix matches
    const targetManagedSource = managedSources
      .filter(s => finalGroup === s.groupName || finalGroup.startsWith(s.groupName + "/"))
      .sort((a, b) => b.groupName.length - a.groupName.length)[0];

    // Only SSH hosts can be managed (SSH config only supports SSH protocol)
    const canBeManaged = !form.protocol || form.protocol === "ssh";

    // Strip spaces from label only if host can be managed and is in a managed group
    // (SSH config requires no spaces in Host alias)
    if (targetManagedSource && canBeManaged) {
      finalLabel = finalLabel.replace(/\s/g, '');
    }

    // Determine managedSourceId:
    // - Only SSH hosts can be managed (SSH config only supports SSH protocol)
    // - If we found a matching managed source, use its id
    // - If managedSources was not provided (empty array) and host already has managedSourceId, preserve it
    // - Otherwise, clear it (host is not in a managed group)
    let finalManagedSourceId: string | undefined;
    if (targetManagedSource && canBeManaged) {
      finalManagedSourceId = targetManagedSource.id;
    } else if (managedSources.length === 0 && form.managedSourceId && canBeManaged) {
      // managedSources not provided, preserve existing value
      finalManagedSourceId = form.managedSourceId;
    } else {
      finalManagedSourceId = undefined;
    }

    const cleaned: Host = {
      ...form,
      label: finalLabel,
      group: finalGroup,
      tags: form.tags || [],
      port: form.port || 22,
      // Clear password if savePassword is explicitly set to false
      password: form.savePassword === false ? undefined : form.password,
      managedSourceId: finalManagedSourceId,
    };
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

  // Get available hosts for chain (exclude current host)
  const availableHostsForChain = useMemo(() => {
    const chainedIds = new Set(form.hostChain?.hostIds || []);
    return allHosts.filter((h) => h.id !== form.id && !chainedIds.has(h.id));
  }, [allHosts, form.id, form.hostChain?.hostIds]);

  // Get hosts in chain
  const chainedHosts = useMemo(() => {
    const ids = form.hostChain?.hostIds || [];
    return ids
      .map((id) => allHosts.find((h) => h.id === id))
      .filter(Boolean) as Host[];
  }, [allHosts, form.hostChain?.hostIds]);

  // Compute group options for Combobox
  const groupOptions: ComboboxOption[] = useMemo(() => {
    return groups.map((g) => ({
      value: g,
      label: g.includes("/") ? g.split("/").pop()! : g,
      sublabel: g.includes("/") ? g : undefined,
    }));
  }, [groups]);

  // Compute tag options for MultiCombobox
  const tagOptions: ComboboxOption[] = useMemo(() => {
    const allTagSet = new Set([...allTags, ...(form.tags || [])]);
    return Array.from(allTagSet).map((t) => ({ value: t, label: t }));
  }, [allTags, form.tags]);

  // Available keys by category
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
      }));
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

  // Render sub-panels
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
      />
    );
  }

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
      />
    );
  }

  // Environment Variables sub-panel
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
      />
    );
  }

  // Theme selection sub-panel (SSH)
  if (activeSubPanel === "theme-select") {
    return (
      <ThemeSelectPanel
        open={true}
        selectedThemeId={form.theme || "flexoki-dark"}
        onSelect={(themeId) => {
          update("theme", themeId);
          setActiveSubPanel("none");
        }}
        onClose={onCancel}
        onBack={() => setActiveSubPanel("none")}
        showBackButton={true}
      />
    );
  }

  // Theme selection sub-panel (Telnet)
  if (activeSubPanel === "telnet-theme-select") {
    return (
      <ThemeSelectPanel
        open={true}
        selectedThemeId={
          form.protocols?.find((p) => p.protocol === "telnet")?.theme ||
          form.theme ||
          "flexoki-dark"
        }
        onSelect={(themeId) => {
          // Update telnet protocol theme
          const telnetConfig = form.protocols?.find(
            (p) => p.protocol === "telnet",
          );
          if (telnetConfig) {
            const newProtocols = form.protocols?.map((p) =>
              p.protocol === "telnet" ? { ...p, theme: themeId } : p,
            );
            setForm((prev) => ({ ...prev, protocols: newProtocols }));
          } else {
            // Create new telnet protocol config with theme
            const newProtocols = [
              ...(form.protocols || []),
              {
                protocol: "telnet" as const,
                port: form.telnetPort || 23,
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
      />
    );
  }

  // Main panel
  return (
    <AsidePanel
      open={true}
      onClose={onCancel}
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
              // Only strip spaces if the TARGET group belongs to a managed source
              // (don't use form.managedSourceId as it reflects old state before group change)
              const targetGroup = groupInputValue.trim() || form.group || "";
              const willBeManaged = managedSources.some(s =>
                targetGroup === s.groupName || targetGroup.startsWith(s.groupName + "/")
              );
              // Also check protocol - only SSH hosts can be managed
              const canBeManaged = !form.protocol || form.protocol === "ssh";
              if (willBeManaged && canBeManaged) {
                value = value.replace(/\s/g, '');
              }
              update("label", value);
            }}
            className="h-10"
          />

          {/* Group selection with Combobox */}
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

          {/* Tag selection with MultiCombobox */}
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

        <Card className="p-3 space-y-2 bg-card border-border/80">
          <div className="flex items-center gap-2">
            <MapPin size={14} className="text-muted-foreground" />
            <p className="text-xs font-semibold">
              {t("hostDetails.section.address")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <DistroAvatar
              host={form as Host}
              fallback={
                form.label?.slice(0, 2).toUpperCase() ||
                form.hostname?.slice(0, 2).toUpperCase() ||
                "H"
              }
              className="h-10 w-10"
            />
            <Input
              placeholder={t("hostDetails.hostname.placeholder")}
              value={form.hostname}
              onChange={(e) => update("hostname", e.target.value)}
              className="h-10 flex-1"
            />
          </div>
        </Card>

        <Card className="p-3 space-y-3 bg-card border-border/80">
          <div className="flex items-center gap-2">
            <KeyRound size={14} className="text-muted-foreground" />
            <p className="text-xs font-semibold">
              {t("hostDetails.section.portCredentials")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex-1 min-w-0 h-10 flex items-center gap-2 bg-secondary/70 border border-border/70 rounded-md px-3">
              <span className="text-xs text-muted-foreground">SSH on</span>
              <div className="ml-auto w-1/2 min-w-0 flex items-center gap-2 justify-end">
                <Input
                  type="number"
                  value={form.port}
                  onChange={(e) => update("port", Number(e.target.value))}
                  className="h-8 flex-1 min-w-0 text-center"
                />
                <span className="text-xs text-muted-foreground">
                  {t("hostDetails.port")}
                </span>
              </div>
            </div>
          </div>
          <div className="grid gap-2">
            {selectedIdentity ? (
              <div className="flex items-center gap-2 h-10 px-3 rounded-md border border-border/70 bg-secondary/60">
                <User size={16} className="text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">
                    {selectedIdentity.label}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  onClick={clearIdentity}
                  title={t("common.clear")}
                >
                  <X size={14} />
                </Button>
              </div>
            ) : form.identityId ? (
              <div className="flex items-center gap-2 h-10 px-3 rounded-md border border-border/70 bg-secondary/60">
                <User size={16} className="text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">
                    {t("hostDetails.identity.missing")}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  onClick={clearIdentity}
                  title={t("common.clear")}
                >
                  <X size={14} />
                </Button>
              </div>
            ) : (
              (() => {
                const hasIdentities = identities.length > 0;
                if (!hasIdentities) {
                  return (
                    <Input
                      placeholder={t("hostDetails.username.placeholder")}
                      value={form.username}
                      onChange={(e) => update("username", e.target.value)}
                      className="h-10"
                    />
                  );
                }

                return (
                  <Popover
                    open={
                      identitySuggestionsOpen &&
                      filteredIdentitySuggestions.length > 0
                    }
                    onOpenChange={setIdentitySuggestionsOpen}
                  >
                    <PopoverTrigger asChild>
                      <div className="relative">
                        <Input
                          placeholder={t("hostDetails.username.placeholder")}
                          value={form.username}
                          onChange={(e) => {
                            const next = e.target.value;
                            update("username", next);
                            const q = next.toLowerCase().trim();
                            const matches = q
                              ? identities.filter(
                                (i) =>
                                  i.label.toLowerCase().includes(q) ||
                                  i.username.toLowerCase().includes(q),
                              )
                              : identities;
                            setIdentitySuggestionsOpen(matches.length > 0);
                          }}
                          onFocus={() => {
                            const q = (form.username || "").toLowerCase().trim();
                            const matches = q
                              ? identities.filter(
                                (i) =>
                                  i.label.toLowerCase().includes(q) ||
                                  i.username.toLowerCase().includes(q),
                              )
                              : identities;
                            setIdentitySuggestionsOpen(matches.length > 0);
                          }}
                          className="h-10 pr-9"
                        />
                        <button
                          type="button"
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                          onClick={() => {
                            setIdentitySuggestionsOpen((prev) => {
                              if (prev) return false;
                              const q = (form.username || "")
                                .toLowerCase()
                                .trim();
                              const matches = q
                                ? identities.filter(
                                  (i) =>
                                    i.label.toLowerCase().includes(q) ||
                                    i.username.toLowerCase().includes(q),
                                )
                                : identities;
                              return matches.length > 0;
                            });
                          }}
                          title={t("hostDetails.identity.suggestions")}
                        >
                          <ChevronDown size={16} />
                        </button>
                      </div>
                    </PopoverTrigger>
                    <PopoverContent
                      className="p-0 border-border/60"
                      align="start"
                      sideOffset={4}
                      onOpenAutoFocus={(e) => e.preventDefault()}
                      style={{ width: "var(--radix-popover-trigger-width)" }}
                    >
                      <ScrollArea className="max-h-[280px]">
                        <div className="p-1">
                          {filteredIdentitySuggestions.length === 0 ? (
                            <div className="py-4 text-center text-sm text-muted-foreground">
                              {t("common.noResultsFound")}
                            </div>
                          ) : (
                            <div className="space-y-1">
                              {filteredIdentitySuggestions.map((identity) => {
                                const keyLabel = identity.keyId
                                  ? availableKeys.find(
                                    (k) => k.id === identity.keyId,
                                  )?.label
                                  : undefined;
                                const methodLabel =
                                  identity.authMethod === "certificate"
                                    ? t("hostDetails.credential.certificate")
                                    : identity.authMethod === "key"
                                      ? t("hostDetails.credential.key")
                                      : t("keychain.identity.method.passwordOnly");
                                const summaryParts = [
                                  identity.username,
                                  identity.password ? "******" : undefined,
                                  keyLabel,
                                ].filter(Boolean);

                                return (
                                  <button
                                    key={identity.id}
                                    type="button"
                                    className="w-full flex items-center gap-3 px-3 py-2 rounded-md hover:bg-secondary/80 transition-colors text-left"
                                    onMouseDown={(e) => {
                                      e.preventDefault();
                                      applyIdentity(identity);
                                    }}
                                  >
                                    <div className="h-8 w-8 rounded-md bg-green-500/15 text-green-500 flex items-center justify-center shrink-0">
                                      <User size={16} />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                      <div className="text-sm font-medium truncate">
                                        {identity.label}
                                      </div>
                                      <div className="text-xs text-muted-foreground truncate">
                                        {methodLabel}
                                        {summaryParts.length
                                          ? ` - ${summaryParts.join(", ")}`
                                          : ""}
                                      </div>
                                    </div>
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </ScrollArea>
                    </PopoverContent>
                  </Popover>
                );
              })()
            )}

            {!selectedIdentity && !form.identityId && (
              <div className="relative">
                <Input
                  placeholder={t("hostDetails.password.placeholder")}
                  type={showPassword ? "text" : "password"}
                  value={form.password || ""}
                  onChange={(e) => update("password", e.target.value)}
                  className="h-10 pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
                  title={showPassword ? t("hostDetails.password.hide") : t("hostDetails.password.show")}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            )}

            {/* Save Password toggle - shown when password is entered */}
            {!selectedIdentity && !form.identityId && form.password && (
              <div className="flex items-center justify-between py-1">
                <span className="text-xs text-muted-foreground">
                  {t("hostDetails.password.save")}
                </span>
                <Switch
                  checked={form.savePassword ?? true}
                  onCheckedChange={(val) => update("savePassword" as keyof Host, val)}
                />
              </div>
            )}

            {/* Selected credential display */}
            {!selectedIdentity && form.identityFileId && (
              <div className="flex items-center gap-2 p-2 rounded-md bg-secondary/50 border border-border/60">
                {form.authMethod === "certificate" ? (
                  <Shield size={14} className="text-primary" />
                ) : (
                  <Key size={14} className="text-primary" />
                )}
                <span className="text-sm flex-1 truncate">
                  {availableKeys.find((k) => k.id === form.identityFileId)
                    ?.label || "Key"}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => {
                    update("identityFileId", undefined);
                    update("authMethod", "password");
                    setSelectedCredentialType(null);
                  }}
                >
                  <X size={12} />
                </Button>
              </div>
            )}

            {/* Credential type selection with inline popover - hidden when credential is selected */}
            {!selectedIdentity &&
              !form.identityFileId &&
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
                    </div>
                  </PopoverContent>
                </Popover>
              )}

            {/* Key selection combobox - appears after selecting "Key" type */}
            {!selectedIdentity &&
              selectedCredentialType === "key" &&
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
            {!selectedIdentity &&
              selectedCredentialType === "certificate" &&
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
          </div>
        </Card>

        <Card className="p-3 space-y-3 bg-card border-border/80">
          <div className="flex items-center gap-2">
            <FolderLock size={14} className="text-muted-foreground" />
            <p className="text-xs font-semibold">
              {t("hostDetails.section.sftp")}
            </p>
          </div>
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <div className="text-sm font-medium">
                {t("hostDetails.sftp.sudo")}
              </div>
              <div className="text-xs text-muted-foreground">
                {t("hostDetails.sftp.sudo.desc")}
              </div>
            </div>
            <Switch
              checked={form.sftpSudo || false}
              onCheckedChange={(val) => update("sftpSudo", val)}
            />
          </div>
          {form.sftpSudo && !form.password && !selectedIdentity?.password && (
            <p className="text-xs text-amber-500">
              {t("hostDetails.sftp.sudo.passwordWarning")}
            </p>
          )}
          <div className="space-y-1">
            <div className="text-sm font-medium">
              {t("hostDetails.sftp.encoding")}
            </div>
            <div className="text-xs text-muted-foreground">
              {t("hostDetails.sftp.encoding.desc")}
            </div>
            <Select
              value={form.sftpEncoding || "auto"}
              onValueChange={(val) => update("sftpEncoding", val as Host["sftpEncoding"])}
            >
              <SelectTrigger className="h-8">
                <SelectValue placeholder={t("sftp.encoding.label")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t("sftp.encoding.auto")}</SelectItem>
                <SelectItem value="utf-8">{t("sftp.encoding.utf8")}</SelectItem>
                <SelectItem value="gb18030">{t("sftp.encoding.gb18030")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </Card>

        <Card className="p-3 space-y-3 bg-card border-border/80">
          <div className="flex items-center gap-2">
            <Palette size={14} className="text-muted-foreground" />
            <p className="text-xs font-semibold">
              {t("hostDetails.section.appearance")}
            </p>
          </div>

          {/* SSH Theme Selection */}
          <button
            type="button"
            className="w-full flex items-center gap-3 p-2 rounded-lg bg-secondary/50 hover:bg-secondary transition-colors text-left"
            onClick={() => setActiveSubPanel("theme-select")}
          >
            <div
              className="w-12 h-8 rounded-md border border-border/60 flex items-center justify-center text-[6px] font-mono overflow-hidden"
              style={{
                backgroundColor:
                  TERMINAL_THEMES.find(
                    (t) => t.id === (form.theme || "flexoki-dark"),
                  )?.colors.background || "#100F0F",
                color:
                  TERMINAL_THEMES.find(
                    (t) => t.id === (form.theme || "flexoki-dark"),
                  )?.colors.foreground || "#CECDC3",
              }}
            >
              <div className="p-0.5">
                <div
                  style={{
                    color: TERMINAL_THEMES.find(
                      (t) => t.id === (form.theme || "flexoki-dark"),
                    )?.colors.green,
                  }}
                >
                  $
                </div>
              </div>
            </div>
            <span className="text-sm flex-1">
              {TERMINAL_THEMES.find(
                (t) => t.id === (form.theme || "flexoki-dark"),
              )?.name || "Flexoki Dark"}
            </span>
          </button>

          {/* Font Size */}
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Font Size:</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if ((form.fontSize || 14) > MIN_FONT_SIZE) {
                  update("fontSize", (form.fontSize || 14) - 1);
                }
              }}
              disabled={(form.fontSize || 14) <= MIN_FONT_SIZE}
              className="px-2 h-8"
            >
              -
            </Button>
            <Input
              type="number"
              min={MIN_FONT_SIZE}
              max={MAX_FONT_SIZE}
              value={form.fontSize || 14}
              onChange={(e) => {
                const val = parseInt(e.target.value);
                if (val >= MIN_FONT_SIZE && val <= MAX_FONT_SIZE) {
                  update("fontSize", val);
                }
              }}
              className="w-16 text-center h-8"
            />
            <span className="text-sm text-muted-foreground">pt</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if ((form.fontSize || 14) < MAX_FONT_SIZE) {
                  update("fontSize", (form.fontSize || 14) + 1);
                }
              }}
              disabled={(form.fontSize || 14) >= MAX_FONT_SIZE}
              className="px-2 h-8"
            >
              +
            </Button>
          </div>
        </Card>

        <Card className="p-3 space-y-3 bg-card border-border/80">
          <div className="flex items-center gap-2">
            <Wifi size={14} className="text-muted-foreground" />
            <p className="text-xs font-semibold">{t("hostDetails.section.mosh")}</p>
          </div>
          <ToggleRow
            label="Mosh"
            enabled={!!form.moshEnabled}
            onToggle={() => update("moshEnabled", !form.moshEnabled)}
          />
        </Card>

        {/* Agent Forwarding */}
        <Card className="p-3 space-y-2 bg-card border-border/80">
          <div className="flex items-center gap-2">
            <Forward size={14} className="text-muted-foreground" />
            <p className="text-xs font-semibold">{t("hostDetails.section.agentForwarding")}</p>
          </div>
          <ToggleRow
            label={t("hostDetails.agentForwarding")}
            enabled={!!form.agentForwarding}
            onToggle={() => update("agentForwarding", !form.agentForwarding)}
          />
          <p className="text-xs text-muted-foreground">
            {t("hostDetails.agentForwarding.desc")}
          </p>
          {form.agentForwarding && sshAgentStatus && !sshAgentStatus.running && (
            <div className="flex items-start gap-2 p-2 rounded-md bg-yellow-500/10 border border-yellow-500/20">
              <AlertTriangle size={14} className="text-yellow-500 mt-0.5 flex-shrink-0" />
              <div className="space-y-1">
                <p className="text-xs text-yellow-600 dark:text-yellow-400 font-medium">
                  {t("hostDetails.agentForwarding.agentNotRunning")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("hostDetails.agentForwarding.agentNotRunningHint")}
                </p>
              </div>
            </div>
          )}
        </Card>

        {/* Legacy Algorithms */}
        <Card className="p-3 space-y-2 bg-card border-border/80">
          <div className="flex items-center gap-2">
            <ShieldAlert size={14} className="text-muted-foreground" />
            <p className="text-xs font-semibold">{t("hostDetails.section.legacyAlgorithms")}</p>
          </div>
          <ToggleRow
            label={t("hostDetails.legacyAlgorithms")}
            enabled={!!form.legacyAlgorithms}
            onToggle={() => update("legacyAlgorithms", !form.legacyAlgorithms)}
          />
          <p className="text-xs text-muted-foreground">
            {t("hostDetails.legacyAlgorithms.desc")}
          </p>
          {form.legacyAlgorithms && (
            <div className="flex items-start gap-2 p-2 rounded-md bg-yellow-500/10 border border-yellow-500/20">
              <AlertTriangle size={14} className="text-yellow-500 mt-0.5 flex-shrink-0" />
              <p className="text-xs text-yellow-600 dark:text-yellow-400">
                {t("hostDetails.legacyAlgorithms.warning")}
              </p>
            </div>
          )}
        </Card>

        {/* Proxy via Hosts (Jump Hosts / ProxyJump) */}
        <Card className="p-3 space-y-2 bg-card border-border/80">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Link2 size={14} className="text-muted-foreground" />
              <p className="text-xs font-semibold">
                {t("hostDetails.jumpHosts")}
              </p>
            </div>
            {chainedHosts.length > 0 ? (
              <Badge variant="secondary" className="text-xs">
                {t("hostDetails.jumpHosts.hops", { count: chainedHosts.length })}
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="text-xs text-muted-foreground"
              >
                {t("hostDetails.jumpHosts.direct")}
              </Badge>
            )}
          </div>
          {chainedHosts.length > 0 && (
            <button
              className="w-full flex flex-col items-start gap-1 p-2 rounded-md bg-secondary/50 hover:bg-secondary transition-colors cursor-pointer"
              onClick={() => setActiveSubPanel("chain")}
            >
              <div className="w-full flex items-center justify-between">
                <div className="flex items-center gap-1 min-w-0 flex-1">
                  <Link2
                    size={14}
                    className="text-muted-foreground flex-shrink-0"
                  />
                  <span className="text-xs text-muted-foreground">
                    {t("hostDetails.jumpHosts.hops", { count: chainedHosts.length })}
                  </span>
                </div>
                <X
                  size={14}
                  className="text-muted-foreground hover:text-destructive flex-shrink-0"
                  onClick={(e) => {
                    e.stopPropagation();
                    clearHostChain();
                  }}
                />
              </div>
              <div className="w-full space-y-1 pl-5">
                {chainedHosts.slice(0, 5).map((h, idx) => (
                  <div key={h.id} className="flex items-center gap-1 text-sm">
                    <span className="text-muted-foreground">{idx + 1}.</span>
                    <span className="truncate">
                      {h.label !== h.hostname ? `${h.hostname} (${h.label})` : h.hostname}
                    </span>
                  </div>
                ))}
                {chainedHosts.length > 5 && (
                  <div className="text-xs text-muted-foreground">
                    +{chainedHosts.length - 5} more...
                  </div>
                )}
              </div>
            </button>
          )}
          {chainedHosts.length === 0 && (
            <Button
              variant="ghost"
              className="w-full h-9 justify-start gap-2 text-sm"
              onClick={() => setActiveSubPanel("chain")}
            >
              <Plus size={14} />
              {t("hostDetails.jumpHosts.configure")}
            </Button>
          )}
        </Card>

        {/* Proxy Configuration */}
        <Card className="p-3 space-y-2 bg-card border-border/80">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Globe size={14} className="text-muted-foreground" />
              <p className="text-xs font-semibold">{t("hostDetails.proxy")}</p>
            </div>
            {form.proxyConfig?.host ? (
              <Badge variant="secondary" className="text-xs">
                {form.proxyConfig.type?.toUpperCase()} {form.proxyConfig.host}:
                {form.proxyConfig.port}
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="text-xs text-muted-foreground"
              >
                {t("hostDetails.proxy.none")}
              </Badge>
            )}
          </div>
          <Button
            variant="ghost"
            className="w-full h-9 justify-start gap-2 text-sm"
            onClick={() => setActiveSubPanel("proxy")}
          >
            <Plus size={14} />
            {form.proxyConfig?.host
              ? t("hostDetails.proxy.edit")
              : t("hostDetails.proxy.configure")}
          </Button>
        </Card>

        {/* Environment Variables */}
        <Card className="p-3 space-y-2 bg-card border-border/80">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Variable size={14} className="text-muted-foreground" />
              <p className="text-xs font-semibold">{t("hostDetails.envVars")}</p>
            </div>
          </div>
          {(form.environmentVariables?.length || 0) > 0 ? (
            <button
              className="w-full flex items-center gap-1 p-2 rounded-md bg-secondary/50 hover:bg-secondary transition-colors cursor-pointer"
              onClick={() => setActiveSubPanel("env-vars")}
            >
              <span className="text-sm truncate">
                {form.environmentVariables
                  ?.slice(0, 2)
                  .map((v) => `${v.name}=${v.value}`)
                  .join(", ")}
                {(form.environmentVariables?.length || 0) > 2 && "..."}
              </span>
              <X
                size={14}
                className="text-muted-foreground hover:text-destructive flex-shrink-0 ml-auto"
                onClick={(e) => {
                  e.stopPropagation();
                  setForm((prev) => ({ ...prev, environmentVariables: [] }));
                }}
              />
            </button>
          ) : (
            <Button
              variant="ghost"
              className="w-full h-9 justify-start gap-2 text-sm"
              onClick={() => setActiveSubPanel("env-vars")}
            >
              <Plus size={14} />
              {t("hostDetails.envVars.add")}
            </Button>
          )}
        </Card>

        {/* Startup Command */}
        <Card className="p-3 space-y-2 bg-card border-border/80">
          <div className="flex items-center gap-2">
            <TerminalSquare size={14} className="text-muted-foreground" />
            <p className="text-xs font-semibold">{t("hostDetails.startupCommand")}</p>
          </div>
          <Textarea
            placeholder={t("hostDetails.startupCommand.placeholder")}
            value={form.startupCommand || ""}
            onChange={(e) => update("startupCommand", e.target.value)}
            className="min-h-[80px] font-mono text-sm"
            rows={3}
          />
          <p className="text-xs text-muted-foreground">
            {t("hostDetails.startupCommand.help")}
          </p>
        </Card>

        {/* Telnet Protocol Section - Separator and Configuration */}
        <div className="flex items-center gap-3 py-2">
          <div className="flex-1 h-px bg-border/60" />
          <span className="text-xs text-muted-foreground">{t("hostDetails.otherProtocols")}</span>
          <div className="flex-1 h-px bg-border/60" />
        </div>

        {/* Telnet Protocol Card */}
        {form.telnetEnabled || form.protocol === "telnet" ? (
          <Card className="p-3 space-y-3 bg-card border-border/80">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 bg-secondary/70 border border-border/70 rounded-md px-2 py-1">
                <span className="text-xs text-muted-foreground">{t("hostDetails.telnetOn")}</span>
                <Input
                  type="number"
                  value={form.telnetPort || 23}
                  onChange={(e) => update("telnetPort", Number(e.target.value))}
                  className="h-8 w-16 text-center"
                />
                <span className="text-xs text-muted-foreground">{t("hostDetails.port")}</span>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                onClick={() => update("telnetEnabled", false)}
              >
                <X size={14} />
              </Button>
            </div>

            {/* Telnet Credentials */}
            <p className="text-xs font-semibold">{t("hostDetails.telnet.credentials")}</p>
            <Input
              placeholder={t("hostDetails.telnet.username")}
              value={form.telnetUsername || form.username || ""}
              onChange={(e) =>
                update("telnetUsername" as keyof Host, e.target.value)
              }
              className="h-10"
            />
            <Input
              placeholder={t("hostDetails.telnet.password")}
              type="password"
              value={form.telnetPassword || form.password || ""}
              onChange={(e) =>
                update("telnetPassword" as keyof Host, e.target.value)
              }
              className="h-10"
            />

            {/* Telnet Charset */}
            <Input
              placeholder={t("hostDetails.charset.placeholder")}
              value={form.charset || "UTF-8"}
              onChange={(e) => update("charset", e.target.value)}
              className="h-10"
            />

            {/* Telnet Theme Selection */}
            <button
              type="button"
              className="w-full flex items-center gap-3 p-2 rounded-lg bg-secondary/50 hover:bg-secondary transition-colors text-left"
              onClick={() => setActiveSubPanel("telnet-theme-select")}
            >
              <div
                className="w-12 h-8 rounded-md border border-border/60 flex items-center justify-center text-[6px] font-mono overflow-hidden"
                style={{
                  backgroundColor:
                    TERMINAL_THEMES.find(
                      (t) =>
                        t.id ===
                        (form.protocols?.find((p) => p.protocol === "telnet")
                          ?.theme ||
                          form.theme ||
                          "flexoki-dark"),
                    )?.colors.background || "#100F0F",
                  color:
                    TERMINAL_THEMES.find(
                      (t) =>
                        t.id ===
                        (form.protocols?.find((p) => p.protocol === "telnet")
                          ?.theme ||
                          form.theme ||
                          "flexoki-dark"),
                    )?.colors.foreground || "#CECDC3",
                }}
              >
                <div className="p-0.5">
                  <div
                    style={{
                      color: TERMINAL_THEMES.find(
                        (t) =>
                          t.id ===
                          (form.protocols?.find((p) => p.protocol === "telnet")
                            ?.theme ||
                            form.theme ||
                            "flexoki-dark"),
                      )?.colors.green,
                    }}
                  >
                    $
                  </div>
                </div>
              </div>
              <span className="text-sm flex-1">
                {TERMINAL_THEMES.find(
                  (t) =>
                    t.id ===
                    (form.protocols?.find((p) => p.protocol === "telnet")
                      ?.theme ||
                      form.theme ||
                      "flexoki-dark"),
                )?.name || "Flexoki Dark"}
              </span>
            </button>
          </Card>
        ) : (
          <Button
            variant="ghost"
            className="w-full h-10 justify-start gap-2 border border-dashed border-border/60"
            onClick={() => {
              update("telnetEnabled", true);
              update("telnetPort", 23);
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

export default HostDetailsPanel;
