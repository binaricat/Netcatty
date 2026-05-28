import React, { useEffect, useState } from "react";
import { ChevronRight, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";


import { DEFAULT_KEYWORD_HIGHLIGHT_RULES, type KeywordHighlightRule } from "../../../domain/models";
import { useI18n } from "../../../application/i18n/I18nProvider";
import { TERMINAL_THEMES } from "../../../infrastructure/config/terminalThemes";
import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { Textarea } from "../../ui/textarea";

// Keyword highlight rules editor for global settings
const DEFAULT_NEW_RULE_COLOR = '#F87171';

export const AddCustomRuleDialog: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editRule?: KeywordHighlightRule | null;
  isBuiltIn?: boolean;
  onAdd: (rule: KeywordHighlightRule) => void;
}> = ({ open, onOpenChange, editRule, isBuiltIn = false, onAdd }) => {
  const { t } = useI18n();
  const [label, setLabel] = useState('');
  // Multi-line text: one regex pattern per line. Built-in rules typically
  // ship multiple patterns (e.g. several spellings of "error"), and the user
  // is allowed to add as many as they like.
  const [patternsText, setPatternsText] = useState('');
  const [color, setColor] = useState(DEFAULT_NEW_RULE_COLOR);
  const [patternError, setPatternError] = useState<string | null>(null);

  const reset = () => { setLabel(''); setPatternsText(''); setColor(DEFAULT_NEW_RULE_COLOR); setPatternError(null); };

  // Populate form when editing
  useEffect(() => {
    if (open && editRule) {
      setLabel(editRule.label);
      setPatternsText(editRule.patterns.join('\n'));
      setColor(editRule.color);
      setPatternError(null);
    } else if (!open) {
      reset();
    }
  }, [open, editRule]);

  const handleSubmit = () => {
    if (!label.trim()) return;
    const patterns = patternsText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (patterns.length === 0) return;
    for (const p of patterns) {
      try { new RegExp(p, 'gi'); } catch {
        setPatternError(t('settings.terminal.keywordHighlight.invalidPattern'));
        return;
      }
    }
    onAdd({
      id: editRule?.id ?? crypto.randomUUID(),
      label: label.trim(),
      patterns,
      color,
      enabled: editRule?.enabled ?? true,
      // Editing a built-in rule flips it into "user-customized" mode so the
      // normalizer keeps the user's patterns across restarts.
      customized: isBuiltIn ? true : editRule?.customized,
    });
    reset();
    onOpenChange(false);
  };

  const dialogTitleKey = editRule
    ? (isBuiltIn
      ? 'settings.terminal.keywordHighlight.editBuiltIn'
      : 'settings.terminal.keywordHighlight.editCustom')
    : 'settings.terminal.keywordHighlight.addCustom';

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v); }}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{t(dialogTitleKey)}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label className="text-xs">{t('settings.terminal.keywordHighlight.labelField')}</Label>
            <div className="flex gap-2">
              <Input
                placeholder={t('settings.terminal.keywordHighlight.labelPlaceholder')}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                className="flex-1"
              />
              <label className="relative flex-shrink-0">
                <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="sr-only" />
                <span className="block w-9 h-9 rounded-md cursor-pointer border border-border/50 hover:border-border" style={{ backgroundColor: color }} />
              </label>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t('settings.terminal.keywordHighlight.patternField')}</Label>
            <Textarea
              placeholder={t('settings.terminal.keywordHighlight.patternPlaceholder')}
              value={patternsText}
              onChange={(e) => { setPatternsText(e.target.value); if (patternError) setPatternError(null); }}
              rows={Math.max(3, Math.min(10, patternsText.split('\n').length + 1))}
              className={cn("font-mono text-xs", patternError && "border-destructive")}
            />
            <p className="text-[11px] text-muted-foreground">
              {t('settings.terminal.keywordHighlight.patternHint')}
            </p>
            {patternError && <div className="text-xs text-destructive">{patternError}</div>}
          </div>
          {label.trim() && patternsText.trim() && !patternError && (
            <div className="flex items-center gap-2 p-2 rounded-md bg-muted/50">
              <span className="text-xs text-muted-foreground">{t('settings.terminal.keywordHighlight.preview')}:</span>
              <span className="text-sm font-medium" style={{ color }}>{label}</span>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { reset(); onOpenChange(false); }}>{t('common.cancel')}</Button>
          <Button onClick={handleSubmit} disabled={!label.trim() || !patternsText.trim()}>{editRule ? t('common.save') : t('common.add')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export const KeywordHighlightRulesEditor: React.FC<{
  rules: KeywordHighlightRule[];
  onChange: (rules: KeywordHighlightRule[]) => void;
}> = ({ rules, onChange }) => {
  const { t } = useI18n();
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<KeywordHighlightRule | null>(null);

  const isBuiltIn = (id: string) => DEFAULT_KEYWORD_HIGHLIGHT_RULES.some((r) => r.id === id);

  return (
    <div className="space-y-2.5">
      {rules.map((rule) => {
        const builtIn = isBuiltIn(rule.id);
        const customized = builtIn && rule.customized;
        return (
          <div key={rule.id} className="flex items-center gap-2 group">
            <div className="flex-1 min-w-0 flex items-center gap-1.5">
              <span className={cn("text-sm truncate", !rule.enabled && "text-muted-foreground line-through")} style={rule.enabled ? { color: rule.color } : undefined}>
                {rule.label}
              </span>
              <Pencil
                size={10}
                className="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground cursor-pointer hover:text-foreground"
                onClick={() => { setEditingRule(rule); setAddDialogOpen(true); }}
              />
              {!builtIn && (
                <Trash2
                  size={10}
                  className="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground cursor-pointer hover:text-destructive"
                  onClick={() => onChange(rules.filter((r) => r.id !== rule.id))}
                />
              )}
              {customized && (
                <RotateCcw
                  size={10}
                  className="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground cursor-pointer hover:text-foreground"
                  aria-label={t('settings.terminal.keywordHighlight.resetBuiltIn')}
                  onClick={() => {
                    // Drop the user's customizations and restore the shipped
                    // defaults for label/patterns. Color stays whatever the
                    // user picked (color is the only built-in property they
                    // can edit without flipping `customized`).
                    const def = DEFAULT_KEYWORD_HIGHLIGHT_RULES.find((r) => r.id === rule.id);
                    if (!def) return;
                    onChange(rules.map((r) => r.id === rule.id
                      ? { ...def, color: r.color, enabled: r.enabled, customized: false }
                      : r));
                  }}
                />
              )}
            </div>
            <label className="relative flex-shrink-0">
              <input
                type="color"
                value={rule.color}
                onChange={(e) => onChange(rules.map((r) => r.id === rule.id ? { ...r, color: e.target.value } : r))}
                className="sr-only"
              />
              <span
                className="block w-8 h-5 rounded cursor-pointer border border-border/50 hover:border-border transition-colors"
                style={{ backgroundColor: rule.color }}
              />
            </label>
          </div>
        );
      })}

      <div className="flex pt-2 mt-2 border-t border-border/50">
        <Button
          variant="ghost"
          size="sm"
          className="flex-1 text-muted-foreground hover:text-foreground"
          onClick={() => setAddDialogOpen(true)}
        >
          <Plus size={14} className="mr-1.5" />
          {t('settings.terminal.keywordHighlight.addCustom')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="flex-1 text-muted-foreground hover:text-foreground"
          onClick={() => {
            // Restore every built-in rule back to shipped defaults
            // (label/patterns/color), drop customizations, and keep the user's
            // custom rules untouched.
            onChange(rules.map((rule) => {
              const def = DEFAULT_KEYWORD_HIGHLIGHT_RULES.find((r) => r.id === rule.id);
              if (!def) return rule;
              return { ...def, enabled: rule.enabled, customized: false };
            }));
          }}
        >
          <RotateCcw size={14} className="mr-1.5" />
          {t("settings.terminal.keywordHighlight.resetDefaults")}
        </Button>
      </div>

      <AddCustomRuleDialog
        open={addDialogOpen}
        onOpenChange={(v) => { setAddDialogOpen(v); if (!v) setEditingRule(null); }}
        editRule={editingRule}
        isBuiltIn={editingRule ? isBuiltIn(editingRule.id) : false}
        onAdd={(rule) => {
          if (editingRule) {
            onChange(rules.map((r) => r.id === editingRule.id ? rule : r));
          } else {
            onChange([...rules, rule]);
          }
          setEditingRule(null);
        }}
      />
    </div>
  );
};

// Theme preview button component
export const ThemePreviewButton: React.FC<{
  theme: (typeof TERMINAL_THEMES)[0];
  onClick: () => void;
  buttonLabel: string;
}> = ({ theme, onClick, buttonLabel }) => {
  const c = theme.colors;
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-4 p-3 rounded-lg border bg-card hover:bg-accent/50 transition-all text-left",
      )}
    >
      {/* Theme preview swatch */}
      <div
        className="w-20 h-14 rounded-lg flex-shrink-0 flex flex-col justify-center items-start pl-2 gap-0.5 border border-border/50"
        style={{ backgroundColor: c.background }}
      >
        <div className="flex gap-1 items-center">
          <span className="font-mono text-[8px]" style={{ color: c.green }}>$</span>
          <span className="font-mono text-[8px]" style={{ color: c.blue }}>ls</span>
        </div>
        <div className="flex gap-0.5">
          <div className="h-1 w-3 rounded-full" style={{ backgroundColor: c.cyan }} />
          <div className="h-1 w-4 rounded-full" style={{ backgroundColor: c.magenta }} />
        </div>
        <div className="flex gap-1 items-center">
          <span className="font-mono text-[8px]" style={{ color: c.green }}>$</span>
          <span className="inline-block w-1.5 h-2 animate-pulse" style={{ backgroundColor: c.cursor }} />
        </div>
      </div>

      {/* Theme info */}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{theme.name}</div>
        <div className="text-xs text-muted-foreground capitalize">{theme.type}</div>
      </div>

      {/* Action button area */}
      <div className="flex items-center gap-2 text-muted-foreground">
        <span className="text-xs">{buttonLabel}</span>
        <ChevronRight size={16} />
      </div>
    </button>
  );
};
