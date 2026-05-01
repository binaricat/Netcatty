import { cn } from '../../lib/utils';
import { cjk } from '@streamdown/cjk';
import { code } from '@streamdown/code';
import type { ComponentProps, HTMLAttributes } from 'react';
import { memo } from 'react';
import { Streamdown } from 'streamdown';

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: 'user' | 'assistant' | 'system' | 'tool';
};

// Public CSS hooks for user customization (Settings → Appearance → Custom CSS):
//   .ai-chat-message[data-role="user"]      — outer row, user-authored
//   .ai-chat-message[data-role="assistant"] — outer row, assistant reply
//   .ai-chat-message-content[data-role=...] — inner bubble / content area
// These attributes are part of the UI's stable contract; do not rename
// without updating Custom CSS docs.
export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      'ai-chat-message group flex w-full max-w-[95%] flex-col gap-1.5',
      from === 'user' ? 'is-user ml-auto' : 'is-assistant',
      className,
    )}
    data-role={from}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement> & {
  from?: 'user' | 'assistant' | 'system' | 'tool';
};

export const MessageContent = ({ children, className, from, ...props }: MessageContentProps) => (
  <div
    className={cn(
      'ai-chat-message-content flex w-fit min-w-0 max-w-full flex-col gap-1.5 text-[13px] leading-relaxed',
      'group-[.is-user]:ml-auto group-[.is-user]:overflow-hidden group-[.is-user]:rounded-lg group-[.is-user]:border group-[.is-user]:border-border/50 group-[.is-user]:bg-muted/50 group-[.is-user]:px-2.5 group-[.is-user]:py-[7px]',
      'group-[.is-assistant]:w-full group-[.is-assistant]:text-foreground/90',
      className,
    )}
    data-role={from}
    {...props}
  >
    {children}
  </div>
);

export type MessageActionsProps = ComponentProps<'div'>;

export const MessageActions = ({ className, children, ...props }: MessageActionsProps) => (
  <div
    className={cn(
      'flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity',
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

const streamdownPlugins = { cjk, code };

export type MessageResponseProps = ComponentProps<typeof Streamdown>;

export const MessageResponse = memo(
  ({ className, ...props }: MessageResponseProps) => (
    <Streamdown
      className={cn(
        'size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
        // Style the rendered markdown
        // Code: base styles (code-block overrides are in index.css)
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
        className,
      )}
      plugins={streamdownPlugins}
      {...props}
    />
  ),
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children &&
    nextProps.isAnimating === prevProps.isAnimating,
);
MessageResponse.displayName = 'MessageResponse';
