import * as React from "react";
import { cn } from "@/lib/utils.ts";

export interface CodeTextareaProps
  extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "spellCheck"> {
  showLineNumbers?: boolean;
}

function countLines(value: string): number {
  if (!value) return 1;
  return value.split("\n").length;
}

const CodeTextarea = React.forwardRef<HTMLTextAreaElement, CodeTextareaProps>(
  ({ className, value, showLineNumbers = true, onScroll, ...props }, ref) => {
    const gutterRef = React.useRef<HTMLDivElement>(null);
    const text = typeof value === "string" ? value : String(value ?? "");
    const lineCount = countLines(text);
    const lineNumbers = React.useMemo(
      () => Array.from({ length: lineCount }, (_, i) => i + 1),
      [lineCount],
    );
    const gutterWidthCh = Math.max(2, String(lineCount).length) + 1;

    const handleScroll = (e: React.UIEvent<HTMLTextAreaElement>) => {
      if (gutterRef.current) {
        gutterRef.current.scrollTop = e.currentTarget.scrollTop;
      }
      onScroll?.(e);
    };

    const editorClass = cn(
      "w-full flex-1 resize-none border-0 bg-transparent px-2 py-2 font-mono text-xs leading-5",
      "placeholder:text-muted-foreground focus-visible:outline-none",
      "whitespace-pre overflow-auto",
      className,
    );

    if (!showLineNumbers) {
      return (
        <textarea
          ref={ref}
          value={value}
          className={cn(
            "flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs leading-5",
            "placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
            "whitespace-pre",
            className,
          )}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          data-gramm="false"
          onScroll={onScroll}
          {...props}
        />
      );
    }

    return (
      <div
        className={cn(
          "flex w-full overflow-hidden rounded-md border border-input bg-background",
          "focus-within:ring-1 focus-within:ring-ring",
        )}
      >
        <div
          ref={gutterRef}
          aria-hidden
          className="shrink-0 overflow-hidden border-r border-border/60 bg-muted/30 py-2 pl-2 pr-1.5 select-none"
          style={{ width: `${gutterWidthCh}ch` }}
        >
          <pre className="font-mono text-[11px] leading-5 text-muted-foreground text-right m-0">
            {lineNumbers.join("\n")}
          </pre>
        </div>
        <textarea
          ref={ref}
          value={value}
          className={editorClass}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          data-gramm="false"
          onScroll={handleScroll}
          {...props}
        />
      </div>
    );
  },
);
CodeTextarea.displayName = "CodeTextarea";

export { CodeTextarea };
