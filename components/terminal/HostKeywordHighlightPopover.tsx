/**
 * Host Keyword Highlight Popover
 * Allows users to manage host-specific keyword highlighting rules in the terminal statusbar
 */
import { Highlighter, Plus, Trash2, RotateCcw } from 'lucide-react';
import React, { useState, useCallback, useMemo } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useI18n } from '../../application/i18n/I18nProvider';
import { Host, KeywordHighlightRule } from '../../types';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { ScrollArea } from '../ui/scroll-area';

export interface HostKeywordHighlightPopoverProps {
  host?: Host;
  onUpdateHost?: (host: Host) => void;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  buttonClassName?: string;
}

const DEFAULT_NEW_RULE_COLOR = '#F87171';

export const HostKeywordHighlightPopover: React.FC<HostKeywordHighlightPopoverProps> = ({
  host,
  onUpdateHost,
  isOpen,
  setIsOpen,
  buttonClassName = '',
}) => {
  const { t } = useI18n();
  const [newRuleLabel, setNewRuleLabel] = useState('');
  const [newRulePattern, setNewRulePattern] = useState('');
  const [newRuleColor, setNewRuleColor] = useState(DEFAULT_NEW_RULE_COLOR);
  const [patternError, setPatternError] = useState<string | null>(null);

  const rules = useMemo(() => host?.keywordHighlightRules ?? [], [host?.keywordHighlightRules]);
  const enabled = host?.keywordHighlightEnabled ?? false;

  const updateRules = useCallback((newRules: KeywordHighlightRule[]) => {
    if (!host || !onUpdateHost) return;
    onUpdateHost({ ...host, keywordHighlightRules: newRules });
  }, [host, onUpdateHost]);

  const toggleEnabled = useCallback(() => {
    if (!host || !onUpdateHost) return;
    onUpdateHost({ ...host, keywordHighlightEnabled: !enabled });
  }, [host, onUpdateHost, enabled]);

  const validatePattern = (pattern: string): boolean => {
    try {
      new RegExp(pattern, 'gi');
      return true;
    } catch {
      return false;
    }
  };

  const handleAddRule = useCallback(() => {
    if (!newRuleLabel.trim() || !newRulePattern.trim()) {
      return;
    }

    if (!validatePattern(newRulePattern)) {
      setPatternError(t('terminal.toolbar.hostHighlight.invalidPattern'));
      return;
    }

    const newRule: KeywordHighlightRule = {
      id: uuidv4(),
      label: newRuleLabel.trim(),
      patterns: [newRulePattern.trim()],
      color: newRuleColor,
      enabled: true,
    };

    updateRules([...rules, newRule]);

    // Reset form
    setNewRuleLabel('');
    setNewRulePattern('');
    setNewRuleColor(DEFAULT_NEW_RULE_COLOR);
    setPatternError(null);

    // Auto-enable if adding the first rule and not enabled
    if (rules.length === 0 && !enabled && host && onUpdateHost) {
      onUpdateHost({ ...host, keywordHighlightRules: [newRule], keywordHighlightEnabled: true });
    }
  }, [newRuleLabel, newRulePattern, newRuleColor, rules, updateRules, enabled, host, onUpdateHost, t]);

  const handleDeleteRule = useCallback((ruleId: string) => {
    updateRules(rules.filter((r) => r.id !== ruleId));
  }, [rules, updateRules]);

  const handleColorChange = useCallback((ruleId: string, color: string) => {
    updateRules(rules.map((r) => (r.id === ruleId ? { ...r, color } : r)));
  }, [rules, updateRules]);

  const handleToggleRule = useCallback((ruleId: string) => {
    updateRules(rules.map((r) => (r.id === ruleId ? { ...r, enabled: !r.enabled } : r)));
  }, [rules, updateRules]);

  const handleClearAll = useCallback(() => {
    if (!host || !onUpdateHost) return;
    onUpdateHost({ ...host, keywordHighlightRules: [], keywordHighlightEnabled: false });
  }, [host, onUpdateHost]);

  const handlePatternChange = (value: string) => {
    setNewRulePattern(value);
    if (patternError && validatePattern(value)) {
      setPatternError(null);
    }
  };

  // Disable if no host (local/serial terminal sessions)
  const isLocalTerminal = host?.protocol === 'local' || host?.id?.startsWith('local-');
  const isSerialTerminal = host?.protocol === 'serial' || host?.id?.startsWith('serial-');
  const isDisabled = !host || !onUpdateHost || isLocalTerminal || isSerialTerminal;

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="secondary"
          size="icon"
          className={buttonClassName}
          title={t('terminal.toolbar.hostHighlight.title')}
          aria-label={t('terminal.toolbar.hostHighlight.title')}
          disabled={isDisabled}
        >
          <Highlighter size={12} />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start" side="top">
        <div className="px-3 py-2 border-b bg-muted/30 flex items-center justify-between">
          <span className="text-xs font-semibold uppercase text-muted-foreground">
            {t('terminal.toolbar.hostHighlight.title')}
          </span>
          <label className="flex items-center gap-2 cursor-pointer">
            <span className="text-xs text-muted-foreground">
              {enabled ? t('common.enabled') : t('common.disabled')}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              onClick={toggleEnabled}
              className={`
                relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent 
                transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2
                ${enabled ? 'bg-primary' : 'bg-muted-foreground/30'}
              `}
            >
              <span
                className={`
                  pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 
                  transition duration-200 ease-in-out
                  ${enabled ? 'translate-x-4' : 'translate-x-0'}
                `}
              />
            </button>
          </label>
        </div>

        <ScrollArea className="max-h-64">
          <div className="p-2 space-y-1.5">
            {rules.length === 0 ? (
              <div className="px-2 py-4 text-xs text-muted-foreground text-center italic">
                {t('terminal.toolbar.hostHighlight.noRules')}
              </div>
            ) : (
              rules.map((rule) => (
                <div
                  key={rule.id}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-accent/50 group"
                >
                  <button
                    type="button"
                    onClick={() => handleToggleRule(rule.id)}
                    className={`
                      flex-shrink-0 w-3 h-3 rounded-sm border transition-colors
                      ${rule.enabled 
                        ? 'bg-primary border-primary' 
                        : 'bg-transparent border-muted-foreground/50'
                      }
                    `}
                    title={rule.enabled ? t('common.enabled') : t('common.disabled')}
                  />
                  <div className="flex-1 min-w-0">
                    <div 
                      className="text-xs font-medium truncate" 
                      style={{ color: rule.enabled ? rule.color : 'inherit' }}
                    >
                      {rule.label}
                    </div>
                    <div className="text-[10px] text-muted-foreground font-mono truncate">
                      {rule.patterns.join(', ')}
                    </div>
                  </div>
                  <label className="relative flex-shrink-0">
                    <input
                      type="color"
                      value={rule.color}
                      onChange={(e) => handleColorChange(rule.id, e.target.value)}
                      className="sr-only"
                      aria-label={`${t('terminal.toolbar.hostHighlight.changeColor')} ${rule.label}`}
                    />
                    <span
                      className="block w-6 h-4 rounded cursor-pointer border border-border/50 hover:border-border"
                      style={{ backgroundColor: rule.color }}
                    />
                  </label>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity text-destructive hover:text-destructive hover:bg-destructive/10"
                    onClick={() => handleDeleteRule(rule.id)}
                  >
                    <Trash2 size={10} />
                  </Button>
                </div>
              ))
            )}
          </div>
        </ScrollArea>

        {/* Add new rule form */}
        <div className="p-2 border-t bg-muted/20 space-y-2">
          <div className="text-xs font-medium text-muted-foreground mb-1">
            {t('terminal.toolbar.hostHighlight.addRule')}
          </div>
          <div className="flex gap-1.5">
            <Input
              placeholder={t('terminal.toolbar.hostHighlight.labelPlaceholder')}
              value={newRuleLabel}
              onChange={(e) => setNewRuleLabel(e.target.value)}
              className="h-7 text-xs flex-1"
            />
            <label className="relative flex-shrink-0">
              <input
                type="color"
                value={newRuleColor}
                onChange={(e) => setNewRuleColor(e.target.value)}
                className="sr-only"
                aria-label={t('terminal.toolbar.hostHighlight.selectColor')}
              />
              <span
                className="block w-7 h-7 rounded cursor-pointer border border-border/50 hover:border-border"
                style={{ backgroundColor: newRuleColor }}
              />
            </label>
          </div>
          <div className="flex gap-1.5">
            <Input
              placeholder={t('terminal.toolbar.hostHighlight.patternPlaceholder')}
              value={newRulePattern}
              onChange={(e) => handlePatternChange(e.target.value)}
              className={`h-7 text-xs font-mono flex-1 ${patternError ? 'border-destructive' : ''}`}
            />
            <Button
              variant="secondary"
              size="icon"
              className="h-7 w-7 flex-shrink-0"
              onClick={handleAddRule}
              disabled={!newRuleLabel.trim() || !newRulePattern.trim()}
            >
              <Plus size={12} />
            </Button>
          </div>
          {patternError && (
            <div className="text-[10px] text-destructive">{patternError}</div>
          )}
        </div>

        {/* Footer actions */}
        {rules.length > 0 && (
          <div className="p-2 border-t flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-xs text-muted-foreground hover:text-destructive"
              onClick={handleClearAll}
            >
              <RotateCcw size={10} className="mr-1" />
              {t('terminal.toolbar.hostHighlight.clearAll')}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
};

export default HostKeywordHighlightPopover;
