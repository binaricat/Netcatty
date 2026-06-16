/**
 * ToolCallGroup - Collapsible container for grouped tool calls.
 *
 * Groups consecutive tool-call messages into a single collapsible section
 * (Codex-style). While the agent is still working the group stays expanded;
 * once the assistant responds it auto-collapses to "Used N tools".
 */

import { ChevronDown, ChevronRight } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { cn } from '../../lib/utils';

interface ToolCallGroupProps {
  count: number;
  children: React.ReactNode;
  /** When true the group starts expanded (e.g. while streaming). */
  defaultExpanded?: boolean;
}

const ToolCallGroup: React.FC<ToolCallGroupProps> = ({
  count,
  children,
  defaultExpanded = false,
}) => {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const prevDefault = useRef(defaultExpanded);

  // Auto-collapse when the group transitions from "active" to "resolved"
  useEffect(() => {
    if (prevDefault.current && !defaultExpanded) {
      setExpanded(false);
    }
    prevDefault.current = defaultExpanded;
  }, [defaultExpanded]);

  return (
    <div className="rounded-md border border-border/20 bg-muted/5 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className={cn(
          'w-full flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer',
          'hover:bg-muted/20 transition-colors select-none',
        )}
      >
        {expanded
          ? <ChevronDown size={12} className="text-muted-foreground/50 shrink-0" />
          : <ChevronRight size={12} className="text-muted-foreground/50 shrink-0" />
        }
        <span className="text-muted-foreground/70 font-medium">
          {t('ai.chat.usedTools', { n: count })}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-border/20 p-1.5 space-y-1.5">
          {children}
        </div>
      )}
    </div>
  );
};

export default ToolCallGroup;
