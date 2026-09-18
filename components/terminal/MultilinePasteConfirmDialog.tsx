import React, { useState } from "react";
import { useSyncExternalStore } from "react";

import { useI18n } from "../../application/i18n/I18nProvider";
import {
  getPendingMultilinePasteConfirm,
  respondMultilinePasteConfirm,
  subscribeMultilinePasteConfirm,
} from "../../application/state/multilinePasteConfirmStore";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Textarea } from "../ui/textarea";
import type { MultilinePasteConfirmRequest } from "../../application/state/multilinePasteConfirmStore";

/**
 * Always-mounted host: renders the multi-line paste confirmation dialog while
 * a paste request is pending (#3398). The preview is editable — the edited
 * content is what actually gets sent.
 */
export const MultilinePasteConfirmHost: React.FC = () => {
  const request = useSyncExternalStore(
    subscribeMultilinePasteConfirm,
    getPendingMultilinePasteConfirm,
    getPendingMultilinePasteConfirm,
  );
  if (!request) return null;
  return <MultilinePasteConfirmDialog key={request.id} request={request} />;
};

const MultilinePasteConfirmDialog: React.FC<{ request: MultilinePasteConfirmRequest }> = ({
  request,
}) => {
  const { t } = useI18n();
  const [previewText, setPreviewText] = useState(request.text);

  const respond = (action: "send" | "line-by-line") =>
    respondMultilinePasteConfirm(action, previewText);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) respondMultilinePasteConfirm("cancel");
      }}
    >
      <DialogContent
        className="sm:max-w-[520px]"
        onCloseAutoFocus={(event) => {
          if (request.onClose) {
            event.preventDefault();
            request.onClose();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("terminal.pasteConfirm.title")}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {t("terminal.pasteConfirm.summary", {
            lines: request.lineCount,
            chars: request.charCount,
          })}
        </p>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">
            {t("terminal.pasteConfirm.preview")}
          </label>
          <Textarea
            value={previewText}
            onChange={(e) => setPreviewText(e.target.value)}
            className="max-h-64 min-h-32 font-mono text-xs"
            spellCheck={false}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => respondMultilinePasteConfirm("cancel")}>
            {t("terminal.pasteConfirm.cancel")}
          </Button>
          <Button variant="outline" onClick={() => respond("line-by-line")}>
            {t("terminal.pasteConfirm.sendLineByLine")}
          </Button>
          <Button onClick={() => respond("send")}>{t("terminal.pasteConfirm.send")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
