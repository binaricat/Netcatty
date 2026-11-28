import {
  Building2,
  Eye,
  EyeOff,
  FileKey,
  Globe,
  Key,
  KeyRound,
  Plug,
  Plus,
  Shield,
  Terminal,
  Trash2,
  User,
  UserCheck,
  X,
} from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";
import {
  DEFAULT_RDP_PORT,
  DEFAULT_VNC_PORT,
  formatVncDisplayNumber,
  parseVncPortOrDisplay,
} from "../domain/remoteDesktop";
import { cn } from "../lib/utils";
import type { GroupConfig, Identity, RdpConfig, SSHKey, VncConfig } from "../types";
import { RdpProtocolIcon, SshTunnelIcon, VncProtocolIcon } from "./icons/RemoteDesktopIcons";
import { HOST_AUTH_METHOD_CHOICES, shouldForceAuthMethodReselect } from "./HostDetailsConnectionSections";
import { parseOptionalPortInput } from "./HostDetailsPanel.helpers";
import { HostDetailsSection, HostDetailsSettingRow } from "./host-details";
import { IdentitySuggestInput } from "./host-details/IdentitySuggestInput";
import { TerminalEncodingSelect } from "./TerminalEncodingSelect";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "./ui/select";
import { Switch } from "./ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { SshCredentialPickerSection } from "./vault/SshCredentialPickerSection";

export type GroupEditableProtocol = "ssh" | "rdp" | "vnc" | "telnet";

export interface GroupRemoteDesktopCredentialDraft {
  username: string;
  password: string;
}

type Translate = (key: string, params?: Record<string, unknown>) => string;

interface GroupProtocolCredentialsSectionProps {
  t: Translate;
  activeProtocolTab: GroupEditableProtocol;
  onSelectProtocolTab: (tab: GroupEditableProtocol) => void;
  enabledProtocols: Record<GroupEditableProtocol, boolean>;
  onEnableProtocol: (protocol: GroupEditableProtocol) => void;
  onRemoveProtocol: (protocol: GroupEditableProtocol) => void;
  form: Partial<GroupConfig>;
  inheritedDefaults: Partial<GroupConfig>;
  update: <K extends keyof GroupConfig>(key: K, value: GroupConfig[K] | undefined) => void;
  updateRdpConfig: (patch: Partial<RdpConfig>) => void;
  updateVncConfig: (patch: Partial<VncConfig>) => void;
  availableKeys: SSHKey[];
  identities: Identity[];
  keysByCategory: { key: SSHKey[]; certificate: SSHKey[] };
  effectiveSshIdentityId?: string;
  effectiveTelnetIdentityId?: string;
  effectiveRdpIdentityId?: string;
  effectiveVncIdentityId?: string;
  onSelectSshIdentity: (identityId: string) => void;
  onSelectTelnetIdentity: (identityId: string) => void;
  onSelectRdpIdentity: (identity: Identity | undefined, identityId?: string) => void;
  onSelectVncIdentity: (identity: Identity | undefined, identityId?: string) => void;
  showPassword: boolean;
  setShowPassword: (show: boolean) => void;
  showTelnetPassword: boolean;
  setShowTelnetPassword: (show: boolean) => void;
  selectedCredentialType: "key" | "certificate" | "localKeyFile" | null;
  setSelectedCredentialType: (type: "key" | "certificate" | "localKeyFile" | null) => void;
  credentialPopoverOpen: boolean;
  setCredentialPopoverOpen: (open: boolean) => void;
  newKeyFilePath: string;
  setNewKeyFilePath: (path: string) => void;
  remoteDesktopCredentialDrafts: {
    rdp?: GroupRemoteDesktopCredentialDraft;
    vnc?: GroupRemoteDesktopCredentialDraft;
  };
  onRemoteDesktopCredentialDraftChange: (
    protocol: "rdp" | "vnc",
    draft:
      | GroupRemoteDesktopCredentialDraft
      | undefined
      | ((prev: GroupRemoteDesktopCredentialDraft | undefined) => GroupRemoteDesktopCredentialDraft | undefined),
  ) => void;
}

