import { Maximize2, Play } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '@/application/i18n/I18nProvider';
import type { Snippet } from '@/domain/models';
import { DEFAULT_SCRIPT_TEMPLATE } from '@/domain/snippetScript.ts';
import { STORAGE_KEY_SCRIPT_EDITOR_HEIGHT } from '@/infrastructure/config/storageKeys.ts';
import { localStorageAdapter } from '@/infrastructure/persistence/localStorageAdapter.ts';
import { ScriptCodeEditor } from './ScriptCodeEditor';
import { ScriptMetaFields } from './ScriptMetaFields';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const DEFAULT_HEIGHT = 200;
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 480;

function clampHeight(height: number): number {
  return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, height));
}

function readStoredHeight(): number {
  const stored = localStorageAdapter.readNumber(STORAGE_KEY_SCRIPT_EDITOR_HEIGHT);
  if (stored === null) return DEFAULT_HEIGHT;
  return clampHeight(stored);
}

function countLines(content: string): number {
  if (!content) return 1;
  let lines = 1;
  for (let i = 0; i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) lines += 1;
  }
  return lines;
}

export interface ScriptEditorPanelProps {
  snippet: Snippet;
  onChange: (snippet: Snippet) => void;
  onRun?: () => void;
  canRun?: boolean;
  onExpand?: () => void;
}

export const ScriptEditorPanel: React.FC<ScriptEditorPanelProps> = ({
  snippet,
  onChange,
  onRun,
  canRun = false,
  onExpand,
}) => {
  const { t } = useI18n();
  const [height, setHeight] = useState(readStoredHeight);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const heightRef = useRef(height);
  heightRef.current = height;

  const language = 'javascript';
  const editorValue = snippet.command || DEFAULT_SCRIPT_TEMPLATE;
  const lineCount = countLines(editorValue);

  const handleResizeStart = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    dragRef.current = { startY: event.clientY, startHeight: heightRef.current };
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = event.clientY - dragRef.current.startY;
      setHeight(clampHeight(dragRef.current.startHeight + delta));
    };
    const onUp = () => {
      if (dragRef.current) {
        localStorageAdapter.writeNumber(STORAGE_KEY_SCRIPT_EDITOR_HEIGHT, heightRef.current);
      }
      dragRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, []);

  return (
    <div className="space-y-4">
      <ScriptMetaFields snippet={snippet} onChange={onChange} layout="stack" />

      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2 min-h-7">
          <div className="flex items-baseline gap-2 min-w-0">
            <p className="text-xs font-semibold text-muted-foreground shrink-0">{t('scripts.meta.code')}</p>
            <span className="text-[10px] text-muted-foreground/80 truncate">
              {t('scripts.editor.lineCount', { count: lineCount })}
            </span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {onRun ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs gap-1 text-muted-foreground hover:text-foreground"
                    onClick={onRun}
                    disabled={!canRun}
                  >
                    <Play size={13} />
                    {t('scripts.actions.runNow')}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('scripts.actions.runNowHint')}</TooltipContent>
              </Tooltip>
            ) : null}
            {onExpand ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs gap-1 text-muted-foreground hover:text-foreground"
                    onClick={onExpand}
                  >
                    <Maximize2 size={13} />
                    {t('scripts.actions.openEditor')}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('scripts.actions.openEditorHint')}</TooltipContent>
              </Tooltip>
            ) : null}
          </div>
        </div>

        <div className="relative rounded-md border border-border/60 overflow-hidden bg-background">
          <ScriptCodeEditor
            value={editorValue}
            onChange={(command) => onChange({ ...snippet, command })}
            language={language}
            height={height}
          />
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label={t('scripts.editor.resize')}
            className="absolute bottom-0 left-0 right-0 z-10 flex h-2.5 cursor-ns-resize items-center justify-center hover:bg-muted/30"
            onMouseDown={handleResizeStart}
          >
            <div className="h-0.5 w-10 rounded-full bg-border/80" />
          </div>
        </div>
      </div>
    </div>
  );
};
