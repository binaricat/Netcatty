import * as React from "react";

import { useI18n } from "../../application/i18n/I18nProvider";
import { cn } from "../../lib/utils";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./dialog";

export interface ConfirmOptions {
  /** Main prompt text. Shown as the title when no explicit `title` is given. */
  message: string;
  /** Optional heading rendered above the message. */
  title?: string;
  /** Label for the confirm button. Defaults to `common.confirm`. */
  confirmLabel?: string;
  /** Label for the cancel button. Defaults to `common.cancel`. */
  cancelLabel?: string;
  /** Render the confirm button in a destructive (red) style. */
  destructive?: boolean;
}

export type ConfirmFn = (options: ConfirmOptions | string) => Promise<boolean>;

const ConfirmContext = React.createContext<ConfirmFn | null>(null);

/**
 * In-app confirmation dialog exposed as a promise-returning `confirm()`.
 *
 * Prefer this over the native `window.confirm()` / `globalThis.confirm()`:
 * native confirms can leave keyboard focus / modal state broken in the
 * Electron renderer on Windows, which blocks typing in the next input and
 * subsequent Radix dialogs until the tree re-renders.
 */
export const ConfirmProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { t } = useI18n();
  const [options, setOptions] = React.useState<ConfirmOptions | null>(null);
  const resolverRef = React.useRef<((value: boolean) => void) | null>(null);

  const confirm = React.useCallback<ConfirmFn>((input) => {
    const opts = typeof input === "string" ? { message: input } : input;
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      // Defer opening to the next task. Confirms are frequently triggered from
      // a Radix ContextMenu / DropdownMenu item (e.g. host delete); if the
      // dialog mounts in the same tick the closing menu is still tearing down,
      // and the two dismissable layers conflict so the dialog opens then
      // instantly dismisses (overlay flashes, content never shows). Letting the
      // menu finish closing first makes the dialog mount cleanly.
      setTimeout(() => setOptions(opts), 0);
    });
  }, []);

  const settle = React.useCallback((result: boolean) => {
    setOptions(null);
    const resolve = resolverRef.current;
    resolverRef.current = null;
    resolve?.(result);
  }, []);

  const open = options !== null;
  const message = options?.message ?? "";
  const title = options?.title;

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog open={open} onOpenChange={(next) => { if (!next) settle(false); }}>
        <DialogContent className="sm:max-w-[400px]" hideCloseButton>
          <DialogHeader>
            <DialogTitle className="whitespace-pre-wrap">{title ?? message}</DialogTitle>
          </DialogHeader>
          {title ? (
            <p className="text-sm text-muted-foreground whitespace-pre-wrap">{message}</p>
          ) : null}
          <DialogFooter>
            <button
              type="button"
              onClick={() => settle(false)}
              className="px-3 py-1.5 text-sm rounded-md border border-border hover:bg-muted transition-colors"
            >
              {options?.cancelLabel ?? t("common.cancel")}
            </button>
            <button
              type="button"
              onClick={() => settle(true)}
              className={cn(
                "px-3 py-1.5 text-sm rounded-md transition-colors",
                options?.destructive
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : "bg-primary text-primary-foreground hover:bg-primary/90",
              )}
            >
              {options?.confirmLabel ?? t("common.confirm")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConfirmContext.Provider>
  );
};

/**
 * Returns a promise-returning `confirm(message | options)` bound to the
 * nearest {@link ConfirmProvider}. Resolves `true` on confirm, `false` on
 * cancel / dismiss.
 */
export function useConfirm(): ConfirmFn {
  const ctx = React.useContext(ConfirmContext);
  // Graceful fallback for trees rendered without a ConfirmProvider (e.g.
  // isolated unit tests): defer to the native confirm so behavior matches a
  // plain browser dialog. All real app windows are wrapped in a provider.
  const fallback = React.useCallback<ConfirmFn>((input) => {
    const message = typeof input === "string" ? input : input.message;
    const ok = typeof globalThis.confirm === "function" ? globalThis.confirm(message) : true;
    return Promise.resolve(ok);
  }, []);
  return ctx ?? fallback;
}
