import { cn } from '../../lib/utils';
import type { HTMLAttributes } from 'react';

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
      'group-[.is-user]:ml-auto group-[.is-user]:overflow-hidden group-[.is-user]:rounded-lg group-[.is-user]:border group-[.is-user]:border-primary/25 group-[.is-user]:bg-primary/12 group-[.is-user]:text-foreground [.dark_&]:group-[.is-user]:border-primary/30 [.dark_&]:group-[.is-user]:bg-primary/18 group-[.is-user]:px-2.5 group-[.is-user]:py-[7px]',
      'group-[.is-assistant]:w-full group-[.is-assistant]:text-foreground/90',
      className,
    )}
    data-role={from}
    {...props}
  >
    {children}
  </div>
);
