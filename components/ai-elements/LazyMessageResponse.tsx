import React, { lazy, Suspense } from 'react';

import { cn } from '../../lib/utils';
import { LazyLoadBoundary } from '../ui/lazy-load-boundary';

type LazyMessageResponseProps = {
  children?: React.ReactNode;
  className?: string;
  isAnimating?: boolean;
};

const MessageResponse = lazy(() =>
  import('./message').then((module) => ({ default: module.MessageResponse })),
);

const PlainTextFallback = ({ children, className }: LazyMessageResponseProps) => (
  <div className={cn('size-full whitespace-pre-wrap break-words', className)}>
    {children}
  </div>
);

export function LazyMessageResponse(props: LazyMessageResponseProps) {
  const resetKey = typeof props.children === 'string' ? props.children : undefined;
  return (
    <LazyLoadBoundary fallback={<PlainTextFallback {...props} />} resetKey={resetKey}>
      <Suspense fallback={<PlainTextFallback {...props} />}>
        <MessageResponse {...props} />
      </Suspense>
    </LazyLoadBoundary>
  );
}
