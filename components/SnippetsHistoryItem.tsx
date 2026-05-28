import React, { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useI18n } from '../application/i18n/I18nProvider';
import type { ShellHistoryEntry } from '../types';
import { Button } from './ui/button';
import { Input } from './ui/input';

// History Item Component
interface HistoryItemProps {
  entry: ShellHistoryEntry;
  onSaveAsSnippet: (entry: ShellHistoryEntry, label: string) => void;
  onCopy: () => void;
  isCopied: boolean;
}

export const HistoryItem: React.FC<HistoryItemProps> = ({ entry, onSaveAsSnippet, onCopy, isCopied }) => {
  const { t } = useI18n();
  const [isEditing, setIsEditing] = useState(false);
  const [label, setLabel] = useState('');

  const handleSave = () => {
    if (label.trim()) {
      onSaveAsSnippet(entry, label);
      setIsEditing(false);
      setLabel('');
    }
  };

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return t('snippets.history.time.justNow');
    if (diffMins < 60) return t('snippets.history.time.minutesAgo', { count: diffMins });
    if (diffHours < 24) return t('snippets.history.time.hoursAgo', { count: diffHours });
    if (diffDays < 7) return t('snippets.history.time.daysAgo', { count: diffDays });
    return date.toLocaleDateString();
  };

  return (
    <div className="group rounded-lg bg-background/60 border border-border/50 p-3">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="font-mono text-sm truncate">{entry.command}</div>
          <div className="flex items-center gap-2 mt-1 text-[11px] text-muted-foreground">
            <span>{entry.hostLabel}</span>
            <span>{t('snippets.history.separator')}</span>
            <span>{formatTime(entry.timestamp)}</span>
          </div>
        </div>
        {!isEditing && (
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              onClick={onCopy}
            >
              {isCopied ? <Check size={14} /> : <Copy size={14} />}
            </Button>
            <Button
              variant="default"
              size="sm"
              className="h-7 px-3"
              onClick={() => setIsEditing(true)}
            >
              {t('common.save')}
            </Button>
          </div>
        )}
      </div>
      {isEditing && (
        <div className="mt-3 space-y-2">
          <Input
            placeholder={t('snippets.history.labelPlaceholder')}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSave()}
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => { setIsEditing(false); setLabel(''); }}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={handleSave} disabled={!label.trim()}>
              {t('snippets.history.saveAsSnippet')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
