/**
 * Passphrase Modal
 * Modal for requesting passphrase for encrypted SSH keys
 */
import { Eye, EyeOff, KeyRound, Loader2 } from "lucide-react";
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

export interface PassphraseRequest {
  requestId: string;
  keyPath: string;
  keyName: string;
  hostname?: string;
}

/** Opt-in only: do not default to remembering key passphrases (#2024). */
export const DEFAULT_REMEMBER_PASSPHRASE = false;

interface PassphraseModalProps {
  request: PassphraseRequest | null;
  onSubmit: (requestId: string, passphrase: string, remember: boolean) => void;
  onCancel: (requestId: string) => void;
  onSkip?: (requestId: string) => void;
}

export const PassphraseModal: React.FC<PassphraseModalProps> = ({
  request,
  onSubmit,
  onCancel,
  onSkip,
}) => {
  const { t } = useI18n();
  const [passphrase, setPassphrase] = useState("");
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [rememberPassphrase, setRememberPassphrase] = useState(DEFAULT_REMEMBER_PASSPHRASE);

  // Reset state when request changes
  useEffect(() => {
    if (request) {
      setPassphrase("");
      setShowPassphrase(false);
      setIsSubmitting(false);
      setRememberPassphrase(DEFAULT_REMEMBER_PASSPHRASE);
    }
  }, [request]);

  const handleSubmit = useCallback(() => {
    if (!request || isSubmitting || !passphrase) return;
    setIsSubmitting(true);
    onSubmit(request.requestId, passphrase, rememberPassphrase);
  }, [request, passphrase, onSubmit, isSubmitting, rememberPassphrase]);

  const handleCancel = useCallback(() => {
    if (!request) return;
    onCancel(request.requestId);
  }, [request, onCancel]);

  const handleSkip = useCallback(() => {
    if (!request || !onSkip) return;
    onSkip(request.requestId);
  }, [request, onSkip]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !isSubmitting && passphrase) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit, isSubmitting, passphrase]
  );

  if (!request) return null;

  const keyDisplayName = request.keyName || request.keyPath.split("/").pop() || "SSH Key";

  return (
    <Dialog open={!!request} onOpenChange={(open) => !open && handleCancel()}>
      <DialogContent className="sm:max-w-[500px]" hideCloseButton>
        <DialogHeader>
          <div className="flex items-center gap-3 mb-2">
            <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
              <KeyRound className="h-5 w-5 text-primary" />
            </div>
            <div className="min-w-0 flex-1">
              <DialogTitle>{t("passphrase.title")}</DialogTitle>
              <DialogDescription className="mt-1 break-words">
                {request.hostname
                  ? t("passphrase.descWithHost", { keyName: keyDisplayName, hostname: request.hostname })
                  : t("passphrase.desc", { keyName: keyDisplayName })}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="passphrase-input">
              {t("passphrase.label")}
            </Label>
            <div className="relative">
              <Input
                id="passphrase-input"
                type={showPassphrase ? "text" : "password"}
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder=""
                className="pr-10"
                autoFocus
                disabled={isSubmitting}
              />
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground disabled:opacity-50 p-1"
                onClick={() => setShowPassphrase(!showPassphrase)}
                disabled={isSubmitting}
              >
                {showPassphrase ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            <p className="text-xs text-muted-foreground break-all">
              {t("passphrase.keyPath")}: <code className="text-xs break-all">{request.keyPath}</code>
            </p>
            <label className="flex items-center gap-2 cursor-pointer select-none mt-2">
              <input
                type="checkbox"
                checked={rememberPassphrase}
                onChange={(e) => setRememberPassphrase(e.target.checked)}
                disabled={isSubmitting}
                className="accent-primary"
              />
              <span className="text-xs text-muted-foreground">
                {t("passphrase.remember")}
              </span>
            </label>
          </div>
        </div>

        <div className="flex items-center justify-between pt-2">
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={handleCancel}
              disabled={isSubmitting}
            >
              {t("common.cancel")}
            </Button>
            {onSkip && (
              <Button
                variant="ghost"
                onClick={handleSkip}
                disabled={isSubmitting}
              >
                {t("passphrase.skip")}
              </Button>
            )}
          </div>
          <Button onClick={handleSubmit} disabled={isSubmitting || !passphrase}>
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t("passphrase.unlocking")}
              </>
            ) : (
              t("passphrase.unlock")
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default PassphraseModal;
