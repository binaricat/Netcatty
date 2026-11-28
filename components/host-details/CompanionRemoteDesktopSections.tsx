import {
  Building2,
  ChevronDown,
  Eye,
  EyeOff,
  Globe,
  KeyRound,
  Maximize2,
  Plug,
  Plus,
  Scaling,
  ShieldCheck,
  User,
  Volume2,
  X,
} from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";
import {
  DEFAULT_RDP_CONFIG,
  DEFAULT_RDP_PORT,
  DEFAULT_VNC_CONFIG,
  DEFAULT_VNC_PORT,
  formatVncDisplayNumber,
  normalizeRdpConfig,
  normalizeVncConfig,
  parseVncPortOrDisplay,
} from "../../domain/remoteDesktop";
import { cn } from "../../lib/utils";
import type {
  GroupConfig,
  Host,
  Identity,
  RdpConfig,
  RdpResolutionMode,
  RdpSecurityMode,
  SSHKey,
  VncConfig,
  VncScalingMode,
} from "../../types";
import {
  RdpProtocolIcon,
  SshTunnelIcon,
  VncProtocolIcon,
} from "../icons/RemoteDesktopIcons";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { HostDetailsSettingRow } from "./HostDetailsSection";
import { IdentitySuggestInput } from "./IdentitySuggestInput";
import { RdpResolutionFields, type RdpResolutionDraftProps } from "./RdpResolutionFields";

type Translate = (key: string, params?: Record<string, unknown>) => string;

interface CompanionCredentialDraft {
  username: string;
  password: string;
}

interface CompanionRemoteDesktopSectionsProps {
  form: Host;
  setForm: React.Dispatch<React.SetStateAction<Host>>;
  identities: Identity[];
  availableKeys?: SSHKey[];
  onCreateIdentity?: (identity: Identity) => void;
  t: Translate;
}

interface CompanionRemoteDesktopInlineFieldsProps extends CompanionRemoteDesktopSectionsProps, RdpResolutionDraftProps {
  protocol: "vnc" | "rdp";
  groupDefaults?: Partial<GroupConfig>;
  credentialDraft?: CompanionCredentialDraft;
  onCredentialDraftChange?: (draft: CompanionCredentialDraft | undefined) => void;
}

/**
 * Inline configuration fields for a companion VNC or RDP protocol attached to an SSH host.
 * Rendered directly inside the unified top protocol tabs (no nested box chrome).
 */
