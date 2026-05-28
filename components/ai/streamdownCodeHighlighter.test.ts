import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  CodeHighlighterPlugin,
  HighlightOptions,
} from 'streamdown';
import {
  createPlainCodeHighlightResult,
  createSafeCodeHighlighter,
  resolveSupportedCodeLanguage,
} from '../ai-elements/streamdownCodeHighlighter';

type HighlightResult = NonNullable<ReturnType<CodeHighlighterPlugin['highlight']>>;

const createFakeHighlighter = (
  supportedLanguages: string[],
  highlightImpl?: CodeHighlighterPlugin['highlight'],
): CodeHighlighterPlugin => ({
  name: 'shiki',
  type: 'code-highlighter',
  getSupportedLanguages: () => supportedLanguages as ReturnType<CodeHighlighterPlugin['getSupportedLanguages']>,
  getThemes: () => ['github-light', 'github-dark'],
  supportsLanguage: (language) => supportedLanguages.includes(language),
  highlight: highlightImpl ?? ((options: HighlightOptions): HighlightResult => ({
    tokens: [[{ content: options.language, offset: 0 }]],
  })),
});

test('maps generic conf fences to ini for Streamdown highlighting', () => {
  const highlighter = createFakeHighlighter(['ini']);

  assert.equal(resolveSupportedCodeLanguage(highlighter, 'conf'), 'ini');
  assert.equal(resolveSupportedCodeLanguage(highlighter, ' config '), 'ini');
});

test('falls back to plain tokens for unsupported languages', () => {
  const highlighter = createSafeCodeHighlighter(
    createFakeHighlighter([], () => {
      throw new Error('delegate should not be called for unsupported languages');
    }),
  );

  const result = highlighter.highlight({
    code: '*.* action(type="omfwd"\n           Target="10.185.3.1")\n',
    language: 'conf',
    themes: ['github-light', 'github-dark'],
  });

  assert.deepEqual(
    result?.tokens.map((line) => line.map((token) => token.content).join('')),
    ['*.* action(type="omfwd"', '           Target="10.185.3.1")'],
  );
});

test('uses supported aliases when highlighting generic config blocks', () => {
  let receivedLanguage: string | null = null;
  const highlighter = createSafeCodeHighlighter(
    createFakeHighlighter(['ini'], (options: HighlightOptions): HighlightResult => {
      receivedLanguage = options.language;
      return createPlainCodeHighlightResult(options.code);
    }),
  );

  const result = highlighter.highlight({
    code: '*.* action(type="omfwd")',
    language: 'conf',
    themes: ['github-light', 'github-dark'],
  });

  assert.equal(receivedLanguage, 'ini');
  assert.equal(result?.tokens[0][0].content, '*.* action(type="omfwd")');
});

test('treats text fences as plain code without calling the delegate', () => {
  const highlighter = createSafeCodeHighlighter(
    createFakeHighlighter(['ini'], () => {
      throw new Error('delegate should not be called for text fences');
    }),
  );

  const result = highlighter.highlight({
    code: 'hello\nworld',
    language: 'text',
    themes: ['github-light', 'github-dark'],
  });

  assert.deepEqual(
    result?.tokens.map((line) => line[0].content),
    ['hello', 'world'],
  );
});
