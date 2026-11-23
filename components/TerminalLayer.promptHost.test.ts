import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('./TerminalLayer.tsx', import.meta.url),
  'utf8',
);

test('terminal output fans out to both coding-CLI and prompt-host handlers', () => {
  assert.match(source, /createPromptHostnameSessionSignalController/);
  assert.match(source, /codingCliSignalController\.handleTerminalOutput/);
  assert.match(source, /promptHostnameSignalController\.handleTerminalOutput/);
});
