import { FileCode, Search, Zap } from 'lucide-react';
import React, { memo, useMemo, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { cn } from '../../lib/utils';
import type { Snippet } from '../../types';
import { FixedSizeVirtualList } from '../ui/FixedSizeVirtualList';
import { Input } from '../ui/input';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';

const ROW_HEIGHT = 34;

export interface SnippetCommandPickerProps {
  snippets: Snippet[];
  selectedId?: string | null;
  onSelect: (snippet: Snippet) => void;
  className?: string;
  showTitle?: boolean;
}

export const SnippetCommandPicker = memo(function SnippetCommandPicker({
  snippets,
  selectedId,
  onSelect,
  className,
  showTitle = true,
}: SnippetCommandPickerProps) {
  const { t } = useI18n();
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const sorted = [...snippets].sort((a, b) => a.label.localeCompare(b.label));
    if (!q) return sorted;
    return sorted.filter(
      (snippet) =>
        snippet.label.toLowerCase().includes(q)
        || snippet.command.toLowerCase().includes(q)
        || (snippet.package || '').toLowerCase().includes(q),
    );
  }, [search, snippets]);

  const listItems = useMemo(
    () => filtered.map((snippet) => ({ key: snippet.id, snippet })),
    [filtered],
  );

  return (
    <TooltipProvider delayDuration={300}>
      <div
        className={cn(
          'flex min-h-0 flex-col overflow-hidden rounded-md border border-border/60 bg-muted/20',
          className,
        )}
      >
        <div className="shrink-0 border-b border-border/50 px-2 py-1.5">
          {showTitle && (
            <p className="mb-1.5 px-0.5 text-[10px] font-medium text-muted-foreground">
              {t('systemManager.tmux.pickSnippet')}
            </p>
          )}
          <div className="relative">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('snippets.searchPlaceholder')}
              className="h-7 border-none bg-background/60 pl-7 text-xs"
              disabled={snippets.length === 0}
            />
          </div>
        </div>

        <div className="min-h-0 flex-1">
          {snippets.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center px-4 py-6 text-center text-muted-foreground">
              <Zap size={22} className="mb-2 opacity-40" />
              <p className="text-xs">{t('systemManager.tmux.pickSnippetEmpty')}</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs italic text-muted-foreground">
              {t('common.noResultsFound')}
            </div>
          ) : (
            <FixedSizeVirtualList
              className="h-full"
              contentClassName="py-1"
              items={listItems}
              itemHeight={ROW_HEIGHT}
              getItemKey={(item) => item.key}
              renderItem={(item) => {
                const { snippet } = item;
                const selected = selectedId === snippet.id;
                return (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => onSelect(snippet)}
                        className={cn(
                          'flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left transition-colors',
                          selected
                            ? 'bg-primary/10 text-foreground'
                            : 'hover:bg-accent/50',
                        )}
                      >
                        <FileCode size={12} className="shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-xs font-medium">{snippet.label}</span>
                        {snippet.package ? (
                          <span className="max-w-[42%] shrink-0 truncate text-[10px] text-muted-foreground">
                            {snippet.package}
                          </span>
                        ) : null}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right" align="start" className="max-w-[480px]">
                      <div className="mb-1 break-all text-xs font-medium">{snippet.label}</div>
                      <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-snug opacity-90">
                        {snippet.command}
                      </pre>
                    </TooltipContent>
                  </Tooltip>
                );
              }}
            />
          )}
        </div>
      </div>
    </TooltipProvider>
  );
});
