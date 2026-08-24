import { cjk } from '@streamdown/cjk';
import type { ComponentProps } from 'react';
import { memo, useEffect, useMemo, useState } from 'react';
import { Streamdown } from 'streamdown';

import { scheduleWhenAiComposerIdle } from '../ai/aiMarkdownWarmup';
import { cn } from '../../lib/utils';
import { hasMarkdownCodeFence } from './hasMarkdownCodeFence';
import {
  getCachedStreamdownCodePlugin,
  warmAiCodeHighlighter,
} from './streamdownCodeWarmup';

const STREAMDOWN_CLASS = [
  'size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
  '[&_code]:text-[12px] [&_code]:font-mono',
  '[&_p_code]:px-[0.4em] [&_p_code]:py-[0.15em] [&_p_code]:rounded [&_p_code]:bg-foreground/[0.06] [&_p_code]:text-[85%] [&_p_code]:whitespace-normal [&_p_code]:[overflow-wrap:anywhere]',
  '[&_p]:my-1.5',
  '[&_ul]:my-1.5 [&_ul]:pl-4 [&_ul]:list-disc',
  '[&_ol]:my-1.5 [&_ol]:pl-4 [&_ol]:list-decimal',
  '[&_li]:my-0.5',
  '[&_h1]:text-base [&_h1]:font-semibold [&_h1]:mt-4 [&_h1]:mb-2',
  '[&_h2]:text-sm [&_h2]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1.5',
  '[&_h3]:text-sm [&_h3]:font-medium [&_h3]:mt-2 [&_h3]:mb-1',
  '[&_blockquote]:border-l-2 [&_blockquote]:border-border/50 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground',
  '[&_a]:text-primary [&_a]:underline',
  '[&_hr]:border-border/30 [&_hr]:my-3',
  '[&_table]:text-[12px] [&_th]:px-2 [&_th]:py-1 [&_th]:border [&_th]:border-border/30 [&_th]:bg-muted/20 [&_td]:px-2 [&_td]:py-1 [&_td]:border [&_td]:border-border/30',
].join(' ');

export type MessageResponseProps = ComponentProps<typeof Streamdown>;

function MessageResponseView({ className, children, ...props }: MessageResponseProps) {
  const [codePlugin, setCodePlugin] = useState(getCachedStreamdownCodePlugin);
  const source = typeof children === 'string' ? children : '';
  const wantsCode = hasMarkdownCodeFence(source);

  useEffect(() => {
    if (!wantsCode || codePlugin) return undefined;
    let cancelled = false;
    const cancelIdle = scheduleWhenAiComposerIdle(() => {
      void warmAiCodeHighlighter().then((plugin) => {
        if (!cancelled) setCodePlugin(plugin);
      });
    });
    return () => {
      cancelled = true;
      cancelIdle();
    };
  }, [codePlugin, wantsCode]);

  const plugins = useMemo(
    () => (codePlugin ? { cjk, code: codePlugin } : { cjk }),
    [codePlugin],
  );

  return (
    <Streamdown
      className={cn(STREAMDOWN_CLASS, className)}
      plugins={plugins}
      {...props}
    >
      {children}
    </Streamdown>
  );
}

/** Streamdown + CJK only. Shiki loads later when a fence exists and the composer is idle. */
export const MessageResponse = memo(
  MessageResponseView,
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children &&
    nextProps.isAnimating === prevProps.isAnimating,
);
MessageResponse.displayName = 'MessageResponse';
