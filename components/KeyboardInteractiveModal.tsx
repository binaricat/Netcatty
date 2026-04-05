/**
 * Keyboard Interactive Authentication Modal
 * Global modal for handling SSH keyboard-interactive authentication (2FA/MFA)
 * This modal displays prompts from the SSH server and collects user responses.
 */
import { Eye, EyeOff, KeyRound, Loader2 } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
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

export interface KeyboardInteractivePrompt {
  prompt: string;
  echo: boolean;
}

export interface KeyboardInteractiveRequest {
  requestId: string;
  sessionId?: string;
  name: string;
  instructions: string;
  prompts: KeyboardInteractivePrompt[];
  hostname?: string;
  savedPassword?: string | null;
}

const isAPasswordPrompt = (prompt: KeyboardInteractivePrompt) => {
  if (prompt.echo) return false;
  const lower = prompt.prompt.toLowerCase();
  if (!lower.includes("password")) return false;
  // Exclude OTP / one-time password / verification code prompts
  if (lower.includes("one-time") || lower.includes("otp") || lower.includes("verification") || lower.includes("token") || lower.includes("code")) return false;
  return true;
};

interface KeyboardInteractiveModalProps {
  request: KeyboardInteractiveRequest | null;
  onSubmit: (requestId: string, responses: string[], savePassword?: string) => void;
  onCancel: (requestId: string) => void;
}

export const KeyboardInteractiveModal: React.FC<KeyboardInteractiveModalProps> = ({
  request,
  onSubmit,
  onCancel,
}) => {
  const { t } = useI18n();
  const [responses, setResponses] = useState<string[]>([]);
  const [showPasswords, setShowPasswords] = useState<boolean[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [savePassword, setSavePassword] = useState(false);

  // Index of the first password prompt (if any)
  const passwordPromptIndex = useMemo(() => {
    if (!request) return -1;
    return request.prompts.findIndex(p => isAPasswordPrompt(p));
  }, [request]);

  // Reset state when request changes
  useEffect(() => {
    if (request) {
      const initial = request.prompts.map(() => "");
      // Auto-fill saved password into the password prompt
      if (request.savedPassword && passwordPromptIndex >= 0) {
        initial[passwordPromptIndex] = request.savedPassword;
      }
      setResponses(initial);
      setShowPasswords(request.prompts.map(() => false));
      setIsSubmitting(false);
      setSavePassword(false);
    }
  }, [request, passwordPromptIndex]);

  const handleResponseChange = useCallback((index: number, value: string) => {
    setResponses((prev) => {
      const updated = [...prev];
      updated[index] = value;
      return updated;
    });
  }, []);

  const toggleShowPassword = useCallback((index: number) => {
    setShowPasswords((prev) => {
      const updated = [...prev];
      updated[index] = !updated[index];
      return updated;
    });
  }, []);

  const handleSubmit = useCallback(() => {
    if (!request || isSubmitting) return;
    setIsSubmitting(true);
    const passwordToSave = savePassword && passwordPromptIndex >= 0
      ? responses[passwordPromptIndex]
      : undefined;
    onSubmit(request.requestId, responses, passwordToSave);
  }, [request, responses, onSubmit, isSubmitting, savePassword, passwordPromptIndex]);

  const handleCancel = useCallback(() => {
    if (!request) return;
    onCancel(request.requestId);
  }, [request, onCancel]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !isSubmitting) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit, isSubmitting]
  );

  if (!request) return null;

  const title = request.name?.trim() || t("keyboard.interactive.title");
  const description =
    request.instructions?.trim() ||
    (request.hostname
      ? t("keyboard.interactive.descWithHost", { hostname: request.hostname })
      : t("keyboard.interactive.desc"));

  return (
    <Dialog open={!!request} onOpenChange={(open) => !open && handleCancel()}>
      <DialogContent className="sm:max-w-[425px]" hideCloseButton>
        <DialogHeader>
          <div className="flex items-center gap-3 mb-2">
            <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
              <KeyRound className="h-5 w-5 text-primary" />
            </div>
            <div>
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription className="mt-1">
                {description}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {request.prompts.map((prompt, index) => {
            const isPassword = !prompt.echo;
            const showPassword = showPasswords[index];
            // Clean up prompt text (remove trailing colon and whitespace)
            const promptLabel = prompt.prompt.replace(/:\s*$/, "").trim();

            return (
              <div key={index} className="space-y-2">
                <Label htmlFor={`ki-prompt-${index}`}>
                  {promptLabel || t("keyboard.interactive.response")}
                </Label>
                <div className="relative">
                  <Input
                    id={`ki-prompt-${index}`}
                    type={isPassword && !showPassword ? "password" : "text"}
                    value={responses[index] || ""}
                    onChange={(e) => handleResponseChange(index, e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder=""
                    className={isPassword ? "pr-10" : undefined}
                    autoFocus={index === 0}
                    disabled={isSubmitting}
                  />
                  {isPassword && (
                    <button
                      type="button"
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground disabled:opacity-50 p-1"
                      onClick={() => toggleShowPassword(index)}
                      disabled={isSubmitting}
                    >
                      {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  )}
                </div>
                {/* Save password checkbox - shown only for the first password prompt */}
                {index === passwordPromptIndex && (
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={savePassword}
                      onChange={(e) => setSavePassword(e.target.checked)}
                      disabled={isSubmitting}
                      className="accent-primary"
                    />
                    <span className="text-xs text-muted-foreground">
                      {t("keyboard.interactive.savePassword")}
                    </span>
                  </label>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between pt-2">
          <Button
            variant="secondary"
            onClick={handleCancel}
            disabled={isSubmitting}
          >
            {t("common.cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t("keyboard.interactive.verifying")}
              </>
            ) : (
              t("keyboard.interactive.submit")
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default KeyboardInteractiveModal;
