import React, { useId, useRef } from "react";
import { Loader2 } from "lucide-react";
import type { SftpArchiveDialogState } from "../../application/state/sftp/useSftpArchiveDialog";
import type { SftpArchiveFormat } from "../../domain/sftpArchiveCreation";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

interface SftpCreateArchiveDialogProps {
  state: SftpArchiveDialogState | null;
  t: (key: string, params?: Record<string, unknown>) => string;
  onClose: () => void;
  onNameChange: (name: string) => void;
  onFormatChange: (format: SftpArchiveFormat) => void;
  onSubmit: (overwrite?: boolean) => Promise<void>;
}

export function SftpCreateArchiveDialog({
  state, t, onClose, onNameChange, onFormatChange, onSubmit,
}: SftpCreateArchiveDialogProps) {
  const id = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  return (
    <Dialog open={!!state} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        className="sm:max-w-md"
        hideCloseButton={state?.busy}
        aria-describedby={`${id}-description`}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          nameRef.current?.focus();
          nameRef.current?.select();
        }}
        onEscapeKeyDown={(event) => { if (state?.busy) event.preventDefault(); }}
        onInteractOutside={(event) => { if (state?.busy) event.preventDefault(); }}
      >
        <DialogHeader>
          <DialogTitle>{t("sftp.archive.title")}</DialogTitle>
          <DialogDescription>
            <span id={`${id}-description`}>{t("sftp.archive.description", { count: state?.paths.length ?? 0 })}</span>
          </DialogDescription>
        </DialogHeader>
        {state && (
          <>
            <div className="space-y-2">
              <Label htmlFor={`${id}-name`}>{t("sftp.archive.name")}</Label>
              <Input
                ref={nameRef}
                id={`${id}-name`}
                value={state.archiveName}
                disabled={state.busy}
                aria-invalid={!!state.error}
                aria-describedby={state.error ? `${id}-error` : undefined}
                onChange={(event) => onNameChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing && !state.confirmOverwrite) {
                    event.preventDefault();
                    void onSubmit();
                  }
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${id}-format`}>{t("sftp.archive.format")}</Label>
              <Select
                value={state.format}
                disabled={state.busy}
                onValueChange={(value) => onFormatChange(value as SftpArchiveFormat)}
              >
                <SelectTrigger id={`${id}-format`}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="tar.gz">TAR.GZ</SelectItem>
                  <SelectItem value="zip">ZIP</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1 text-xs text-muted-foreground">
              <div>{t("sftp.archive.destination")}</div>
              <div className="break-all font-mono">{state.directory}</div>
            </div>
            {state.error && <p id={`${id}-error`} role="alert" className="text-xs text-destructive">{state.error}</p>}
            {state.confirmOverwrite && (
              <div role="alert" className="space-y-1 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
                <p className="font-medium">{t("sftp.archive.overwriteTitle")}</p>
                <p className="break-words text-muted-foreground">
                  {t("sftp.archive.overwriteDescription", { name: state.archiveName })}
                </p>
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" size="sm" disabled={state.busy} onClick={onClose}>
                {t("common.cancel")}
              </Button>
              <Button
                size="sm"
                variant={state.confirmOverwrite ? "destructive" : "default"}
                disabled={state.busy || !state.archiveName.trim() || state.paths.length === 0}
                onClick={() => void onSubmit(state.confirmOverwrite)}
              >
                {state.busy && <Loader2 size={14} className="mr-2 animate-spin" />}
                {t(state.busy ? "sftp.archive.creating" : state.confirmOverwrite ? "sftp.archive.overwrite" : "sftp.archive.create")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
