import type { CodeHighlighterPlugin } from 'streamdown';

let cachedCodePlugin: CodeHighlighterPlugin | null = null;
let codePluginPromise: Promise<CodeHighlighterPlugin> | null = null;

export function getCachedStreamdownCodePlugin(): CodeHighlighterPlugin | null {
  return cachedCodePlugin;
}

export function isAiCodeHighlighterReady(): boolean {
  return cachedCodePlugin != null;
}

/** Prefetch Shiki only when a message actually contains a code fence. */
export function warmAiCodeHighlighter(): Promise<CodeHighlighterPlugin> {
  codePluginPromise ??= import('./streamdownCodePlugin').then((module) => {
    cachedCodePlugin = module.streamdownCodePlugin;
    return module.streamdownCodePlugin;
  }, (error) => {
    codePluginPromise = null;
    throw error;
  });
  return codePluginPromise;
}
