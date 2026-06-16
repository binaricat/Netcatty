import React, { memo, useEffect, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { cn } from '../../lib/utils';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';

export interface SystemPanelPromptField {
  id: string;
  label: string;
  placeholder?: string;
  initialValue?: string;
  mono?: boolean;
  /** Defaults to true; optional fields may be submitted empty. */
  required?: boolean;
}

interface SystemPanelPromptDialogProps {
  open: boolean;
  title: string;
  fields: SystemPanelPromptField[];
  confirmLabel: string;
  busy?: boolean;
  error?: string | null;
  /** Return an error message to block submit, or null to accept. */
  validate?: (values: Record<string, string>) => string | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: Record<string, string>) => void;
}

/**
 * Dialog replacement for window.prompt(), which Electron does not support
 * (calling it throws, leaving buttons silently dead).
 */
export const SystemPanelPromptDialog = memo(function SystemPanelPromptDialog({
  open,
  title,
  fields,
  confirmLabel,
  busy = false,
  error,
  validate,
  onOpenChange,
  onSubmit,
}: SystemPanelPromptDialogProps) {
  const { t } = useI18n();
  const [values, setValues] = useState<Record<string, string>>({});
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      const initial: Record<string, string> = {};
      for (const field of fields) initial[field.id] = field.initialValue ?? '';
      setValues(initial);
      setLocalError(null);
    }
    // Reinitialize only when the dialog (re)opens — `fields` is rebuilt by
    // callers on every render, so depending on it would wipe user input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const hasEmptyField = fields.some(
    (field) => (field.required ?? true) && !(values[field.id] ?? '').trim(),
  );

  const handleSubmit = () => {
    const trimmed: Record<string, string> = {};
    for (const field of fields) trimmed[field.id] = (values[field.id] ?? '').trim();
    const validationError = validate?.(trimmed) ?? null;
    if (validationError) {
      setLocalError(validationError);
      return;
    }
    setLocalError(null);
    onSubmit(trimmed);
  };

  const displayError = localError || error;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[380px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {fields.map((field, index) => (
            <div key={field.id} className="space-y-2">
              <label className="text-sm font-medium" htmlFor={`system-prompt-${field.id}`}>
                {field.label}
              </label>
              <Input
                id={`system-prompt-${field.id}`}
                value={values[field.id] ?? ''}
                onChange={(e) => setValues((prev) => ({ ...prev, [field.id]: e.target.value }))}
                placeholder={field.placeholder}
                className={cn('h-9 text-sm', field.mono && 'font-mono')}
                autoFocus={index === 0}
                disabled={busy}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !busy && !hasEmptyField) handleSubmit();
                }}
              />
            </div>
          ))}

          {displayError && (
            <p className="text-xs text-destructive">{displayError}</p>
          )}
        </div>

        <DialogFooter>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={busy}
            className="px-3 py-1.5 text-sm rounded-md border border-border hover:bg-muted transition-colors disabled:opacity-50"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={busy || hasEmptyField}
            className="px-3 py-1.5 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {confirmLabel}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});
