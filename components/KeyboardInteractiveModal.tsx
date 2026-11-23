/**
 * Keyboard Interactive Authentication Modal
 * Global modal for handling SSH keyboard-interactive authentication (2FA/MFA)
 * This modal displays prompts from the SSH server and collects user responses.
 */
import { Eye, EyeOff, KeyRound, Loader2 } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { NON_TOTP_PROMPT } from "../domain/totpPrompt.shared.cjs";
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
  /** otpauth URI from the connection attempt that opened this dialog. */
  totpUri?: string;
}

/** Last meaningful line of a server prompt, without the raw banner. */
export function keyboardInteractiveFieldLabel(prompt: string | undefined, fallback: string): string {
  const lines = String(prompt || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const last = lines.at(-1) || "";
  const cleaned = last
    .replace(/^[\s|｜>•*-]+/, "")
    .replace(/[:：]\s*$/, "")
    .trim()
    .replace(/^\[(.+)\]$/, "$1")
    .trim();
  return cleaned || fallback;
}

function guidanceKeys(text: string): string[] {
  const trimmed = text.trim().toLowerCase();
  const label = keyboardInteractiveFieldLabel(text, "").toLowerCase();
  return [trimmed, label].filter(Boolean);
}

/** Server directions that are not already the field label. Plain text, not a prompt dump. */
export function keyboardInteractiveGuidance(request: Pick<KeyboardInteractiveRequest, "name" | "instructions" | "prompts" | "hostname">): string {
  const labelKeys = new Set<string>();
  const promptLines: string[] = [];
  for (const prompt of request.prompts || []) {
    const parts = String(prompt?.prompt || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const last = parts.at(-1) || "";
    for (const key of guidanceKeys(last)) labelKeys.add(key);
    promptLines.push(...parts.slice(0, -1));
  }
  const seen = new Set<string>();
  const lines: string[] = [];
  const push = (text: string) => {
    const line = text.trim().replace(/^\|\s*/, "");
    if (!line) return;
    const keys = guidanceKeys(line);
    if (keys.some((key) => labelKeys.has(key) || seen.has(key))) return;
    for (const key of keys) seen.add(key);
    lines.push(line);
  };
  const hostname = (request.hostname || "").trim().toLowerCase();
  const name = (request.name || "").trim();
  if (name && name.toLowerCase() !== hostname) push(name);
  for (const part of String(request.instructions || "").split(/\r?\n/)) push(part);
  for (const part of promptLines) push(part);
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
  canFillTotp?: boolean;
  onFillTotp?: () => Promise<string | null> | string | null;
}

const OTP_PROMPT = /otp|one[-\s]?time|totp|verification|passcode|authenticator|\bmfa\b|\b2fa\b|two[-\s]?factor|验证码|驗證碼|动态口令|動態口令|二次认证|二次認證|二次验证|二次驗證/i;

export type TotpFillPlacement = "preferred" | "available" | "hidden";

function lastPromptLine(prompt: string | undefined): string {
  const lines = String(prompt || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.at(-1) || "";
}

/** Where a TOTP fill action may appear. Password prompts never receive the code. */
export function totpFillPlacement(prompt: KeyboardInteractivePrompt): TotpFillPlacement {
  const rawLast = lastPromptLine(prompt.prompt);
  const label = keyboardInteractiveFieldLabel(prompt.prompt, "");
  if (!label || NON_TOTP_PROMPT.test(rawLast) || NON_TOTP_PROMPT.test(label)) return "hidden";
  if (OTP_PROMPT.test(label)) return "preferred";
  if (isAPasswordPrompt({ prompt: label, echo: prompt.echo })) return "hidden";
  if (/\b(password|passwd|passphrase)\b/i.test(label)) return "hidden";
  return "available";
}

export function visibleTotpFillPlacements(prompts: KeyboardInteractivePrompt[]): TotpFillPlacement[] {
  const placements = prompts.map(totpFillPlacement);
  const hasPreferred = placements.some((placement) => placement === "preferred");
  if (!hasPreferred) return placements;
  return placements.map((placement) => (placement === "preferred" ? placement : "hidden"));
}

export const KeyboardInteractiveModal: React.FC<KeyboardInteractiveModalProps> = ({
  request,
  onSubmit,
  onCancel,
  canFillTotp = false,
  onFillTotp,
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

  const handleFillTotp = useCallback(async (index: number) => {
    if (!request || isSubmitting || !onFillTotp) return;
    const prompt = request.prompts[index];
    if (!prompt || totpFillPlacement(prompt) === "hidden") return;
    const code = await onFillTotp();
    if (!code) return;
    handleResponseChange(index, code);
  }, [request, isSubmitting, onFillTotp, handleResponseChange]);

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

  const title = t("keyboard.interactive.title");
  const description =
    request.hostname
      ? t("keyboard.interactive.descWithHost", { hostname: request.hostname })
      : t("keyboard.interactive.desc");
  const fillPlacements = canFillTotp ? visibleTotpFillPlacements(request.prompts) : [];
  const preferredFillIndex = fillPlacements.findIndex((placement) => placement === "preferred");
  const guidance = keyboardInteractiveGuidance(request);

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
          {guidance ? (
            <p className="max-h-36 overflow-auto whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
              {guidance}
            </p>
          ) : null}
          {request.prompts.map((prompt, index) => {
            const isPassword = !prompt.echo;
            const showPassword = showPasswords[index];
            const promptLabel = keyboardInteractiveFieldLabel(
              prompt.prompt,
              t("keyboard.interactive.verificationCode"),
            );
            const fillPlacement = fillPlacements[index] ?? "hidden";

            return (
              <div key={index} className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor={`ki-prompt-${index}`}>
                    {promptLabel}
                  </Label>
                  {fillPlacement !== "hidden" && (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="h-7 shrink-0 px-2 font-normal focus:bg-secondary focus:text-secondary-foreground focus-visible:bg-secondary focus-visible:text-secondary-foreground"
                      data-totp-fill={fillPlacement}
                      onClick={() => { void handleFillTotp(index); }}
                      disabled={isSubmitting}
                    >
                      {t("keyboard.interactive.fillTotp")}
                    </Button>
                  )}
                </div>
                <div className="relative">
                  <Input
                    id={`ki-prompt-${index}`}
                    type={isPassword && !showPassword ? "password" : "text"}
                    value={responses[index] || ""}
                    onChange={(e) => handleResponseChange(index, e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder=""
                    className={isPassword ? "pr-10" : undefined}
                    autoFocus={preferredFillIndex >= 0 ? index === preferredFillIndex : index === 0}
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
