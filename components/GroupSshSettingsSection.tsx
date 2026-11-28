import {
  AlertTriangle,
  ChevronDown,
  ClipboardCopy,
  Eye,
  FolderUp,
  Forward,
  Gauge,
  Globe,
  Link2,
  Maximize2,
  Monitor,
  MousePointer2,
  Palette,
  Plus,
  Router,
  Scaling,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  TerminalSquare,
  Users,
  Variable,
  Volume2,
  Wifi,
  X,
} from "lucide-react";
import React, { useState } from "react";
import { customThemeStore } from "../application/state/customThemeStore";
import {
  DEFAULT_VNC_CONFIG,
  normalizeRdpConfig,
  normalizeVncConfig,
  type RdpResolutionDraft,
} from "../domain/remoteDesktop";
import { MAX_FONT_SIZE, MIN_FONT_SIZE } from "../infrastructure/config/fonts";
import type {
  GroupConfig,
  Host,
  RdpColorDepth,
  RdpConfig,
  RdpResolutionMode,
  RdpSecurityMode,
  VncConfig,
  VncScalingMode,
} from "../types";
import type { GroupEditableProtocol } from "./GroupProtocolCredentialsSection";
import { TerminalEncodingSelect } from "./TerminalEncodingSelect";
import {
  HostDetailsOverrideReset,
  HostDetailsSection,
  HostDetailsSettingRow,
  SshAlgorithmOverridesCollapsible,
} from "./host-details";
import { RdpResolutionFields } from "./host-details/RdpResolutionFields";
import { TerminalFontSelect } from "./settings/TerminalFontSelect";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import type { TerminalFont } from "../infrastructure/config/fonts";

type Translate = (key: string, params?: Record<string, unknown>) => string;
type SubPanel = "none" | "proxy" | "chain" | "env-vars" | "theme-select";

const ToggleRow: React.FC<{
  label: string;
  hint?: React.ReactNode;
  enabled: boolean;
  onToggle: () => void;
}> = ({ label, hint, enabled, onToggle }) => (
  <HostDetailsSettingRow label={label} hint={hint}>
    <Switch checked={enabled} onCheckedChange={() => onToggle()} />
  </HostDetailsSettingRow>
);

export interface GroupSshSettingsSectionProps {
  t: Translate;
  activeProtocolTab: GroupEditableProtocol;
  isCurrentTabEnabled: boolean;
  form: Partial<GroupConfig>;
  setForm: React.Dispatch<React.SetStateAction<Partial<GroupConfig>>>;
  update: <K extends keyof GroupConfig>(key: K, value: GroupConfig[K] | undefined) => void;
  updateRdpConfig: (patch: Partial<RdpConfig>) => void;
  updateVncConfig: (patch: Partial<VncConfig>) => void;
  inheritedDefaults: Partial<GroupConfig>;
  effectiveThemeId: string;
  hasActiveThemeOverride: boolean;
  availableFonts: TerminalFont[];
  terminalFontSize: number;
  effectiveDeviceType?: "general" | "network";
  inheritedLegacyAlgorithms: boolean;
  inheritedSkipEcdsaHostKey: boolean;
  inheritedX11Forwarding: boolean;
  inheritedStartupCommandRunMode: "lineDelay" | "paste";
  showAlgorithmOverrides: boolean;
  setShowAlgorithmOverrides: (open: boolean) => void;
  inheritedAlgorithmOverrides: GroupConfig["algorithms"];
  proxySummaryType: string;
  proxySummaryLabel: string;
  proxySummaryTooltip: string;
  hasProxyConfig: boolean;
  clearProxyConfig: () => void;
  chainedHosts: Host[];
  clearHostChain: () => void;
  setActiveSubPanel: (panel: SubPanel) => void;
  rdpResolutionDraft: RdpResolutionDraft;
  onRdpResolutionDraftChange: (dimension: "width" | "height", value: string) => void;
}

