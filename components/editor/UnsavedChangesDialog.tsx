import React, { useCallback, useEffect, useRef, useState } from "react";
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
  const pendingRef = useRef<Pending | null>(null);
  pendingRef.current = pending;

  const prompt = useCallback(
    (fileName: string) =>
      new Promise<UnsavedChoice>((resolve) => {
        // Re-entrance: if a prior prompt is still pending, cancel it so its caller
        // doesn't hang forever waiting for a resolve that now belongs to a new prompt.
        const prior = pendingRef.current;
        if (prior) prior.resolve("cancel");
        setPending({ fileName, resolve });
      }),
    [],
  );

  // Register the prompt function as the module-level singleton so it can be
  // called from outside the React tree (e.g. useSftpViewPaneActions).
  useEffect(() => {
    promptSingleton = prompt;
    return () => { promptSingleton = null; };
  }, [prompt]);

  // On unmount, resolve any in-flight prompt as "cancel" so awaiting callers don't leak.
  useEffect(() => () => {
    const prior = pendingRef.current;
    if (prior) {
      prior.resolve("cancel");
      pendingRef.current = null;
    }
  }, []);

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

// ---------------------------------------------------------------------------
// Module-level singleton — lets non-React code call the dialog without
// prop-drilling. Registered/unregistered by UnsavedChangesProvider above.
// ---------------------------------------------------------------------------

let promptSingleton: ((fileName: string) => Promise<UnsavedChoice>) | null = null;

export const promptUnsavedChanges = (fileName: string): Promise<UnsavedChoice> => {
  if (!promptSingleton) return Promise.resolve("cancel");
  return promptSingleton(fileName);
};
