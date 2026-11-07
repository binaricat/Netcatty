import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import type { Monaco } from '@monaco-editor/react';
import { nginxLanguage, nginxLanguageConfiguration, registerNginxLanguage } from './nginxLanguage';

const require = createRequire(import.meta.url);
const { compile } = require('monaco-editor/esm/vs/editor/standalone/common/monarch/monarchCompile.js');
const { MonarchTokenizer } = require('monaco-editor/esm/vs/editor/standalone/common/monarch/monarchLexer.js');

// Exercise Monaco's real Monarch engine rather than approximating its regex/state rules.
function tokenize(content: string) {
  const tokenizer = new MonarchTokenizer({}, {}, 'nginx', compile('nginx', nginxLanguage), {
    getValue: () => 20000,
    onDidChangeConfiguration: () => ({ dispose() {} }),
  });
  let state = tokenizer.getInitialState();
  try {
    return content.split('\n').map((line) => {
      const result = tokenizer.tokenize(line, true, state);
      state = result.endState;
      return result.tokens.map((token: { offset: number; type: string }, index: number) => ({
        text: line.slice(token.offset, result.tokens[index + 1]?.offset ?? line.length),
        type: token.type,
      }));
    });
  } finally {
    tokenizer.dispose();
  }
}

test('highlights directives, block structure, comments, strings and variables', () => {
  const tokens = tokenize(`upstream backend { server 127.0.0.1:8080; }
server {
  # location ignored;
  location / { proxy_pass http://backend/$uri; }
  set $message "hello \${host} #still string";
  add_header X-Value 'literal; { # text }';
}`).flat();
  for (const directive of ['upstream', 'server', 'location', 'proxy_pass', 'set', 'add_header']) {
    assert.ok(tokens.some(({ text, type }) => text === directive && type === 'keyword.nginx'), directive);
  }
  for (const variable of ['$uri', '$message', '${host}']) {
    assert.ok(tokens.some(({ text, type }) => text === variable && type === 'variable.nginx'), variable);
  }
  assert.ok(tokens.some(({ text, type }) => text === '# location ignored;' && type === 'comment.nginx'));
  assert.ok(tokens.some(({ text, type }) => text.includes('#still string') && type === 'string.nginx'));
  assert.ok(tokens.some(({ text, type }) => text.includes('literal; { # text }') && type === 'string.nginx'));
  assert.ok(tokens.some(({ text, type }) => text === '{' && type === 'delimiter.curly.nginx'));
  assert.ok(tokens.some(({ text, type }) => text === ';' && type === 'delimiter.nginx'));
});

test('retains argument and quote states across lines and respects escapes', () => {
  const lines = tokenize(String.raw`proxy_set_header
  Host $host; custom_module_directive on;
set $message "first
  second \" #literal"; # comment
set $escaped value\#literal;`);
  assert.ok(lines[1].some(({ text, type }) => text === 'custom_module_directive' && type === 'keyword.nginx'));
  assert.ok(lines[1].every(({ text, type }) => text !== 'Host' || type !== 'keyword.nginx'));
  assert.ok(lines[3].some(({ text, type }) => text.includes('#literal') && type === 'string.nginx'));
  assert.ok(lines[3].some(({ text, type }) => text === '# comment' && type === 'comment.nginx'));
  assert.ok(lines[4].some(({ text, type }) => text === '\\#' && type === 'string.escape.nginx'));
});

test('registers once per Monaco instance and exposes only highlighting/configuration', () => {
  const calls: string[] = [];
  const createMonaco = () => ({ languages: {
    register: ({ id }: { id: string }) => calls.push(id),
    setMonarchTokensProvider: (id: string, grammar: unknown) => {
      assert.equal(grammar, nginxLanguage);
      calls.push(`${id}:tokens`);
    },
    setLanguageConfiguration: (id: string, configuration: unknown) => {
      assert.equal(configuration, nginxLanguageConfiguration);
      calls.push(`${id}:configuration`);
    },
  } }) as unknown as Monaco;
  const first = createMonaco();
  registerNginxLanguage(first);
  registerNginxLanguage(first);
  registerNginxLanguage(createMonaco());
  assert.deepEqual(calls, ['nginx', 'nginx:tokens', 'nginx:configuration', 'nginx', 'nginx:tokens', 'nginx:configuration']);
});
