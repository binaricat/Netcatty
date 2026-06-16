import React, { useEffect, useRef, useState } from 'react';

import { cn } from '../../lib/utils';

type SessionInlineRenameInputProps = {
  initialName: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
  className?: string;
  style?: React.CSSProperties;
};

export const SessionInlineRenameInput: React.FC<SessionInlineRenameInputProps> = ({
  initialName,
  onCommit,
  onCancel,
  className,
  style,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initialName);
  const committedRef = useRef(false);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  const commit = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    onCommit(value);
  };

  const cancel = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    onCancel();
  };

  return (
    <input
      ref={inputRef}
      data-session-inline-rename="true"
      value={value}
      draggable={false}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => {
        queueMicrotask(() => {
          commit();
        });
      }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onDragStart={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          cancel();
        }
      }}
      className={cn(
        'min-w-0 flex-1 truncate select-text rounded-sm border border-primary/50 bg-background/80 px-1 py-0 text-sm font-medium outline-none ring-1 ring-primary/30',
        className,
      )}
      style={style}
    />
  );
};
