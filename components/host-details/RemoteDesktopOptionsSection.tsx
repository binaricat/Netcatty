import {
  ChevronDown,
  ClipboardCopy,
  Eye,
  FolderUp,
  Gauge,
  Maximize2,
  Monitor,
  MousePointer2,
  Palette,
  Scaling,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Users,
  Volume2,
} from "lucide-react";
import React, { useState } from "react";
import {
  DEFAULT_RDP_CONFIG,
  DEFAULT_VNC_CONFIG,
  normalizeRdpConfig,
  normalizeVncConfig,
} from "../../domain/remoteDesktop";
import type {
  GroupConfig,
  Host,
  RdpColorDepth,
  RdpConfig,
  RdpResolutionMode,
  RdpSecurityMode,
  VncConfig,
  VncScalingMode,
} from "../../types";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { HostDetailsSection, HostDetailsSettingRow } from "./HostDetailsSection";
import { RdpResolutionFields, type RdpResolutionDraftProps } from "./RdpResolutionFields";

type Translate = (key: string, params?: Record<string, unknown>) => string;

interface RemoteDesktopOptionsSectionProps extends RdpResolutionDraftProps {
  form: Host;
  setForm: React.Dispatch<React.SetStateAction<Host>>;
  groupDefaults?: Partial<GroupConfig>;
  t: Translate;
}

export const RemoteDesktopOptionsSection: React.FC<RemoteDesktopOptionsSectionProps> = ({
  form,
  setForm,
  groupDefaults,
  t,
  resolutionDraft,
  onResolutionDraftChange,
}) => {
  const [advancedOpen, setAdvancedOpen] = useState(() =>
    Boolean(
      form.rdpConfig?.loadBalanceInfo ||
        form.rdpConfig?.alternateShell ||
        form.rdpConfig?.shellWorkingDir ||
        groupDefaults?.rdpConfig?.loadBalanceInfo ||
        groupDefaults?.rdpConfig?.alternateShell ||
        groupDefaults?.rdpConfig?.shellWorkingDir,
    ),
  );

  if (form.protocol === "rdp") {
    const rdp = normalizeRdpConfig({
      ...(groupDefaults?.rdpConfig ?? {}),
      ...(form.rdpConfig ?? {}),
    });
    const updateRdp = <K extends keyof RdpConfig>(key: K, value: RdpConfig[K]) => {
      setForm((prev) => ({
        ...prev,
        rdpConfig: {
          ...(prev.rdpConfig ?? {}),
          [key]: value,
        },
      }));
    };

    return (
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
              updateRdp("resolutionMode", value as RdpResolutionMode)
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
            form={form}
            setForm={setForm}
            inheritedRdpConfig={groupDefaults?.rdpConfig}
            t={t}
            resolutionDraft={resolutionDraft}
            onResolutionDraftChange={onResolutionDraftChange}
          />
        )}

        <HostDetailsSettingRow
          icon={<Palette />}
          label={t("hostDetails.rdp.colorDepth")}
        >
          <Select
            value={String(rdp.colorDepth)}
            onValueChange={(value) =>
              updateRdp("colorDepth", Number(value) as RdpColorDepth)
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
            onCheckedChange={(checked) => updateRdp("audioEnabled", checked)}
          />
        </HostDetailsSettingRow>

        <HostDetailsSettingRow
          icon={<ClipboardCopy />}
          label={t("hostDetails.rdp.clipboard")}
          hint={t("hostDetails.rdp.clipboardDesc")}
        >
          <Switch
            checked={rdp.clipboardSync}
            onCheckedChange={(checked) => updateRdp("clipboardSync", checked)}
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
              onCheckedChange={(checked) => updateRdp("clipboardFilesEnabled", checked)}
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
              updateRdp("securityMode", value as RdpSecurityMode)
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
            onCheckedChange={(checked) => updateRdp("ignoreCertErrors", checked)}
          />
        </HostDetailsSettingRow>

        <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
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
              <ChevronDown size={14} className="text-muted-foreground group-data-[state=open]:rotate-180 transition-transform" />
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
                  updateRdp("loadBalanceInfo", e.target.value || undefined)
                }
                placeholder={groupDefaults?.rdpConfig?.loadBalanceInfo || t("hostDetails.rdp.loadBalanceInfoPlaceholder")}
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
                  updateRdp("alternateShell", e.target.value || undefined)
                }
                placeholder={groupDefaults?.rdpConfig?.alternateShell || t("hostDetails.rdp.alternateShellPlaceholder")}
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
                  updateRdp("shellWorkingDir", e.target.value || undefined)
                }
                placeholder={groupDefaults?.rdpConfig?.shellWorkingDir || t("hostDetails.rdp.shellWorkingDirPlaceholder")}
                className="h-10 rounded-lg text-sm font-mono"
              />
            </div>
          </CollapsibleContent>
        </Collapsible>
      </HostDetailsSection>
    );
  }

  if (form.protocol === "vnc") {
    const vnc = normalizeVncConfig({
      ...(groupDefaults?.vncConfig ?? {}),
      ...(form.vncConfig ?? {}),
    });
    const updateVnc = <K extends keyof VncConfig>(key: K, value: VncConfig[K]) => {
      setForm((prev) => ({
        ...prev,
        vncConfig: {
          ...(prev.vncConfig ?? {}),
          [key]: value,
        },
      }));
    };

    return (
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
              updateVnc("scalingMode", value as VncScalingMode)
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
              onChange={(e) => updateVnc("quality", Number(e.target.value))}
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
              onChange={(e) => updateVnc("compressionLevel", Number(e.target.value))}
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
            onCheckedChange={(checked) => updateVnc("viewOnly", checked)}
          />
        </HostDetailsSettingRow>

        <HostDetailsSettingRow
          icon={<Users />}
          label={t("hostDetails.vnc.sharedSession")}
          hint={t("hostDetails.vnc.sharedSessionDesc")}
        >
          <Switch
            checked={vnc.sharedSession}
            onCheckedChange={(checked) => updateVnc("sharedSession", checked)}
          />
        </HostDetailsSettingRow>

        <HostDetailsSettingRow
          icon={<ClipboardCopy />}
          label={t("hostDetails.vnc.clipboard")}
          hint={t("hostDetails.vnc.clipboardDesc")}
        >
          <Switch
            checked={vnc.clipboardSync}
            onCheckedChange={(checked) => updateVnc("clipboardSync", checked)}
          />
        </HostDetailsSettingRow>

        <HostDetailsSettingRow
          icon={<MousePointer2 />}
          label={t("hostDetails.vnc.showRemoteCursor")}
          hint={t("hostDetails.vnc.showRemoteCursorDesc")}
        >
          <Switch
            checked={vnc.showRemoteCursor}
            onCheckedChange={(checked) => updateVnc("showRemoteCursor", checked)}
          />
        </HostDetailsSettingRow>
      </HostDetailsSection>
    );
  }

  void DEFAULT_RDP_CONFIG;
  return null;
};
