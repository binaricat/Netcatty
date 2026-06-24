import React from "react";
import { LazyMessageResponse } from "../ai-elements/LazyMessageResponse";

export function MarkdownPreview({
  content,
  emptyText,
}: {
  content: string;
  emptyText: string;
}) {
  const trimmed = content.trim();
  if (!trimmed) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {emptyText}
      </div>
    );
  }

  return (
    <LazyMessageResponse className="text-sm leading-relaxed text-foreground/90">
      {trimmed}
    </LazyMessageResponse>
  );
}
