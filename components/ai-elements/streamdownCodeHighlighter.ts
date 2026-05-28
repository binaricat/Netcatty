import type {
  CodeHighlighterPlugin,
  HighlightOptions,
} from 'streamdown';
import type { BundledLanguage } from 'shiki';

type HighlightResult = NonNullable<ReturnType<CodeHighlighterPlugin['highlight']>>;

const PLAIN_TEXT_LANGUAGES = new Set([
  '',
  'plain',
  'plaintext',
  'text',
  'txt',
]);

const LANGUAGE_ALIASES: Record<string, BundledLanguage> = {
  cfg: 'ini',
  conf: 'ini',
  config: 'ini',
};

export const createPlainCodeHighlightResult = (source: string): HighlightResult => {
  const code = source.replace(/\n+$/, '');
  return {
    bg: 'transparent',
    fg: 'inherit',
    tokens: code.split('\n').map((line) => [
      {
        content: line,
        color: 'inherit',
        bgColor: 'transparent',
        htmlStyle: {},
        offset: 0,
      },
    ]),
  };
};

const normalizeLanguageKey = (language: string): string =>
  language.trim().toLowerCase();

export const resolveSupportedCodeLanguage = (
  highlighter: CodeHighlighterPlugin,
  language: string,
): BundledLanguage | null => {
  const key = normalizeLanguageKey(language);
  if (PLAIN_TEXT_LANGUAGES.has(key)) return null;

  const direct = key as BundledLanguage;
  if (highlighter.supportsLanguage(direct)) return direct;

  const alias = LANGUAGE_ALIASES[key];
  if (alias && highlighter.supportsLanguage(alias)) return alias;

  return null;
};

export const createSafeCodeHighlighter = (
  highlighter: CodeHighlighterPlugin,
): CodeHighlighterPlugin => ({
  ...highlighter,
  supportsLanguage(language) {
    return resolveSupportedCodeLanguage(highlighter, language) !== null;
  },
  highlight(options: HighlightOptions, callback?: (result: HighlightResult) => void) {
    const supportedLanguage = resolveSupportedCodeLanguage(highlighter, options.language);
    if (!supportedLanguage) {
      return createPlainCodeHighlightResult(options.code);
    }

    return highlighter.highlight(
      { ...options, language: supportedLanguage },
      callback,
    );
  },
});
