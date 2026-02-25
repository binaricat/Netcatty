/**
 * Keyboard Interactive Authentication Modal
 * Global modal for handling SSH keyboard-interactive authentication (2FA/MFA)
 * This modal displays prompts from the SSH server and collects user responses.
 */
import { Eye, EyeOff, KeyRound, Loader2 } from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
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
  traceId?: string | null;
  source?: string;
  name: string;
  instructions: string;
  prompts: KeyboardInteractivePrompt[];
  hostname?: string;
  savedPassword?: string | null;
}

interface KeyboardInteractiveModalProps {
  request: KeyboardInteractiveRequest | null;
  onSubmit: (requestId: string, responses: string[]) => void;
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
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);

  const getAutofillPasswordIndex = useCallback((prompts: KeyboardInteractivePrompt[]) => {
    const passwordPromptPattern = /password|passphrase|passwd|密码|口令/i;
    const oneTimeCodePattern = /otp|token|verification|verify|\bcode\b|验证码|动态码|二次验证|双因素|2fa|mfa/i;

    for (let i = 0; i < prompts.length; i++) {
      const prompt = prompts[i];
      if (prompt.echo) continue;
      const text = (prompt.prompt || "").toLowerCase();
      if (passwordPromptPattern.test(text) && !oneTimeCodePattern.test(text)) {
        return i;
      }
    }
    return -1;
  }, []);

  // Reset state when request changes
  useEffect(() => {
    if (request) {
      inputRefs.current = [];
      const initialResponses = request.prompts.map(() => "");
      if (request.savedPassword) {
        const passwordPromptIndex = getAutofillPasswordIndex(request.prompts);
        if (passwordPromptIndex >= 0) {
          initialResponses[passwordPromptIndex] = request.savedPassword;
        }
      }
      setResponses(initialResponses);
      setShowPasswords(request.prompts.map(() => false));
      setIsSubmitting(false);
    }
  }, [request, getAutofillPasswordIndex]);

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
    onSubmit(request.requestId, responses);
  }, [request, responses, onSubmit, isSubmitting]);

  const handleCancel = useCallback(() => {
    if (!request) return;
    onCancel(request.requestId);
  }, [request, onCancel]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, index: number) => {
      if (e.key === "Enter" && !isSubmitting && request) {
        e.preventDefault();
        if (index < request.prompts.length - 1) {
          inputRefs.current[index + 1]?.focus();
          return;
        }
        handleSubmit();
      }
    },
    [handleSubmit, isSubmitting, request]
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
                    onKeyDown={(e) => handleKeyDown(e, index)}
                    placeholder=""
                    className={isPassword ? "pr-10" : undefined}
                    autoFocus={index === 0}
                    disabled={isSubmitting}
                    ref={(el) => {
                      inputRefs.current[index] = el;
                    }}
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
                {/* Use saved password button - shown below input, right-aligned */}
                {isPassword && request.savedPassword && !responses[index] && (
                  <div className="flex justify-end">
                    <button
                      type="button"
                      className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 disabled:opacity-50"
                      onClick={() => handleResponseChange(index, request.savedPassword!)}
                      disabled={isSubmitting}
                    >
                      <KeyRound size={12} />
                      <span>{t("keyboard.interactive.useSavedPassword")}</span>
                    </button>
                  </div>
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
