import React, { useEffect, useState } from 'react';
import { Search, Trash2, X } from 'lucide-react';
import type { AISession } from '../infrastructure/ai/types';
import { useI18n } from '../application/i18n/I18nProvider';
import { cn } from '../lib/utils';
import { Input } from './ui/input';
import { ScrollArea } from './ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { SESSION_HISTORY_ROW_CLASSNAMES } from './ai/sessionHistoryLayout';
import { filterSessionHistory } from '../domain/sessionHistorySearch';

// -------------------------------------------------------------------
// Session History Drawer
// -------------------------------------------------------------------

interface SessionHistoryDrawerProps {
  sessions: AISession[];
  activeSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onDelete: (e: React.MouseEvent, sessionId: string) => void;
  onClose: () => void;
}

const SESSION_RENDER_BATCH = 80;
const SESSION_RENDER_STEP = 60;

export const SessionHistoryDrawer: React.FC<SessionHistoryDrawerProps> = ({
  sessions,
  activeSessionId,
  onSelect,
  onDelete,
  onClose,
}) => {
  const { t } = useI18n();
  const [renderCount, setRenderCount] = useState(SESSION_RENDER_BATCH);
  const [searchQuery, setSearchQuery] = useState('');

  const filteredSessions = React.useMemo(
    () => filterSessionHistory(sessions, searchQuery),
    [sessions, searchQuery],
  );

  // Reset the render batch when the list scope or query changes so matching
  // sessions are never hidden behind stale paging.
  useEffect(() => {
    setRenderCount(SESSION_RENDER_BATCH);
  }, [sessions, searchQuery]);

  const displayedSessions = filteredSessions.slice(0, renderCount);
  const hiddenSessionCount = Math.max(0, filteredSessions.length - renderCount);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-4 py-2.5 flex items-center justify-between shrink-0 border-b border-border/30">
        <span className="text-[13px] font-medium text-foreground/80">{t('ai.chat.allSessions')}</span>
        <button
          onClick={onClose}
          className="text-[12px] text-muted-foreground/60 hover:text-muted-foreground transition-colors cursor-pointer"
        >
          <X size={14} />
        </button>
      </div>
      <div className="px-3 py-2 shrink-0 border-b border-border/30">
        <div className="relative">
          <Search
            size={13}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/50 pointer-events-none"
          />
          <Input
            type="text"
            value={searchQuery}
            placeholder={t('ai.chat.searchSessions')}
            onChange={(event) => setSearchQuery(event.target.value)}
            className="h-8 pl-8 pr-7 text-[12px]"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-muted-foreground transition-colors cursor-pointer"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>
      <ScrollArea className="flex-1">
        <div className="px-3">
          {sessions.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-[13px] text-muted-foreground/40">
                {t('ai.chat.noSessions')}
              </p>
            </div>
          ) : filteredSessions.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-[13px] text-muted-foreground/40">
                {t('ai.chat.noMatchingSessions')}
              </p>
            </div>
          ) : (
            <>
            {hiddenSessionCount > 0 && (
              <button
                type="button"
                onClick={() => setRenderCount((count) => count + SESSION_RENDER_STEP)}
                className="w-full py-2 text-center text-[12px] text-muted-foreground/50 hover:text-muted-foreground transition-colors cursor-pointer"
              >
                {t('ai.chat.loadMoreSessions').replace('{n}', String(hiddenSessionCount))}
              </button>
            )}
            {displayedSessions.map((session) => {
              const isActive = session.id === activeSessionId;
              const time = new Date(session.updatedAt);
              const timeStr = formatRelativeTime(time, t);

              return (
                <div
                  key={session.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(session.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelect(session.id); }}
                  className={cn(
                    SESSION_HISTORY_ROW_CLASSNAMES.row,
                    isActive ? 'text-foreground' : 'text-foreground/70 hover:text-foreground',
                  )}
                >
                  <span className={SESSION_HISTORY_ROW_CLASSNAMES.title}>
                    {session.title || t('ai.chat.untitled')}
                  </span>
                  <div className={SESSION_HISTORY_ROW_CLASSNAMES.meta}>
                    <span className={SESSION_HISTORY_ROW_CLASSNAMES.time}>
                      {timeStr}
                    </span>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          onClick={(e) => onDelete(e, session.id)}
                          className={SESSION_HISTORY_ROW_CLASSNAMES.deleteButton}
                        >
                          <Trash2 size={12} />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>{t('common.delete')}</TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              );
            })}
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
};

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

export function formatRelativeTime(date: Date, t: (key: string) => string): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);

  if (minutes < 1) return t('ai.chat.justNow');
  if (minutes < 60) return t('ai.chat.minutesAgo').replace('{n}', String(minutes));
  if (hours < 24) return t('ai.chat.hoursAgo').replace('{n}', String(hours));
  if (days < 7) return t('ai.chat.daysAgo').replace('{n}', String(days));
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
