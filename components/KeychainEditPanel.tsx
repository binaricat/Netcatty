import React from "react";
import { Eye, EyeOff, FileKey, Info } from "lucide-react";
import type { SSHKey } from "../types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KeychainEditPanelProps = Record<string, any>;

export const KeychainEditPanel: React.FC<KeychainEditPanelProps> = ({
  panel,
  t,
  draftKey,
  setDraftKey,
  showPassphrase,
  setShowPassphrase,
  openKeyExport,
  onUpdate,
  closePanel,
}) => {
  return (
              <>
                <div className="space-y-2">
                  <Label>{t("keychain.edit.labelRequired")}</Label>
                  <Input
                    value={draftKey.label || ""}
                    onChange={(e) =>
                      setDraftKey({ ...draftKey, label: e.target.value })
                    }
                    placeholder={t("keychain.edit.keyLabelPlaceholder")}
                  />
                </div>

                {/* Reference key: show file path read-only */}
                {draftKey.source === 'reference' && draftKey.filePath && (
                  <div className="space-y-2">
                    <Label className="text-muted-foreground">
                      {t("keychain.edit.filePath")}
                    </Label>
                    <div className="flex items-center gap-2 p-2 rounded-md bg-secondary/50 border border-border/60">
                      <FileKey size={14} className="text-primary shrink-0" />
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="text-xs font-mono truncate cursor-default">
                            {draftKey.filePath}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>{draftKey.filePath}</TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                )}

                {/* Managed key: show private key editor */}
                {draftKey.source !== 'reference' && (
                  <div className="space-y-2">
                    <Label className="text-destructive">
                      {t("keychain.edit.privateKeyRequired")}
                    </Label>
                    <Textarea
                      value={draftKey.privateKey || ""}
                      onChange={(e) =>
                        setDraftKey({ ...draftKey, privateKey: e.target.value })
                      }
                      placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                      className="min-h-[180px] font-mono text-xs"
                    />
                  </div>
                )}

                {draftKey.source !== 'reference' && (
                  <div className="space-y-2">
                    <Label className="text-muted-foreground">
                      {t("keychain.edit.publicKey")}
                    </Label>
                    <Textarea
                      value={draftKey.publicKey || ""}
                      onChange={(e) =>
                        setDraftKey({ ...draftKey, publicKey: e.target.value })
                      }
                      placeholder="ssh-ed25519 AAAA..."
                      className="min-h-[80px] font-mono text-xs"
                    />
                  </div>
                )}

                {draftKey.source !== 'reference' && (
                  <div className="space-y-2">
                    <Label className="text-muted-foreground">
                      {t("keychain.edit.certificate")}
                    </Label>
                    <Textarea
                      value={draftKey.certificate || ""}
                      onChange={(e) =>
                        setDraftKey({ ...draftKey, certificate: e.target.value })
                      }
                      placeholder={t("keychain.edit.certificatePlaceholder")}
                      className="min-h-[60px] font-mono text-xs"
                    />
                  </div>
                )}

                {/* Passphrase section */}
                <div className="space-y-2">
                  <Label>{t('terminal.auth.passphrase')}</Label>
                  <div className="relative">
                    <Input
                      type={showPassphrase ? 'text' : 'password'}
                      value={draftKey.passphrase || ''}
                      onChange={(e) =>
                        setDraftKey({ ...draftKey, passphrase: e.target.value })
                      }
                      placeholder={t('keychain.generate.passphrasePlaceholder')}
                      className="pr-10"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="absolute right-1 top-1/2 -translate-y-1/2 h-8 w-8"
                      onClick={() => setShowPassphrase(!showPassphrase)}
                    >
                      {showPassphrase ? <EyeOff size={14} /> : <Eye size={14} />}
                    </Button>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="editSavePassphrase"
                      checked={draftKey.savePassphrase || false}
                      onChange={(e) =>
                        setDraftKey({ ...draftKey, savePassphrase: e.target.checked })
                      }
                      className="h-4 w-4 rounded border-border"
                    />
                    <Label htmlFor="editSavePassphrase" className="text-sm font-normal cursor-pointer">
                      {t('keychain.generate.savePassphrase')}
                    </Label>
                  </div>
                </div>

                {/* Key Export section - only for managed keys */}
                {draftKey.source !== 'reference' && (
                  <div className="pt-4 mt-4 border-t border-border/60">
                    <div className="flex items-center gap-2 mb-3">
                      <span className="text-sm font-medium">
                        {t("keychain.edit.keyExport")}
                      </span>
                      <div className="h-4 w-4 rounded-full bg-muted flex items-center justify-center">
                        <Info size={10} className="text-muted-foreground" />
                      </div>
                    </div>
                    <Button
                      className="w-full h-11"
                      onClick={() => openKeyExport(panel.key)}
                    >
                      {t("keychain.edit.exportToHost")}
                    </Button>
                  </div>
                )}

                {/* Save button */}
                <Button
                  className="w-full h-11 mt-4"
                  disabled={
                    !draftKey.label?.trim() ||
                    (draftKey.source !== 'reference' && !draftKey.privateKey?.trim())
                  }
                  onClick={() => {
                    if (draftKey.id) {
                      onUpdate({
                        ...panel.key,
                        ...(draftKey as SSHKey),
                      });
                      closePanel();
                    }
                  }}
                >
                  {t("common.saveChanges")}
                </Button>
              </>
  );
};
