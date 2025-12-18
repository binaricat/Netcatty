import React, { useCallback, useRef } from "react";
import { useI18n } from "../../application/i18n/I18nProvider";
import { getVaultCsvTemplate } from "../../domain/vaultImport";
import type { VaultImportFormat } from "../../domain/vaultImport";
import { cn } from "../../lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

type ImportOption = {
  format: VaultImportFormat;
  label: string;
  iconSrc: string;
  accept: string;
};

const OPTIONS: ImportOption[] = [
  {
    format: "putty",
    label: "PuTTY",
    iconSrc: "/import/putty.png",
    accept: ".reg,.txt,.ini",
  },
  {
    format: "mobaxterm",
    label: "MobaXterm",
    iconSrc: "/import/moba.jpg",
    accept: ".ini,.mxtsessions,.txt",
  },
  {
    format: "csv",
    label: "CSV",
    iconSrc: "/import/csv.png",
    accept: ".csv,.txt",
  },
  {
    format: "securecrt",
    label: "SecureCRT",
    iconSrc: "/import/securecrt.png",
    accept: ".ini,.txt",
  },
  {
    format: "ssh_config",
    label: "ssh_config",
    iconSrc: "/import/file.png",
    accept: ".conf,.config,.txt",
  },
];

export type ImportVaultDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFileSelected: (format: VaultImportFormat, file: File) => void;
};

export const ImportVaultDialog: React.FC<ImportVaultDialogProps> = ({
  open,
  onOpenChange,
  onFileSelected,
}) => {
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingFormatRef = useRef<VaultImportFormat | null>(null);

  const downloadCsvTemplate = useCallback(() => {
    const csv = getVaultCsvTemplate();
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "netcatty-vault-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const pickFile = useCallback(
    (format: VaultImportFormat, accept: string) => {
      const input = fileInputRef.current;
      if (!input) return;
      pendingFormatRef.current = format;
      input.accept = accept;
      input.value = "";
      input.click();
    },
    [],
  );

  const onChangeFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      const format = pendingFormatRef.current;
      if (!file || !format) return;
      onFileSelected(format, file);
      e.target.value = "";
    },
    [onFileSelected],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader className="text-center sm:text-center">
          <div className="mx-auto h-14 w-14 rounded-2xl bg-muted/60 border border-border/60 flex items-center justify-center">
            <img
              src="/import/file.png"
              alt=""
              className="h-8 w-8 object-contain"
            />
          </div>
          <DialogTitle className="text-xl">{t("vault.import.title")}</DialogTitle>
          <DialogDescription className="mx-auto max-w-xl">
            {t("vault.import.desc")}
          </DialogDescription>
        </DialogHeader>

        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={onChangeFile}
        />

        <div className="flex flex-col gap-4">
          <div className="text-sm font-medium text-center text-muted-foreground">
            {t("vault.import.chooseFormat")}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            {OPTIONS.map((opt) => (
              <button
                key={opt.format}
                type="button"
                className={cn(
                  "group rounded-2xl border border-border/60 bg-background",
                  "px-3 py-4 hover:bg-muted/30 hover:border-border transition-colors",
                  "flex flex-col items-center gap-3",
                )}
                onClick={() => pickFile(opt.format, opt.accept)}
              >
                <div className="h-16 flex items-center justify-center">
                  <img
                    src={opt.iconSrc}
                    alt=""
                    className={cn(
                      "max-h-12 w-14 object-contain",
                      opt.format === "mobaxterm" && "w-16",
                    )}
                  />
                </div>
                <div className="text-sm font-medium text-foreground">
                  {opt.label}
                </div>
              </button>
            ))}
          </div>

          <div className="flex items-center justify-between gap-3 pt-2 border-t border-border/60">
            <div className="text-xs text-muted-foreground">
              {t("vault.import.csv.tip")}
            </div>
            <button
              type="button"
              onClick={downloadCsvTemplate}
              className="text-xs text-primary hover:underline"
            >
              {t("vault.import.csv.downloadTemplate")}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
