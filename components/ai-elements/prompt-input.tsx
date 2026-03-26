/**
 * PromptInput - Adapted from Vercel AI Elements prompt-input for netcatty.
 *
 * Simplified: no file attachments, screenshots, drag-drop, command palette,
 * hover cards, referenced sources, or tabs. Core input + footer + submit.
 */

import { ArrowUp, Square, X } from 'lucide-react';
import type {
  ComponentProps,
  FormEvent,
  HTMLAttributes,
  KeyboardEvent,
  ReactNode,
} from 'react';
import { forwardRef, useCallback, useRef } from 'react';
import { cn } from '../../lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '../ui/input-group';
import { Spinner } from '../ui/spinner';

// ---------------------------------------------------------------------------
// PromptInput (form wrapper)
// ---------------------------------------------------------------------------

export interface PromptInputProps extends HTMLAttributes<HTMLFormElement> {
  onSubmit: (text: string, event: FormEvent<HTMLFormElement>) => void | Promise<void>;
}

export const PromptInput = forwardRef<HTMLFormElement, PromptInputProps>(
  ({ className, onSubmit, children, ...props }, ref) => {
    const handleSubmit = useCallback(
      (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const form = e.currentTarget;
        const textarea = form.querySelector('textarea');
        const text = textarea?.value?.trim() ?? '';
        if (!text) return;
        onSubmit(text, e);
      },
      [onSubmit],
    );

    return (
      <form ref={ref} onSubmit={handleSubmit} className={className} {...props}>
        <InputGroup>{children}</InputGroup>
      </form>
    );
  },
);
PromptInput.displayName = 'PromptInput';

// ---------------------------------------------------------------------------
// PromptInputTextarea
// ---------------------------------------------------------------------------

export interface PromptInputTextareaProps extends ComponentProps<'textarea'> {
  /** Called when Enter is pressed (without Shift) to trigger form submit */
  onSubmitRequest?: () => void;
}

export const PromptInputTextarea = forwardRef<HTMLTextAreaElement, PromptInputTextareaProps>(
  ({ className, onSubmitRequest, onKeyDown, ...props }, ref) => {
    const internalRef = useRef<HTMLTextAreaElement | null>(null);

    const setRef = useCallback(
      (node: HTMLTextAreaElement | null) => {
        internalRef.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
      },
      [ref],
    );

    const handleKeyDown = useCallback(
      (e: KeyboardEvent<HTMLTextAreaElement>) => {
        onKeyDown?.(e);
        if (e.defaultPrevented) return;

        // CJK composition guard
        if (e.nativeEvent.isComposing) return;

        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          onSubmitRequest?.();
          // Trigger form submit
          const form = internalRef.current?.closest('form');
          if (form) {
            form.requestSubmit();
          }
        }
      },
      [onKeyDown, onSubmitRequest],
    );

    return (
      <InputGroupTextarea
        ref={setRef}
        className={className}
        onKeyDown={handleKeyDown}
        {...props}
      />
    );
  },
);
PromptInputTextarea.displayName = 'PromptInputTextarea';

// ---------------------------------------------------------------------------
// PromptInputFooter
// ---------------------------------------------------------------------------

export type PromptInputFooterProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputFooter = forwardRef<HTMLDivElement, PromptInputFooterProps>(
  ({ className, ...props }, ref) => (
    <InputGroupAddon
      ref={ref}
      align="block-end"
      className={cn('gap-1', className)}
      {...props}
    />
  ),
);
PromptInputFooter.displayName = 'PromptInputFooter';

// ---------------------------------------------------------------------------
// PromptInputTools (left side of footer)
// ---------------------------------------------------------------------------

export type PromptInputToolsProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputTools = forwardRef<HTMLDivElement, PromptInputToolsProps>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('flex items-center gap-0.5', className)}
      {...props}
    />
  ),
);
PromptInputTools.displayName = 'PromptInputTools';

// ---------------------------------------------------------------------------
// PromptInputButton (toolbar button with optional tooltip)
// ---------------------------------------------------------------------------

export interface PromptInputButtonProps extends ComponentProps<typeof InputGroupButton> {
  tooltip?: ReactNode;
  tooltipSide?: 'top' | 'bottom' | 'left' | 'right';
}

export const PromptInputButton = forwardRef<HTMLButtonElement, PromptInputButtonProps>(
  ({ tooltip, tooltipSide = 'top', ...props }, ref) => {
    const button = <InputGroupButton ref={ref} {...props} />;

    if (!tooltip) return button;

    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent side={tooltipSide}>{tooltip}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  },
);
PromptInputButton.displayName = 'PromptInputButton';

// ---------------------------------------------------------------------------
// PromptInputSubmit
// ---------------------------------------------------------------------------

export type PromptInputStatus = 'idle' | 'submitted' | 'streaming' | 'error';

export interface PromptInputSubmitProps extends ComponentProps<typeof InputGroupButton> {
  status?: PromptInputStatus;
  onStop?: () => void;
}

export const PromptInputSubmit = forwardRef<HTMLButtonElement, PromptInputSubmitProps>(
  ({ status = 'idle', onStop, className, disabled, ...props }, ref) => {
    const isRunning = status === 'submitted' || status === 'streaming';

    const handleClick = useCallback(() => {
      if (isRunning && onStop) {
        onStop();
      }
    }, [isRunning, onStop]);

    const icon =
      status === 'submitted' ? (
        <Spinner size={14} />
      ) : status === 'streaming' ? (
        <Square size={14} />
      ) : status === 'error' ? (
        <X size={14} />
      ) : (
        <ArrowUp size={14} />
      );

    const tooltipLabel =
      status === 'submitted'
        ? 'Waiting...'
        : status === 'streaming'
          ? 'Stop'
          : status === 'error'
            ? 'Error'
            : 'Send';

    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <InputGroupButton
              ref={ref}
              type={isRunning ? 'button' : 'submit'}
              onClick={isRunning ? handleClick : undefined}
              variant="ghost"
              disabled={disabled && !isRunning}
              className={cn(
                'h-8 w-8 rounded-full border p-0 shadow-sm disabled:opacity-100',
                isRunning
                  ? 'border-destructive/60 bg-destructive/85 text-destructive-foreground hover:bg-destructive'
                  : disabled
                    ? 'border-border/80 bg-muted/52 text-foreground/72 hover:bg-muted/52'
                    : 'border-foreground/20 bg-foreground text-background hover:bg-foreground/90',
                className,
              )}
              {...props}
            >
              {icon}
            </InputGroupButton>
          </TooltipTrigger>
          <TooltipContent side="top">{tooltipLabel}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  },
);
PromptInputSubmit.displayName = 'PromptInputSubmit';

