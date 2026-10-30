import { ArrowUp, ChevronDown, Folder, LoaderCircle, RefreshCw } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { useComposeDirectoryPicker } from '../../application/state/useComposeDirectoryPicker';
import { directoryDisplayName, directoryLabel } from '../../domain/directoryPicker';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import type { ComposeBarTheme } from './TerminalComposeBar';

export function ComposeDirectoryPicker({ sessionId, theme, onReturnFocus }: {
  sessionId: string; theme: ComposeBarTheme; onReturnFocus: () => void;
}) {
  const { t } = useI18n();
  const model = useComposeDirectoryPicker(sessionId);
  const [active, setActive] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const outside = useRef(false);
  const id = useId();
  const hasParent = model.parent !== null;
  const count = model.entries.length + Number(hasParent);
  const activeEntry = active === 0 && hasParent ? model.parent : model.entries[active - Number(hasParent)]?.path;
  const errorText = model.error ? t('terminal.directory.' + model.error) : null;
  useEffect(() => {
    setActive(model.entries.length ? Number(hasParent) : -1);
    setScrollTop(0);
    if (viewport.current) viewport.current.scrollTop = 0;
  }, [model.entries, hasParent, model.open]);

  const virtual = model.entries.length > 200;
  const start = virtual ? Math.max(0, Math.floor(scrollTop / 32) - 4) : 0;
  const visible = virtual ? model.entries.slice(start, start + 16) : model.entries;
  const row = (name: string, path: string, index: number, parent = false) => (
    <div
      key={path} id={`${id}-${index}`} role="option" aria-selected={active === index}
      title={directoryDisplayName(path)}
      className="h-8 flex items-center gap-2 px-3 text-xs cursor-pointer min-w-0"
      style={{ backgroundColor: active === index ? theme.chipHoverBg : undefined,
        color: active === index ? theme.resolvedFg : theme.mutedFg }}
      onPointerMove={() => setActive(index)}
      onMouseDown={event => event.preventDefault()}
      onClick={() => { if (!model.pending) void model.change(path); }}
    >
      {parent ? <ArrowUp size={13} className="shrink-0" /> : <Folder size={13} className="shrink-0" />}
      <span className="truncate">{directoryDisplayName(name)}</span>
    </div>
  );
  return (
    <div className="shrink-0 flex items-center gap-2 px-3 h-7 min-w-0" role="group" aria-label="Context Chips">
      <Popover open={model.open} onOpenChange={value => { if (value) outside.current = false; model.setOpen(value); }}>
        <PopoverTrigger asChild>
          <button type="button" disabled={model.pending}
            aria-label={t('terminal.directory.open', { path: model.cwd ? directoryLabel(model.cwd, model.home) : t('terminal.directory.unknown') })}
            title={model.cwd ? directoryDisplayName(model.cwd) : t('terminal.directory.unknown')}
            className="h-6 min-w-0 max-w-full flex items-center gap-1.5 rounded border px-2 text-[11px] font-mono focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-60"
            style={{ backgroundColor: theme.chipBg, borderColor: theme.borderColor, color: theme.resolvedFg }}
          >
            {model.pending ? <LoaderCircle size={12} className="shrink-0 animate-spin" /> : <Folder size={12} className="shrink-0" />}
            <span className="truncate">{model.cwd ? directoryDisplayName(directoryLabel(model.cwd, model.home)) : t('terminal.directory.unknown')}</span>
            <ChevronDown size={10} className="shrink-0 opacity-60" />
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" sideOffset={6}
          className="p-0 overflow-hidden w-[360px] max-w-[calc(100vw-16px)]"
          style={{ backgroundColor: theme.resolvedBg, borderColor: theme.borderColor, color: theme.resolvedFg }}
          onOpenAutoFocus={event => { event.preventDefault(); search.current?.focus(); }}
          onInteractOutside={() => { outside.current = true; }}
          onCloseAutoFocus={event => { event.preventDefault(); if (!outside.current) onReturnFocus(); }}
          onKeyDown={event => {
            event.stopPropagation();
            if (composing.current || event.nativeEvent.isComposing) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              const next = active < 0 ? (event.key === 'ArrowDown' ? 0 : count - 1)
                : Math.max(0, Math.min(count - 1, active + (event.key === 'ArrowDown' ? 1 : -1)));
              setActive(next);
              const child = next - Number(hasParent);
              if (viewport.current && child >= 0) {
                const el = viewport.current;
                if (child * 32 < el.scrollTop) el.scrollTop = child * 32;
                else if ((child + 1) * 32 > el.scrollTop + el.clientHeight) el.scrollTop = (child + 1) * 32 - el.clientHeight;
              }
            } else if (event.key === 'Enter' && event.target === search.current) {
              event.preventDefault(); if (activeEntry && !model.pending) void model.change(activeEntry);
            }
          }}
        >
          <div className="px-3 py-2 border-b" style={{ borderColor: theme.borderColor }}>
            <input ref={search} value={model.query} onChange={event => model.setQuery(event.target.value)}
              aria-label={t('terminal.directory.search')} aria-controls={`${id}-list`}
              aria-activedescendant={activeEntry ? `${id}-${active}` : undefined}
              placeholder={t('terminal.directory.search')}
              className="w-full bg-transparent text-xs outline-none placeholder:opacity-60"
              onCompositionStart={() => { composing.current = true; }}
              onCompositionEnd={() => { composing.current = false; }}
            />
          </div>
          <div role="listbox" aria-label={t('terminal.directory.directories')} id={`${id}-list`} aria-busy={model.loading}>
            {model.parent && row(t('terminal.directory.parent'), model.parent, 0, true)}
            <div ref={viewport} className="max-h-56 overflow-y-auto overscroll-contain" onScroll={event => setScrollTop(event.currentTarget.scrollTop)}>
              <div style={virtual ? { height: model.entries.length * 32, position: 'relative' } : undefined}>
                <div style={virtual ? { position: 'absolute', top: start * 32, left: 0, right: 0 } : undefined}>
                  {visible.map((entry, index) => row(entry.name, entry.path, start + index + Number(hasParent)))}
                </div>
              </div>
              {model.loading && <p className="px-3 py-4 text-xs" role="status">{t('terminal.directory.loading')}</p>}
              {!model.loading && !errorText && model.cwd && !model.entries.length && (
                <p className="px-3 py-4 text-xs" style={{ color: theme.mutedFg }}>{t(model.query ? 'terminal.directory.noMatches' : 'terminal.directory.empty')}</p>
              )}
            </div>
          </div>
          {(errorText || !model.available || !model.cwd) && <p className="px-3 py-2 text-xs" role="status">
            {errorText ?? t(model.available ? 'terminal.directory.unknown' : 'terminal.directory.unavailable')}
          </p>}
          <div className="flex items-center justify-between border-t px-3 py-2 text-[11px]" style={{ borderColor: theme.borderColor, color: theme.mutedFg }}>
            <label className="flex items-center gap-2"><input type="checkbox" checked={model.showHidden} onChange={event => model.setShowHidden(event.target.checked)} />{t('terminal.directory.hidden')}</label>
            <button type="button" disabled={model.loading || model.pending || !model.available}
              className="inline-flex items-center gap-1 rounded px-1 disabled:opacity-50"
              onClick={() => { if (model.cwd) void model.reload(); else void model.refresh(); }}>
              <RefreshCw size={11} />{t('terminal.directory.refresh')}
            </button>
          </div>
        </PopoverContent>
      </Popover>
      {!model.open && errorText && <span role="status" title={errorText} className="truncate text-[10px]" style={{ color: theme.mutedFg }}>{errorText}</span>}
    </div>
  );
}