export const CompanionRemoteDesktopInlineFields: React.FC<CompanionRemoteDesktopInlineFieldsProps> = ({
  protocol,
  form,
  setForm,
  groupDefaults,
  identities,
  availableKeys = [],
  credentialDraft,
  onCredentialDraftChange,
  resolutionDraft,
  onResolutionDraftChange,
  t,
}) => {
  const [vncPortInput, setVncPortInput] = useState<string>(() =>
    form.vncConfig?.port !== undefined
      ? String(form.vncConfig.port)
      : groupDefaults?.vncConfig?.port !== undefined
        ? ""
        : String(DEFAULT_VNC_PORT),
  );
  const [showManualPassword, setShowManualPassword] = useState(false);

  useEffect(() => {
    if (protocol === "vnc") {
      setVncPortInput(
        form.vncConfig?.port !== undefined
          ? String(form.vncConfig.port)
          : groupDefaults?.vncConfig?.port !== undefined
            ? ""
            : String(DEFAULT_VNC_PORT),
      );
    }
  }, [form.id, protocol, form.vncConfig?.port, groupDefaults?.vncConfig?.port]);

  const passwordCompatibleIdentities = useMemo(
    () =>
      identities.filter(
        (identity) => identity.authMethod === "password" || Boolean(identity.password),
      ),
    [identities],
  );

  const updateVncConfig = (patch: Partial<VncConfig>) => {
    setForm((prev) => ({
      ...prev,
      vncConfig: {
        ...(prev.vncConfig ?? { enabled: true }),
        ...patch,
      },
    }));
  };

  const updateRdpConfig = (patch: Partial<RdpConfig>) => {
    setForm((prev) => ({
      ...prev,
      rdpConfig: {
        ...(prev.rdpConfig ?? { enabled: true }),
        ...patch,
      },
    }));
  };

  if (protocol === "vnc") {
    const groupVnc = groupDefaults?.vncConfig;
    const effectiveVnc = { ...(groupVnc ?? {}), ...(form.vncConfig ?? {}) };
    const vncTunneled = effectiveVnc.tunnelViaHostSsh ?? true;
    const vncNormalized = normalizeVncConfig(effectiveVnc);
    const vncDisplayLabel = formatVncDisplayNumber(vncNormalized.port);
    const hostHasManualVncCreds =
      form.vncConfig?.useHostCredentials === false
      || Boolean(form.vncConfig?.username?.trim())
      || form.vncConfig?.identityId !== undefined;
    const effectiveVncIdentityId = form.vncConfig?.identityId !== undefined
      ? (form.vncConfig.identityId || undefined)
      : (form.vncConfig?.useHostCredentials === true || Boolean(form.vncConfig?.username?.trim()))
        ? undefined
        : (groupVnc?.identityId || undefined);
    const useHostCreds =
      !effectiveVncIdentityId
      && (
        form.vncConfig?.useHostCredentials !== undefined
          ? form.vncConfig.useHostCredentials
          : hostHasManualVncCreds
            ? false
            : groupVnc?.useHostCredentials === true
      );
    const selectedVncIdentity = effectiveVncIdentityId
      ? identities.find((i) => i.id === effectiveVncIdentityId)
      : undefined;

    return (
      <div className="space-y-2">
        <HostDetailsSettingRow
          icon={<Plug />}
          label={t("hostDetails.vnc.portLabel")}
        >
          <div className="flex items-center gap-1.5 w-44">
            <Input
              value={vncPortInput}
              onChange={(e) => {
                const raw = e.target.value;
                setVncPortInput(raw);
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
                if (!vncPortInput.trim() && groupVnc?.port !== undefined) {
                  updateVncConfig({ port: undefined });
                  return;
                }
                const parsed = parseVncPortOrDisplay(vncPortInput);
                const resolved = parsed ?? (groupVnc?.port !== undefined ? undefined : DEFAULT_VNC_PORT);
                setVncPortInput(resolved !== undefined ? String(resolved) : "");
                updateVncConfig({ port: resolved });
              }}
              placeholder={groupVnc?.port ? String(groupVnc.port) : t("hostDetails.vnc.displayPlaceholder")}
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
              placeholder={groupVnc?.tunnelTargetHost || "127.0.0.1"}
              className="h-8 w-44 font-mono text-sm"
            />
          </HostDetailsSettingRow>
        )}

        <HostDetailsSettingRow
          icon={<KeyRound />}
          label={t("hostDetails.companion.credentials.host")}
        >
          <Switch
            checked={useHostCreds}
            onCheckedChange={(checked) => {
              if (checked) {
                onCredentialDraftChange?.(undefined);
                updateVncConfig({ useHostCredentials: true, identityId: undefined, username: undefined });
              } else {
                updateVncConfig({ useHostCredentials: false });
              }
            }}
          />
        </HostDetailsSettingRow>

        {!useHostCreds && (
          <div className="space-y-2">
            {effectiveVncIdentityId ? (
              <div className="flex items-center gap-2 h-10 px-3 rounded-lg border border-border/60 bg-transparent">
                <User size={16} className="text-muted-foreground shrink-0" />
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
                      onClick={() => updateVncConfig({
                        identityId: groupVnc?.identityId ? "" : undefined,
                        useHostCredentials: false,
                      })}
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
                  value={credentialDraft?.username ?? form.vncConfig?.username ?? ""}
                  onChange={(next) => {
                    updateVncConfig({
                      username: next || undefined,
                      useHostCredentials: false,
                      ...(groupVnc?.identityId ? { identityId: "" } : {}),
                    });
                    onCredentialDraftChange?.({
                      username: next,
                      password: credentialDraft?.password ?? "",
                    });
                  }}
                  placeholder={groupVnc?.username || t("hostDetails.vnc.usernamePlaceholder")}
                  identities={passwordCompatibleIdentities}
                  availableKeys={availableKeys}
                  onSelectIdentity={(identity) => {
                    onCredentialDraftChange?.(undefined);
                    updateVncConfig({
                      useHostCredentials: false,
                      identityId: identity.id,
                      username: undefined,
                    });
                  }}
                  t={t}
                />
                <div className="relative">
                  <Input
                    type={showManualPassword ? "text" : "password"}
                    value={credentialDraft?.password ?? ""}
                    onChange={(e) =>
                      onCredentialDraftChange?.({
                        username: credentialDraft?.username ?? form.vncConfig?.username ?? "",
                        password: e.target.value,
                      })
                    }
                    placeholder={t("hostDetails.password.placeholder")}
                    className="h-10 rounded-lg pr-10 text-sm"
                  />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => setShowManualPassword((prev) => !prev)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {showManualPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {showManualPassword ? t("hostDetails.password.hide") : t("hostDetails.password.show")}
                    </TooltipContent>
                  </Tooltip>
                </div>
                {credentialDraft?.password ? (
                  <p className="px-1 text-[11px] text-muted-foreground">
                    {t("hostDetails.companion.credentials.manualHint")}
                  </p>
                ) : null}
              </>
            )}
          </div>
        )}

        <HostDetailsSettingRow
          icon={<Scaling />}
          label={t("hostDetails.vnc.scalingMode")}
        >
          <Select
            value={vncNormalized.scalingMode}
            onValueChange={(value) =>
              updateVncConfig({ scalingMode: value as VncScalingMode })
            }
          >
            <SelectTrigger className="h-8 w-44 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="fit">{t("hostDetails.vnc.scalingMode.fit")}</SelectItem>
              <SelectItem value="actual">{t("hostDetails.vnc.scalingMode.actual")}</SelectItem>
              <SelectItem value="stretch">{t("hostDetails.vnc.scalingMode.stretch")}</SelectItem>
              <SelectItem value="dynamic">{t("hostDetails.vnc.scalingMode.dynamic")}</SelectItem>
            </SelectContent>
          </Select>
        </HostDetailsSettingRow>

        <HostDetailsSettingRow
          icon={<Eye />}
          label={t("hostDetails.vnc.viewOnly")}
          hint={t("hostDetails.vnc.viewOnlyDesc")}
        >
          <Switch
            checked={vncNormalized.viewOnly}
            onCheckedChange={(checked) => updateVncConfig({ viewOnly: checked })}
          />
        </HostDetailsSettingRow>
      </div>
    );
  }

  const groupRdp = groupDefaults?.rdpConfig;
  const effectiveRdp = { ...(groupRdp ?? {}), ...(form.rdpConfig ?? {}) };
  const rdpTunneled = effectiveRdp.tunnelViaHostSsh ?? true;
  const rdpNormalized = normalizeRdpConfig(effectiveRdp);
  const hostHasManualRdpCreds =
    form.rdpConfig?.useHostCredentials === false
    || Boolean(form.rdpConfig?.username?.trim())
    || form.rdpConfig?.identityId !== undefined;
  const effectiveRdpIdentityId = form.rdpConfig?.identityId !== undefined
    ? (form.rdpConfig.identityId || undefined)
    : (form.rdpConfig?.useHostCredentials === true || Boolean(form.rdpConfig?.username?.trim()))
      ? undefined
      : (groupRdp?.identityId || undefined);
  const useHostCreds =
    !effectiveRdpIdentityId
    && (
      form.rdpConfig?.useHostCredentials !== undefined
        ? form.rdpConfig.useHostCredentials
        : hostHasManualRdpCreds
          ? false
          : groupRdp?.useHostCredentials === true
    );
  const selectedRdpIdentity = effectiveRdpIdentityId
    ? identities.find((i) => i.id === effectiveRdpIdentityId)
    : undefined;

  return (
    <div className="space-y-2">
      <HostDetailsSettingRow
        icon={<Plug />}
        label={t("hostDetails.rdp.portLabel")}
      >
        <Input
          type="number"
          min={1}
          max={65535}
          value={form.rdpConfig?.port ?? (groupRdp?.port !== undefined ? "" : DEFAULT_RDP_PORT)}
          onChange={(e) => {
            const n = Number.parseInt(e.target.value, 10);
            updateRdpConfig({ port: Number.isFinite(n) ? n : undefined });
          }}
          placeholder={String(groupRdp?.port ?? DEFAULT_RDP_PORT)}
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
            placeholder={groupRdp?.tunnelTargetHost || "127.0.0.1"}
            className="h-8 w-44 font-mono text-sm"
          />
        </HostDetailsSettingRow>
      )}

      <HostDetailsSettingRow
        icon={<KeyRound />}
        label={t("hostDetails.companion.credentials.host")}
      >
        <Switch
          checked={useHostCreds}
          onCheckedChange={(checked) => {
            if (checked) {
              onCredentialDraftChange?.(undefined);
              updateRdpConfig({ useHostCredentials: true, identityId: undefined, username: undefined });
            } else {
              updateRdpConfig({ useHostCredentials: false });
            }
          }}
        />
      </HostDetailsSettingRow>

      {!useHostCreds && (
        <div className="space-y-2">
          {effectiveRdpIdentityId ? (
            <div className="flex items-center gap-2 h-10 px-3 rounded-lg border border-border/60 bg-transparent">
              <User size={16} className="text-muted-foreground shrink-0" />
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
                    onClick={() => updateRdpConfig({
                      identityId: groupRdp?.identityId ? "" : undefined,
                      useHostCredentials: false,
                    })}
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
                value={credentialDraft?.username ?? form.rdpConfig?.username ?? ""}
                onChange={(next) => {
                  updateRdpConfig({
                    username: next || undefined,
                    useHostCredentials: false,
                    ...(groupRdp?.identityId ? { identityId: "" } : {}),
                  });
                  onCredentialDraftChange?.({
                    username: next,
                    password: credentialDraft?.password ?? "",
                  });
                }}
                placeholder={groupRdp?.username || t("hostDetails.rdp.usernamePlaceholder")}
                identities={passwordCompatibleIdentities}
                availableKeys={availableKeys}
                onSelectIdentity={(identity) => {
                  onCredentialDraftChange?.(undefined);
                  updateRdpConfig({
                    useHostCredentials: false,
                    identityId: identity.id,
                    username: undefined,
                    ...(identity.domain ? { domain: identity.domain } : {}),
                  });
                }}
                t={t}
              />
              <div className="relative">
                <Input
                  type={showManualPassword ? "text" : "password"}
                  value={credentialDraft?.password ?? ""}
                  onChange={(e) =>
                    onCredentialDraftChange?.({
                      username: credentialDraft?.username ?? form.rdpConfig?.username ?? "",
                      password: e.target.value,
                    })
                  }
                  placeholder={t("hostDetails.password.placeholder")}
                  className="h-10 rounded-lg pr-10 text-sm"
                />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => setShowManualPassword((prev) => !prev)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {showManualPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {showManualPassword ? t("hostDetails.password.hide") : t("hostDetails.password.show")}
                  </TooltipContent>
                </Tooltip>
              </div>
              {credentialDraft?.password ? (
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
          onChange={(e) =>
            updateRdpConfig({ domain: e.target.value || undefined })
          }
          placeholder={groupRdp?.domain || t("hostDetails.rdp.domainPlaceholder")}
          className="h-8 w-44 text-sm"
        />
      </HostDetailsSettingRow>

      <HostDetailsSettingRow
        icon={<Maximize2 />}
        label={t("hostDetails.rdp.resolutionMode")}
      >
        <Select
          value={rdpNormalized.resolutionMode}
          onValueChange={(value) =>
            updateRdpConfig({ resolutionMode: value as RdpResolutionMode })
          }
        >
          <SelectTrigger className="h-8 w-44 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="dynamic">{t("hostDetails.rdp.resolutionMode.dynamic")}</SelectItem>
            <SelectItem value="fit">{t("hostDetails.rdp.resolutionMode.fit")}</SelectItem>
            <SelectItem value="fixed">{t("hostDetails.rdp.resolutionMode.fixed")}</SelectItem>
          </SelectContent>
        </Select>
      </HostDetailsSettingRow>

      {rdpNormalized.resolutionMode === "fixed" && (
        <RdpResolutionFields
          form={form}
          setForm={setForm}
          inheritedRdpConfig={groupRdp}
          t={t}
          resolutionDraft={resolutionDraft}
          onResolutionDraftChange={onResolutionDraftChange}
        />
      )}

      <HostDetailsSettingRow
        icon={<ShieldCheck />}
        label={t("hostDetails.rdp.securityMode")}
      >
        <Select
          value={rdpNormalized.securityMode}
          onValueChange={(value) =>
            updateRdpConfig({ securityMode: value as RdpSecurityMode })
          }
        >
          <SelectTrigger className="h-8 w-44 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">{t("hostDetails.rdp.securityMode.auto")}</SelectItem>
            <SelectItem value="nla">{t("hostDetails.rdp.securityMode.nla")}</SelectItem>
            <SelectItem value="tls">{t("hostDetails.rdp.securityMode.tls")}</SelectItem>
            <SelectItem value="rdp">{t("hostDetails.rdp.securityMode.rdp")}</SelectItem>
          </SelectContent>
        </Select>
      </HostDetailsSettingRow>

      <HostDetailsSettingRow
        icon={<Volume2 />}
        label={t("hostDetails.rdp.audio")}
        hint={t("hostDetails.rdp.audioDesc")}
      >
        <Switch
          checked={rdpNormalized.audioEnabled}
          onCheckedChange={(checked) => updateRdpConfig({ audioEnabled: checked })}
        />
      </HostDetailsSettingRow>
    </div>
  );
};

/**
 * Legacy collapsible wrapper kept exported for standalone/unit reuse.
 */
export const CompanionRemoteDesktopSections: React.FC<CompanionRemoteDesktopSectionsProps> = ({
  form,
  setForm,
  identities,
  onCreateIdentity,
  t,
}) => {
  const [vncExpanded, setVncExpanded] = useState(false);
  const [rdpExpanded, setRdpExpanded] = useState(false);

  const vncEnabled = form.vncConfig?.enabled === true;
  const rdpEnabled = form.rdpConfig?.enabled === true;
  const vncTunneled = form.vncConfig?.tunnelViaHostSsh ?? true;
  const rdpTunneled = form.rdpConfig?.tunnelViaHostSsh ?? true;
  const vncNormalized = normalizeVncConfig(form.vncConfig);
  const rdpNormalized = normalizeRdpConfig(form.rdpConfig);

  return (
    <>
      {vncEnabled ? (
        <div className="rounded-lg border border-border/70 bg-card/50 overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2.5">
            <button
              type="button"
              onClick={() => setVncExpanded((prev) => !prev)}
              aria-expanded={vncExpanded}
              className="flex flex-1 min-w-0 items-center gap-2 text-left"
            >
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-teal-500/12 text-teal-600 dark:text-teal-400 shrink-0">
                <VncProtocolIcon size={14} />
              </span>
              <span className="text-xs font-semibold text-foreground">VNC</span>
              <span className="text-[11px] font-mono text-muted-foreground">:{vncNormalized.port}</span>
              {vncTunneled && (
                <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0 text-[10px] font-medium leading-4 text-emerald-600 dark:text-emerald-400 shrink-0">
                  <SshTunnelIcon size={10} />
                  SSH
                </span>
              )}
              <ChevronDown
                size={14}
                className={cn("ml-auto text-muted-foreground transition-transform shrink-0", vncExpanded && "rotate-180")}
              />
            </button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0"
              onClick={() => {
                setVncExpanded(false);
                setForm((prev) => ({ ...prev, vncConfig: undefined }));
              }}
            >
              <X size={14} />
            </Button>
          </div>
          {vncExpanded && (
            <div className="border-t border-border/50 px-3 py-3">
              <CompanionRemoteDesktopInlineFields
                protocol="vnc"
                form={form}
                setForm={setForm}
                identities={identities}
                onCreateIdentity={onCreateIdentity}
                t={t}
              />
            </div>
          )}
        </div>
      ) : (
        <Button
          type="button"
          variant="ghost"
          className="group w-full h-11 justify-between px-3 border border-dashed border-border/70 hover:border-teal-500/40 hover:bg-teal-500/5"
          onClick={() => {
            setVncExpanded(true);
            setForm((prev) => ({
              ...prev,
              vncConfig: {
                ...DEFAULT_VNC_CONFIG,
                enabled: true,
                port: DEFAULT_VNC_PORT,
                tunnelViaHostSsh: true,
                useHostCredentials: true,
              },
            }));
          }}
        >
          <span className="flex items-center gap-2.5">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-teal-500/12 text-teal-600 dark:text-teal-400">
              <VncProtocolIcon size={14} />
            </span>
            <span className="text-xs font-medium text-foreground">{t("hostDetails.companion.addVnc")}</span>
          </span>
          <span className="inline-flex items-center gap-1 text-[10px] font-mono text-muted-foreground">
            <span>:{DEFAULT_VNC_PORT}</span>
            <Plus size={13} className="text-muted-foreground group-hover:text-teal-500 transition-colors" />
          </span>
        </Button>
      )}

      {rdpEnabled ? (
        <div className="rounded-lg border border-border/70 bg-card/50 overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2.5">
            <button
              type="button"
              onClick={() => setRdpExpanded((prev) => !prev)}
              aria-expanded={rdpExpanded}
              className="flex flex-1 min-w-0 items-center gap-2 text-left"
            >
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-blue-500/12 text-blue-600 dark:text-blue-400 shrink-0">
                <RdpProtocolIcon size={14} />
              </span>
              <span className="text-xs font-semibold text-foreground">RDP</span>
              <span className="text-[11px] font-mono text-muted-foreground">:{rdpNormalized.port}</span>
              {rdpTunneled && (
                <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0 text-[10px] font-medium leading-4 text-emerald-600 dark:text-emerald-400 shrink-0">
                  <SshTunnelIcon size={10} />
                  SSH
                </span>
              )}
              <ChevronDown
                size={14}
                className={cn("ml-auto text-muted-foreground transition-transform shrink-0", rdpExpanded && "rotate-180")}
              />
            </button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0"
              onClick={() => {
                setRdpExpanded(false);
                setForm((prev) => ({ ...prev, rdpConfig: undefined }));
              }}
            >
              <X size={14} />
            </Button>
          </div>
          {rdpExpanded && (
            <div className="border-t border-border/50 px-3 py-3">
              <CompanionRemoteDesktopInlineFields
                protocol="rdp"
                form={form}
                setForm={setForm}
                identities={identities}
                onCreateIdentity={onCreateIdentity}
                t={t}
              />
            </div>
          )}
        </div>
      ) : (
        <Button
          type="button"
          variant="ghost"
          className="group w-full h-11 justify-between px-3 border border-dashed border-border/70 hover:border-blue-500/40 hover:bg-blue-500/5"
          onClick={() => {
            setRdpExpanded(true);
            setForm((prev) => ({
              ...prev,
              rdpConfig: {
                ...DEFAULT_RDP_CONFIG,
                enabled: true,
                port: DEFAULT_RDP_PORT,
                tunnelViaHostSsh: true,
                useHostCredentials: true,
              },
            }));
          }}
        >
          <span className="flex items-center gap-2.5">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-blue-500/12 text-blue-600 dark:text-blue-400">
              <RdpProtocolIcon size={14} />
            </span>
            <span className="text-xs font-medium text-foreground">{t("hostDetails.companion.addRdp")}</span>
          </span>
          <span className="inline-flex items-center gap-1 text-[10px] font-mono text-muted-foreground">
            <span>:{DEFAULT_RDP_PORT}</span>
            <Plus size={13} className="text-muted-foreground group-hover:text-blue-500 transition-colors" />
          </span>
        </Button>
      )}
    </>
  );
};
