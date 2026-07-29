import React, { useMemo, useState } from 'react';
import { MessageCircleQuestion } from 'lucide-react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { Button } from '../ui/button';
import type { CodexAppServerInteraction } from '../../infrastructure/ai/shared/codexAppServerInteractions';
import type { OpenCodeQuestionInteraction } from '../../infrastructure/ai/shared/openCodeQuestionInteractions';

type UserInputInteraction =
  | Extract<CodexAppServerInteraction, { kind: 'user-input' }>
  | OpenCodeQuestionInteraction;

function getSelectedLabels(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  if (typeof value === 'string' && value.length > 0) return [value];
  return [];
}

export const CodexUserInputCard: React.FC<{
  interaction: UserInputInteraction;
  onSubmit: (answers: Record<string, { answers: string[] }>) => void;
  onSkip: () => void;
}> = ({ interaction, onSubmit, onSkip }) => {
  const { t } = useI18n();
  const [values, setValues] = useState<Record<string, string | string[]>>({});
  const [otherValues, setOtherValues] = useState<Record<string, string>>({});
  const questions = useMemo(() => interaction.questions || [], [interaction.questions]);
  const complete = useMemo(
    () => questions.every((question) => {
      const selected = getSelectedLabels(values[question.id]);
      const other = String(otherValues[question.id] || '').trim();
      if (question.multiple) {
        return selected.length > 0 || (question.isOther && other.length > 0);
      }
      if (question.options?.length) {
        if (selected.length > 0) return true;
        return question.isOther && other.length > 0;
      }
      return String(values[question.id] || '').trim().length > 0;
    }),
    [questions, values, otherValues],
  );
  const isOpenCode = interaction.source === 'opencode';
  const title = isOpenCode
    ? t('ai.opencode.question.title')
    : t('ai.codex.appServer.userInput.title');
  const description = isOpenCode
    ? t('ai.opencode.question.description')
    : t('ai.codex.appServer.userInput.description');
  const otherPlaceholder = isOpenCode
    ? t('ai.opencode.question.other')
    : t('ai.codex.appServer.userInput.other');
  const skipLabel = isOpenCode
    ? t('ai.opencode.question.skip')
    : t('ai.codex.appServer.userInput.skip');
  const submitLabel = isOpenCode
    ? t('ai.opencode.question.submit')
    : t('ai.codex.appServer.userInput.submit');

  const submit = () => {
    if (!complete) return;
    const answers: Record<string, { answers: string[] }> = {};
    for (const question of questions) {
      if (question.multiple) {
        const selected = getSelectedLabels(values[question.id]);
        const other = question.isSecret
          ? String(otherValues[question.id] || '')
          : String(otherValues[question.id] || '').trim();
        const next = [...selected];
        if (question.isOther && other) next.push(other);
        answers[question.id] = { answers: next };
        continue;
      }
      if (question.options?.length) {
        const selected = getSelectedLabels(values[question.id])[0] || '';
        const other = question.isSecret
          ? String(otherValues[question.id] || '')
          : String(otherValues[question.id] || '').trim();
        const value = selected || other;
        answers[question.id] = { answers: [value] };
        continue;
      }
      const value = String(values[question.id] || '');
      answers[question.id] = { answers: [question.isSecret ? value : value.trim()] };
    }
    onSubmit(answers);
  };

  return (
    <div className="rounded-lg border border-border/70 bg-card/70 p-3 space-y-3">
      <div className="flex items-start gap-2">
        <MessageCircleQuestion size={16} className="mt-0.5 shrink-0 text-blue-500" />
        <div className="min-w-0">
          <div className="text-sm font-medium">{title}</div>
          <div className="text-xs text-muted-foreground leading-5">
            {description}
          </div>
        </div>
      </div>

      {questions.map((question) => {
        const multiple = question.multiple === true;
        const selected = getSelectedLabels(values[question.id]);
        return (
          <fieldset key={question.id} className="space-y-2">
            <legend className="text-xs font-medium">
              {question.header ? `${question.header}: ` : ''}{question.question}
            </legend>
            {question.options?.length ? (
              <div className="space-y-1.5">
                {question.options.map((option) => (
                  <label
                    key={option.label}
                    className="flex cursor-pointer items-start gap-2 rounded-md border border-border/50 px-2.5 py-2 text-xs hover:bg-muted/40"
                  >
                    <input
                      type={multiple ? 'checkbox' : 'radio'}
                      name={`${interaction.interactionId}:${question.id}`}
                      value={option.label}
                      checked={selected.includes(option.label)}
                      onChange={(event) => {
                        if (multiple) {
                          setValues((current) => {
                            const existing = getSelectedLabels(current[question.id]);
                            const next = event.target.checked
                              ? (existing.includes(option.label) ? existing : [...existing, option.label])
                              : existing.filter((label) => label !== option.label);
                            return { ...current, [question.id]: next };
                          });
                          return;
                        }
                        setOtherValues((current) => ({ ...current, [question.id]: '' }));
                        setValues((current) => ({ ...current, [question.id]: option.label }));
                      }}
                      className="mt-0.5"
                    />
                    <span className="min-w-0">
                      <span className="block font-medium">{option.label}</span>
                      {option.description ? (
                        <span className="block text-muted-foreground leading-5">{option.description}</span>
                      ) : null}
                    </span>
                  </label>
                ))}
                {question.isOther ? (
                  <input
                    type={question.isSecret ? 'password' : 'text'}
                    value={otherValues[question.id] || ''}
                    onChange={(event) => {
                      const nextOther = event.target.value;
                      setOtherValues((current) => ({ ...current, [question.id]: nextOther }));
                      if (!multiple && nextOther) {
                        setValues((current) => ({ ...current, [question.id]: '' }));
                      }
                    }}
                    placeholder={otherPlaceholder}
                    className="h-8 w-full rounded-md border border-input bg-background px-2.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  />
                ) : null}
              </div>
            ) : (
              <input
                type={question.isSecret ? 'password' : 'text'}
                value={typeof values[question.id] === 'string' ? values[question.id] : ''}
                onChange={(event) => setValues((current) => ({ ...current, [question.id]: event.target.value }))}
                className="h-8 w-full rounded-md border border-input bg-background px-2.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            )}
          </fieldset>
        );
      })}

      {interaction.autoResolutionMs ? (
        <p className="text-[11px] text-muted-foreground">
          {t('ai.codex.appServer.userInput.autoResolve')}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onSkip}>
          {skipLabel}
        </Button>
        <Button size="sm" disabled={!complete} onClick={submit}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
};
