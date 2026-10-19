/** PIN entry and user-presence prompts from OpenSSH. */
import { Clock3, Eye, EyeOff, Hand, KeyRound, Loader2, ShieldAlert, Usb } from "lucide-react";
import React, { useCallback, useEffect, useId, useState } from "react";
import { useI18n } from "../application/i18n/I18nProvider";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export type FidoPromptKind = "pin" | "touch" | "confirm" | "recovery";
export interface FidoPromptRequest {
  requestId: string;
  kind: FidoPromptKind;
  message?: string;
  title?: string;
  keyName?: string;
  notificationOnly?: boolean;
  reason?: "device-unavailable" | "timeout" | "pin-failed" | "failed";
  allowPasswordFallback?: boolean;
}
interface FidoPromptModalProps {
  request: FidoPromptRequest | null;
  onSubmit: (requestId: string, response: string) => void;
  onCancel: (requestId: string) => void;
}

export const FidoPromptModal: React.FC<FidoPromptModalProps> = ({ request, onSubmit, onCancel }) => {
  const { t } = useI18n();
  // Retain the content during Radix's closing animation, but clear the PIN.
  const [lastRequest, setLastRequest] = useState(request);
  const [pin, setPin] = useState("");
  const [showPin, setShowPin] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const descriptionId = useId();
  useEffect(() => { if (request) setLastRequest(request); }, [request]);
  useEffect(() => {
    setPin("");
    setShowPin(false);
    setIsSubmitting(false);
  }, [request?.requestId]);

  const visibleRequest = request || lastRequest;
  const isTouch = visibleRequest?.kind === "touch" || visibleRequest?.kind === "confirm";
  const isRecovery = visibleRequest?.kind === "recovery";
  const recoveryReason = visibleRequest?.reason || "failed";
  const RecoveryIcon = recoveryReason === "device-unavailable" ? Usb : recoveryReason === "timeout" ? Clock3 : ShieldAlert;
  const handleSubmit = useCallback(() => {
    if (!request || request.notificationOnly || isSubmitting || (!isTouch && !isRecovery && !pin)) return;
    setIsSubmitting(true);
    onSubmit(request.requestId, isRecovery ? "retry" : isTouch ? "" : pin);
  }, [request, isSubmitting, isTouch, isRecovery, pin, onSubmit]);
  const handleCancel = useCallback(() => {
    if (request) onCancel(request.requestId);
  }, [request, onCancel]);

  const message = visibleRequest?.message?.trim();
  const hasPinAndTouch = !isTouch && /user presence|touch|tap/i.test(message || "");
  const isErrorPrompt = /incorrect|invalid|wrong|failed|retries|attempts|错误|錯誤|剩余|剩餘/i.test(message || "");

  return (
    <Dialog open={!!request} onOpenChange={open => !open && handleCancel()}>
      {visibleRequest && (
        <DialogContent
          hideCloseButton
          aria-describedby={descriptionId}
          overlayClassName="fido-prompt-overlay bg-black/20"
          className="fido-prompt-dialog z-[51] w-[calc(100%_-_2rem)] max-w-[400px] gap-0 overflow-hidden rounded-xl border-border/70 p-6 sm:rounded-xl"
          style={{ boxShadow: '0 20px 60px -20px rgb(0 0 0 / 0.28)' }}
        >
          <div key={visibleRequest.requestId} className="fido-prompt-stage">
            {isRecovery ? (
              <div className="pb-2 pt-2 text-center">
                <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-primary/8 text-primary" aria-hidden="true">
                  <RecoveryIcon size={29} strokeWidth={1.5} />
                </div>
                <DialogTitle className="text-base">{t(`fido.recovery.${recoveryReason}.title`)}</DialogTitle>
                {visibleRequest.keyName && <p className="mt-2 truncate text-sm font-medium">{visibleRequest.keyName}</p>}
                <DialogDescription id={descriptionId} className="mt-2 text-sm leading-relaxed">
                  {t(`fido.recovery.${recoveryReason}.desc`)}
                </DialogDescription>
              </div>
            ) : isTouch ? (
              <div className="pb-5 pt-2 text-center">
                <div className="relative mx-auto mb-6 flex h-24 w-24 items-center justify-center" aria-hidden="true">
                  <span className="fido-touch-ring absolute inset-0 rounded-full bg-primary/5" />
                  <span className="fido-touch-ring fido-touch-ring-delayed absolute inset-0 rounded-full bg-primary/5" />
                  <div className="fido-touch-symbol relative flex h-16 w-16 items-center justify-center rounded-full bg-primary/8 text-primary">
                    <Hand size={30} strokeWidth={1.5} />
                  </div>
                </div>
                <DialogTitle className="text-base">{visibleRequest.title || t("fido.prompt.touchTitle")}</DialogTitle>
                {visibleRequest.keyName && <p className="mt-2 truncate text-sm font-medium">{visibleRequest.keyName}</p>}
                <DialogDescription id={descriptionId} className="mt-2 text-sm leading-relaxed">
                  {t("fido.prompt.touchDesc", { keyName: visibleRequest.keyName || "FIDO2" })}
                </DialogDescription>
                <div role="status" className="mt-5 flex items-center justify-center gap-2 text-xs text-muted-foreground">
                  <span className="fido-status-dot h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
                  {t(visibleRequest.notificationOnly ? "fido.prompt.touchAutomatic" : "fido.prompt.touchWaiting")}
                </div>
              </div>
            ) : (
              <>
                <div className="mb-5 flex items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/8 text-primary" aria-hidden="true">
                    <KeyRound size={21} strokeWidth={1.7} />
                  </div>
                  <div className="min-w-0">
                    <DialogTitle className="text-base">{visibleRequest.title || t("fido.prompt.pinTitle")}</DialogTitle>
                    {visibleRequest.keyName && <p className="mt-1 truncate text-xs font-medium">{visibleRequest.keyName}</p>}
                    <DialogDescription id={descriptionId} className="mt-1 text-xs leading-relaxed">
                      {t(hasPinAndTouch ? "fido.prompt.pinTouchDesc" : "fido.prompt.pinDesc", { keyName: visibleRequest.keyName || "FIDO2" })}
                    </DialogDescription>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="fido-pin-input" className="text-xs">{t("fido.prompt.pinLabel")}</Label>
                  <div className="relative">
                    <Input id="fido-pin-input" type={showPin ? "text" : "password"}
                      value={pin} onChange={e => setPin(e.target.value)} disabled={isSubmitting}
                      onKeyDown={e => {
                        if (e.key === "Enter") { e.preventDefault(); handleSubmit(); }
                      }} autoFocus className="h-11 pr-11" autoComplete="off" spellCheck={false} />
                    <Button type="button" variant="ghost" size="icon" disabled={isSubmitting}
                      className="absolute right-1 top-1/2 h-8 w-8 -translate-y-1/2 text-muted-foreground"
                      aria-label={t(showPin ? "fido.prompt.hidePin" : "fido.prompt.showPin")}
                      aria-pressed={showPin} onClick={() => setShowPin(value => !value)}>
                      {showPin ? <EyeOff size={15} /> : <Eye size={15} />}
                    </Button>
                  </div>
                </div>
              </>
            )}
            {message && (isErrorPrompt ? (
              <p role="alert" className="mt-3 break-words text-xs leading-relaxed text-destructive">{message}</p>
            ) : (
              <details className="mt-3 text-xs text-muted-foreground">
                <summary className="w-fit cursor-pointer rounded-sm text-[11px] outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">{t("fido.prompt.details")}</summary>
                <p className="mt-2 break-words leading-relaxed">{message}</p>
              </details>
            ))}
          </div>
          <div className="-mx-6 -mb-6 mt-5 flex items-center justify-end gap-2 border-t border-border/50 bg-muted/15 px-6 py-3.5">
            <Button type="button" variant="ghost" className="h-9" onClick={handleCancel} disabled={isSubmitting}>{t(visibleRequest.notificationOnly ? "common.close" : "common.cancel")}</Button>
            {isRecovery && visibleRequest.allowPasswordFallback && <Button type="button" variant="outline" className="h-9" onClick={() => request && onSubmit(request.requestId, "fallback")}>{t("fido.recovery.usePassword")}</Button>}
            {!visibleRequest.notificationOnly && <Button type="button" className="h-9 min-w-20 gap-2" onClick={handleSubmit} disabled={isSubmitting || (!isTouch && !isRecovery && !pin)}>
              {isSubmitting && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              {t(isSubmitting ? "fido.prompt.verifying" : isRecovery ? "fido.recovery.retry" : "common.continue")}
            </Button>}
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
};
export default FidoPromptModal;
