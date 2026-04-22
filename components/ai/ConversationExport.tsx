/**
 * ConversationExport - Dropdown button for exporting chat sessions
 *
 * Small download icon button with a dropdown offering Markdown, JSON,
 * and Plain Text export formats.
 */

import { Download, FileJson, FileText, FileType } from 'lucide-react';
import React, { useCallback } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { AISession } from '../../infrastructure/ai/types';
import { Button } from '../ui/button';
import {
  Dropdown,
  DropdownContent,
  DropdownTrigger,
} from '../ui/dropdown';

interface ConversationExportProps {
  session: AISession | null;
  onExport: (format: 'md' | 'json' | 'txt') => void;
  className?: string;
}

const EXPORT_OPTIONS = [
  { format: 'md' as const, labelKey: 'ai.chat.exportMarkdown' as const, icon: FileText },
  { format: 'json' as const, labelKey: 'ai.chat.exportJSON' as const, icon: FileJson },
  { format: 'txt' as const, labelKey: 'ai.chat.exportPlainText' as const, icon: FileType },
];

const ConversationExport: React.FC<ConversationExportProps> = ({
  session,
  onExport,
  className,
}) => {
  const { t } = useI18n();
  const handleExport = useCallback(
    (format: 'md' | 'json' | 'txt') => {
      onExport(format);
    },
    [onExport],
  );

  const hasMessages = session && session.messages.length > 0;

  return (
    <Dropdown>
      <DropdownTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={className ?? 'h-7 w-7 rounded-md text-muted-foreground/62 hover:bg-white/[0.05] hover:text-foreground'}
          disabled={!hasMessages}
          title={t('ai.chat.exportConversation')}
        >
          <Download size={14} />
        </Button>
      </DropdownTrigger>
      <DropdownContent
        align="end"
        sideOffset={6}
        className="w-40 rounded-xl border border-border/45 bg-[#111111]/98 p-1.5 text-foreground shadow-[0_20px_48px_rgba(0,0,0,0.48)] supports-[backdrop-filter]:bg-[#111111]/92 supports-[backdrop-filter]:backdrop-blur-sm"
      >
        <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/48">
          {t('ai.chat.exportAs')}
        </div>
        {EXPORT_OPTIONS.map(({ format, labelKey, icon: Icon }) => (
          <button
            key={format}
            onClick={() => handleExport(format)}
            className="w-full flex items-center gap-2 px-2 py-1.5 text-[13px] rounded-lg transition-colors cursor-pointer hover:bg-white/[0.04]"
          >
            <Icon size={13} className="shrink-0 text-muted-foreground/70" />
            <span>{t(labelKey)}</span>
          </button>
        ))}
      </DropdownContent>
    </Dropdown>
  );
};

export default React.memo(ConversationExport);
