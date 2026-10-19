import React from 'react';
import { Globe } from 'lucide-react';

export function BrowserIcon({ image, glyph, color, className = '' }: {
  image?: string | null; glyph?: string | null; color?: string | null; className?: string;
}) {
  return <span className={`inline-flex shrink-0 items-center justify-center overflow-hidden ${className}`}>
    {image ? <img src={image} alt="" className="h-full w-full rounded-[20%] object-contain" draggable={false} />
      : glyph ? <span className="truncate text-xs" style={{ color: color || undefined }}>{glyph}</span>
        : <Globe size={14} className="text-muted-foreground" />}
  </span>;
}
