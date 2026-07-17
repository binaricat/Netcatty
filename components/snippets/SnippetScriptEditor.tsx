import { Maximize2 } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { STORAGE_KEY_SNIPPET_SCRIPT_EDITOR_HEIGHT } from '@/infrastructure/config/storageKeys.ts';
import { localStorageAdapter } from '@/infrastructure/persistence/localStorageAdapter.ts';
import { Button } from '../ui/button';
import {
  ScriptCodeEditor,
  type ScriptCodeEditorHandle,
} from '../scripts/ScriptCodeEditor';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

const DEFAULT_HEIGHT = 120;
const MIN_HEIGHT = 80;
const MAX_HEIGHT = 520;

function clampHeight(height: number, minHeight = MIN_HEIGHT, maxHeight = MAX_HEIGHT): number {
  return Math.max(minHeight, Math.min(maxHeight, height));
}

function readStoredHeight({
  defaultHeight,
  minHeight,
  maxHeight,
  persistHeight,
}: {
  defaultHeight: number;
  minHeight: number;
  maxHeight: number;
  persistHeight: boolean;
}): number {
  if (!persistHeight) return clampHeight(defaultHeight, minHeight, maxHeight);
  const stored = localStorageAdapter.readNumber(STORAGE_KEY_SNIPPET_SCRIPT_EDITOR_HEIGHT);
  if (stored === null) return clampHeight(defaultHeight, minHeight, maxHeight);
  return clampHeight(stored, minHeight, maxHeight);
}

export interface SnippetScriptEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  id?: string;
  /** Shown on the same row as the expand button (e.g. "Script *"). */
  label?: string;
  defaultHeight?: number;
  minHeight?: number;
  maxHeight?: number;
  persistHeight?: boolean;
  /** Save or submit the surrounding form with Cmd/Ctrl+Enter. */
  onSubmitShortcut?: () => void;
}

export const SnippetScriptEditor: React.FC<SnippetScriptEditorProps> = ({
  value,
  onChange,
  placeholder,
  id,
  label,
  defaultHeight = DEFAULT_HEIGHT,
  minHeight = MIN_HEIGHT,
  maxHeight = MAX_HEIGHT,
  persistHeight = true,
  onSubmitShortcut,
}) => {
  const { t } = useI18n();
  const [height, setHeight] = useState(() => readStoredHeight({
    defaultHeight,
    minHeight,
    maxHeight,
    persistHeight,
  }));
  const [modalOpen, setModalOpen] = useState(false);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const inlineEditorRef = useRef<ScriptCodeEditorHandle>(null);
  const heightRef = useRef(height);
  heightRef.current = height;

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startHeight: heightRef.current };
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = e.clientY - dragRef.current.startY;
      setHeight(clampHeight(dragRef.current.startHeight + delta, minHeight, maxHeight));
    };
    const onUp = () => {
      if (dragRef.current && persistHeight) {
        localStorageAdapter.writeNumber(
          STORAGE_KEY_SNIPPET_SCRIPT_EDITOR_HEIGHT,
          heightRef.current,
        );
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
  }, [maxHeight, minHeight, persistHeight]);

  return (
    <>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2 min-h-7">
          {label ? (
            id ? (
              <label
                id={`${id}-label`}
                className="text-xs font-semibold text-muted-foreground shrink-0 cursor-text"
                onClick={() => inlineEditorRef.current?.focus()}
              >
                {label}
              </label>
            ) : (
              <p className="text-xs font-semibold text-muted-foreground shrink-0">{label}</p>
            )
          ) : (
            <span className="flex-1" aria-hidden />
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 shrink-0 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setModalOpen(true)}
                aria-label={t('snippets.scriptEditor.expand')}
              >
                <Maximize2 size={14} />
                {t('snippets.scriptEditor.expand')}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('snippets.scriptEditor.expand')}</TooltipContent>
          </Tooltip>
        </div>
        <div
          className="relative overflow-hidden rounded-md border border-border/60 bg-background"
          style={{ height }}
        >
          <ScriptCodeEditor
            ref={inlineEditorRef}
            value={value}
            onChange={onChange}
            language="shell"
            fill
            height={height}
            ariaLabel={label || placeholder}
            placeholder={placeholder}
            tabFocusMode
            onSubmitShortcut={onSubmitShortcut}
          />
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label={t('snippets.scriptEditor.resize')}
            className="absolute bottom-0 left-0 right-0 z-10 flex h-2.5 cursor-ns-resize items-center justify-center rounded-b-md hover:bg-muted/40"
            onMouseDown={handleResizeStart}
          >
            <div className="h-0.5 w-10 rounded-full bg-border/80" />
          </div>
        </div>
      </div>

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="max-w-4xl w-[min(90vw,56rem)] h-[min(85vh,640px)] flex flex-col gap-0 p-0">
          <DialogHeader className="px-6 pt-6 pb-3 shrink-0">
            <DialogTitle>{t('snippets.scriptEditor.modalTitle')}</DialogTitle>
          </DialogHeader>
          <div className="flex-1 min-h-0 mx-6 mb-3 overflow-hidden rounded-md border border-border/60 bg-background">
            <ScriptCodeEditor
              value={value}
              onChange={onChange}
              language="shell"
              fill
              autoFocus
              active={modalOpen}
              ariaLabel={label || placeholder}
              placeholder={placeholder}
              onSubmitShortcut={onSubmitShortcut}
            />
          </div>
          <DialogFooter className="px-6 pb-6 pt-2 shrink-0">
            <Button type="button" onClick={() => setModalOpen(false)}>
              {t('common.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
