import React from "react";
import { FileKey, FolderOpen, Key, Plus, Shield, X } from "lucide-react";
import type { SSHKey } from "../../types";
import { Button } from "../ui/button";
import { Combobox } from "../ui/combobox";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

export type SshCredentialType = "key" | "certificate" | "localKeyFile";

export interface SshCredentialPickerSectionProps {
  visible: boolean;
  identityFileId?: string;
  keysByCategory: {
    key: SSHKey[];
    certificate: SSHKey[];
  };
  selectedCredentialType: SshCredentialType | null;
  setSelectedCredentialType: (type: SshCredentialType | null) => void;
  credentialPopoverOpen: boolean;
  setCredentialPopoverOpen: (open: boolean) => void;
  newKeyFilePath: string;
  setNewKeyFilePath: (value: string) => void;
  onSelectKey: (keyId: string) => void;
  onSelectCertificate: (certId: string) => void;
  onAddLocalKeyFile: (filePath: string, source: "input" | "browse") => void;
  onCancelLocalKeyFile?: () => void;
  t: (key: string) => string;
}

export const SshCredentialPickerSection: React.FC<SshCredentialPickerSectionProps> = ({
  visible,
  identityFileId,
  keysByCategory,
  selectedCredentialType,
  setSelectedCredentialType,
  credentialPopoverOpen,
  setCredentialPopoverOpen,
  newKeyFilePath,
  setNewKeyFilePath,
  onSelectKey,
  onSelectCertificate,
  onAddLocalKeyFile,
  onCancelLocalKeyFile,
  t,
}) => {
  if (!visible) return null;

  const handleCancelLocalKeyFile = () => {
    if (onCancelLocalKeyFile) {
      onCancelLocalKeyFile();
      return;
    }
    setSelectedCredentialType(null);
  };

  return (
    <>
      {/* Credential type selection with inline popover - hidden when credential is selected */}
      {!selectedCredentialType && (
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
      {selectedCredentialType === "key" && (
        <div className="flex items-center gap-1">
          <Combobox
            options={keysByCategory.key.map((k) => ({
              value: k.id,
              label: k.label,
              sublabel: `${k.type}${k.keySize ? ` ${k.keySize}` : ""}`,
              icon: <Key size={14} className="text-muted-foreground" />,
            }))}
            value={identityFileId}
            onValueChange={onSelectKey}
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
      {selectedCredentialType === "certificate" && (
        <div className="flex items-center gap-1">
          <Combobox
            options={keysByCategory.certificate.map((k) => ({
              value: k.id,
              label: k.label,
              icon: <Shield size={14} className="text-muted-foreground" />,
            }))}
            value={identityFileId}
            onValueChange={onSelectCertificate}
            placeholder={t("hostDetails.certs.search")}
            emptyText={t("hostDetails.certs.empty")}
            icon={<Shield size={14} className="text-muted-foreground" />}
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
      {selectedCredentialType === "localKeyFile" && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1 w-full min-w-0">
            <input
              type="text"
              className="flex-1 min-w-0 w-0 h-8 px-2 text-xs font-mono bg-background border border-border/60 rounded-md focus:outline-none focus:ring-1 focus:ring-ring"
              placeholder={t("hostDetails.credential.localKeyFilePlaceholder")}
              value={newKeyFilePath}
              onChange={(e) => setNewKeyFilePath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newKeyFilePath.trim()) {
                  e.preventDefault();
                  onAddLocalKeyFile(newKeyFilePath.trim(), "input");
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
                      [{ name: "All Files", extensions: ["*"] }],
                    );
                    if (filePath) {
                      onAddLocalKeyFile(filePath, "browse");
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
              onClick={handleCancelLocalKeyFile}
            >
              <X size={14} />
            </Button>
          </div>
        </div>
      )}
    </>
  );
};