export const GroupSshSettingsSection: React.FC<GroupSshSettingsSectionProps> = ({
  t,
  activeProtocolTab,
  isCurrentTabEnabled,
  form,
  setForm,
  update,
  updateRdpConfig,
  updateVncConfig,
  inheritedDefaults,
  effectiveThemeId,
  hasActiveThemeOverride,
  availableFonts,
  terminalFontSize,
  effectiveDeviceType,
  inheritedLegacyAlgorithms,
  inheritedSkipEcdsaHostKey,
  inheritedX11Forwarding,
  inheritedStartupCommandRunMode,
  showAlgorithmOverrides,
  setShowAlgorithmOverrides,
  inheritedAlgorithmOverrides,
  proxySummaryType,
  proxySummaryLabel,
  proxySummaryTooltip,
  hasProxyConfig,
  clearProxyConfig,
  chainedHosts,
  clearHostChain,
  setActiveSubPanel,
  rdpResolutionDraft,
  onRdpResolutionDraftChange,
}) => {
  const [rdpAdvancedOpen, setRdpAdvancedOpen] = useState(() =>
    Boolean(
      form.rdpConfig?.loadBalanceInfo ||
        form.rdpConfig?.alternateShell ||
        form.rdpConfig?.shellWorkingDir ||
        inheritedDefaults.rdpConfig?.loadBalanceInfo ||
        inheritedDefaults.rdpConfig?.alternateShell ||
        inheritedDefaults.rdpConfig?.shellWorkingDir,
    ),
  );

  if (!isCurrentTabEnabled) return null;

  const isSshView = activeProtocolTab === "ssh";
  const isTelnetView = activeProtocolTab === "telnet";
  const isRdpView = activeProtocolTab === "rdp";
  const isVncView = activeProtocolTab === "vnc";
  const isRemoteDesktopView = isRdpView || isVncView;

  const effectiveMoshEnabled = form.moshEnabled ?? inheritedDefaults.moshEnabled;
  const effectiveEtEnabled = form.etEnabled ?? inheritedDefaults.etEnabled;
  const showPlainSshOptions = isSshView && !effectiveMoshEnabled && !effectiveEtEnabled;
  const effectiveStartupCommandRunMode = form.startupCommandRunMode ?? inheritedStartupCommandRunMode;
  const effectiveFontSize = form.fontSizeOverride === false
    ? terminalFontSize
    : (form.fontSize ?? inheritedDefaults.fontSize ?? terminalFontSize);
  const hasActiveFontSizeOverride = form.fontSizeOverride === true || (form.fontSize != null && form.fontSizeOverride !== false);

  const rdp = normalizeRdpConfig({
    ...(inheritedDefaults.rdpConfig ?? {}),
    ...(form.rdpConfig ?? {}),
  });
  const vnc = normalizeVncConfig({
    ...(inheritedDefaults.vncConfig ?? {}),
    ...(form.vncConfig ?? {}),
  });

  // Adapter so RdpResolutionFields updates Partial<GroupConfig> cleanly
  const setRdpResolutionForm: React.Dispatch<React.SetStateAction<Host>> = (updater) => {
    setForm((prev) => {
      const dummy = { rdpConfig: prev.rdpConfig } as Host;
      const next = typeof updater === "function" ? updater(dummy) : updater;
      return {
        ...prev,
        rdpConfig: next.rdpConfig,
      };
    });
  };

  return (
    <>
      {/* RDP Options — unified with RemoteDesktopOptionsSection */}
      {isRdpView && (
        <HostDetailsSection
          icon={<Monitor size={14} className="text-muted-foreground" />}
          title={t("hostDetails.remoteDesktop.sectionTitle")}
        >
          <HostDetailsSettingRow
            icon={<Maximize2 />}
            label={t("hostDetails.rdp.resolutionMode")}
          >
            <Select
              value={rdp.resolutionMode}
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

          {rdp.resolutionMode === "fixed" && (
            <RdpResolutionFields
              form={{ rdpConfig: form.rdpConfig }}
              setForm={setRdpResolutionForm}
              inheritedRdpConfig={inheritedDefaults.rdpConfig}
              t={t}
              resolutionDraft={rdpResolutionDraft}
              onResolutionDraftChange={onRdpResolutionDraftChange}
            />
          )}

          <HostDetailsSettingRow
            icon={<Palette />}
            label={t("hostDetails.rdp.colorDepth")}
          >
            <Select
              value={String(rdp.colorDepth)}
              onValueChange={(value) =>
                updateRdpConfig({ colorDepth: Number(value) as RdpColorDepth })
              }
            >
              <SelectTrigger className="h-8 w-44 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="32">32-bit</SelectItem>
                <SelectItem value="24">24-bit</SelectItem>
                <SelectItem value="16">16-bit</SelectItem>
              </SelectContent>
            </Select>
          </HostDetailsSettingRow>

          <HostDetailsSettingRow
            icon={<Volume2 />}
            label={t("hostDetails.rdp.audio")}
            hint={t("hostDetails.rdp.audioDesc")}
          >
            <Switch
              checked={rdp.audioEnabled}
              onCheckedChange={(checked) => updateRdpConfig({ audioEnabled: checked })}
            />
          </HostDetailsSettingRow>

          <HostDetailsSettingRow
            icon={<ClipboardCopy />}
            label={t("hostDetails.rdp.clipboard")}
            hint={t("hostDetails.rdp.clipboardDesc")}
          >
            <Switch
              checked={rdp.clipboardSync}
              onCheckedChange={(checked) => updateRdpConfig({ clipboardSync: checked })}
            />
          </HostDetailsSettingRow>

          {rdp.clipboardSync && (
            <HostDetailsSettingRow
              icon={<FolderUp />}
              label={t("hostDetails.rdp.clipboardFiles")}
              hint={t("hostDetails.rdp.clipboardFilesDesc")}
            >
              <Switch
                checked={rdp.clipboardFilesEnabled}
                onCheckedChange={(checked) => updateRdpConfig({ clipboardFilesEnabled: checked })}
              />
            </HostDetailsSettingRow>
          )}

          <HostDetailsSettingRow
            icon={<ShieldCheck />}
            label={t("hostDetails.rdp.securityMode")}
          >
            <Select
              value={rdp.securityMode}
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
            icon={<ShieldAlert />}
            label={t("hostDetails.rdp.ignoreCertErrors")}
            hint={t("hostDetails.rdp.ignoreCertErrorsDesc")}
          >
            <Switch
              checked={rdp.ignoreCertErrors}
              onCheckedChange={(checked) => updateRdpConfig({ ignoreCertErrors: checked })}
            />
          </HostDetailsSettingRow>

          <Collapsible open={rdpAdvancedOpen} onOpenChange={setRdpAdvancedOpen}>
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                className="group w-full justify-between h-8 px-2 hover:bg-accent/50"
              >
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <SlidersHorizontal size={13} />
                  {t("hostDetails.rdp.advanced")}
                </span>
                <ChevronDown
                  size={14}
                  className="text-muted-foreground group-data-[state=open]:rotate-180 transition-transform"
                />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2 space-y-2.5 rounded-lg border border-border/60 bg-secondary/25 p-2.5">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">
                  {t("hostDetails.rdp.loadBalanceInfo")}
                </label>
                <Input
                  value={form.rdpConfig?.loadBalanceInfo ?? ""}
                  onChange={(e) =>
                    updateRdpConfig({ loadBalanceInfo: e.target.value || undefined })
                  }
                  placeholder={
                    inheritedDefaults.rdpConfig?.loadBalanceInfo ||
                    t("hostDetails.rdp.loadBalanceInfoPlaceholder")
                  }
                  className="h-10 rounded-lg text-sm font-mono"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">
                  {t("hostDetails.rdp.alternateShell")}
                </label>
                <Input
                  value={form.rdpConfig?.alternateShell ?? ""}
                  onChange={(e) =>
                    updateRdpConfig({ alternateShell: e.target.value || undefined })
                  }
                  placeholder={
                    inheritedDefaults.rdpConfig?.alternateShell ||
                    t("hostDetails.rdp.alternateShellPlaceholder")
                  }
                  className="h-10 rounded-lg text-sm font-mono"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">
                  {t("hostDetails.rdp.shellWorkingDir")}
                </label>
                <Input
                  value={form.rdpConfig?.shellWorkingDir ?? ""}
                  onChange={(e) =>
                    updateRdpConfig({ shellWorkingDir: e.target.value || undefined })
                  }
                  placeholder={
                    inheritedDefaults.rdpConfig?.shellWorkingDir ||
                    t("hostDetails.rdp.shellWorkingDirPlaceholder")
                  }
                  className="h-10 rounded-lg text-sm font-mono"
                />
              </div>
            </CollapsibleContent>
          </Collapsible>
        </HostDetailsSection>
      )}

      {/* VNC Options — unified with RemoteDesktopOptionsSection */}
      {isVncView && (
        <HostDetailsSection
          icon={<Monitor size={14} className="text-muted-foreground" />}
          title={t("hostDetails.remoteDesktop.sectionTitle")}
        >
          <HostDetailsSettingRow
            icon={<Scaling />}
            label={t("hostDetails.vnc.scalingMode")}
          >
            <Select
              value={vnc.scalingMode}
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
            icon={<Sparkles />}
            label={t("hostDetails.vnc.quality")}
          >
            <div className="flex items-center justify-end gap-2 w-44">
              <input
                type="range"
                min={0}
                max={9}
                step={1}
                value={vnc.quality ?? DEFAULT_VNC_CONFIG.quality}
                onChange={(e) => updateVncConfig({ quality: Number(e.target.value) })}
                aria-label={t("hostDetails.vnc.quality")}
                className="flex-1 min-w-0 accent-primary"
              />
              <span className="w-9 rounded bg-background/80 border border-border/60 px-1 py-0.5 text-center font-mono text-xs text-foreground shrink-0">
                {vnc.quality}/9
              </span>
            </div>
          </HostDetailsSettingRow>

          <HostDetailsSettingRow
            icon={<Gauge />}
            label={t("hostDetails.vnc.compression")}
          >
            <div className="flex items-center justify-end gap-2 w-44">
              <input
                type="range"
                min={0}
                max={9}
                step={1}
                value={vnc.compressionLevel ?? DEFAULT_VNC_CONFIG.compressionLevel}
                onChange={(e) => updateVncConfig({ compressionLevel: Number(e.target.value) })}
                aria-label={t("hostDetails.vnc.compression")}
                className="flex-1 min-w-0 accent-primary"
              />
              <span className="w-9 rounded bg-background/80 border border-border/60 px-1 py-0.5 text-center font-mono text-xs text-foreground shrink-0">
                {vnc.compressionLevel}/9
              </span>
            </div>
          </HostDetailsSettingRow>

          <HostDetailsSettingRow
            icon={<Eye />}
            label={t("hostDetails.vnc.viewOnly")}
            hint={t("hostDetails.vnc.viewOnlyDesc")}
          >
            <Switch
              checked={vnc.viewOnly}
              onCheckedChange={(checked) => updateVncConfig({ viewOnly: checked })}
            />
          </HostDetailsSettingRow>

          <HostDetailsSettingRow
            icon={<Users />}
            label={t("hostDetails.vnc.sharedSession")}
            hint={t("hostDetails.vnc.sharedSessionDesc")}
          >
            <Switch
              checked={vnc.sharedSession}
              onCheckedChange={(checked) => updateVncConfig({ sharedSession: checked })}
            />
          </HostDetailsSettingRow>

          <HostDetailsSettingRow
            icon={<ClipboardCopy />}
            label={t("hostDetails.vnc.clipboard")}
            hint={t("hostDetails.vnc.clipboardDesc")}
          >
            <Switch
              checked={vnc.clipboardSync}
              onCheckedChange={(checked) => updateVncConfig({ clipboardSync: checked })}
            />
          </HostDetailsSettingRow>

          <HostDetailsSettingRow
            icon={<MousePointer2 />}
            label={t("hostDetails.vnc.showRemoteCursor")}
            hint={t("hostDetails.vnc.showRemoteCursorDesc")}
          >
            <Switch
              checked={vnc.showRemoteCursor}
              onCheckedChange={(checked) => updateVncConfig({ showRemoteCursor: checked })}
            />
          </HostDetailsSettingRow>
        </HostDetailsSection>
      )}

      {/* Appearance — unified with HostDetailsAdvancedSections (SSH & Telnet) */}
      {(isSshView || isTelnetView) && (
        <HostDetailsSection
          icon={<Palette size={14} className="text-muted-foreground" />}
          title={t("hostDetails.section.appearance")}
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
              ariaLabel={t("vault.groups.details.fontFamily")}
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

          <HostDetailsSettingRow label={t("vault.groups.details.fontSize")}>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (effectiveFontSize > MIN_FONT_SIZE) {
                      setForm((prev) => ({
                        ...prev,
                        fontSize: effectiveFontSize - 1,
                        fontSizeOverride: true,
                      }));
                    }
                  }}
                  disabled={effectiveFontSize <= MIN_FONT_SIZE}
                  className="h-8 w-8 px-0"
                >
                  -
                </Button>
                <Input
                  type="number"
                  min={MIN_FONT_SIZE}
                  max={MAX_FONT_SIZE}
                  value={effectiveFontSize}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    if (val >= MIN_FONT_SIZE && val <= MAX_FONT_SIZE) {
                      setForm((prev) => ({
                        ...prev,
                        fontSize: val,
                        fontSizeOverride: true,
                      }));
                    }
                  }}
                  className="h-8 w-16 text-center"
                />
                <span className="text-sm text-muted-foreground">pt</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (effectiveFontSize < MAX_FONT_SIZE) {
                      setForm((prev) => ({
                        ...prev,
                        fontSize: effectiveFontSize + 1,
                        fontSizeOverride: true,
                      }));
                    }
                  }}
                  disabled={effectiveFontSize >= MAX_FONT_SIZE}
                  className="h-8 w-8 px-0"
                >
                  +
                </Button>
              </div>
              {hasActiveFontSizeOverride && (
                <HostDetailsOverrideReset
                  size="sm"
                  label={t("common.useGlobal")}
                  onClick={() =>
                    setForm((prev) => ({
                      ...prev,
                      fontSize: undefined,
                      fontSizeOverride: false,
                    }))
                  }
                />
              )}
            </div>
          </HostDetailsSettingRow>
        </HostDetailsSection>
      )}

      {/* SSH-specific sections — unified with HostDetailsAdvancedSections */}
      {isSshView && (
        <>
          <HostDetailsSection
            icon={<Wifi size={14} className="text-muted-foreground" />}
            title={t("hostDetails.section.mosh")}
          >
            <ToggleRow
              label="Mosh"
              enabled={!!effectiveMoshEnabled}
              onToggle={() => {
                const enabling = !effectiveMoshEnabled;
                if (enabling) {
                  setForm((prev) => ({
                    ...prev,
                    moshEnabled: true,
                    etEnabled: false,
                    x11Forwarding: undefined,
                  }));
                } else {
                  update("moshEnabled", false);
                }
              }}
            />
            {effectiveMoshEnabled && (
              <Input
                placeholder={t("hostDetails.moshServerPath") || "mosh-server path"}
                value={form.moshServerPath || ""}
                onChange={(e) => update("moshServerPath", e.target.value || undefined)}
                className="h-10"
              />
            )}
          </HostDetailsSection>

          <HostDetailsSection
            icon={<Wifi size={14} className="text-muted-foreground" />}
            title={t("hostDetails.section.et")}
          >
            <ToggleRow
              label="EternalTerminal"
              enabled={!!effectiveEtEnabled}
              onToggle={() => {
                const enabling = !effectiveEtEnabled;
                if (enabling) {
                  setForm((prev) => ({
                    ...prev,
                    etEnabled: true,
                    moshEnabled: false,
                    x11Forwarding: undefined,
                  }));
                } else {
                  update("etEnabled", false);
                }
              }}
            />
            {effectiveEtEnabled && (
              <HostDetailsSettingRow
                label={t("hostDetails.et.port")}
                hint={t("hostDetails.et.port.desc")}
              >
                <Input
                  type="number"
                  className="h-8 w-28"
                  placeholder={inheritedDefaults.etPort ? String(inheritedDefaults.etPort) : "2022"}
                  value={form.etPort ?? ""}
                  onChange={(e) => {
                    const v = e.target.value.trim();
                    update("etPort", v === "" ? undefined : Number(v));
                  }}
                />
              </HostDetailsSettingRow>
            )}
          </HostDetailsSection>

          <HostDetailsSection
            icon={<Forward size={14} className="text-muted-foreground" />}
            title={t("hostDetails.section.agentForwarding")}
          >
            <ToggleRow
              label={t("hostDetails.agentForwarding")}
              hint={t("hostDetails.agentForwarding.desc")}
              enabled={!!form.agentForwarding}
              onToggle={() => update("agentForwarding", !form.agentForwarding)}
            />
          </HostDetailsSection>

          {showPlainSshOptions && (
            <HostDetailsSection
              icon={<TerminalSquare size={14} className="text-muted-foreground" />}
              title={t("hostDetails.section.x11Forwarding")}
            >
              <ToggleRow
                label={t("hostDetails.x11Forwarding")}
                hint={t("hostDetails.x11Forwarding.desc")}
                enabled={!!(form.x11Forwarding ?? inheritedX11Forwarding)}
                onToggle={() =>
                  update("x11Forwarding", !(form.x11Forwarding ?? inheritedX11Forwarding))
                }
              />
            </HostDetailsSection>
          )}

          {showPlainSshOptions && (
            <HostDetailsSection
              icon={<Router size={14} className="text-muted-foreground" />}
              title={t("hostDetails.section.deviceType")}
            >
              <ToggleRow
                label={t("hostDetails.deviceType")}
                hint={t("hostDetails.deviceType.desc")}
                enabled={effectiveDeviceType === "network"}
                onToggle={() =>
                  update("deviceType", effectiveDeviceType === "network" ? "general" : "network")
                }
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

          <HostDetailsSection
            icon={<ShieldAlert size={14} className="text-muted-foreground" />}
            title={t("hostDetails.section.sshAlgorithms")}
          >
            <ToggleRow
              label={t("hostDetails.legacyAlgorithms")}
              hint={t("hostDetails.legacyAlgorithms.desc")}
              enabled={!!(form.legacyAlgorithms ?? inheritedLegacyAlgorithms)}
              onToggle={() =>
                update("legacyAlgorithms", !(form.legacyAlgorithms ?? inheritedLegacyAlgorithms))
              }
            />
            {(form.legacyAlgorithms ?? inheritedLegacyAlgorithms) && (
              <div className="flex items-start gap-2 p-2 rounded-md bg-yellow-500/10 border border-yellow-500/20">
                <AlertTriangle size={14} className="text-yellow-500 mt-0.5 flex-shrink-0" />
                <p className="text-xs text-yellow-600 dark:text-yellow-400 break-words">
                  {t("hostDetails.legacyAlgorithms.warning")}
                </p>
              </div>
            )}
            <ToggleRow
              label={t("hostDetails.skipEcdsaHostKey")}
              hint={t("hostDetails.skipEcdsaHostKey.desc")}
              enabled={!!(form.skipEcdsaHostKey ?? inheritedSkipEcdsaHostKey)}
              onToggle={() =>
                update("skipEcdsaHostKey", !(form.skipEcdsaHostKey ?? inheritedSkipEcdsaHostKey))
              }
            />
            <SshAlgorithmOverridesCollapsible
              open={showAlgorithmOverrides}
              onOpenChange={setShowAlgorithmOverrides}
              value={form.algorithms}
              legacyEnabled={!!(form.legacyAlgorithms ?? inheritedLegacyAlgorithms)}
              inheritedFromGroup={inheritedAlgorithmOverrides}
              onChange={(next) => update("algorithms", next)}
              t={t}
            />
          </HostDetailsSection>

          <HostDetailsSection
            icon={<TerminalSquare size={14} className="text-muted-foreground" />}
            title={t("hostDetails.section.terminalBehavior")}
          >
            <TerminalEncodingSelect
              value={form.charset}
              inheritedValue={inheritedDefaults.charset}
              onValueChange={(value) => update("charset", value)}
            />
            <HostDetailsSettingRow label={t("hostDetails.backspaceBehavior")}>
              <Select
                value={form.backspaceBehavior ?? "default"}
                onValueChange={(v) =>
                  update("backspaceBehavior", v === "default" ? undefined : (v as "ctrl-h"))
                }
              >
                <SelectTrigger className="h-8 w-36 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">{t("hostDetails.backspaceBehavior.default")}</SelectItem>
                  <SelectItem value="ctrl-h">^H (0x08)</SelectItem>
                </SelectContent>
              </Select>
            </HostDetailsSettingRow>
          </HostDetailsSection>
        </>
      )}

      {/* Jump Hosts (ProxyJump) — shared for SSH, RDP, and VNC, matching HostDetailsAdvancedSections */}
      {(isSshView || isRemoteDesktopView) && (
        <HostDetailsSection
          icon={<Link2 size={14} className="text-muted-foreground" />}
          title={t("hostDetails.jumpHosts")}
          action={
            chainedHosts.length > 0 ? (
              <Badge variant="secondary" className="text-xs">
                {t("hostDetails.jumpHosts.hops", { count: chainedHosts.length })}
              </Badge>
            ) : (
              <Badge variant="outline" className="text-xs text-muted-foreground">
                {t("hostDetails.jumpHosts.direct")}
              </Badge>
            )
          }
        >
          {chainedHosts.length > 0 ? (
            <button
              type="button"
              className="w-full flex flex-col items-start gap-1 p-2 rounded-md bg-secondary/50 hover:bg-secondary transition-colors cursor-pointer"
              onClick={() => setActiveSubPanel("chain")}
            >
              <div className="w-full flex items-center justify-between">
                <div className="flex items-center gap-1 min-w-0 flex-1">
                  <Link2 size={14} className="text-muted-foreground flex-shrink-0" />
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
          ) : (
            <Button
              type="button"
              variant="ghost"
              className="w-full h-9 justify-start gap-2 text-sm"
              onClick={() => setActiveSubPanel("chain")}
            >
              <Plus size={14} />
              {t("hostDetails.jumpHosts.configure")}
            </Button>
          )}
        </HostDetailsSection>
      )}

      {/* Proxy Configuration — shared across all protocols, matching HostDetailsAdvancedSections */}
      <HostDetailsSection
        icon={<Globe size={14} className="text-muted-foreground" />}
        title={t("hostDetails.proxy")}
        className="overflow-hidden"
      >
        {hasProxyConfig ? (
          <div className="w-full min-w-0 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1">
            <button
              type="button"
              className="min-w-0 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 p-2 rounded-md bg-secondary/50 hover:bg-secondary transition-colors cursor-pointer overflow-hidden"
              onClick={() => setActiveSubPanel("proxy")}
            >
              <Badge variant="secondary" className="text-xs shrink-0">
                {proxySummaryType}
              </Badge>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-sm">
                      {proxySummaryLabel}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" align="start" className="max-w-xs break-all">
                    {proxySummaryTooltip}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-9 w-9 text-muted-foreground hover:text-destructive shrink-0"
              aria-label={t("hostDetails.proxyPanel.remove")}
              onClick={clearProxyConfig}
            >
              <X size={14} />
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="ghost"
            className="w-full h-9 justify-start gap-2 text-sm"
            onClick={() => setActiveSubPanel("proxy")}
          >
            <Plus size={14} />
            {t("hostDetails.proxy.configure")}
          </Button>
        )}
      </HostDetailsSection>

      {/* Environment Variables — SSH only, matching HostDetailsAdvancedSections */}
      {isSshView && (
        <HostDetailsSection
          icon={<Variable size={14} className="text-muted-foreground" />}
          title={t("hostDetails.envVars")}
        >
          {(form.environmentVariables?.length || 0) > 0 ? (
            <button
              type="button"
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
                  setForm((prev) => ({ ...prev, environmentVariables: undefined }));
                }}
              />
            </button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              className="w-full h-9 justify-start gap-2 text-sm"
              onClick={() => setActiveSubPanel("env-vars")}
            >
              <Plus size={14} />
              {t("hostDetails.envVars.add")}
            </Button>
          )}
        </HostDetailsSection>
      )}

      {/* Startup Command — SSH & Telnet, matching HostDetailsAdvancedSections */}
      {(isSshView || isTelnetView) && (
        <HostDetailsSection
          icon={<TerminalSquare size={14} className="text-muted-foreground" />}
          title={t("hostDetails.startupCommand")}
          hint={t("hostDetails.startupCommand.help")}
        >
          <Textarea
            placeholder={
              inheritedDefaults.startupCommand || t("hostDetails.startupCommand.placeholder")
            }
            value={form.startupCommand || ""}
            onChange={(e) => update("startupCommand", e.target.value || undefined)}
            className="min-h-[80px] font-mono text-sm"
            rows={3}
          />
          <HostDetailsSettingRow
            label={t("hostDetails.startupCommand.runMode")}
            hint={t("hostDetails.startupCommand.runMode.help")}
          >
            <Select
              value={effectiveStartupCommandRunMode}
              onValueChange={(value) =>
                update(
                  "startupCommandRunMode",
                  value === inheritedStartupCommandRunMode
                    ? undefined
                    : (value as "lineDelay" | "paste"),
                )
              }
            >
              <SelectTrigger className="h-8 w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="lineDelay">
                  {t("hostDetails.startupCommand.runMode.lineDelay")}
                </SelectItem>
                <SelectItem value="paste">
                  {t("hostDetails.startupCommand.runMode.paste")}
                </SelectItem>
              </SelectContent>
            </Select>
          </HostDetailsSettingRow>
        </HostDetailsSection>
      )}
    </>
  );
};
