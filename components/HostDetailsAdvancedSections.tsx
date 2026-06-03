import React from "react";
import { AlertTriangle, ChevronDown, ChevronUp, Forward, Globe, HeartPulse, Link2, Palette, Plus, Router, ShieldAlert, TerminalSquare, Wifi, X, Variable } from "lucide-react";
import { customThemeStore } from "../application/state/customThemeStore";
import { clearHostFontSizeOverride, clearHostThemeOverride } from "../domain/terminalAppearance";
import { MAX_FONT_SIZE, MIN_FONT_SIZE } from "../infrastructure/config/fonts";
import { AlgorithmOverridesPanel } from "./host-details/AlgorithmOverridesPanel";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { HostDetailsSection, HostDetailsSettingRow } from "./host-details";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HostDetailsAdvancedSectionsProps = Record<string, any>;

const ToggleRow: React.FC<{ label: string; hint?: React.ReactNode; enabled: boolean; onToggle: () => void }> = ({ label, hint, enabled, onToggle }) => {
  return (
    <HostDetailsSettingRow label={label} hint={hint}>
      <Switch checked={enabled} onCheckedChange={() => onToggle()} />
    </HostDetailsSettingRow>
  );
};

export const HostDetailsAdvancedSections: React.FC<HostDetailsAdvancedSectionsProps> = ({
  t,
  form,
  setForm,
  update,
  effectiveThemeId,
  hasEffectiveThemeOverride,
  effectiveFontSize,
  hasEffectiveFontSizeOverride,
  sshAgentStatus,
  effectiveGroupDefaults,
  showAlgorithmOverrides,
  setShowAlgorithmOverrides,
  chainedHosts,
  setActiveSubPanel,
  clearHostChain,
  proxySummaryType,
  proxySummaryLabel,
  proxySummaryTooltip,
  clearProxyConfig,
  groupDefaults,
}) => (
  <>
        <HostDetailsSection
          icon={<Palette size={14} className="text-muted-foreground" />}
          title={t("hostDetails.section.appearance")}
        >

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
          {hasEffectiveThemeOverride && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start text-primary"
              onClick={() => setForm((prev) => clearHostThemeOverride(prev))}
            >
              {t("common.useGlobal")}
            </Button>
          )}

          {/* Font Size */}
          <HostDetailsSettingRow label="Font Size">
            <div className="flex items-center gap-2">
              <Button
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
                  const val = parseInt(e.target.value);
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
              {hasEffectiveFontSizeOverride && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-primary"
                  onClick={() => setForm((prev) => clearHostFontSizeOverride(prev))}
                >
                  {t("common.useGlobal")}
                </Button>
              )}
              <Button
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
          </HostDetailsSettingRow>
        </HostDetailsSection>

        <HostDetailsSection
          icon={<Wifi size={14} className="text-muted-foreground" />}
          title={t("hostDetails.section.mosh")}
        >
          <ToggleRow
            label="Mosh"
            enabled={!!form.moshEnabled}
            onToggle={() => {
              const enabling = !form.moshEnabled;
              if (enabling) {
                setForm(prev => ({
                  ...prev,
                  moshEnabled: true,
                  etEnabled: false,
                  deviceType: prev.deviceType === 'network' ? undefined : prev.deviceType,
                  x11Forwarding: undefined,
                }));
              } else {
                update("moshEnabled", false);
              }
            }}
          />
        </HostDetailsSection>

        <HostDetailsSection
          icon={<Wifi size={14} className="text-muted-foreground" />}
          title={t("hostDetails.section.et")}
        >
          <ToggleRow
            label="EternalTerminal"
            enabled={!!form.etEnabled}
            onToggle={() => {
              const enabling = !form.etEnabled;
              if (enabling) {
                setForm(prev => ({
                  ...prev,
                  etEnabled: true,
                  moshEnabled: false,
                  deviceType: prev.deviceType === 'network' ? undefined : prev.deviceType,
                  x11Forwarding: undefined,
                }));
              } else {
                update("etEnabled", false);
              }
            }}
          />
          {form.etEnabled && (
            <>
              <HostDetailsSettingRow label={t("hostDetails.et.port")} hint={t("hostDetails.et.port.desc")}>
                <Input
                  type="number"
                  className="w-28"
                  placeholder="2022"
                  value={form.etPort ?? ""}
                  onChange={(e) => {
                    const v = e.target.value.trim();
                    update("etPort", v === "" ? undefined : Number(v));
                  }}
                />
              </HostDetailsSettingRow>
            </>
          )}
        </HostDetailsSection>

        {/* Agent Forwarding */}
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
        </HostDetailsSection>

        {/* X11 Forwarding */}
        {(!form.protocol || form.protocol === "ssh") && !form.moshEnabled && !form.etEnabled && (
          <HostDetailsSection
            icon={<TerminalSquare size={14} className="text-muted-foreground" />}
            title={t("hostDetails.section.x11Forwarding")}
          >
            <ToggleRow
              label={t("hostDetails.x11Forwarding")}
              hint={t("hostDetails.x11Forwarding.desc")}
              enabled={!!form.x11Forwarding}
              onToggle={() => update("x11Forwarding", !form.x11Forwarding)}
            />
          </HostDetailsSection>
        )}

        {/* Network Device Mode — only for SSH hosts without Mosh / ET (serial already uses raw mode) */}
        {(!form.protocol || form.protocol === 'ssh') && !form.moshEnabled && !form.etEnabled && (
        <HostDetailsSection
          icon={<Router size={14} className="text-muted-foreground" />}
          title={t("hostDetails.section.deviceType")}
        >
          <ToggleRow
            label={t("hostDetails.deviceType")}
            hint={t("hostDetails.deviceType.desc")}
            enabled={form.deviceType === 'network'}
            onToggle={() => update("deviceType", form.deviceType === 'network' ? undefined : 'network')}
          />
          {form.deviceType === 'network' && (
            <div className="flex items-start gap-2 p-2 rounded-md bg-yellow-500/10 border border-yellow-500/20">
              <AlertTriangle size={14} className="text-yellow-500 mt-0.5 flex-shrink-0" />
              <p className="text-xs text-yellow-600 dark:text-yellow-400 break-words">
                {t("hostDetails.deviceType.warning")}
              </p>
            </div>
          )}
        </HostDetailsSection>
        )}

        {/* SSH Algorithms */}
        <HostDetailsSection
          icon={<ShieldAlert size={14} className="text-muted-foreground" />}
          title={t("hostDetails.section.sshAlgorithms")}
        >
          {/* Display the *effective* value of these toggles (host field
              falling back to the resolved group default). Without the
              fallback a host that inherits the flag from its group would
              show "off" while the runtime applied it anyway, and the
              toggle's onToggle handler would compute the wrong "next"
              value from the raw host field. */}
          <ToggleRow
            label={t("hostDetails.legacyAlgorithms")}
            hint={t("hostDetails.legacyAlgorithms.desc")}
            enabled={!!(form.legacyAlgorithms ?? effectiveGroupDefaults?.legacyAlgorithms)}
            onToggle={() => update(
              "legacyAlgorithms",
              !(form.legacyAlgorithms ?? effectiveGroupDefaults?.legacyAlgorithms),
            )}
          />
          {(form.legacyAlgorithms ?? effectiveGroupDefaults?.legacyAlgorithms) && (
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
            enabled={!!(form.skipEcdsaHostKey ?? effectiveGroupDefaults?.skipEcdsaHostKey)}
            onToggle={() => update(
              "skipEcdsaHostKey",
              !(form.skipEcdsaHostKey ?? effectiveGroupDefaults?.skipEcdsaHostKey),
            )}
          />
          <Collapsible open={showAlgorithmOverrides} onOpenChange={setShowAlgorithmOverrides}>
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                className="w-full justify-between h-8 px-2 hover:bg-accent/50"
              >
                <span className="text-xs font-medium text-muted-foreground">
                  {t("hostDetails.algorithms.advanced")}
                  {form.algorithms && Object.keys(form.algorithms).length > 0 && (
                    <span className="ml-1.5 text-[10px] text-yellow-600 dark:text-yellow-400">
                      ({t("hostDetails.algorithms.customized")})
                    </span>
                  )}
                </span>
                {showAlgorithmOverrides
                  ? <ChevronUp size={14} className="text-muted-foreground" />
                  : <ChevronDown size={14} className="text-muted-foreground" />}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2">
              <AlgorithmOverridesPanel
                value={form.algorithms}
                /* Use the effective legacy flag (host value falling back to
                   the currently selected group's default) so the seed
                   reflects what the host would actually advertise. We
                   read from `effectiveGroupDefaults` (re-resolved on
                   every form.group change), not the `groupDefaults` prop
                   — otherwise switching the host into a different group
                   without saving first would seed from the original
                   group's flag and silently mis-populate the override. */
                legacyEnabled={!!(form.legacyAlgorithms ?? effectiveGroupDefaults?.legacyAlgorithms)}
                inheritedFromGroup={effectiveGroupDefaults?.algorithms}
                onChange={(next) => update("algorithms", next)}
              />
            </CollapsibleContent>
          </Collapsible>
        </HostDetailsSection>

        {/* Terminal Behavior — input/output key mappings (backspace, etc.) */}
        <HostDetailsSection
          icon={<TerminalSquare size={14} className="text-muted-foreground" />}
          title={t("hostDetails.section.terminalBehavior")}
        >
          <HostDetailsSettingRow label={t("hostDetails.backspaceBehavior")}>
            <Select
              value={form.backspaceBehavior ?? "default"}
              onValueChange={(v) => update("backspaceBehavior", v === "default" ? undefined : v)}
            >
              <SelectTrigger className="h-10 w-36 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">{t("hostDetails.backspaceBehavior.default")}</SelectItem>
                <SelectItem value="ctrl-h">^H (0x08)</SelectItem>
              </SelectContent>
            </Select>
          </HostDetailsSettingRow>
        </HostDetailsSection>

        {/* Per-host keepalive override */}
        <HostDetailsSection
          icon={<HeartPulse size={14} className="text-muted-foreground" />}
          title={t("hostDetails.section.keepalive")}
        >
          <ToggleRow
            label={t("hostDetails.keepalive.override")}
            hint={t("hostDetails.keepalive.desc")}
            enabled={!!form.keepaliveOverride}
            onToggle={() => {
              const next = !form.keepaliveOverride;
              update("keepaliveOverride", next);
              // Seed sensible per-host defaults the first time the user
              // turns the override on so the inputs aren't empty.
              if (next) {
                if (form.keepaliveInterval == null) update("keepaliveInterval", 0);
                if (form.keepaliveCountMax == null) update("keepaliveCountMax", 3);
              }
            }}
          />
          {form.keepaliveOverride && (
            <div className="space-y-2 pt-1">
              <HostDetailsSettingRow label={t("hostDetails.keepalive.interval")}>
                <Input
                  type="number"
                  min={0}
                  max={3600}
                  className="h-8 w-24 text-xs"
                  value={form.keepaliveInterval ?? 0}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (!Number.isFinite(v)) return;
                    if (v < 0 || v > 3600) return;
                    update("keepaliveInterval", v);
                  }}
                />
              </HostDetailsSettingRow>
              <HostDetailsSettingRow label={t("hostDetails.keepalive.countMax")}>
                <Input
                  type="number"
                  min={1}
                  max={100}
                  className="h-8 w-24 text-xs"
                  value={form.keepaliveCountMax ?? 3}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (!Number.isFinite(v)) return;
                    if (v < 1 || v > 100) return;
                    update("keepaliveCountMax", v);
                  }}
                />
              </HostDetailsSettingRow>
              {(form.keepaliveInterval ?? 0) === 0 && (
                <p className="text-xs text-muted-foreground break-words pl-1">
                  {t("hostDetails.keepalive.disabledHint")}
                </p>
              )}
            </div>
          )}
        </HostDetailsSection>

        {/* Proxy via Hosts (Jump Hosts / ProxyJump) */}
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
        </HostDetailsSection>

        {/* Proxy Configuration */}
        <HostDetailsSection
          icon={<Globe size={14} className="text-muted-foreground" />}
          title={t("hostDetails.proxy")}
          className="overflow-hidden"
        >
          {form.proxyConfig?.host || form.proxyProfileId ? (
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
              variant="ghost"
              className="w-full h-9 justify-start gap-2 text-sm"
              onClick={() => setActiveSubPanel("proxy")}
            >
              <Plus size={14} />
              {t("hostDetails.proxy.configure")}
            </Button>
          )}
        </HostDetailsSection>

        {/* Environment Variables */}
        <HostDetailsSection
          icon={<Variable size={14} className="text-muted-foreground" />}
          title={t("hostDetails.envVars")}
        >
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
                  setForm((prev) => ({ ...prev, environmentVariables: undefined }));
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
        </HostDetailsSection>

        {/* Startup Command */}
        <HostDetailsSection
          icon={<TerminalSquare size={14} className="text-muted-foreground" />}
          title={t("hostDetails.startupCommand")}
          hint={t("hostDetails.startupCommand.help")}
        >
          <Textarea
            placeholder={groupDefaults?.startupCommand || t("hostDetails.startupCommand.placeholder")}
            value={form.startupCommand || ""}
            onChange={(e) => update("startupCommand", e.target.value)}
            className="min-h-[80px] font-mono text-sm"
            rows={3}
          />
        </HostDetailsSection>
  </>
);
