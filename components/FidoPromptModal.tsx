/**
 * FIDO2 PIN / touch presence modal for OpenSSH sk-* flows.
 */
import { Fingerprint, KeyRound, Loader2, Usb } from "lucide-react";
import React, { useCallback, useEffect, useState } from "react";
import { useI18n } from "../application/i18n/I18nProvider";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export type FidoPromptKind = "pin" | "touch" | "confirm";

export interface FidoPromptRequest {
  requestId: string;
  kind: FidoPromptKind;
  message?: string;
  title?: string;
  keyName?: string;
}

interface FidoPromptModalProps {
  request: FidoPromptRequest | null;
  onSubmit: (requestId: string, response: string) => void;
  onCancel: (requestId: string) => void;
}

export const FidoPromptModal: React.FC<FidoPromptModalProps> = ({
  request,
  onSubmit,
  onCancel,
}) => {
  const { t } = useI18n();
  const [pin, setPin] = useState("");
  const [showPin, setShowPin] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (request) {
      setPin("");
      setShowPin(false);
      setIsSubmitting(false);
    }
  }, [request]);

  const isTouch = request?.kind === "touch" || request?.kind === "confirm";

  const handleSubmit = useCallback(() => {
    if (!request || isSubmitting) return;
    if (!isTouch && !pin) return;
    setIsSubmitting(true);
    onSubmit(request.requestId, isTouch ? "" : pin);
  }, [request, isSubmitting, isTouch, pin, onSubmit]);

  const handleCancel = useCallback(() => {
    if (!request) return;
    onCancel(request.requestId);
  }, [request, onCancel]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !isSubmitting && (isTouch || pin)) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit, isSubmitting, isTouch, pin],
  );

  if (!request) return null;

  const title = request.title
    || (isTouch ? t("fido.prompt.touchTitle") : t("fido.prompt.pinTitle"));
  const description = request.message?.trim()
    || (isTouch
      ? t("fido.prompt.touchDesc", { keyName: request.keyName || "FIDO2" })
      : t("fido.prompt.pinDesc", { keyName: request.keyName || "FIDO2" }));

  return (
    <Dialog open={!!request} onOpenChange={(open) => !open && handleCancel()}>
      <DialogContent className="sm:max-w-[460px]" hideCloseButton>
        <DialogHeader>
          <div className="flex items-center gap-3 mb-2">
            <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
              {isTouch
                ? <Usb className="h-5 w-5 text-primary" />
                : <Fingerprint className="h-5 w-5 text-primary" />}
            </div>
            <div className="min-w-0 flex-1">
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription className="mt-1 break-words">
                {description}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {!isTouch && (
            <div className="space-y-2">
              <Label htmlFor="fido-pin-input">{t("fido.prompt.pinLabel")}</Label>
              <div className="relative">
                <Input
                  id="fido-pin-input"
                  type={showPin ? "text" : "password"}
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  onKeyDown={handleKeyDown}
                  autoFocus
                  className="pr-10"
                  autoComplete="off"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-1 top-1/2 -translate-y-1/2 h-8 w-8"
                  onClick={() => setShowPin((v) => !v)}
                >
                  <KeyRound size={14} />
                </Button>
              </div>
            </div>
          )}

          {isTouch && (
            <div className="rounded-lg border border-border/60 bg-muted/30 px-4 py-6 text-center text-sm text-muted-foreground">
              {t("fido.prompt.touchWaiting")}
            </div>
          )}

          <div className="flex gap-2 justify-end pt-2">
            <Button type="button" variant="ghost" onClick={handleCancel} disabled={isSubmitting}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              onClick={handleSubmit}
              disabled={isSubmitting || (!isTouch && !pin)}
            >
              {isSubmitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                t("common.continue")
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default FidoPromptModal;
