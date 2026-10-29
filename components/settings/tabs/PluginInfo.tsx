import React, { useRef, useState } from 'react';
import { CircleAlert, Info } from 'lucide-react';
import { Button } from '../../ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../ui/tooltip';

/** Hover/focus previews explanatory text; click pins it in the existing accessible popover. */
export function PluginInfo({ label, children, badgeCount, previewContent, variant = 'info' }: { label: string; children: React.ReactNode; badgeCount?: number; previewContent?: React.ReactNode; variant?: 'info' | 'error' }) {
  const [pinned, setPinned] = useState(false);
  const [preview, setPreview] = useState(false);
  const suppressFocusPreview = useRef(false);
  return <Popover open={pinned} onOpenChange={(open) => { setPinned(open); setPreview(false); }}>
    <TooltipProvider delayDuration={200}>
      <Tooltip open={!pinned && preview} onOpenChange={(open) => { if (!open || !suppressFocusPreview.current) setPreview(open); }}>
        <TooltipTrigger asChild><PopoverTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className={`relative shrink-0 p-0 focus-visible:ring-2 focus-visible:ring-ring ${variant === 'error' ? 'h-6 w-6 text-red-600 hover:bg-red-500/10 hover:text-red-600 dark:text-red-400 dark:hover:text-red-400' : 'h-8 w-8 text-muted-foreground'}`} aria-label={label} onBlur={() => { suppressFocusPreview.current = false; }} onPointerMove={() => { suppressFocusPreview.current = false; }}>
            {variant === 'error' ? <CircleAlert size={15} /> : <Info size={15} />}{Boolean(badgeCount) && <span aria-hidden="true" className="absolute right-0 top-0 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-muted px-0.5 text-[9px] font-medium leading-none text-foreground">{badgeCount}</span>}
          </Button>
        </PopoverTrigger></TooltipTrigger>
        <TooltipContent className="max-h-64 max-w-xs space-y-2 overflow-y-auto break-words bg-popover p-3 text-xs leading-5 text-popover-foreground shadow-sm">{previewContent ?? children}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
    <PopoverContent onEscapeKeyDown={() => { suppressFocusPreview.current = true; }} aria-label={label} align="end" className="max-h-64 max-w-xs space-y-2 overflow-y-auto break-words text-xs leading-5">{children}</PopoverContent>
  </Popover>;
}
