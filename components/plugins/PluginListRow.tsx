import React from 'react';
import { ChevronRight } from 'lucide-react';
import { PluginBrandIcon } from './PluginBrandIcon';

/** Shared installed-plugin composition; navigation never wraps the quick actions. */
export function PluginListRow({ plugin, name, description, metadata, actions, openLabel, onOpen }: {
  plugin: NetcattyInstalledPlugin;
  name: string;
  description: string;
  metadata?: React.ReactNode;
  actions: React.ReactNode;
  openLabel?: string;
  onOpen?: () => void;
}) {
  const heading = <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
    <span className="min-w-0 max-w-full text-sm font-medium leading-5 [overflow-wrap:anywhere]">{name}</span>
    {plugin.activeVersion && <span className="inline-flex max-w-full items-center rounded-full border-0 bg-muted/60 px-2 py-0 text-[11px] font-normal leading-5 text-muted-foreground hover:bg-muted/60 [overflow-wrap:anywhere]" data-plugin-row-tag>{plugin.activeVersion}</span>}
  </span>;
  return <article aria-label={name} data-plugin-row={plugin.id} className="grid min-w-0 grid-cols-[3rem_minmax(0,1fr)_auto] items-start gap-x-3 rounded-lg py-4 sm:gap-x-4">
    <div data-plugin-icon-slot className="flex h-12 w-12 shrink-0 items-center justify-center text-muted-foreground"><PluginBrandIcon plugin={plugin} size={32} /></div>
    <div className="min-w-0 space-y-1.5">
      {onOpen ? <button type="button" data-plugin-card={plugin.id} aria-label={openLabel} aria-expanded={false} onClick={onOpen}
        className="group block w-full min-w-0 rounded-md text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
        <span className="flex min-w-0 items-center gap-2"><span className="min-w-0 flex-1">{heading}</span><ChevronRight size={14} className="shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" aria-hidden="true" /></span>
        <span className="mt-1 block line-clamp-2 text-sm leading-5 text-muted-foreground [overflow-wrap:anywhere]" title={description}>{description}</span>
      </button> : <div>{heading}<p className="mt-1 line-clamp-2 text-sm leading-5 text-muted-foreground [overflow-wrap:anywhere]" title={description}>{description}</p></div>}
      {metadata && <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs leading-5 text-muted-foreground [&>*]:min-w-0 [&>*]:max-w-full [overflow-wrap:anywhere]">{metadata}</div>}
    </div>
    <div className="flex min-h-12 shrink-0 items-center justify-end gap-2 self-center" data-plugin-row-actions>{actions}</div>
  </article>;
}
