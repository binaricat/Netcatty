import { cn } from '../../lib/utils';

export function sidePanelHiddenPanelClassName(hidden: boolean): string {
  return cn(
    'absolute inset-0 z-10',
    hidden && 'hidden [content-visibility:hidden] [contain:strict]',
  );
}

export function sidePanelHiddenNotesPanelClassName(hidden: boolean): string {
  return cn(
    'absolute inset-0 z-20 bg-background text-foreground',
    hidden && 'hidden [content-visibility:hidden] [contain:strict]',
  );
}
