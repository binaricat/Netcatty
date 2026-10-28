import React, { useMemo } from 'react';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { RootContent, Root } from 'mdast';

function renderNode(node: Root | RootContent, key: number, images: Record<string, string>, depth = 0): React.ReactNode {
  if (depth > 24) return null;
  const children = 'children' in node ? node.children.map((child, index) => renderNode(child as RootContent, index, images, depth + 1)) : null;
  switch (node.type) {
    case 'root': return <React.Fragment key={key}>{children}</React.Fragment>;
    case 'heading': return <h4 key={key} className="mt-5 font-semibold">{children}</h4>;
    case 'paragraph': return <p key={key} className="my-2 leading-relaxed">{children}</p>;
    case 'text': return node.value;
    case 'strong': return <strong key={key}>{children}</strong>;
    case 'emphasis': return <em key={key}>{children}</em>;
    case 'inlineCode': return <code key={key} className="rounded bg-muted px-1">{node.value}</code>;
    case 'code': return <pre key={key} className="my-3 overflow-auto rounded-lg bg-muted p-3 text-xs"><code>{node.value}</code></pre>;
    case 'list': return <ul key={key} className="my-2 list-disc pl-5">{children}</ul>;
    case 'listItem': return <li key={key}>{children}</li>;
    case 'blockquote': return <blockquote key={key} className="border-l-2 pl-3 text-muted-foreground">{children}</blockquote>;
    case 'break': return <br key={key} />;
    case 'thematicBreak': return <hr key={key} />;
    case 'link': {
      let safe = false;
      try { const url = new URL(node.url); safe = url.protocol === 'https:' && !url.username && !url.password; } catch { /* relative and unsafe links stay text */ }
      return safe ? <a key={key} href={node.url} target="_blank" rel="noopener noreferrer" className="underline">{children}</a> : <span key={key}>{children}</span>;
    }
    case 'image': {
      const src = Object.hasOwn(images, node.url) ? images[node.url] : undefined;
      return src && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(src)
        ? <img key={key} src={src} alt={node.alt ?? ''} className="my-2 max-w-full" />
        : <span key={key} className="text-muted-foreground">[{node.alt ?? 'image'}]</span>;
    }
    case 'imageReference': return <span key={key} className="text-muted-foreground">[{node.alt ?? 'image'}]</span>;
    case 'html': return <span key={key}>{node.value}</span>;
    default: return <React.Fragment key={key}>{children}</React.Fragment>;
  }
}

export function PluginReadme({ markdown, images = {} }: { markdown: string; images?: Record<string, string> }) {
  const tree = useMemo(() => fromMarkdown(markdown.slice(0, 256 * 1024)), [markdown]);
  return <div className="break-words text-sm">{renderNode(tree, 0, images)}</div>;
}
