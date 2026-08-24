import { code } from '@streamdown/code';

import { createSafeCodeHighlighter } from './streamdownCodeHighlighter';

/** Isolated Shiki entry — import this file only through warmAiCodeHighlighter. */
export const streamdownCodePlugin = createSafeCodeHighlighter(code);
