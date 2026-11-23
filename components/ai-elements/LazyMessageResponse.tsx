import React, { lazy, Suspense, useEffect, useState } from 'react';

import { cn } from '../../lib/utils';
import {
  enqueueChatMarkdownHydrate,
  isAiMarkdownRendererReady,
  subscribeAiMarkdownRendererReady,
  warmAiMarkdownRenderer,
} from '../ai/aiMarkdownWarmup';
import { LazyLoadBoundary } from '../ui/lazy-load-boundary';

type LazyMessageResponseProps = {
  children?: React.ReactNode;
  className?: string;
  isAnimating?: boolean;
  /**
   * Optional opt-in to keep plaintext until Streamdown is already warmed.
   * Defaults to false so visible markdown renders immediately.
   */
  deferUntilWarm?: boolean;
};

const MessageResponse = lazy(() =>
  import('./messageResponse').then((module) => ({ default: module.MessageResponse })),
);

const PlainTextFallback = ({ children, className }: LazyMessageResponseProps) => (
  <div className={cn('size-full whitespace-pre-wrap break-words', className)}>
    {children}
  </div>
);

export function LazyMessageResponse(props: LazyMessageResponseProps) {
  const { deferUntilWarm = false, ...rendererProps } = props;
  const [ready, setReady] = useState(() => isAiMarkdownRendererReady());
  const resetKey = typeof rendererProps.children === 'string' ? rendererProps.children : undefined;

  useEffect(() => {
    if (ready) return undefined;
    if (!deferUntilWarm) {
      const unsubscribe = subscribeAiMarkdownRendererReady(() => setReady(true));
      if (!isAiMarkdownRendererReady()) {
        void warmAiMarkdownRenderer();
      }
      return unsubscribe;
    }
    return enqueueChatMarkdownHydrate(() => setReady(true));
  }, [deferUntilWarm, ready]);

  if (deferUntilWarm && !ready) {
    return <PlainTextFallback {...rendererProps} />;
  }

  return (
    <LazyLoadBoundary fallback={<PlainTextFallback {...rendererProps} />} resetKey={resetKey}>
      <Suspense fallback={<PlainTextFallback {...rendererProps} />}>
        <MessageResponse {...rendererProps} />
      </Suspense>
    </LazyLoadBoundary>
  );
}
