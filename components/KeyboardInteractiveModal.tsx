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
  hostId?: string;
  scope?: "terminal" | "external";
  name: string;
  instructions: string;
  prompts: KeyboardInteractivePrompt[];
  hostname?: string;
  savedPassword?: string | null;
  /** When false, hide save-password UI (second-factor / EDR challenges). Default true. */
  allowSavePassword?: boolean;
  /**
   * Pre-check the "Save password" checkbox — sent only by emitters that can
   * prove the challenge is a retry after a saved password was actually
   * rejected (#3556). Consecutive keyboard-interactive rounds carry no such
   * signal, so the SSH bridge never defaults this on for a later round of a
   * multi-round exchange (#3558).
   */
  defaultSavePassword?: boolean;
}

type KeyboardInteractiveServerPromptInput = Pick<
  KeyboardInteractiveRequest,
  "name" | "instructions" | "prompts" | "hostname"
>;

/** Formats the server-supplied keyboard-interactive prompt block for display. */
export function formatKeyboardInteractiveServerPrompt(request: KeyboardInteractiveServerPromptInput): string {
  const lines: string[] = [];
  const name = request.name?.trim();
  const hostname = request.hostname?.trim();
  const instructions = request.instructions?.trim();
  const hasServerText = !!instructions || !!(name && name !== hostname);
  if (!hasServerText) return "";
  if (name && name !== hostname) {
    lines.push(name.endsWith(":") ? name : `${name}:`);
  }
  if (instructions) {
    for (const line of instructions.split(/\r?\n/).map((part) => part.trim()).filter(Boolean)) {
      lines.push(`| ${line}`);
    }
  }
  for (const prompt of request.prompts || []) {
    const promptText = prompt.prompt?.trim();
    if (promptText) {
      lines.push(`| ${promptText}`);
    }
  }
  return lines.join("\n");
}

const isAPasswordPrompt = (prompt: KeyboardInteractivePrompt) => {
  if (prompt.echo) return false;
  const lower = prompt.prompt.toLowerCase();
  if (!lower.includes("password") && !lower.includes("passwd")) return false;
  // Keep aligned with electron/bridges/sshAuthHelper.cjs OTP_PROMPT_PATTERN so
  // the modal never prefills the host login password into a second-factor field
  // (#2150). Backend also omits savedPassword for those challenges; this is
  // defense in depth if a caller still passes it.
  if (
    lower.includes("one-time") ||
    lower.includes("otp") ||
    lower.includes("verification") ||
    lower.includes("token") ||
    lower.includes("code") ||
    lower.includes("passcode") ||
    lower.includes("2fa") ||
    lower.includes("mfa") ||
    lower.includes("two-factor") ||
    lower.includes("two factor") ||
    lower.includes("multi-factor") ||
    lower.includes("multi factor") ||
    lower.includes("second factor") ||
    lower.includes("secondary password") ||
    lower.includes("secondary authentication") ||
    lower.includes("second password") ||
    lower.includes("additional password") ||
    lower.includes("re-enter password") ||
    lower.includes("reenter password") ||
    lower.includes("confirm password") ||
    lower.includes("edr") ||
    lower.includes("duo")
  ) {
    return false;
  }
  return true;
};

interface KeyboardInteractiveModalProps {
  request: KeyboardInteractiveRequest | null;
  onSubmit: (requestId: string, responses: string[], savePassword?: string) => boolean | Promise<boolean>;
  onCancel: (requestId: string) => boolean | Promise<boolean>;
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
      // Pre-check "Save password" on the post-failed-auto-fill retry (#3556):
      // only meaningful when the challenge has a password slot to save.
      setSavePassword(Boolean(request.defaultSavePassword) && passwordPromptIndex >= 0);
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

  const canSavePassword = request?.allowSavePassword !== false;

  const handleSubmit = useCallback(async () => {
    if (!request || isSubmitting) return;
    setIsSubmitting(true);
    const passwordToSave =
      canSavePassword && savePassword && passwordPromptIndex >= 0
        ? responses[passwordPromptIndex]
        : undefined;
    try {
      const submitted = await onSubmit(request.requestId, responses, passwordToSave);
      if (!submitted) setIsSubmitting(false);
    } catch {
      setIsSubmitting(false);
    }
  }, [request, responses, onSubmit, isSubmitting, savePassword, passwordPromptIndex, canSavePassword]);

  const handleCancel = useCallback(async () => {
    if (!request || isSubmitting) return;
    setIsSubmitting(true);
    try {
      const cancelled = await onCancel(request.requestId);
      if (!cancelled) setIsSubmitting(false);
    } catch {
      setIsSubmitting(false);
    }
  }, [request, onCancel, isSubmitting]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !isSubmitting) {
        e.preventDefault();
        void handleSubmit();
      }
    },
    [handleSubmit, isSubmitting]
  );

  if (!request) return null;

  const serverPromptText = formatKeyboardInteractiveServerPrompt(request);
  const title = t("keyboard.interactive.title");
  const description =
    request.hostname
      ? t("keyboard.interactive.descWithHost", { hostname: request.hostname })
      : t("keyboard.interactive.desc");

  return (
    <Dialog open={!!request} onOpenChange={() => {/* intentionally non-dismissable */}}>
      <DialogContent
        className="sm:max-w-[425px]"
        hideCloseButton
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
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
          {serverPromptText && (
            <pre className="max-h-36 overflow-auto rounded-md border border-border/60 bg-muted/45 px-3 py-2 text-xs leading-relaxed text-foreground whitespace-pre-wrap [overflow-wrap:anywhere]">
              {serverPromptText}
            </pre>
          )}

          {request.prompts.map((prompt, index) => {
            const isPassword = !prompt.echo;
            const showPassword = showPasswords[index];
            const showPromptLabel = !(serverPromptText && request.prompts.length === 1);
            // Clean up prompt text (remove trailing colon and whitespace)
            const promptLabel = prompt.prompt.replace(/:\s*$/, "").trim();

            return (
              <div key={index} className="space-y-2">
                {showPromptLabel && (
                  <Label htmlFor={`ki-prompt-${index}`}>
                    {promptLabel || t("keyboard.interactive.response")}
                  </Label>
                )}
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
                {/* Save password checkbox - first-factor password prompts only */}
                {canSavePassword && index === passwordPromptIndex && (
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
