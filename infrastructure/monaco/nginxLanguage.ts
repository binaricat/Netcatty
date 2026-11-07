import type { Monaco } from '@monaco-editor/react';
import type { languages } from 'monaco-editor';

// Original Monarch grammar for Netcatty (same license as the project).
// Syntax reference: https://nginx.org/en/docs/beginners_guide.html#conf_structure
// Recognize directive positions rather than maintaining a list of module names.
export const nginxLanguage: languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.nginx',
  tokenizer: {
    root: [
      { include: '@whitespace' },
      [/[{}]/, 'delimiter.curly'],
      [/;/, 'delimiter'],
      [/[^\s{};#"'\\$]+/, 'keyword', '@arguments'],
      { include: '@values' },
    ],
    arguments: [
      { include: '@whitespace' },
      [/[{}]/, 'delimiter.curly', '@pop'],
      [/;/, 'delimiter', '@pop'],
      { include: '@values' },
      [/[^\s{};#"'\\$]+/, ''],
    ],
    whitespace: [
      [/\s+/, ''],
      [/#.*$/, 'comment'],
    ],
    values: [
      [/\\./, 'string.escape'],
      [/\$(?:\{[\w]+\}|[\w]+)/, 'variable'],
      [/"/, 'string', '@doubleQuoted'],
      [/'/, 'string', '@singleQuoted'],
    ],
    doubleQuoted: [
      [/\\./, 'string.escape'],
      [/\$(?:\{[\w]+\}|[\w]+)/, 'variable'],
      [/"/, 'string', '@pop'],
      [/[^"\\$]+/, 'string'],
      [/\$/, 'string'],
    ],
    singleQuoted: [
      [/\\./, 'string.escape'],
      [/\$(?:\{[\w]+\}|[\w]+)/, 'variable'],
      [/'/, 'string', '@pop'],
      [/[^'\\$]+/, 'string'],
      [/\$/, 'string'],
    ],
  },
};

export const nginxLanguageConfiguration: languages.LanguageConfiguration = {
  comments: { lineComment: '#' },
  brackets: [['{', '}']],
};

const registeredInstances = new WeakSet<Monaco>();

/** Called before model creation, including when Monaco is loaded lazily. */
export function registerNginxLanguage(monaco: Monaco): void {
  if (registeredInstances.has(monaco)) return;
  monaco.languages.register({ id: 'nginx', aliases: ['Nginx', 'nginx'], filenames: ['nginx.conf'] });
  monaco.languages.setMonarchTokensProvider('nginx', nginxLanguage);
  monaco.languages.setLanguageConfiguration('nginx', nginxLanguageConfiguration);
  registeredInstances.add(monaco);
}
