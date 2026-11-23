import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('./TerminalLayer.tsx', import.meta.url),
  'utf8',
);
const terminalHostSource = readFileSync(
  new URL('../application/app/hosts/TerminalHost.tsx', import.meta.url),
  'utf8',
);

test('terminal output fans out to both coding-CLI and prompt-host handlers', () => {
  assert.match(source, /createPromptHostnameSessionSignalController/);
  assert.match(source, /codingCliSignalController\.handleTerminalOutput/);
  assert.match(source, /promptHostnameSignalController\.handleTerminalOutput/);
});

test('session publisher exposes prompt-host updates to the terminal props', () => {
  assert.match(
    terminalHostSource,
    /updateSessionPromptHost:\s*sessionActions\?\.updateSessionPromptHost/,
  );
});
