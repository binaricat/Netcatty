import React, { useEffect, useState } from "react";
import { Building2, ChevronDown, Eye, EyeOff, FileKey, FolderLock, Key, KeyRound, MapPin, Plug, Plus, Shapes, Shield, Terminal, Trash2, User, UserCheck, X } from "lucide-react";
import type { Host, Identity } from "../types";
import { applyHostAuthMethodSelection } from "../domain/sshAuth";
import {
  DEFAULT_RDP_PORT,
  DEFAULT_VNC_PORT,
  formatVncDisplayNumber,
  isRdpProtocol,
  isRemoteDesktopProtocol,
  isVncProtocol,
  parseVncPortOrDisplay,
} from "../domain/remoteDesktop";
import { cn } from "../lib/utils";
import { RdpProtocolIcon, VncProtocolIcon } from "./icons/RemoteDesktopIcons";
import { HostTotpFields } from "./HostTotpFields";
import { HostIconPicker } from "./HostIconPicker";
import { parseOptionalPortInput } from "./HostDetailsPanel.helpers";
import { TerminalEncodingSelect } from "./TerminalEncodingSelect";
import { Button } from "./ui/button";
import { HostDetailsSection, HostDetailsSettingRow } from "./host-details";
import { CompanionRemoteDesktopInlineFields } from "./host-details/CompanionRemoteDesktopSections";
import { IdentitySuggestInput } from "./host-details/IdentitySuggestInput";
import { Input } from "./ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "./ui/popover";
import { ScrollArea } from "./ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { SshCredentialPickerSection } from "./vault/SshCredentialPickerSection";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HostDetailsConnectionSectionsProps = Record<string, any>;

export const HOST_AUTH_METHOD_CHOICES = [
  ["auto", "hostDetails.auth.auto"],
  ["password", "hostDetails.auth.passwordOnly"],
  ["key", "hostDetails.auth.key"],
  ["certificate", "hostDetails.auth.certificate"],
] as const;

export function shouldForceAuthMethodReselect(
  nextMethod: "auto" | "password" | "key" | "certificate",
  currentMethod: "auto" | "password" | "key" | "certificate",
): boolean {
  // Radix Select skips onValueChange when the value is unchanged. Key/certificate
  // still need that path so re-opening the chooser keeps working.
  return (
    nextMethod === currentMethod
    && (nextMethod === "key" || nextMethod === "certificate")
  );
}


export const applyEffectiveHostAuthMethodSelection = (
  host: Host,
  authMethod: "auto" | "password" | "key" | "certificate",
  effectiveAuthMethod: "auto" | "password" | "key" | "certificate",
  effectiveUsername?: string,
): Host => {
  if (authMethod === effectiveAuthMethod) return host;
  const selected = applyHostAuthMethodSelection(host, authMethod, effectiveAuthMethod);
  return !selected.username?.trim() && effectiveUsername?.trim()
    ? { ...selected, username: effectiveUsername }
    : selected;
};

export const detachEffectiveHostIdentity = (host: Host, effectiveUsername?: string): Host => ({
  ...host,
  identityId: "",
  ...(!host.username?.trim() && effectiveUsername?.trim()
    ? { username: effectiveUsername }
    : {}),
});

export const removeSelectedHostCredential = (
  host: Host,
  effectiveAuthMethod: "auto" | "password" | "key" | "certificate",
  effectiveUsername?: string,
): Host => {
  const authMethod = host.password ? "password" : "auto";
  const selected = applyHostAuthMethodSelection(host, authMethod, effectiveAuthMethod);
  return !selected.username?.trim() && effectiveUsername?.trim()
    ? { ...selected, username: effectiveUsername }
    : selected;
};

