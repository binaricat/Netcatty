import React from "react";
import { AlertTriangle, ChevronDown, ChevronUp, Forward, Globe, HeartPulse, Link2, Palette, Plus, Router, ShieldAlert, TerminalSquare, Wifi, X, Variable } from "lucide-react";
import { customThemeStore } from "../application/state/customThemeStore";
import { clearHostFontSizeOverride, clearHostThemeOverride } from "../domain/terminalAppearance";
import { MAX_FONT_SIZE, MIN_FONT_SIZE } from "../infrastructure/config/fonts";
import { AlgorithmOverridesPanel } from "./host-details/AlgorithmOverridesPanel";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Textarea } from "./ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { cn } from "../lib/utils";
import { useI18n } from "../application/i18n/I18nProvider";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HostDetailsAdvancedSectionsProps = Record<string, any>;

const ToggleRow: React.FC<{ label: string; enabled: boolean; onToggle: () => void }> = ({ label, enabled, onToggle }) => {
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
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Font Size:</span>
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
              className="px-2 h-8"
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
              className="w-16 text-center h-8"
            />
            <span className="text-sm text-muted-foreground">pt</span>
            {hasEffectiveFontSizeOverride && (
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto h-8 text-primary"
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
            onToggle={() => {
              const enabling = !form.moshEnabled;
              if (enabling) {
                setForm(prev => ({
                  ...prev,
                  moshEnabled: true,
                  deviceType: prev.deviceType === 'network' ? undefined : prev.deviceType,
                  x11Forwarding: undefined,
                }));
              } else {
                update("moshEnabled", false);
              }
            }}
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

        {/* X11 Forwarding */}
        {(!form.protocol || form.protocol === "ssh") && !form.moshEnabled && (
          <Card className="p-3 space-y-2 bg-card border-border/80">
            <div className="flex items-center gap-2">
              <TerminalSquare size={14} className="text-muted-foreground" />
              <p className="text-xs font-semibold">{t("hostDetails.section.x11Forwarding")}</p>
            </div>
            <ToggleRow
              label={t("hostDetails.x11Forwarding")}
              enabled={!!form.x11Forwarding}
              onToggle={() => update("x11Forwarding", !form.x11Forwarding)}
            />
            <p className="text-xs text-muted-foreground">
              {t("hostDetails.x11Forwarding.desc")}
            </p>
          </Card>
        )}

        {/* Network Device Mode — only for SSH hosts without Mosh (serial already uses raw mode) */}
        {(!form.protocol || form.protocol === 'ssh') && !form.moshEnabled && (
        <Card className="p-3 space-y-2 bg-card border-border/80">
          <div className="flex items-center gap-2">
            <Router size={14} className="text-muted-foreground" />
            <p className="text-xs font-semibold">{t("hostDetails.section.deviceType")}</p>
          </div>
          <ToggleRow
            label={t("hostDetails.deviceType")}
            enabled={form.deviceType === 'network'}
            onToggle={() => update("deviceType", form.deviceType === 'network' ? undefined : 'network')}
          />
          <p className="text-xs text-muted-foreground break-words">
            {t("hostDetails.deviceType.desc")}
          </p>
          {form.deviceType === 'network' && (
            <div className="flex items-start gap-2 p-2 rounded-md bg-yellow-500/10 border border-yellow-500/20">
              <AlertTriangle size={14} className="text-yellow-500 mt-0.5 flex-shrink-0" />
              <p className="text-xs text-yellow-600 dark:text-yellow-400 break-words">
                {t("hostDetails.deviceType.warning")}
              </p>
            </div>
          )}
        </Card>
        )}

        {/* SSH Algorithms */}
        <Card className="p-3 space-y-2 bg-card border-border/80">
          <div className="flex items-center gap-2">
            <ShieldAlert size={14} className="text-muted-foreground" />
            <p className="text-xs font-semibold">{t("hostDetails.section.sshAlgorithms")}</p>
          </div>
          {/* Display the *effective* value of these toggles (host field
              falling back to the resolved group default). Without the
              fallback a host that inherits the flag from its group would
              show "off" while the runtime applied it anyway, and the
              toggle's onToggle handler would compute the wrong "next"
              value from the raw host field. */}
          <ToggleRow
            label={t("hostDetails.legacyAlgorithms")}
            enabled={!!(form.legacyAlgorithms ?? effectiveGroupDefaults?.legacyAlgorithms)}
            onToggle={() => update(
              "legacyAlgorithms",
              !(form.legacyAlgorithms ?? effectiveGroupDefaults?.legacyAlgorithms),
            )}
          />
          <p className="text-xs text-muted-foreground break-words">
            {t("hostDetails.legacyAlgorithms.desc")}
          </p>
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
            enabled={!!(form.skipEcdsaHostKey ?? effectiveGroupDefaults?.skipEcdsaHostKey)}
            onToggle={() => update(
              "skipEcdsaHostKey",
              !(form.skipEcdsaHostKey ?? effectiveGroupDefaults?.skipEcdsaHostKey),
            )}
          />
          <p className="text-xs text-muted-foreground break-words">
            {t("hostDetails.skipEcdsaHostKey.desc")}
          </p>
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
        </Card>

        {/* Terminal Behavior — input/output key mappings (backspace, etc.) */}
        <Card className="p-3 space-y-2 bg-card border-border/80">
          <div className="flex items-center gap-2">
            <TerminalSquare size={14} className="text-muted-foreground" />
            <p className="text-xs font-semibold">{t("hostDetails.section.terminalBehavior")}</p>
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">{t("hostDetails.backspaceBehavior")}</p>
            <Select
              value={form.backspaceBehavior ?? "default"}
              onValueChange={(v) => update("backspaceBehavior", v === "default" ? undefined : v)}
            >
              <SelectTrigger className="h-8 w-auto text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">{t("hostDetails.backspaceBehavior.default")}</SelectItem>
                <SelectItem value="ctrl-h">^H (0x08)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </Card>

        {/* Per-host keepalive override */}
        <Card className="p-3 space-y-2 bg-card border-border/80">
          <div className="flex items-center gap-2">
            <HeartPulse size={14} className="text-muted-foreground" />
            <p className="text-xs font-semibold">{t("hostDetails.section.keepalive")}</p>
          </div>
          <ToggleRow
            label={t("hostDetails.keepalive.override")}
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
          <p className="text-xs text-muted-foreground break-words">
            {t("hostDetails.keepalive.desc")}
          </p>
          {form.keepaliveOverride && (
            <div className="space-y-2 pt-1">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">{t("hostDetails.keepalive.interval")}</p>
                <input
                  type="number"
                  min={0}
                  max={3600}
                  className="h-8 w-24 rounded-md border border-input bg-background px-2 text-xs"
                  value={form.keepaliveInterval ?? 0}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (!Number.isFinite(v)) return;
                    if (v < 0 || v > 3600) return;
                    update("keepaliveInterval", v);
                  }}
                />
              </div>
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">{t("hostDetails.keepalive.countMax")}</p>
                <input
                  type="number"
                  min={1}
                  max={100}
                  className="h-8 w-24 rounded-md border border-input bg-background px-2 text-xs"
                  value={form.keepaliveCountMax ?? 3}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (!Number.isFinite(v)) return;
                    if (v < 1 || v > 100) return;
                    update("keepaliveCountMax", v);
                  }}
                />
              </div>
              {(form.keepaliveInterval ?? 0) === 0 && (
                <p className="text-xs text-muted-foreground break-words pl-1">
                  {t("hostDetails.keepalive.disabledHint")}
                </p>
              )}
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
        <Card className="p-3 space-y-2 bg-card border-border/80 overflow-hidden">
          <div className="flex items-center gap-2">
            <Globe size={14} className="text-muted-foreground" />
            <p className="text-xs font-semibold">{t("hostDetails.proxy")}</p>
          </div>
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
        </Card>

        {/* Startup Command */}
        <Card className="p-3 space-y-2 bg-card border-border/80">
          <div className="flex items-center gap-2">
            <TerminalSquare size={14} className="text-muted-foreground" />
            <p className="text-xs font-semibold">{t("hostDetails.startupCommand")}</p>
          </div>
          <Textarea
            placeholder={groupDefaults?.startupCommand || t("hostDetails.startupCommand.placeholder")}
            value={form.startupCommand || ""}
            onChange={(e) => update("startupCommand", e.target.value)}
            className="min-h-[80px] font-mono text-sm"
            rows={3}
          />
          <p className="text-xs text-muted-foreground">
            {t("hostDetails.startupCommand.help")}
          </p>
        </Card>
  </>
);
