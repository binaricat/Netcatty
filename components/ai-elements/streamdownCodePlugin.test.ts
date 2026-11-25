import assert from 'node:assert/strict';
import test from 'node:test';
import type { BundledLanguage } from 'shiki';
import type { CodeHighlighterPlugin } from 'streamdown';

import {
  createFineGrainedShikiCodePlugin,
  streamdownCodePlugin,
} from './streamdownCodePlugin';

type HighlightResult = NonNullable<ReturnType<CodeHighlighterPlugin['highlight']>>;

test('streamdownCodePlugin exposes curated languages, aliases, and github themes only', () => {
  assert.deepEqual(streamdownCodePlugin.getThemes(), ['github-light', 'github-dark']);

  const supported = streamdownCodePlugin.getSupportedLanguages();
  assert.ok(supported.length >= 60 && supported.length <= 90, `expected curated language count, got ${supported.length}`);

  for (const lang of [
    'shellscript', 'bash', 'sh', 'zsh', 'shell', ' BASH ',
    'fish', 'powershell', 'ps1', 'bat', 'batch', 'cmd',
    'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'properties', 'conf', 'cfg', 'config', 'dotenv', 'xml', 'csv',
    'sql', 'plsql', 'graphql', 'gql',
    'javascript', 'js', 'typescript', 'ts', 'jsx', 'tsx', 'html', 'css', 'scss', 'less', 'vue', 'svelte',
    'python', 'py', 'go', 'rust', 'rs', 'java', 'kotlin', 'kt', 'c', 'cpp', 'c++', 'csharp', 'c#', 'cs',
    'swift', 'ruby', 'rb', 'php', 'perl', 'lua', 'r', 'dart', 'elixir', 'scala', 'haskell', 'hs',
    'docker', 'dockerfile', 'nginx', 'apache', 'hcl', 'terraform', 'tf', 'nix', 'cmake', 'make', 'makefile',
    'diff', 'patch', 'log', 'markdown', 'md', 'mdx', 'regexp', 'regex', 'ssh-config', 'systemd', 'awk',
    'groovy', 'proto', 'protobuf', 'prisma', 'solidity', 'zig', 'vim', 'viml', 'asm', 'http', 'jinja',
    'latex', 'kusto', 'kql', 'bicep', 'cue', 'just', 'kdl', 'ron', 'nushell', 'nu',
  ]) {
    assert.equal(
      streamdownCodePlugin.supportsLanguage(lang as BundledLanguage),
      true,
      `expected ${lang} to be supported`,
    );
  }

  for (const unsupported of ['text', 'plaintext', 'plain', '', 'emacs-lisp', 'wolfram', 'cobol']) {
    assert.equal(
      streamdownCodePlugin.supportsLanguage(unsupported as BundledLanguage),
      false,
      `expected ${unsupported} not to be supported`,
    );
  }
});

test('fine-grained shiki/core plugin highlights asynchronously, deduplicates in-flight calls, and caches results', async () => {
  const plugin = createFineGrainedShikiCodePlugin();
  const options = {
    code: 'echo "hello world"\nexport FOO=bar',
    language: 'bash' as BundledLanguage,
    themes: ['github-light', 'github-dark'] as ['github-light', 'github-dark'],
  };

  let cb1Result: HighlightResult | null = null;
  let cb2Result: HighlightResult | null = null;
  let resolveBoth!: () => void;
  const bothDone = new Promise<void>((resolve) => {
    resolveBoth = resolve;
  });
  let callCount = 0;
  const onResult = (assign: (result: HighlightResult) => void) => (result: HighlightResult) => {
    assign(result);
    callCount += 1;
    if (callCount === 2) resolveBoth();
  };

  // Both concurrent calls return null synchronously and share the same in-flight work.
  assert.equal(plugin.highlight(options, onResult((r) => { cb1Result = r; })), null);
  assert.equal(plugin.highlight(options, onResult((r) => { cb2Result = r; })), null);

  await bothDone;
  assert.ok(cb1Result);
  assert.equal(cb1Result, cb2Result, 'deduplicated subscribers must receive the same HighlightResult');
  assert.equal(cb1Result!.tokens.length, 2);
  assert.equal(
    cb1Result!.tokens.map((line) => line.map((token) => token.content).join('')).join('\n'),
    options.code,
  );

  // Subsequent identical calls hit the cache synchronously.
  const cached = plugin.highlight(options);
  assert.equal(cached, cb1Result);
});

test('streamdownCodePlugin falls back synchronously to plain tokens for unlisted languages and handles aliases', async () => {
  const plain = streamdownCodePlugin.highlight({
    code: '(defun hello () "world")\n',
    language: 'emacs-lisp' as BundledLanguage,
    themes: ['github-light', 'github-dark'],
  });
  assert.ok(plain, 'unlisted languages must return plain tokens synchronously');
  assert.deepEqual(
    plain.tokens.map((line) => line.map((token) => token.content).join('')),
    ['(defun hello () "world")'],
  );

  // Alias ("conf" -> "ini") and unknown theme name fallback must highlight without error.
  const highlighted = await new Promise<HighlightResult>((resolve) => {
    const syncResult = streamdownCodePlugin.highlight(
      {
        code: '[server]\nhost = 127.0.0.1',
        language: 'conf' as BundledLanguage,
        themes: ['unknown-light' as 'github-light', 'github-dark'],
      },
      resolve,
    );
    if (syncResult) resolve(syncResult);
  });
  assert.equal(highlighted.tokens.length, 2);
  assert.equal(
    highlighted.tokens.map((line) => line.map((token) => token.content).join('')).join('\n'),
    '[server]\nhost = 127.0.0.1',
  );
});