export const HostDetailsConnectionSections: React.FC<HostDetailsConnectionSectionsProps> = ({
  t,
  form,
  setForm,
  update,
  groupDefaults,
  effectiveAuthMethod,
  effectiveUsername,
  effectiveIdentityId,
  selectedIdentity,
  clearIdentity,
  identities,
  identitySuggestionsOpen,
  filteredIdentitySuggestions,
  setIdentitySuggestionsOpen,
  availableKeys,
  applyIdentity,
  showPassword,
  setShowPassword,
  pendingReferenceKeyPath,
  setPendingReferenceKeyPath,
  selectedCredentialType,
  setSelectedCredentialType,
  credentialPopoverOpen,
  setCredentialPopoverOpen,
  keysByCategory,
  newKeyFilePath,
  setNewKeyFilePath,
  addLocalKeyFilePath,
  distroOptions,
  effectiveFormDistro,
  getDistroOptionLabel,
  totpFlushRef,
  onSelectPrimaryProtocol,
  activeProtocolTab,
  enabledProtocols,
  defaultConnectProtocol,
  effectiveConnectBehavior,
  onSelectProtocolTab,
  onEnableSecondaryProtocol,
  onSwitchOnlyProtocol,
  onSetDefaultProtocol,
  onSetConnectBehavior,
  onRemoveProtocol,
  onCreateIdentity,
  companionCredentialDrafts,
  onCompanionCredentialDraftChange,
  resolutionDraft,
  onResolutionDraftChange,
  effectiveTelnetPort,
  effectiveTelnetUsername,
  effectiveTelnetPassword,
  selectedTelnetIdentity,
  updateTelnetIdentity,
  showTelnetPassword = false,
  setShowTelnetPassword,
}) => {
  const fallbackPrimary: "ssh" | "rdp" | "vnc" | "telnet" =
    form.protocol === "rdp" || form.protocol === "vnc" || form.protocol === "telnet"
      ? form.protocol
      : "ssh";
  const resolvedEnabledProtocols: Record<"ssh" | "rdp" | "vnc" | "telnet", boolean> =
    enabledProtocols ?? {
      ssh:
        !form.protocol
        || form.protocol === "ssh"
        || form.protocol === "mosh"
        || form.protocol === "et"
        || Boolean(form.protocols?.some((p: { protocol?: string; enabled?: boolean }) => p.protocol === "ssh" && p.enabled)),
      rdp: form.protocol === "rdp" || form.rdpConfig?.enabled === true,
      vnc: form.protocol === "vnc" || form.vncConfig?.enabled === true,
      telnet: form.protocol === "telnet" || form.telnetEnabled === true,
    };
  const resolvedDefaultProtocol: "ssh" | "rdp" | "vnc" | "telnet" =
    defaultConnectProtocol ?? fallbackPrimary;
  const resolvedConnectBehavior: "ask" | "ssh" | "rdp" | "vnc" | "telnet" =
    effectiveConnectBehavior ?? resolvedDefaultProtocol;
  const currentTab: "ssh" | "rdp" | "vnc" | "telnet" =
    activeProtocolTab ?? fallbackPrimary;
  const enabledProtocolList = (["ssh", "rdp", "vnc", "telnet"] as const).filter(
    (proto) => resolvedEnabledProtocols[proto],
  );
  const enabledCount = enabledProtocolList.length;
  const isCurrentTabEnabled = resolvedEnabledProtocols[currentTab];
  const isRdpPrimary = isRdpProtocol(form.protocol);
  const isVncPrimary = isVncProtocol(form.protocol);
  const isRemoteDesktopPrimary = isRemoteDesktopProtocol(form.protocol);
  const isCompanionRdpTab = currentTab === "rdp" && resolvedEnabledProtocols.ssh && isCurrentTabEnabled;
  const isCompanionVncTab = currentTab === "vnc" && resolvedEnabledProtocols.ssh && isCurrentTabEnabled;
  const isStandaloneRdpTab = currentTab === "rdp" && !resolvedEnabledProtocols.ssh && isCurrentTabEnabled;
  const isStandaloneVncTab = currentTab === "vnc" && !resolvedEnabledProtocols.ssh && isCurrentTabEnabled;
  const isTelnetTab = currentTab === "telnet" && isCurrentTabEnabled;
  const protocolLabels: Record<"ssh" | "rdp" | "vnc" | "telnet", string> = {
    ssh: "SSH",
    rdp: "RDP",
    vnc: "VNC",
    telnet: "Telnet",
  };
  const canAddCurrentAsSecondary =
    !isCurrentTabEnabled
    && Boolean(onEnableSecondaryProtocol)
    && (
      (resolvedEnabledProtocols.ssh && (currentTab === "rdp" || currentTab === "vnc" || currentTab === "telnet"))
      || (!resolvedEnabledProtocols.ssh && currentTab === "ssh" && (resolvedEnabledProtocols.rdp || resolvedEnabledProtocols.vnc || resolvedEnabledProtocols.telnet))
    );

  const [vncPortText, setVncPortText] = useState<string>(() =>
    String(form.port ?? DEFAULT_VNC_PORT),
  );

  useEffect(() => {
    if (isVncPrimary) {
      setVncPortText(String(form.port ?? DEFAULT_VNC_PORT));
    }
  }, [form.id, form.port, isVncPrimary]);

  const handleTabClick = (next: "ssh" | "rdp" | "vnc" | "telnet") => {
    if (onSelectProtocolTab) {
      onSelectProtocolTab(next);
    } else if (onSelectPrimaryProtocol) {
      onSelectPrimaryProtocol(next);
    } else {
      update("protocol", next);
    }
  };

  const passwordCompatibleIdentities: Identity[] = (identities || []).filter(
    (identity: Identity) => identity.authMethod === "password" || Boolean(identity.password),
  );
  const vncDisplayLabel = isVncPrimary
    ? formatVncDisplayNumber(form.port ?? DEFAULT_VNC_PORT)
    : null;

  const selectAuthMethod = (authMethod: "auto" | "password" | "key" | "certificate") => {
    setForm((previous: Host) => applyEffectiveHostAuthMethodSelection(
      previous,
      authMethod,
      effectiveAuthMethod,
      effectiveUsername,
    ));
    if (authMethod === "auto" || authMethod === "password") {
      setPendingReferenceKeyPath(null);
      setSelectedCredentialType(null);
      setCredentialPopoverOpen(false);
      return;
    }
    setSelectedCredentialType(authMethod);
    setCredentialPopoverOpen(false);
  };

  const resolvedAuthMethod = HOST_AUTH_METHOD_CHOICES.some(([value]) => value === effectiveAuthMethod)
    ? effectiveAuthMethod
    : "auto";
  const selectedAuthMethodLabel = t(
    HOST_AUTH_METHOD_CHOICES.find(([value]) => value === resolvedAuthMethod)?.[1] ?? "hostDetails.auth.auto",
  );
  const effectiveEtEnabled = form.etEnabled ?? groupDefaults?.etEnabled;
  const effectiveProtocol = form.protocol ?? groupDefaults?.protocol;

  return (
  <>
        <HostDetailsSection
          icon={<MapPin size={14} className="text-muted-foreground" />}
          title={t("hostDetails.section.address")}
        >
          <Input
            placeholder={t("hostDetails.hostname.placeholder")}
            value={form.hostname}
            onChange={(e) => update("hostname", e.target.value)}
            className="h-10 w-full"
          />
        </HostDetailsSection>

        <HostDetailsSection
          icon={<KeyRound size={14} className="text-muted-foreground" />}
          title={t("hostDetails.section.portCredentials")}
          className="overflow-hidden"
        >
          {/* Primary protocol selector: minimalist flat segmented control */}
          <div
            className="grid grid-cols-4 gap-1 rounded-lg bg-secondary/60 p-1"
            role="radiogroup"
            aria-label={t("hostDetails.protocol.label")}
          >
            {(
              [
                {
                  id: "ssh",
                  label: "SSH",
                  icon: <Shield size={13} />,
                  activeIcon: "text-sky-500",
                },
                {
                  id: "rdp",
                  label: "RDP",
                  icon: <RdpProtocolIcon size={13} />,
                  activeIcon: "text-blue-500",
                },
                {
                  id: "vnc",
                  label: "VNC",
                  icon: <VncProtocolIcon size={13} />,
                  activeIcon: "text-teal-500",
                },
                {
                  id: "telnet",
                  label: "Telnet",
                  icon: <Terminal size={13} />,
                  activeIcon: "text-amber-500",
                },
              ] as const
            ).map((item) => {
              const active = currentTab === item.id;
              const isEnabled = resolvedEnabledProtocols[item.id];
              const isDefault = resolvedDefaultProtocol === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  data-primary-protocol={item.id}
                  onClick={() => handleTabClick(item.id)}
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
                  {enabledCount >= 2 && isEnabled && (
                    <span
                      className={cn(
                        "h-1.5 w-1.5 rounded-full shrink-0",
                        resolvedConnectBehavior !== "ask" && isDefault
                          ? "bg-primary"
                          : "bg-muted-foreground/45",
                      )}
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
                {t("hostDetails.protocol.notEnabledDesc", { protocol: protocolLabels[currentTab] })}
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 gap-1.5 px-4 text-xs font-medium"
                  onClick={() => {
                    if (canAddCurrentAsSecondary && onEnableSecondaryProtocol) {
                      onEnableSecondaryProtocol(currentTab);
                    } else {
                      onSwitchOnlyProtocol?.(currentTab);
                    }
                  }}
                >
                  <Plus size={14} />
                  {canAddCurrentAsSecondary
                    ? t("hostDetails.protocol.addProtocol", { protocol: protocolLabels[currentTab] })
                    : t("hostDetails.protocol.switchOnly", { protocol: protocolLabels[currentTab] })}
                </Button>
                {canAddCurrentAsSecondary && onSwitchOnlyProtocol ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-9 px-3 text-xs font-medium text-muted-foreground hover:text-foreground"
                    onClick={() => onSwitchOnlyProtocol(currentTab)}
                  >
                    {t("hostDetails.protocol.switchOnly", { protocol: protocolLabels[currentTab] })}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : isCompanionVncTab ? (
            <CompanionRemoteDesktopInlineFields
              protocol="vnc"
              form={form}
              setForm={setForm}
              identities={identities}
              availableKeys={availableKeys}
              onCreateIdentity={onCreateIdentity}
              credentialDraft={companionCredentialDrafts?.vnc}
              onCredentialDraftChange={(draft) => onCompanionCredentialDraftChange?.("vnc", draft)}
              t={t}
            />
          ) : isCompanionRdpTab ? (
            <CompanionRemoteDesktopInlineFields
              protocol="rdp"
              form={form}
              setForm={setForm}
              identities={identities}
              availableKeys={availableKeys}
              onCreateIdentity={onCreateIdentity}
              resolutionDraft={resolutionDraft}
              onResolutionDraftChange={onResolutionDraftChange}
              credentialDraft={companionCredentialDrafts?.rdp}
              onCredentialDraftChange={(draft) => onCompanionCredentialDraftChange?.("rdp", draft)}
              t={t}
            />
          ) : (isStandaloneRdpTab || isStandaloneVncTab) ? (
            <div className="space-y-2">
              <HostDetailsSettingRow
                icon={<Plug />}
                label={isRdpPrimary ? t("hostDetails.rdp.portLabel") : t("hostDetails.vnc.portLabel")}
              >
                {isVncPrimary ? (
                  <div className="flex items-center gap-1.5 w-44">
                    <Input
                      value={vncPortText}
                      onChange={(e) => {
                        const raw = e.target.value;
                        setVncPortText(raw);
                        const parsed = parseVncPortOrDisplay(raw);
                        if (parsed !== null) {
                          update("port", parsed);
                        }
                      }}
                      onBlur={() => {
                        const parsed = parseVncPortOrDisplay(vncPortText);
                        const resolved = parsed ?? DEFAULT_VNC_PORT;
                        setVncPortText(String(resolved));
                        update("port", resolved);
                      }}
                      placeholder={t("hostDetails.vnc.displayPlaceholder")}
                      className="h-8 flex-1 min-w-0 text-center font-mono text-sm"
                    />
                    {vncDisplayLabel ? (
                      <span className="rounded border border-border/60 bg-background px-1.5 py-0.5 text-xs font-mono text-muted-foreground shrink-0">
                        {vncDisplayLabel}
                      </span>
                    ) : null}
                  </div>
                ) : (
                  <Input
                    type="number"
                    value={form.port ?? ""}
                    onChange={(e) =>
                      update("port", e.target.value ? Number(e.target.value) : undefined)
                    }
                    placeholder={String(DEFAULT_RDP_PORT)}
                    className="h-8 w-44 text-center font-mono text-sm"
                  />
                )}
              </HostDetailsSettingRow>

              <div className="grid gap-2">
                {selectedIdentity ? (
                  <div className="flex items-center gap-2 h-10 px-3 rounded-lg border border-border/60 bg-transparent">
                    <UserCheck size={14} className="text-muted-foreground shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">
                        {selectedIdentity.label}
                      </div>
                    </div>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          onClick={clearIdentity}
                        >
                          <X size={14} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t("common.clear")}</TooltipContent>
                    </Tooltip>
                  </div>
                ) : effectiveIdentityId ? (
                  <div className="flex items-center gap-2 h-10 px-3 rounded-lg border border-border/60 bg-transparent">
                    <User size={16} className="text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">
                        {t("hostDetails.identity.missing")}
                      </div>
                    </div>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          onClick={clearIdentity}
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
                      value={form.username ?? ""}
                      onChange={(next) => update("username", next)}
                      placeholder={
                        isRdpPrimary
                          ? t("hostDetails.rdp.usernamePlaceholder")
                          : t("hostDetails.vnc.usernamePlaceholder")
                      }
                      identities={passwordCompatibleIdentities}
                      availableKeys={availableKeys}
                      onSelectIdentity={(identity) => {
                        applyIdentity(identity);
                        if (isRdpPrimary && identity.domain) {
                          setForm((prev: Host) => ({
                            ...prev,
                            rdpConfig: {
                              ...(prev.rdpConfig ?? {}),
                              domain: identity.domain,
                            },
                          }));
                        }
                      }}
                      t={t}
                    />

                    <div className="relative">
                      <Input
                        placeholder={t("hostDetails.password.placeholder")}
                        type={showPassword ? "text" : "password"}
                        value={form.password || ""}
                        onChange={(e) => update("password", e.target.value)}
                        className="h-10 rounded-lg pr-10"
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
                          onCheckedChange={(val) => update("savePassword" as keyof Host, val)}
                        />
                      </div>
                    )}

                    {isRdpPrimary ? (
                      <HostDetailsSettingRow
                        icon={<Building2 />}
                        label={t("hostDetails.rdp.domainLabel")}
                      >
                        <Input
                          placeholder={t("hostDetails.rdp.domainPlaceholder")}
                          value={form.rdpConfig?.domain ?? ""}
                          onChange={(e) =>
                            setForm((prev: Host) => ({
                              ...prev,
                              rdpConfig: {
                                ...(prev.rdpConfig ?? {}),
                                domain: e.target.value || undefined,
                              },
                            }))
                          }
                          className="h-8 w-44 text-sm"
                        />
                      </HostDetailsSettingRow>
                    ) : null}
                  </>
                )}
              </div>
            </div>
          ) : isTelnetTab ? (
            <>
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0 h-10 flex items-center gap-2 bg-transparent px-1">
                  <Plug size={14} className="text-muted-foreground shrink-0" />
                  <span className="text-sm font-medium text-foreground">{t("hostDetails.telnetOn")}</span>
                  <div className="ml-auto w-1/2 min-w-0 flex items-center gap-2 justify-end">
                    <Input
                      type="number"
                      value={effectiveTelnetPort ?? form.telnetPort ?? form.port ?? 23}
                      onChange={(e) => {
                        const parsed = parseOptionalPortInput(e.target.value);
                        setForm((prev: Host) => ({
                          ...prev,
                          ...(resolvedEnabledProtocols.ssh ? {} : { port: parsed }),
                          telnetPort: parsed,
                        }));
                      }}
                      placeholder="23"
                      className="h-8 flex-1 min-w-0 text-center font-mono text-sm"
                    />
                    <span className="text-xs text-muted-foreground shrink-0">
                      {t("hostDetails.port")}
                    </span>
                  </div>
                </div>
              </div>

              <div className="grid gap-2">
                {form.telnetIdentityId ? (
                  <div className="flex items-center gap-2 h-10 px-3 rounded-lg border border-border/60 bg-transparent">
                    <UserCheck size={14} className="text-muted-foreground shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">
                        {selectedTelnetIdentity
                          ? `${selectedTelnetIdentity.username} - ${selectedTelnetIdentity.label}`
                          : t("hostDetails.identity.missing")}
                      </div>
                    </div>
                    {updateTelnetIdentity && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0"
                        onClick={() => updateTelnetIdentity("")}
                      >
                        <X size={14} />
                      </Button>
                    )}
                  </div>
                ) : (
                  <>
                    <IdentitySuggestInput
                      value={effectiveTelnetUsername ?? form.telnetUsername ?? ""}
                      onChange={(next) =>
                        update("telnetUsername" as keyof Host, next)
                      }
                      placeholder={t("hostDetails.telnet.username")}
                      identities={updateTelnetIdentity ? passwordCompatibleIdentities : []}
                      availableKeys={availableKeys}
                      onSelectIdentity={(identity) => updateTelnetIdentity?.(identity.id)}
                      t={t}
                    />
                    <div className="relative">
                      <Input
                        placeholder={t("hostDetails.telnet.password")}
                        type={showTelnetPassword ? "text" : "password"}
                        value={effectiveTelnetPassword ?? form.telnetPassword ?? ""}
                        onChange={(e) =>
                          update("telnetPassword" as keyof Host, e.target.value)
                        }
                        className="h-10 rounded-lg pr-10"
                      />
                      {setShowTelnetPassword && (
                        <button
                          type="button"
                          onClick={() => setShowTelnetPassword(!showTelnetPassword)}
                          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
                        >
                          {showTelnetPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                        </button>
                      )}
                    </div>
                  </>
                )}

                <TerminalEncodingSelect
                  value={form.charset}
                  inheritedValue={groupDefaults?.charset}
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
                  placeholder={groupDefaults?.port ? String(groupDefaults.port) : "22"}
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
                onValueChange={(val) => selectAuthMethod(val as "auto" | "password" | "key" | "certificate")}
              >
                <SelectTrigger
                  className="h-8 w-32 gap-2"
                  aria-label={t("hostDetails.auth.method")}
                >
                  {/*
                    Radix Select only mirrors the selected item text after the
                    closed control is measured. Render the current label directly
                    so the default value is never blank on first paint.
                  */}
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
                        // Radix skips consumer onValueChange for an unchanged value.
                        // Key/certificate still need the same-item path to reopen the chooser.
                        if (shouldForceAuthMethodReselect(value, resolvedAuthMethod)) {
                          selectAuthMethod(value);
                        }
                      }}
                      onKeyDown={(event) => {
                        if (
                          (event.key === "Enter" || event.key === " ")
                          && shouldForceAuthMethodReselect(value, resolvedAuthMethod)
                        ) {
                          selectAuthMethod(value);
                        }
                      }}
                    >
                      {t(labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </HostDetailsSettingRow>
            {!effectiveEtEnabled && effectiveProtocol !== "et" && (
              <HostDetailsSettingRow
                label={t("hostDetails.auth.mfaFirst")}
                hint={t("hostDetails.auth.mfaFirst.desc")}
              >
                <Switch
                  checked={!!form.requiresMfa}
                  onCheckedChange={(val) => update("requiresMfa" as keyof Host, val)}
                />
              </HostDetailsSettingRow>
            )}
            {selectedIdentity ? (
              <div className="flex items-center gap-2 h-10 px-3 rounded-md border border-border/70 bg-secondary/60">
                <User size={16} className="text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">
                    {selectedIdentity.label}
                  </div>
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={clearIdentity}
                    >
                      <X size={14} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t("common.clear")}</TooltipContent>
                </Tooltip>
              </div>
            ) : effectiveIdentityId ? (
              <div className="flex items-center gap-2 h-10 px-3 rounded-md border border-border/70 bg-secondary/60">
                <User size={16} className="text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">
                    {t("hostDetails.identity.missing")}
                  </div>
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={clearIdentity}
                    >
                      <X size={14} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t("common.clear")}</TooltipContent>
                </Tooltip>
              </div>
            ) : (
              (() => {
                const hasIdentities = identities.length > 0;
                if (!hasIdentities) {
                  return (
                    <Input
                      placeholder={groupDefaults?.username || t("hostDetails.username.placeholder")}
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
                    {/*
                      Anchor (not Trigger): wrapping the username Input in
                      PopoverTrigger races focus→open with the same click's
                      toggle→close, which flashes saved identities then closes.
                      Anchor is not exempt from Radix outside dismissal (only
                      Trigger is), so tag it and ignore those events below.
                    */}
                    <PopoverAnchor asChild>
                      <div
                        className="relative"
                        data-identity-suggestions-anchor=""
                      >
                        <Input
                          placeholder={groupDefaults?.username || t("hostDetails.username.placeholder")}
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
                        <Tooltip>
                          <TooltipTrigger asChild>
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
                            >
                              <ChevronDown size={16} />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>{t("hostDetails.identity.suggestions")}</TooltipContent>
                        </Tooltip>
                      </div>
                    </PopoverAnchor>
                    <PopoverContent
                      className="p-0 border-border/60"
                      align="start"
                      sideOffset={4}
                      onOpenAutoFocus={(e) => e.preventDefault()}
                      onInteractOutside={(e) => {
                        const target = e.target as Element | null;
                        if (target?.closest("[data-identity-suggestions-anchor]")) {
                          e.preventDefault();
                        }
                      }}
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
                  <TooltipContent>{showPassword ? t("hostDetails.password.hide") : t("hostDetails.password.show")}</TooltipContent>
                </Tooltip>
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

            {/* Local key file paths display */}
            {!selectedIdentity && !form.identityFileId && form.identityFilePaths && form.identityFilePaths.length > 0 && (
              <div className="space-y-1.5">
                {form.identityFilePaths.map((keyPath, idx) => (
                  <div key={idx} className="flex items-center gap-2 p-2 rounded-md bg-secondary/50 border border-border/60 overflow-hidden">
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
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 shrink-0"
                      onClick={() => {
                        const paths = form.identityFilePaths?.filter((_, i) => i !== idx) || [];
                        update("identityFilePaths", paths.length > 0 ? paths : undefined);
                        if (keyPath === pendingReferenceKeyPath) {
                          setPendingReferenceKeyPath(null);
                        }
                      }}
                    >
                      <Trash2 size={12} />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {/* Selected credential display */}
            {!selectedIdentity && form.identityFileId && (
              <div className="flex items-center gap-2 min-w-0 overflow-hidden p-2 rounded-md bg-secondary/50 border border-border/60">
                {form.authMethod === "certificate" ? (
                  <Shield size={14} className="text-primary shrink-0" />
                ) : (
                  <Key size={14} className="text-primary shrink-0" />
                )}
                <span className="text-sm min-w-0 flex-1 truncate">
                  {availableKeys.find((k) => k.id === form.identityFileId)
                    ?.label || "Key"}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0"
                  onClick={() => {
                    setForm((previous: Host) => removeSelectedHostCredential(
                      previous,
                      effectiveAuthMethod,
                      effectiveUsername,
                    ));
                    setPendingReferenceKeyPath(null);
                    setSelectedCredentialType(null);
                  }}
                >
                  <X size={12} />
                </Button>
              </div>
            )}

            <SshCredentialPickerSection
              visible={!selectedIdentity && !form.identityFileId}
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
                update("identityFilePaths", undefined);
                setPendingReferenceKeyPath(null);
                setSelectedCredentialType(null);
              }}
              onSelectCertificate={(val) => {
                update("identityFileId", val);
                update("authMethod", "certificate");
                update("identityFilePaths", undefined);
                setPendingReferenceKeyPath(null);
                setSelectedCredentialType(null);
              }}
              onAddLocalKeyFile={(filePath) => {
                addLocalKeyFilePath(filePath);
              }}
              onCancelLocalKeyFile={() => {
                setSelectedCredentialType(null);
                setNewKeyFilePath("");
              }}
              t={t}
            />
            <HostTotpFields
              t={t}
              form={form}
              setForm={setForm}
              effectiveProtocol={effectiveProtocol}
              flushRef={totpFlushRef}
            />
          </div>
            </>
          )}

          {enabledCount >= 2 && isCurrentTabEnabled && onRemoveProtocol && (
            <div className="flex items-center justify-end border-t border-border/40 pt-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-destructive"
                onClick={() => onRemoveProtocol(currentTab)}
              >
                <Trash2 size={12} />
                {t("hostDetails.protocol.removeProtocol", {
                  protocol: protocolLabels[currentTab],
                })}
              </Button>
            </div>
          )}
        </HostDetailsSection>

        {enabledCount >= 2 && (
        <HostDetailsSection
          icon={<Plug size={14} className="text-muted-foreground" />}
          title={t("hostDetails.section.connectBehavior")}
        >
          <HostDetailsSettingRow label={t("hostDetails.protocol.doubleClick")}>
            <Select
              value={resolvedConnectBehavior}
              onValueChange={(value) => {
                const next = value as "ask" | "ssh" | "rdp" | "vnc" | "telnet";
                if (onSetConnectBehavior) {
                  onSetConnectBehavior(next);
                } else if (next !== "ask" && onSetDefaultProtocol) {
                  onSetDefaultProtocol(next);
                }
              }}
            >
              <SelectTrigger
                className="h-8 w-44 text-sm"
                aria-label={t("hostDetails.protocol.doubleClick")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {enabledProtocolList.map((proto) => (
                  <SelectItem key={proto} value={proto}>
                    {t("hostDetails.protocol.connectOptionDefault", {
                      protocol: protocolLabels[proto],
                    })}
                  </SelectItem>
                ))}
                <SelectItem value="ask">
                  {t("hostDetails.protocol.connectOptionAsk")}
                </SelectItem>
              </SelectContent>
            </Select>
          </HostDetailsSettingRow>
        </HostDetailsSection>
        )}

        {isCurrentTabEnabled && currentTab === "ssh" && (
        <HostDetailsSection
          icon={<FolderLock size={14} className="text-muted-foreground" />}
          title={t("hostDetails.section.sftp")}
        >
          <HostDetailsSettingRow
            label={t("hostDetails.sftp.fileProtocol")}
            hint={t("hostDetails.sftp.fileProtocol.desc")}
          >
            <Select
              value={form.sftpFileProtocol || "auto"}
              onValueChange={(val) => {
                const protocol = val as Host["sftpFileProtocol"];
                update("sftpFileProtocol", protocol);
                // SCP mode has no sudo-sftp elevation path; clear a contradictory saved flag.
                if (protocol === "scp" && form.sftpSudo) {
                  update("sftpSudo", false);
                }
              }}
            >
              <SelectTrigger className="h-8 w-32">
                <SelectValue placeholder={t("hostDetails.sftp.fileProtocol.auto")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t("hostDetails.sftp.fileProtocol.auto")}</SelectItem>
                <SelectItem value="sftp">{t("hostDetails.sftp.fileProtocol.sftp")}</SelectItem>
                <SelectItem value="scp">{t("hostDetails.sftp.fileProtocol.scp")}</SelectItem>
              </SelectContent>
            </Select>
          </HostDetailsSettingRow>
          <HostDetailsSettingRow
            label={t("hostDetails.sftp.sudo")}
            hint={t("hostDetails.sftp.sudo.desc")}
          >
            <Switch
              checked={form.sftpSudo || false}
              onCheckedChange={(val) => update("sftpSudo", val)}
              disabled={form.sftpFileProtocol === "scp"}
            />
          </HostDetailsSettingRow>
          {form.sftpSudo && !form.password && !selectedIdentity?.password && (
            <p className="text-xs text-amber-500">
              {t("hostDetails.sftp.sudo.passwordWarning")}
            </p>
          )}
          <HostDetailsSettingRow
            label={t("hostDetails.sftp.encoding")}
            hint={t("hostDetails.sftp.encoding.desc")}
          >
            <Select
              value={form.sftpEncoding || "auto"}
              onValueChange={(val) => update("sftpEncoding", val as Host["sftpEncoding"])}
            >
              <SelectTrigger className="h-8 w-32">
                <SelectValue placeholder={t("sftp.encoding.label")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t("sftp.encoding.auto")}</SelectItem>
                <SelectItem value="utf-8">{t("sftp.encoding.utf8")}</SelectItem>
                <SelectItem value="gb18030">{t("sftp.encoding.gb18030")}</SelectItem>
              </SelectContent>
            </Select>
          </HostDetailsSettingRow>
        </HostDetailsSection>
        )}

        <HostDetailsSection
          icon={<Shapes size={14} className="text-muted-foreground" />}
          title={t("hostDetails.icon.sectionTitle")}
          hint={t("hostDetails.icon.desc")}
        >
          <HostIconPicker
            previewHost={form as Host}
            hideAutoDistro={isRemoteDesktopPrimary && !resolvedEnabledProtocols.ssh}
            distroMode={form.distroMode}
            manualDistro={form.manualDistro}
            effectiveDistro={effectiveFormDistro}
            distroOptions={distroOptions}
            getDistroOptionLabel={getDistroOptionLabel}
            iconMode={form.iconMode}
            iconId={form.iconId}
            iconColorMode={form.iconColorMode}
            iconColor={form.iconColor}
            iconColorCustom={form.iconColorCustom}
            onChange={(next) => {
              if ("distroMode" in next) update("distroMode", next.distroMode);
              if ("manualDistro" in next) update("manualDistro", next.manualDistro);
              if ("iconMode" in next) update("iconMode", next.iconMode);
              if ("iconId" in next) update("iconId", next.iconId);
              if ("iconColorMode" in next) update("iconColorMode", next.iconColorMode);
              if ("iconColor" in next) update("iconColor", next.iconColor);
              if ("iconColorCustom" in next) update("iconColorCustom", next.iconColorCustom);
            }}
          />
        </HostDetailsSection>
  </>
  );
};
