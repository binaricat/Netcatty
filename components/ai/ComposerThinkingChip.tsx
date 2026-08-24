import { Brain, Check, ChevronDown } from 'lucide-react';
import React, { useRef } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../application/i18n/I18nProvider';
import { formatComposerThinkingLabel } from '../../infrastructure/ai/composerPicker';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

export interface ComposerThinkingChipProps {
  levels: readonly string[];
  selectedLevel?: string;
  disabled?: boolean;
  open: boolean;
  menuPos: { left: number; bottom: number } | null;
  onToggle: (rect: DOMRect | undefined) => void;
  onSelect: (level: string) => void;
  onClose: () => void;
}

const chipClassName =
  'inline-flex h-6 items-center gap-1 rounded-full px-1.5 text-[10.5px] text-foreground/72';

export const ComposerThinkingChip: React.FC<ComposerThinkingChipProps> = ({
  levels,
  selectedLevel,
  disabled = false,
  open,
  menuPos,
  onToggle,
  onSelect,
  onClose,
}) => {
  const { t } = useI18n();
  const btnRef = useRef<HTMLButtonElement>(null);
  const formatLevel = (level: string) => (
    level === 'off' ? t('ai.chat.thinkingOff') : formatComposerThinkingLabel(level)
  );
  const label = selectedLevel
    ? formatLevel(selectedLevel)
    : t('ai.chat.thinkingLevel');

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            ref={btnRef}
            type="button"
            disabled={disabled}
            onClick={() => onToggle(btnRef.current?.getBoundingClientRect())}
            className={`${chipClassName} shrink-0 ${
              disabled
                ? 'opacity-60'
                : 'cursor-pointer hover:bg-muted/24 transition-colors'
            }`}
            aria-label={t('ai.chat.thinkingLevel')}
            aria-expanded={open}
          >
            <Brain size={11} className="text-violet-400/75" />
            <span className="truncate max-w-[56px]">{label}</span>
            {!disabled && <ChevronDown size={9} className="text-muted-foreground/50" />}
          </button>
        </TooltipTrigger>
        <TooltipContent>{t('ai.chat.thinkingLevel')}</TooltipContent>
      </Tooltip>
      {open && menuPos && createPortal(
        <>
          <div className="fixed inset-0 z-[999]" onClick={onClose} />
          <div
            role="listbox"
            aria-label={t('ai.chat.thinkingLevel')}
            className="fixed z-[1000] min-w-[148px] rounded-lg border border-border/50 bg-popover shadow-lg py-1"
            style={{ left: menuPos.left, bottom: menuPos.bottom }}
          >
            {levels.map((level) => {
              const isSelected = selectedLevel === level;
              return (
                <button
                  key={level}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => {
                    if (!isSelected) onSelect(level);
                    else onClose();
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[12px] hover:bg-muted/30 transition-colors cursor-pointer"
                >
                  {isSelected
                    ? <Check size={11} className="text-primary shrink-0" />
                    : <span className="w-[11px] shrink-0" />}
                  <Brain size={12} className="text-violet-400/70 shrink-0" />
                  <span className="text-foreground/85">{formatLevel(level)}</span>
                </button>
              );
            })}
          </div>
        </>,
        document.body,
      )}
    </>
  );
};

export default React.memo(ComposerThinkingChip);
