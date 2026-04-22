import React, { useCallback, useState } from "react";
import { useI18n } from "../../application/i18n/I18nProvider";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

export type UnsavedChoice = "save" | "discard" | "cancel";

interface Pending {
  fileName: string;
  resolve: (choice: UnsavedChoice) => void;
}

interface UnsavedChangesAPI {
  prompt: (fileName: string) => Promise<UnsavedChoice>;
}

export const UnsavedChangesProvider: React.FC<{
  children: (api: UnsavedChangesAPI) => React.ReactNode;
}> = ({ children }) => {
  const { t } = useI18n();
  const [pending, setPending] = useState<Pending | null>(null);

  const prompt = useCallback(
    (fileName: string) =>
      new Promise<UnsavedChoice>((resolve) => {
        setPending({ fileName, resolve });
      }),
    [],
  );

  const resolveWith = useCallback((choice: UnsavedChoice) => {
    if (!pending) return;
    pending.resolve(choice);
    setPending(null);
  }, [pending]);

  return (
    <>
      {children({ prompt })}
      <Dialog open={!!pending} onOpenChange={(o) => { if (!o) resolveWith("cancel"); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("sftp.editor.unsavedTitle")}</DialogTitle>
            <DialogDescription>
              {t("sftp.editor.unsavedMessage", { fileName: pending?.fileName ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => resolveWith("cancel")}>
              {t("common.cancel")}
            </Button>
            <Button variant="outline" onClick={() => resolveWith("discard")}>
              {t("sftp.editor.discardChanges")}
            </Button>
            <Button variant="default" onClick={() => resolveWith("save")}>
              {t("sftp.editor.saveAndClose")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
