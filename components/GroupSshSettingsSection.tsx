import React from "react";
import { ChevronDown, ChevronRight, ChevronUp, Eye, EyeOff, FileKey, FolderOpen, Globe, Key, Link2, MoreHorizontal, Plus, Shield, TerminalSquare, Trash2, Variable, X } from "lucide-react";
import { AlgorithmOverridesPanel } from "./host-details/AlgorithmOverridesPanel";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { HostDetailsSection, HostDetailsSettingRow } from "./host-details";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { Combobox } from "./ui/combobox";
import { Dropdown, DropdownContent, DropdownTrigger } from "./ui/dropdown";
import { Input } from "./ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GroupSshSettingsSectionProps = Record<string, any>;

const ToggleRow: React.FC<{ label: string; hint?: React.ReactNode; enabled: boolean; onToggle: () => void }> = ({ label, hint, enabled, onToggle }) => {
  return (
    <HostDetailsSettingRow label={label} hint={hint}>
      <Switch checked={enabled} onCheckedChange={() => onToggle()} />
    </HostDetailsSettingRow>
  );
};

export const GroupSshSettingsSection: React.FC<GroupSshSettingsSectionProps> = ({
  sshEnabled,
  t,
  removeSsh,
  form,
  update,
  showPassword,
  setShowPassword,
  availableKeys,
  setSelectedCredentialType,
  selectedCredentialType,
  credentialPopoverOpen,
  setCredentialPopoverOpen,
  keysByCategory,
  newKeyFilePath,
  setNewKeyFilePath,
  inheritedLegacyAlgorithms,
  inheritedSkipEcdsaHostKey,
  showAlgorithmOverrides,
  setShowAlgorithmOverrides,
  inheritedAlgorithmOverrides,
  proxySummaryLabel,
  setActiveSubPanel,
  chainedHosts,
}) => {
  if (!sshEnabled) return null;

  return (
          <HostDetailsSection
            icon={<TerminalSquare size={14} className="text-muted-foreground" />}
            title={t("vault.groups.details.ssh")}
            className="overflow-hidden"
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
                    onClick={removeSsh}
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
                <span className="text-xs text-muted-foreground">SSH on</span>
                <div className="ml-auto w-1/2 min-w-0 flex items-center gap-2 justify-end">
                  <Input
                    type="number"
                    placeholder="22"
                    value={form.port ?? ""}
                    onChange={(e) =>
                      update("port", e.target.value ? Number(e.target.value) : undefined)
                    }
                    className="h-8 flex-1 min-w-0 text-center"
                  />
                  <span className="text-xs text-muted-foreground">
                    {t("hostDetails.port")}
                  </span>
                </div>
              </div>
            </div>

            <Input
              placeholder={t("hostDetails.username.placeholder")}
              value={form.username || ""}
              onChange={(e) => update("username", e.target.value || undefined)}
              className="h-10"
            />

            <div className="relative">
              <Input
                placeholder={t("hostDetails.password.placeholder")}
                type={showPassword ? "text" : "password"}
                value={form.password || ""}
                onChange={(e) => update("password", e.target.value || undefined)}
                className="h-10 pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>

            {/* Selected credential display */}
            {form.identityFileId && (
              <div className="flex items-center gap-2 p-2 rounded-md bg-secondary/50 border border-border/60">
                {form.authMethod === "certificate" ? (
                  <Shield size={14} className="text-primary" />
                ) : (
                  <Key size={14} className="text-primary" />
                )}
                <span className="text-sm flex-1 truncate">
                  {availableKeys.find((k) => k.id === form.identityFileId)?.label || "Key"}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
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

            {/* Local key file paths display */}
            {!form.identityFileId && form.identityFilePaths && form.identityFilePaths.length > 0 && (
              <div className="space-y-1">
                {form.identityFilePaths.map((keyPath, idx) => (
                  <div key={idx} className="flex items-center gap-2 h-8 px-2 rounded-md bg-secondary/50 border border-border/60" style={{ maxWidth: '100%' }}>
                    <FileKey size={12} className="text-muted-foreground shrink-0" />
                    <span className="text-xs font-mono truncate" style={{ maxWidth: '320px' }}>{keyPath}</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 shrink-0"
                      onClick={() => {
                        const paths = (form.identityFilePaths || []).filter((_, i) => i !== idx);
                        update("identityFilePaths", paths.length > 0 ? paths : undefined);
                        if (paths.length === 0) update("authMethod", undefined);
                      }}
                    >
                      <X size={10} />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {/* Credential type selection with inline popover - hidden when credential is selected */}
            {!form.identityFileId &&
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

                      <button
                        type="button"
                        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-secondary/80 transition-colors text-left"
                        onClick={() => {
                          setSelectedCredentialType("localKeyFile");
                          setCredentialPopoverOpen(false);
                        }}
                      >
                        <FileKey size={16} className="text-muted-foreground" />
                        <span className="text-sm font-medium">
                          {t("hostDetails.credential.localKeyFile")}
                        </span>
                      </button>
                    </div>
                  </PopoverContent>
                </Popover>
              )}

            {/* Key selection combobox - appears after selecting "Key" type */}
            {selectedCredentialType === "key" &&
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
            {selectedCredentialType === "certificate" &&
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

            {/* Local key file path input - appears after selecting "Local Key File" type */}
            {!form.identityFileId && selectedCredentialType === "localKeyFile" && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-1 w-full">
                  <input
                    type="text"
                    className="flex-1 w-0 h-8 px-2 text-xs font-mono bg-background border border-border/60 rounded-md focus:outline-none focus:ring-1 focus:ring-ring"
                    placeholder={t("hostDetails.credential.localKeyFilePlaceholder")}
                    value={newKeyFilePath}
                    onChange={(e) => setNewKeyFilePath(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && newKeyFilePath.trim()) {
                        e.preventDefault();
                        const paths = [...(form.identityFilePaths || []), newKeyFilePath.trim()];
                        update("identityFilePaths", paths);
                        update("identityFileId", undefined);
                        update("authMethod", "key");
                        setNewKeyFilePath("");
                      }
                    }}
                  />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="secondary"
                        size="icon"
                        className="h-8 w-8 shrink-0"
                        onClick={async () => {
                          const bridge = (window as unknown as { netcatty?: NetcattyBridge }).netcatty;
                          if (!bridge?.selectFile) return;
                          const filePath = await bridge.selectFile(
                            "Select SSH Private Key",
                            undefined,
                            [{ name: "All Files", extensions: ["*"] }]
                          );
                          if (filePath) {
                            const paths = [...(form.identityFilePaths || []), filePath];
                            update("identityFilePaths", paths);
                            update("identityFileId", undefined);
                            update("authMethod", "key");
                          }
                        }}
                      >
                        <FolderOpen size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("hostDetails.credential.browseKeyFile")}</TooltipContent>
                  </Tooltip>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    onClick={() => setSelectedCredentialType(null)}
                  >
                    <X size={14} />
                  </Button>
                </div>
              </div>
            )}

            <ToggleRow
              label={t("hostDetails.agentForwarding")}
              hint={t("hostDetails.agentForwarding.desc")}
              enabled={!!form.agentForwarding}
              onToggle={() => update("agentForwarding", !form.agentForwarding)}
            />

            {/* Startup Command — Textarea so multi-line sequences are typeable
                here just like on the per-host details panel (#1083 follow-up). */}
            <Textarea
              placeholder={t("hostDetails.startupCommand.placeholder")}
              value={form.startupCommand || ""}
              onChange={(e) => update("startupCommand", e.target.value || undefined)}
              className="min-h-[80px] font-mono text-sm"
              rows={3}
            />

            {/* Display the *effective* value (this group's field falling
                back to the resolved parent default). Same rationale as
                in HostDetailsPanel — without the fallback, a child group
                that inherits a flag from a parent would show "off" in
                the UI while connections still applied it. */}
            <ToggleRow
              label={t("hostDetails.legacyAlgorithms")}
              hint={t("hostDetails.legacyAlgorithms.desc")}
              enabled={!!(form.legacyAlgorithms ?? inheritedLegacyAlgorithms)}
              onToggle={() => update(
                "legacyAlgorithms",
                !(form.legacyAlgorithms ?? inheritedLegacyAlgorithms),
              )}
            />

            <ToggleRow
              label={t("hostDetails.skipEcdsaHostKey")}
              hint={t("hostDetails.skipEcdsaHostKey.desc")}
              enabled={!!(form.skipEcdsaHostKey ?? inheritedSkipEcdsaHostKey)}
              onToggle={() => update(
                "skipEcdsaHostKey",
                !(form.skipEcdsaHostKey ?? inheritedSkipEcdsaHostKey),
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
                  legacyEnabled={!!(form.legacyAlgorithms ?? inheritedLegacyAlgorithms)}
                  inheritedFromGroup={inheritedAlgorithmOverrides}
                  onChange={(next) => update("algorithms", next)}
                />
              </CollapsibleContent>
            </Collapsible>

            {/* Proxy */}
            <button
              type="button"
              className="w-full flex min-h-12 items-center justify-between gap-3 rounded-lg border border-border/60 bg-secondary/40 px-3 py-2 transition-colors hover:bg-secondary/70"
              onClick={() => setActiveSubPanel("proxy")}
            >
              <div className="flex items-center gap-2">
                <Globe size={14} className="text-muted-foreground" />
                <span className="text-sm">{t("hostDetails.proxy")}</span>
              </div>
              <div className="flex min-w-0 items-center gap-2">
                {(form.proxyConfig?.host || form.proxyProfileId) && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="min-w-0 cursor-default">
                        <Badge
                          variant="secondary"
                          className="max-w-[160px] truncate text-xs"
                        >
                          {proxySummaryLabel}
                        </Badge>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>{proxySummaryLabel}</TooltipContent>
                  </Tooltip>
                )}
                <ChevronRight size={14} className="text-muted-foreground" />
              </div>
            </button>

            {/* Host Chaining */}
            <button
              type="button"
              className="w-full flex min-h-12 items-center justify-between gap-3 rounded-lg border border-border/60 bg-secondary/40 px-3 py-2 transition-colors hover:bg-secondary/70"
              onClick={() => setActiveSubPanel("chain")}
            >
              <div className="flex items-center gap-2">
                <Link2 size={14} className="text-muted-foreground" />
                <span className="text-sm">{t("hostDetails.jumpHosts")}</span>
              </div>
              <div className="flex items-center gap-2">
                {chainedHosts.length > 0 && (
                  <Badge variant="secondary" className="text-xs">
                    {t("hostDetails.jumpHosts.hops", { count: chainedHosts.length })}
                  </Badge>
                )}
                <ChevronRight size={14} className="text-muted-foreground" />
              </div>
            </button>

            {/* Environment Variables */}
            <button
              type="button"
              className="w-full flex min-h-12 items-center justify-between gap-3 rounded-lg border border-border/60 bg-secondary/40 px-3 py-2 transition-colors hover:bg-secondary/70"
              onClick={() => setActiveSubPanel("env-vars")}
            >
              <div className="flex items-center gap-2">
                <Variable size={14} className="text-muted-foreground" />
                <span className="text-sm">{t("hostDetails.envVars")}</span>
              </div>
              <div className="flex items-center gap-2">
                {(form.environmentVariables?.length || 0) > 0 && (
                  <Badge variant="secondary" className="text-xs">
                    {form.environmentVariables!.length}
                  </Badge>
                )}
                <ChevronRight size={14} className="text-muted-foreground" />
              </div>
            </button>

            {/* Mosh */}
            <ToggleRow
              label="Mosh"
              enabled={!!form.moshEnabled}
              onToggle={() => update("moshEnabled", !form.moshEnabled)}
            />
            {form.moshEnabled && (
              <Input
                placeholder={t("hostDetails.moshServerPath") || "mosh-server path"}
                value={form.moshServerPath || ""}
                onChange={(e) => update("moshServerPath", e.target.value || undefined)}
                className="h-10"
              />
            )}

            {/* EternalTerminal */}
            <ToggleRow
              label="EternalTerminal"
              enabled={!!form.etEnabled}
              onToggle={() => update("etEnabled", !form.etEnabled)}
            />
            {form.etEnabled && (
              <Input
                type="number"
                placeholder={t("hostDetails.et.port") || "ET server port (2022)"}
                value={form.etPort ?? ""}
                onChange={(e) => {
                  const v = e.target.value.trim();
                  update("etPort", v === "" ? undefined : Number(v));
                }}
                className="h-10"
              />
            )}

            {/* Backspace behavior — terminal input mapping, lives at the
                bottom of the SSH section so it doesn't get visually
                grouped with the algorithm controls above. */}
            <HostDetailsSettingRow label={t("hostDetails.backspaceBehavior")}>
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
            </HostDetailsSettingRow>
          </HostDetailsSection>
  );
};
