import React from "react";
import { ChevronRight, Info } from "lucide-react";
import { applyGroupDefaults, resolveGroupDefaults } from "../domain/groupConfig";
import { sanitizeCredentialValue } from "../domain/credentials";
import { resolveBridgeKeyAuth, resolveHostAuth } from "../domain/sshAuth";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { toast } from "./ui/toast";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KeychainExportPanelProps = Record<string, any>;

export const KeychainExportPanel: React.FC<KeychainExportPanelProps> = ({
  panel,
  t,
  getKeyIcon,
  getKeyTypeDisplay,
  setShowHostSelector,
  exportHost,
  exportLocation,
  setExportLocation,
  exportFilename,
  setExportFilename,
  exportAdvancedOpen,
  setExportAdvancedOpen,
  exportScript,
  setExportScript,
  isExporting,
  setIsExporting,
  keys,
  identities,
  groupConfigs,
  execCommand,
  onSaveIdentity,
  onSaveHost,
  closePanel,
}) => {
  return (
              <>
                {/* Key info card */}
                <div className="flex items-center gap-3 p-3 bg-card border border-border/80 rounded-lg">
                  <div
                    className={cn(
                      "h-10 w-10 rounded-md flex items-center justify-center",
                      panel.key.certificate
                        ? "bg-emerald-500/15 text-emerald-500"
                        : "bg-primary/15 text-primary",
                    )}
                  >
                    {getKeyIcon(panel.key)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold truncate">
                      {panel.key.label}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t("auth.keyType", { type: getKeyTypeDisplay(panel.key) })}
                    </p>
                  </div>
                </div>

                {/* Export to field */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-muted-foreground">
                      {t("keychain.export.exportTo")}
                    </Label>
                    <Button
                      variant="link"
                      className="h-auto p-0 text-primary text-sm"
                      onClick={() => setShowHostSelector(true)}
                    >
                      {t("keychain.export.selectHost")}
                    </Button>
                  </div>
                  <Input
                    value={exportHost?.label || ""}
                    readOnly
                    placeholder={t("common.selectAHostPlaceholder")}
                    className="bg-muted/50 cursor-pointer"
                    onClick={() => setShowHostSelector(true)}
                  />
                </div>

                {/* Location field */}
                <div className="space-y-2">
                  <Label className="text-muted-foreground">
                    {t("keychain.export.location")}
                  </Label>
                  <Input
                    value={exportLocation}
                    onChange={(e) => setExportLocation(e.target.value)}
                    placeholder=".ssh"
                  />
                </div>

                {/* Filename field */}
                <div className="space-y-2">
                  <Label className="text-muted-foreground">
                    {t("keychain.export.filename")}
                  </Label>
                  <Input
                    value={exportFilename}
                    onChange={(e) => setExportFilename(e.target.value)}
                    placeholder="authorized_keys"
                  />
                </div>

                {/* Info note */}
                <div className="flex items-start gap-2 p-3 bg-muted/50 border border-border/60 rounded-lg">
                  <Info
                    size={14}
                    className="mt-0.5 text-muted-foreground shrink-0"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("keychain.export.note", {
                      unix: "UNIX",
                      advanced: t("common.advanced"),
                    })}
                  </p>
                </div>

                {/* Advanced collapsible */}
                <Collapsible
                  open={exportAdvancedOpen}
                  onOpenChange={setExportAdvancedOpen}
                >
                  <CollapsibleTrigger asChild>
                    <Button
                      variant="ghost"
                      className="w-full justify-between px-0 h-10 hover:bg-transparent hover:text-current"
                    >
                      <span className="font-medium">{t("common.advanced")}</span>
                      <ChevronRight
                        size={16}
                        className={cn(
                          "transition-transform",
                          exportAdvancedOpen && "rotate-90",
                        )}
                      />
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="space-y-2 pt-2">
                    <Label className="text-muted-foreground">
                      {t("keychain.export.script")}
                    </Label>
                    <Textarea
                      value={exportScript}
                      onChange={(e) => setExportScript(e.target.value)}
                      className="min-h-[180px] font-mono text-xs"
                      placeholder={t("keychain.export.scriptPlaceholder")}
                    />
                  </CollapsibleContent>
                </Collapsible>

                {/* Export button */}
                <Button
                  className="w-full h-11"
                  disabled={
                    !exportHost ||
                    !exportLocation ||
                    !exportFilename ||
                    isExporting
                  }
                  onClick={async () => {
                    if (!exportHost || !panel.key.publicKey) return;

                    setIsExporting(true);

                    try {
                      const exportAuth = resolveHostAuth({
                        host: exportHost,
                        keys,
                        identities,
                      });
                      const exportKeyAuth = resolveBridgeKeyAuth({
                        key: exportAuth.key,
                        fallbackIdentityFilePaths: exportAuth.authMethod === "password" || exportAuth.keyId
                          ? undefined
                          : exportHost.identityFilePaths,
                        passphrase: exportAuth.passphrase,
                      });
                      const exportPassword = sanitizeCredentialValue(exportAuth.password);

                      // Need either password or a usable key to run remote command.
                      if (
                        !exportPassword &&
                        !exportKeyAuth.privateKey &&
                        !exportKeyAuth.identityFilePaths?.length
                      ) {
                        throw new Error(
                          t("keychain.export.missingCredentials"),
                        );
                      }

                      // Escape the public key for shell (single quotes, escape existing quotes)
                      const escapedPublicKey = panel.key.publicKey.replace(
                        /'/g,
                        "'\\''",
                      );

                      // Build the command by replacing $1, $2, $3
                      const scriptWithVars = exportScript
                        .replace(/\$1/g, exportLocation)
                        .replace(/\$2/g, exportFilename)
                        .replace(/\$3/g, `'${escapedPublicKey}'`);

                      // Execute the script directly - SSH exec handles multiline commands
                      const command = scriptWithVars;

                      // Resolve the effective host (applying group
                      // defaults), so algorithm settings inherited from
                      // the group reach the bridge — the host object on
                      // its own only carries explicitly set fields.
                      const effectiveExportHost = exportHost.group
                        ? applyGroupDefaults(
                          exportHost,
                          resolveGroupDefaults(exportHost.group, groupConfigs),
                        )
                        : applyGroupDefaults(exportHost, {});

                      // Execute via SSH
                      const result = await execCommand({
                        hostname: effectiveExportHost.hostname,
                        username: exportAuth.username,
                        port: effectiveExportHost.port || 22,
                        password: exportPassword,
                        privateKey: exportKeyAuth.privateKey,
                        certificate: exportAuth.key?.certificate,
                        publicKey: exportAuth.key?.publicKey,
                        keyId: exportAuth.keyId,
                        keySource: exportAuth.key?.source,
                        passphrase: exportKeyAuth.passphrase,
                        identityFilePaths: exportKeyAuth.identityFilePaths,
                        // Carry the effective host's algorithm settings
                        // (host value falling back to its group default)
                        // so the one-off SSH exec honors them just like
                        // the interactive terminal does.
                        legacyAlgorithms: effectiveExportHost.legacyAlgorithms,
                        skipEcdsaHostKey: effectiveExportHost.skipEcdsaHostKey,
                        algorithmOverrides: effectiveExportHost.algorithms,
                        command,
                        timeout: 30000,
                        enableKeyboardInteractive: true,
                        sessionId: `export-key:${effectiveExportHost.id}:${panel.key.id}`,
                      });

                      // Check result - code 0, null, or undefined with no stderr is success
                      const exitCode = result?.code;
                      const hasError = result?.stderr?.trim();
                      if (exitCode === 0 || (exitCode == null && !hasError)) {
                        // Update identity (preferred) or host to use this key for authentication
                        if (exportHost.identityId && onSaveIdentity) {
                          const existing = identities.find(
                            (i) => i.id === exportHost.identityId,
                          );
                          if (existing) {
                            onSaveIdentity({
                              ...existing,
                              authMethod: "key",
                              keyId: panel.key.id,
                            });
                          }
                        } else if (onSaveHost) {
                          onSaveHost({
                            ...exportHost,
                            identityFileId: panel.key.id,
                            authMethod: "key",
                          });
                        }
                        toast.success(
                          t("keychain.export.successMessage", {
                            host: exportHost.label,
                          }),
                          t("keychain.export.successTitle"),
                        );
                        closePanel();
                      } else {
                        const errorMsg =
                          hasError ||
                          result?.stdout?.trim() ||
                          t("keychain.export.exitCode", { code: exitCode });
                        toast.error(
                          t("keychain.export.failedMessage", { error: errorMsg }),
                          t("keychain.export.failedTitle"),
                        );
                      }
                    } catch (err) {
                      const message =
                        err instanceof Error ? err.message : String(err);
                      toast.error(
                        t("keychain.export.failedPrefix", { error: message }),
                        t("keychain.export.failedTitle"),
                      );
                    } finally {
                      setIsExporting(false);
                    }
                  }}
                >
                  {isExporting
                    ? t("keychain.export.exporting")
                    : t("keychain.export.exportAndAttach")}
                </Button>
              </>
  );
};