const PROTOCOL_TABS = [
  {
    id: "ssh" as const,
    label: "SSH",
    icon: <Shield size={13} />,
    activeIcon: "text-sky-500",
  },
  {
    id: "rdp" as const,
    label: "RDP",
    icon: <RdpProtocolIcon size={13} />,
    activeIcon: "text-blue-500",
  },
  {
    id: "vnc" as const,
    label: "VNC",
    icon: <VncProtocolIcon size={13} />,
    activeIcon: "text-teal-500",
  },
  {
    id: "telnet" as const,
    label: "Telnet",
    icon: <Terminal size={13} />,
    activeIcon: "text-amber-500",
  },
] as const;

const PROTOCOL_LABELS: Record<GroupEditableProtocol, string> = {
  ssh: "SSH",
  rdp: "RDP",
  vnc: "VNC",
  telnet: "Telnet",
};

export const GroupProtocolCredentialsSection: React.FC<GroupProtocolCredentialsSectionProps> = ({
  t,
  activeProtocolTab,
  onSelectProtocolTab,
  enabledProtocols,
  onEnableProtocol,
  onRemoveProtocol,
  form,
  inheritedDefaults,
  update,
  updateRdpConfig,
  updateVncConfig,
  availableKeys,
  identities,
  keysByCategory,
  effectiveSshIdentityId,
  effectiveTelnetIdentityId,
  effectiveRdpIdentityId,
  effectiveVncIdentityId,
  onSelectSshIdentity,
  onSelectTelnetIdentity,
  onSelectRdpIdentity,
  onSelectVncIdentity,
  showPassword,
  setShowPassword,
  showTelnetPassword,
  setShowTelnetPassword,
  selectedCredentialType,
  setSelectedCredentialType,
  credentialPopoverOpen,
  setCredentialPopoverOpen,
  newKeyFilePath,
  setNewKeyFilePath,
  remoteDesktopCredentialDrafts,
  onRemoteDesktopCredentialDraftChange,
}) => {
  const isCurrentTabEnabled = enabledProtocols[activeProtocolTab];
  const [showRdpPassword, setShowRdpPassword] = useState(false);
  const [showVncPassword, setShowVncPassword] = useState(false);

  const [vncPortText, setVncPortText] = useState<string>(() =>
    form.vncConfig?.port !== undefined ? String(form.vncConfig.port) : "",
  );

  useEffect(() => {
    setVncPortText(form.vncConfig?.port !== undefined ? String(form.vncConfig.port) : "");
  }, [form.vncConfig?.port]);

  const passwordCompatibleIdentities = useMemo(
    () =>
      identities.filter(
        (identity) => identity.authMethod === "password" || Boolean(identity.password),
      ),
    [identities],
  );

  const selectedSshIdentity = useMemo(
    () => (effectiveSshIdentityId ? identities.find((i) => i.id === effectiveSshIdentityId) : undefined),
    [effectiveSshIdentityId, identities],
  );
  const selectedTelnetIdentity = useMemo(
    () => (effectiveTelnetIdentityId ? identities.find((i) => i.id === effectiveTelnetIdentityId) : undefined),
    [effectiveTelnetIdentityId, identities],
  );
  const selectedRdpIdentity = useMemo(
    () => (effectiveRdpIdentityId ? identities.find((i) => i.id === effectiveRdpIdentityId) : undefined),
    [effectiveRdpIdentityId, identities],
  );
  const selectedVncIdentity = useMemo(
    () => (effectiveVncIdentityId ? identities.find((i) => i.id === effectiveVncIdentityId) : undefined),
    [effectiveVncIdentityId, identities],
  );

  const effectiveSshAuthMethod = form.authMethod ?? inheritedDefaults.authMethod ?? "auto";
  const resolvedAuthMethod = HOST_AUTH_METHOD_CHOICES.some(([value]) => value === effectiveSshAuthMethod)
    ? effectiveSshAuthMethod
    : "auto";
  const selectedAuthMethodLabel = t(
    HOST_AUTH_METHOD_CHOICES.find(([value]) => value === resolvedAuthMethod)?.[1] ?? "hostDetails.auth.auto",
  );

  const selectSshAuthMethod = (nextMethod: "auto" | "password" | "key" | "certificate") => {
    if (nextMethod === "auto" || nextMethod === "password") {
      update("authMethod", nextMethod === "auto" ? undefined : "password");
      update("identityFileId", undefined);
      update("identityFilePaths", undefined);
      setSelectedCredentialType(null);
      setCredentialPopoverOpen(false);
      return;
    }
    update("authMethod", nextMethod);
    setSelectedCredentialType(nextMethod);
    setCredentialPopoverOpen(false);
  };

  // Effective RDP/VNC display state (merging parent group defaults underneath current group edits)
  const inheritedRdp = inheritedDefaults.rdpConfig;
  const effectiveRdp = { ...(inheritedRdp ?? {}), ...(form.rdpConfig ?? {}) };
  const rdpTunneled = effectiveRdp.tunnelViaHostSsh ?? true;
  const rdpUseHostCreds = !effectiveRdpIdentityId && (
    form.rdpConfig?.useHostCredentials !== undefined
      ? form.rdpConfig.useHostCredentials
      : form.rdpConfig?.username?.trim()
        ? false
        : (inheritedRdp?.useHostCredentials === true)
  );

  const inheritedVnc = inheritedDefaults.vncConfig;
  const effectiveVnc = { ...(inheritedVnc ?? {}), ...(form.vncConfig ?? {}) };
  const vncTunneled = effectiveVnc.tunnelViaHostSsh ?? true;
  const vncUseHostCreds = !effectiveVncIdentityId && (
    form.vncConfig?.useHostCredentials !== undefined
      ? form.vncConfig.useHostCredentials
      : form.vncConfig?.username?.trim()
        ? false
        : (inheritedVnc?.useHostCredentials === true)
  );
  const vncDisplayLabel = formatVncDisplayNumber(
    form.vncConfig?.port ?? inheritedVnc?.port ?? DEFAULT_VNC_PORT,
  );

  return (
    <HostDetailsSection
      icon={<KeyRound size={14} className="text-muted-foreground" />}
      title={t("hostDetails.section.portCredentials")}
      className="overflow-hidden"
    >
      {/* Unified 4-protocol flat segmented control matching HostDetailsConnectionSections */}
      <div
        className="grid grid-cols-4 gap-1 rounded-lg bg-secondary/60 p-1"
        role="radiogroup"
        aria-label={t("hostDetails.protocol.label")}
      >
        {PROTOCOL_TABS.map((item) => {
          const active = activeProtocolTab === item.id;
          const isEnabled = enabledProtocols[item.id];
          return (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={active}
              data-group-protocol={item.id}
              onClick={() => onSelectProtocolTab(item.id)}
              className={cn(
                "relative flex h-8 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors",
                active
                  ? "bg-background text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <span
                className={cn(
                  "shrink-0 transition-colors",
                  active || isEnabled ? item.activeIcon : "opacity-60",
                )}
              >
                {item.icon}
              </span>
              <span className="truncate leading-none">{item.label}</span>
              {isEnabled && (
                <span
                  className="h-1.5 w-1.5 rounded-full bg-primary shrink-0"
                  aria-hidden="true"
                />
              )}
            </button>
          );
        })}
      </div>

      {!isCurrentTabEnabled ? (
        <div className="rounded-lg border border-dashed border-border/60 bg-transparent px-3 py-5 text-center space-y-3">
          <p className="text-xs text-muted-foreground">
            {t("vault.groups.details.protocolNotEnabledDesc", {
              protocol: PROTOCOL_LABELS[activeProtocolTab],
            })}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9 gap-1.5 px-4 text-xs font-medium"
              onClick={() => onEnableProtocol(activeProtocolTab)}
            >
              <Plus size={14} />
              {t("hostDetails.protocol.addProtocol", {
                protocol: PROTOCOL_LABELS[activeProtocolTab],
              })}
            </Button>
          </div>
        </div>
      ) : activeProtocolTab === "rdp" ? (
        <div className="space-y-2">
          <HostDetailsSettingRow
            icon={<Plug />}
            label={t("hostDetails.rdp.portLabel")}
          >
            <Input
              type="number"
              min={1}
              max={65535}
              value={form.rdpConfig?.port ?? ""}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10);
                updateRdpConfig({ port: Number.isFinite(n) ? n : undefined });
              }}
              placeholder={String(inheritedRdp?.port ?? DEFAULT_RDP_PORT)}
              className="h-8 w-44 text-center font-mono text-sm"
            />
          </HostDetailsSettingRow>

          <HostDetailsSettingRow
            icon={<SshTunnelIcon />}
            label={t("hostDetails.companion.tunnelViaSsh")}
            hint={t("hostDetails.companion.tunnelViaSshDesc")}
          >
            <Switch
              checked={rdpTunneled}
              onCheckedChange={(checked) => updateRdpConfig({ tunnelViaHostSsh: checked })}
            />
          </HostDetailsSettingRow>

          {rdpTunneled && (
            <HostDetailsSettingRow
              icon={<Globe />}
              label={t("hostDetails.companion.tunnelTargetHost")}
            >
              <Input
                value={form.rdpConfig?.tunnelTargetHost ?? ""}
                onChange={(e) =>
                  updateRdpConfig({ tunnelTargetHost: e.target.value || undefined })
                }
                placeholder={inheritedRdp?.tunnelTargetHost || "127.0.0.1"}
                className="h-8 w-44 font-mono text-sm"
              />
            </HostDetailsSettingRow>
          )}

          <HostDetailsSettingRow
            icon={<KeyRound />}
            label={t("hostDetails.companion.credentials.host")}
          >
            <Switch
              checked={rdpUseHostCreds}
              onCheckedChange={(checked) => {
                if (checked) {
                  onRemoteDesktopCredentialDraftChange("rdp", undefined);
                  updateRdpConfig({
                    useHostCredentials: true,
                    identityId: undefined,
                    username: undefined,
                  });
                } else {
                  updateRdpConfig({ useHostCredentials: false });
                }
              }}
            />
          </HostDetailsSettingRow>

          {!rdpUseHostCreds && (
            <div className="space-y-2">
              {effectiveRdpIdentityId ? (
                <div className="flex items-center gap-2 h-10 px-3 rounded-lg border border-border/60 bg-transparent">
                  <UserCheck size={14} className="text-muted-foreground shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">
                      {selectedRdpIdentity
                        ? selectedRdpIdentity.label
                        : t("hostDetails.identity.missing")}
                    </div>
                  </div>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0"
                        onClick={() => onSelectRdpIdentity(undefined, "")}
                      >
                        <X size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("common.clear")}</TooltipContent>
                  </Tooltip>
                </div>
              ) : (
                <>
                  <IdentitySuggestInput
                    value={remoteDesktopCredentialDrafts.rdp?.username ?? form.rdpConfig?.username ?? ""}
                    onChange={(next) => {
                      updateRdpConfig({
                        username: next || undefined,
                        ...(inheritedRdp?.useHostCredentials ? { useHostCredentials: false } : {}),
                      });
                      onRemoteDesktopCredentialDraftChange("rdp", (prev) => ({
                        username: next,
                        password: prev?.password ?? "",
                      }));
                    }}
                    placeholder={inheritedRdp?.username || t("hostDetails.rdp.usernamePlaceholder")}
                    identities={passwordCompatibleIdentities}
                    availableKeys={availableKeys}
                    onSelectIdentity={(identity) => {
                      onRemoteDesktopCredentialDraftChange("rdp", undefined);
                      onSelectRdpIdentity(identity, identity.id);
                    }}
                    t={t}
                  />
                  <div className="relative">
                    <Input
                      type={showRdpPassword ? "text" : "password"}
                      value={remoteDesktopCredentialDrafts.rdp?.password ?? ""}
                      onChange={(e) => {
                        const password = e.target.value;
                        onRemoteDesktopCredentialDraftChange("rdp", (prev) => ({
                          username: prev?.username ?? form.rdpConfig?.username ?? "",
                          password,
                        }));
                      }}
                      placeholder={t("hostDetails.password.placeholder")}
                      className="h-10 rounded-lg pr-10 text-sm"
                    />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => setShowRdpPassword((prev) => !prev)}
                          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
                        >
                          {showRdpPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {showRdpPassword ? t("hostDetails.password.hide") : t("hostDetails.password.show")}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  {remoteDesktopCredentialDrafts.rdp?.password ? (
                    <p className="px-1 text-[11px] text-muted-foreground">
                      {t("hostDetails.companion.credentials.manualHint")}
                    </p>
                  ) : null}
                </>
              )}
            </div>
          )}

          <HostDetailsSettingRow
            icon={<Building2 />}
            label={t("hostDetails.rdp.domainLabel")}
          >
            <Input
              value={form.rdpConfig?.domain ?? ""}
              onChange={(e) => updateRdpConfig({ domain: e.target.value || undefined })}
              placeholder={inheritedRdp?.domain || t("hostDetails.rdp.domainPlaceholder")}
              className="h-8 w-44 text-sm"
            />
          </HostDetailsSettingRow>
        </div>
      ) : activeProtocolTab === "vnc" ? (
        <div className="space-y-2">
          <HostDetailsSettingRow
            icon={<Plug />}
            label={t("hostDetails.vnc.portLabel")}
          >
            <div className="flex items-center gap-1.5 w-44">
              <Input
                value={vncPortText}
                onChange={(e) => {
                  const raw = e.target.value;
                  setVncPortText(raw);
                  if (!raw.trim()) {
                    updateVncConfig({ port: undefined });
                    return;
                  }
                  const parsed = parseVncPortOrDisplay(raw);
                  if (parsed !== null) {
                    updateVncConfig({ port: parsed });
                  }
                }}
                onBlur={() => {
                  if (!vncPortText.trim()) {
                    updateVncConfig({ port: undefined });
                    return;
                  }
                  const parsed = parseVncPortOrDisplay(vncPortText);
                  if (parsed !== null) {
                    setVncPortText(String(parsed));
                    updateVncConfig({ port: parsed });
                  } else {
                    setVncPortText(form.vncConfig?.port !== undefined ? String(form.vncConfig.port) : "");
                  }
                }}
                placeholder={
                  inheritedVnc?.port
                    ? String(inheritedVnc.port)
                    : t("hostDetails.vnc.displayPlaceholder")
                }
                className="h-8 flex-1 min-w-0 text-center font-mono text-sm"
              />
              {vncDisplayLabel ? (
                <span className="rounded border border-border/60 bg-background px-1.5 py-0.5 text-xs font-mono text-muted-foreground shrink-0">
                  {vncDisplayLabel}
                </span>
              ) : null}
            </div>
          </HostDetailsSettingRow>

          <HostDetailsSettingRow
            icon={<SshTunnelIcon />}
            label={t("hostDetails.companion.tunnelViaSsh")}
            hint={t("hostDetails.companion.tunnelViaSshDesc")}
          >
            <Switch
              checked={vncTunneled}
              onCheckedChange={(checked) => updateVncConfig({ tunnelViaHostSsh: checked })}
            />
          </HostDetailsSettingRow>

          {vncTunneled && (
            <HostDetailsSettingRow
              icon={<Globe />}
              label={t("hostDetails.companion.tunnelTargetHost")}
            >
              <Input
                value={form.vncConfig?.tunnelTargetHost ?? ""}
                onChange={(e) =>
                  updateVncConfig({ tunnelTargetHost: e.target.value || undefined })
                }
                placeholder={inheritedVnc?.tunnelTargetHost || "127.0.0.1"}
                className="h-8 w-44 font-mono text-sm"
              />
            </HostDetailsSettingRow>
          )}

          <HostDetailsSettingRow
            icon={<KeyRound />}
            label={t("hostDetails.companion.credentials.host")}
          >
            <Switch
              checked={vncUseHostCreds}
              onCheckedChange={(checked) => {
                if (checked) {
                  onRemoteDesktopCredentialDraftChange("vnc", undefined);
                  updateVncConfig({
                    useHostCredentials: true,
                    identityId: undefined,
                    username: undefined,
                  });
                } else {
                  updateVncConfig({ useHostCredentials: false });
                }
              }}
            />
          </HostDetailsSettingRow>

          {!vncUseHostCreds && (
            <div className="space-y-2">
              {effectiveVncIdentityId ? (
                <div className="flex items-center gap-2 h-10 px-3 rounded-lg border border-border/60 bg-transparent">
                  <UserCheck size={14} className="text-muted-foreground shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">
                      {selectedVncIdentity
                        ? selectedVncIdentity.label
                        : t("hostDetails.identity.missing")}
                    </div>
                  </div>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0"
                        onClick={() => onSelectVncIdentity(undefined, "")}
                      >
                        <X size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("common.clear")}</TooltipContent>
                  </Tooltip>
                </div>
              ) : (
                <>
                  <IdentitySuggestInput
                    value={remoteDesktopCredentialDrafts.vnc?.username ?? form.vncConfig?.username ?? ""}
                    onChange={(next) => {
                      updateVncConfig({
                        username: next || undefined,
                        ...(inheritedVnc?.useHostCredentials ? { useHostCredentials: false } : {}),
                      });
                      onRemoteDesktopCredentialDraftChange("vnc", (prev) => ({
                        username: next,
                        password: prev?.password ?? "",
                      }));
                    }}
                    placeholder={inheritedVnc?.username || t("hostDetails.vnc.usernamePlaceholder")}
                    identities={passwordCompatibleIdentities}
                    availableKeys={availableKeys}
                    onSelectIdentity={(identity) => {
                      onRemoteDesktopCredentialDraftChange("vnc", undefined);
                      onSelectVncIdentity(identity, identity.id);
                    }}
                    t={t}
                  />
                  <div className="relative">
                    <Input
                      type={showVncPassword ? "text" : "password"}
                      value={remoteDesktopCredentialDrafts.vnc?.password ?? ""}
                      onChange={(e) => {
                        const password = e.target.value;
                        onRemoteDesktopCredentialDraftChange("vnc", (prev) => ({
                          username: prev?.username ?? form.vncConfig?.username ?? "",
                          password,
                        }));
                      }}
                      placeholder={t("hostDetails.password.placeholder")}
                      className="h-10 rounded-lg pr-10 text-sm"
                    />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => setShowVncPassword((prev) => !prev)}
                          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
                        >
                          {showVncPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {showVncPassword ? t("hostDetails.password.hide") : t("hostDetails.password.show")}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  {remoteDesktopCredentialDrafts.vnc?.password ? (
                    <p className="px-1 text-[11px] text-muted-foreground">
                      {t("hostDetails.companion.credentials.manualHint")}
                    </p>
                  ) : null}
                </>
              )}
            </div>
          )}
        </div>
      ) : activeProtocolTab === "telnet" ? (
        <>
          <div className="flex items-center gap-2">
            <div className="flex-1 min-w-0 h-10 flex items-center gap-2 bg-transparent px-1">
              <Plug size={14} className="text-muted-foreground shrink-0" />
              <span className="text-sm font-medium text-foreground">{t("hostDetails.telnetOn")}</span>
              <div className="ml-auto w-1/2 min-w-0 flex items-center gap-2 justify-end">
                <Input
                  type="number"
                  value={form.telnetPort ?? ""}
                  onChange={(e) => update("telnetPort", parseOptionalPortInput(e.target.value))}
                  placeholder={inheritedDefaults.telnetPort ? String(inheritedDefaults.telnetPort) : "23"}
                  className="h-8 flex-1 min-w-0 text-center font-mono text-sm"
                />
                <span className="text-xs text-muted-foreground shrink-0">
                  {t("hostDetails.port")}
                </span>
              </div>
            </div>
          </div>

          <div className="grid gap-2">
            {effectiveTelnetIdentityId ? (
              <div className="flex items-center gap-2 h-10 px-3 rounded-lg border border-border/60 bg-transparent">
                <UserCheck size={14} className="text-muted-foreground shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">
                    {selectedTelnetIdentity
                      ? `${selectedTelnetIdentity.username} - ${selectedTelnetIdentity.label}`
                      : t("hostDetails.identity.missing")}
                  </div>
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={() => onSelectTelnetIdentity("")}
                    >
                      <X size={14} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t("common.clear")}</TooltipContent>
                </Tooltip>
              </div>
            ) : (
              <>
                <IdentitySuggestInput
                  value={form.telnetUsername || ""}
                  onChange={(next) => update("telnetUsername", next)}
                  placeholder={inheritedDefaults.telnetUsername || t("hostDetails.telnet.username")}
                  identities={passwordCompatibleIdentities}
                  availableKeys={availableKeys}
                  onSelectIdentity={(identity) => onSelectTelnetIdentity(identity.id)}
                  t={t}
                />
                <div className="relative">
                  <Input
                    placeholder={t("hostDetails.telnet.password")}
                    type={showTelnetPassword ? "text" : "password"}
                    value={form.telnetPassword || ""}
                    onChange={(e) => update("telnetPassword", e.target.value)}
                    className="h-10 rounded-lg pr-10"
                  />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => setShowTelnetPassword(!showTelnetPassword)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {showTelnetPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {showTelnetPassword ? t("hostDetails.password.hide") : t("hostDetails.password.show")}
                    </TooltipContent>
                  </Tooltip>
                </div>
              </>
            )}

            <TerminalEncodingSelect
              value={form.charset}
              inheritedValue={inheritedDefaults.charset}
              onValueChange={(value) => update("charset", value)}
            />
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <div className="flex-1 min-w-0 h-10 flex items-center gap-2 bg-transparent px-1">
              <Plug size={14} className="text-muted-foreground shrink-0" />
              <span className="text-sm font-medium text-foreground">SSH on</span>
              <div className="ml-auto w-1/2 min-w-0 flex items-center gap-2 justify-end">
                <Input
                  type="number"
                  value={form.port ?? ""}
                  onChange={(e) => update("port", e.target.value ? Number(e.target.value) : undefined)}
                  placeholder={inheritedDefaults.port ? String(inheritedDefaults.port) : "22"}
                  className="h-8 flex-1 min-w-0 text-center"
                />
                <span className="text-xs text-muted-foreground">
                  {t("hostDetails.port")}
                </span>
              </div>
            </div>
          </div>

          <div className="grid gap-2">
            <HostDetailsSettingRow
              label={t("hostDetails.auth.method")}
              hint={t(`hostDetails.auth.${resolvedAuthMethod}.desc`)}
            >
              <Select
                value={resolvedAuthMethod}
                onValueChange={(val) =>
                  selectSshAuthMethod(val as "auto" | "password" | "key" | "certificate")
                }
              >
                <SelectTrigger
                  className="h-8 w-32 gap-2"
                  aria-label={t("hostDetails.auth.method")}
                >
                  <span className="min-w-0 flex-1 truncate text-left">
                    {selectedAuthMethodLabel}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  {HOST_AUTH_METHOD_CHOICES.map(([value, labelKey]) => (
                    <SelectItem
                      key={value}
                      value={value}
                      textValue={t(labelKey)}
                      onPointerUp={() => {
                        if (shouldForceAuthMethodReselect(value, resolvedAuthMethod)) {
                          selectSshAuthMethod(value);
                        }
                      }}
                      onKeyDown={(event) => {
                        if (
                          (event.key === "Enter" || event.key === " ")
                          && shouldForceAuthMethodReselect(value, resolvedAuthMethod)
                        ) {
                          selectSshAuthMethod(value);
                        }
                      }}
                    >
                      {t(labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </HostDetailsSettingRow>

            {effectiveSshIdentityId ? (
              <div className="flex items-center gap-2 h-10 px-3 rounded-md border border-border/70 bg-secondary/60">
                <User size={16} className="text-muted-foreground shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">
                    {selectedSshIdentity
                      ? selectedSshIdentity.label
                      : t("hostDetails.identity.missing")}
                  </div>
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={() => onSelectSshIdentity("")}
                    >
                      <X size={14} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t("common.clear")}</TooltipContent>
                </Tooltip>
              </div>
            ) : (
              <>
                <IdentitySuggestInput
                  value={form.username || ""}
                  onChange={(next) => update("username", next || undefined)}
                  placeholder={inheritedDefaults.username || t("hostDetails.username.placeholder")}
                  identities={identities}
                  availableKeys={availableKeys}
                  onSelectIdentity={(identity) => onSelectSshIdentity(identity.id)}
                  t={t}
                />

                <div className="relative">
                  <Input
                    placeholder={t("hostDetails.password.placeholder")}
                    type={showPassword ? "text" : "password"}
                    value={form.password || ""}
                    onChange={(e) => update("password", e.target.value || undefined)}
                    className="h-10 pr-10"
                  />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {showPassword ? t("hostDetails.password.hide") : t("hostDetails.password.show")}
                    </TooltipContent>
                  </Tooltip>
                </div>

                {form.password && (
                  <div className="flex items-center justify-between py-1">
                    <span className="text-xs text-muted-foreground">
                      {t("hostDetails.password.save")}
                    </span>
                    <Switch
                      checked={form.savePassword ?? true}
                      onCheckedChange={(val) => update("savePassword", val)}
                    />
                  </div>
                )}

                {!form.identityFileId && form.identityFilePaths && form.identityFilePaths.length > 0 && (
                  <div className="space-y-1.5">
                    {form.identityFilePaths.map((keyPath, idx) => (
                      <div
                        key={idx}
                        className="flex items-center gap-2 p-2 rounded-md bg-secondary/50 border border-border/60 overflow-hidden"
                      >
                        <FileKey size={14} className="text-primary shrink-0" />
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="text-xs w-0 flex-1 truncate font-mono cursor-default">
                              {keyPath}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>{keyPath}</TooltipContent>
                        </Tooltip>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 shrink-0"
                          onClick={() => {
                            const paths = (form.identityFilePaths || []).filter((_, i) => i !== idx);
                            update("identityFilePaths", paths.length > 0 ? paths : undefined);
                            if (paths.length === 0) update("authMethod", undefined);
                          }}
                        >
                          <Trash2 size={12} />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}

                {form.identityFileId && (
                  <div className="flex items-center gap-2 min-w-0 overflow-hidden p-2 rounded-md bg-secondary/50 border border-border/60">
                    {form.authMethod === "certificate" ? (
                      <Shield size={14} className="text-primary shrink-0" />
                    ) : (
                      <Key size={14} className="text-primary shrink-0" />
                    )}
                    <span className="text-sm min-w-0 flex-1 truncate">
                      {availableKeys.find((k) => k.id === form.identityFileId)?.label || "Key"}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 shrink-0"
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

                <SshCredentialPickerSection
                  visible={!form.identityFileId}
                  identityFileId={form.identityFileId}
                  keysByCategory={keysByCategory}
                  selectedCredentialType={selectedCredentialType}
                  setSelectedCredentialType={setSelectedCredentialType}
                  credentialPopoverOpen={credentialPopoverOpen}
                  setCredentialPopoverOpen={setCredentialPopoverOpen}
                  newKeyFilePath={newKeyFilePath}
                  setNewKeyFilePath={setNewKeyFilePath}
                  onSelectKey={(val) => {
                    update("identityFileId", val);
                    update("authMethod", "key");
                    setSelectedCredentialType(null);
                  }}
                  onSelectCertificate={(val) => {
                    update("identityFileId", val);
                    update("authMethod", "certificate");
                    setSelectedCredentialType(null);
                  }}
                  onAddLocalKeyFile={(filePath, source) => {
                    const paths = [...(form.identityFilePaths || []), filePath];
                    update("identityFilePaths", paths);
                    update("identityFileId", undefined);
                    update("authMethod", "key");
                    if (source === "input") {
                      setNewKeyFilePath("");
                    }
                  }}
                  onCancelLocalKeyFile={() => {
                    setSelectedCredentialType(null);
                    setNewKeyFilePath("");
                  }}
                  t={t}
                />
              </>
            )}
          </div>
        </>
      )}

      {isCurrentTabEnabled && (
        <div className="flex items-center justify-end border-t border-border/40 pt-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-destructive"
            onClick={() => onRemoveProtocol(activeProtocolTab)}
          >
            <Trash2 size={12} />
            {t("hostDetails.protocol.removeProtocol", {
              protocol: PROTOCOL_LABELS[activeProtocolTab],
            })}
          </Button>
        </div>
      )}
    </HostDetailsSection>
  );
};
