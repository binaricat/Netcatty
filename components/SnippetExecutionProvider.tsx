import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../application/i18n/I18nProvider';
import type { Snippet } from '../domain/models';
import {
  applySnippetVariables,
  parseSnippetVariables,
  previewSnippetCommand,
  snippetHasVariables,
  type SnippetVariableDef,
} from '../domain/snippetVariables';
import {
  readSnippetVariableValuesForSnippet,
  saveSnippetVariableValues,
} from '../application/state/snippetVariableValues';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { ScrollArea } from './ui/scroll-area';

interface PendingPrompt {
  snippet: Snippet;
  variables: SnippetVariableDef[];
  resolve: (values: Record<string, string> | null) => void;
}

function buildInitialValues(
  snippet: Snippet,
  variables: SnippetVariableDef[],
): Record<string, string> {
  const cached = readSnippetVariableValuesForSnippet(snippet.id);
  const values: Record<string, string> = {};
  for (const def of variables) {
    if (cached[def.name] !== undefined) {
      values[def.name] = cached[def.name];
    } else if (def.defaultValue !== undefined) {
      values[def.name] = def.defaultValue;
    } else {
      values[def.name] = '';
    }
  }
  return values;
}

function isFormValid(
  variables: SnippetVariableDef[],
  values: Record<string, string>,
): boolean {
  for (const def of variables) {
    const raw = values[def.name] ?? '';
    if (raw.trim() === '' && def.defaultValue === undefined) {
      return false;
    }
  }
  return true;
}

export const SnippetExecutionProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const { t } = useI18n();
  const [pending, setPending] = useState<PendingPrompt | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const pendingRef = useRef<PendingPrompt | null>(null);
  pendingRef.current = pending;

  const prompt = useCallback(
    (snippet: Snippet) =>
      new Promise<Record<string, string> | null>((resolve) => {
        const prior = pendingRef.current;
        if (prior) prior.resolve(null);

        const variables = parseSnippetVariables(snippet.command);
        if (variables.length === 0) {
          resolve({});
          return;
        }

        setValues(buildInitialValues(snippet, variables));
        setPending({ snippet, variables, resolve });
      }),
    [],
  );

  useEffect(() => {
    promptSnippetVariablesSingleton = prompt;
    return () => {
      promptSnippetVariablesSingleton = null;
    };
  }, [prompt]);

  useEffect(() => () => {
    const prior = pendingRef.current;
    if (prior) {
      prior.resolve(null);
      pendingRef.current = null;
    }
  }, []);

  const preview = useMemo(() => {
    if (!pending) return '';
    return previewSnippetCommand(pending.snippet.command, values);
  }, [pending, values]);

  const canSubmit = pending ? isFormValid(pending.variables, values) : false;

  const closeWith = useCallback((result: Record<string, string> | null) => {
    if (!pending) return;
    pending.resolve(result);
    setPending(null);
  }, [pending]);

  const handleSubmit = useCallback(() => {
    if (!pending || !canSubmit) return;
    const result = applySnippetVariables(pending.snippet.command, values);
    if (!result.ok) return;
    saveSnippetVariableValues(pending.snippet.id, values);
    closeWith(values);
  }, [pending, canSubmit, values, closeWith]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey && canSubmit) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [canSubmit, handleSubmit],
  );

  return (
    <>
      {children}
      <Dialog open={!!pending} onOpenChange={(open) => { if (!open) closeWith(null); }}>
        <DialogContent className="sm:max-w-[520px]" onKeyDown={handleKeyDown}>
          <DialogHeader>
            <DialogTitle>{t('snippets.variables.dialogTitle')}</DialogTitle>
            <DialogDescription>
              {t('snippets.variables.dialogDesc', { label: pending?.snippet.label ?? '' })}
            </DialogDescription>
          </DialogHeader>

          {pending && (
            <div className="space-y-4 py-1">
              <p className="text-xs text-muted-foreground">{t('snippets.variables.hint')}</p>
              <div className="space-y-3">
                {pending.variables.map((def) => {
                  const raw = values[def.name] ?? '';
                  const invalid = raw.trim() === '' && def.defaultValue === undefined;
                  return (
                    <div key={def.name} className="space-y-1.5">
                      <Label htmlFor={`snippet-var-${def.name}`}>{def.name}</Label>
                      <Input
                        id={`snippet-var-${def.name}`}
                        value={raw}
                        placeholder={
                          def.defaultValue !== undefined
                            ? t('snippets.variables.placeholderDefault', { value: def.defaultValue })
                            : t('snippets.variables.placeholder')
                        }
                        onChange={(e) => {
                          const next = e.target.value;
                          setValues((prev) => ({ ...prev, [def.name]: next }));
                        }}
                        className={invalid ? 'border-destructive' : undefined}
                        autoFocus={def === pending.variables[0]}
                      />
                      {invalid && (
                        <p className="text-xs text-destructive">{t('snippets.variables.required')}</p>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="space-y-1.5">
                <p className="text-xs font-semibold text-muted-foreground">
                  {t('snippets.variables.preview')}
                </p>
                <ScrollArea className="max-h-32 rounded-md border border-border/60 bg-muted/30">
                  <pre className="p-3 text-[11px] font-mono whitespace-pre-wrap break-all">
                    {preview}
                  </pre>
                </ScrollArea>
              </div>
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => closeWith(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="default" disabled={!canSubmit} onClick={handleSubmit}>
              {t('snippets.variables.run')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

let promptSnippetVariablesSingleton:
  | ((snippet: Snippet) => Promise<Record<string, string> | null>)
  | null = null;

export async function resolveSnippetCommand(snippet: Snippet): Promise<string | null> {
  if (!snippetHasVariables(snippet.command)) {
    return snippet.command;
  }

  const promptFn = promptSnippetVariablesSingleton;
  if (!promptFn) {
    return snippet.command;
  }

  const values = await promptFn(snippet);
  if (values === null) {
    return null;
  }

  const result = applySnippetVariables(snippet.command, values);
  if (!result.ok) {
    return null;
  }
  return result.command;
}
