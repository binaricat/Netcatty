import React, { useEffect, useRef, useState } from "react";

import { cn } from "../../lib/utils";

type DataAttributes = {
  [K in `data-${string}`]?: string | boolean | undefined;
};

export type InlineRenameInputProps = DataAttributes & {
  initialName: string;
  onCommit: (name: string) => boolean | void | Promise<boolean | void>;
  onCancel: () => void;
  className?: string;
  style?: React.CSSProperties;
};

export const InlineRenameInput: React.FC<InlineRenameInputProps> = ({
  initialName,
  onCommit,
  onCancel,
  className,
  style,
  ...dataProps
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initialName);
  const submittingRef = useRef(false);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  const commit = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    try {
      const committed = await onCommit(value);
      if (committed === false) submittingRef.current = false;
    } catch {
      submittingRef.current = false;
    }
  };

  const cancel = () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    onCancel();
  };

  return (
    <input
      ref={inputRef}
      {...dataProps}
      value={value}
      draggable={false}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => {
        queueMicrotask(() => {
          void commit();
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
        if (event.key === "Enter") {
          event.preventDefault();
          void commit();
        }
        if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        }
      }}
      className={cn(
        "min-w-0 flex-1 truncate select-text rounded-sm border border-primary/50 bg-background/80 px-1 py-0 text-sm font-medium outline-none ring-1 ring-primary/30",
        className,
      )}
      style={style}
    />
  );
};
