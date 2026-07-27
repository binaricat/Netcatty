import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCodingCliOutputScanner,
  inferCodingCliProviderFromOutput,
  stripTerminalControlSequences,
} from './codingCliOutputDetect';

test('inferCodingCliProviderFromOutput detects Codex startup banner', () => {
  assert.equal(
    inferCodingCliProviderFromOutput('>_ OpenAI Codex (v0.141.0)\r\nmodel: gpt-5.5'),
    'codex',
  );
  assert.equal(
    inferCodingCliProviderFromOutput('OpenAI Codex (v0.141.0)'),
    'codex',
  );
});

test('inferCodingCliProviderFromOutput detects other CLI banners', () => {
  assert.equal(inferCodingCliProviderFromOutput('Welcome to Claude Code'), 'claude');
  assert.equal(inferCodingCliProviderFromOutput('GitHub Copilot CLI'), 'copilot');
  assert.equal(inferCodingCliProviderFromOutput('Factory Droid ready'), 'droid');
  assert.equal(
    inferCodingCliProviderFromOutput(
      '█▀▀█ █▀▀█ █▀▀█ █▀▀▄ █▀▀▀ █▀▀█ █▀▀█ █▀▀█\n'
      + '█  █ █  █ █▀▀▀ █  █ █    █  █ █  █ █▀▀▀\n'
      + '▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀  ▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀',
    ),
    'opencode',
  );
});

test('inferCodingCliProviderFromOutput ignores coding CLI installer and package output', () => {
  assert.equal(
    inferCodingCliProviderFromOutput('Setting up Claude Code...\n✅ Installation complete!'),
    undefined,
  );
  assert.equal(
    inferCodingCliProviderFromOutput(
      'npm update codex\nchanged 3 packages in 2s\nopencode@1.2.3\n├── opencode@1.2.3',
    ),
    undefined,
  );
  assert.equal(
    inferCodingCliProviderFromOutput(
      '\x1b[90mOpenCode includes free models, to start:\x1b[0m\n'
      + 'cd <project>  # Open directory\n'
      + 'opencode      # Run command\n'
      + 'For more information visit https://opencode.ai/docs',
    ),
    undefined,
  );
  assert.equal(
    inferCodingCliProviderFromOutput('updated opencode-ai@1.2.3'),
    undefined,
  );
});

test('createCodingCliOutputScanner ignores split installer output', () => {
  const scanner = createCodingCliOutputScanner();
  assert.equal(scanner.feed('\x1b[90mSetting up Claude '), undefined);
  assert.equal(scanner.feed('Code...\x1b[0m\n✅ Installation complete!'), undefined);
  assert.equal(
    scanner.feed(
      '\n\x1b[90m█▀▀█ █▀▀█ █▀▀█ █▀▀▄ \x1b[0m█▀▀▀ █▀▀█ █▀▀█ █▀▀█\n'
      + '\x1b[90m█░░█ █░░█ █▀▀▀ █░░█ \x1b[0m█░░░ █░░█ █░░█ █▀▀▀\n',
    ),
    undefined,
  );
  assert.equal(
    scanner.feed(
      '\x1b[90m▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀  ▀ \x1b[0m▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀\n'
      + '\x1b[90mOpenCode includes free models, ',
    ),
    undefined,
  );
  assert.equal(scanner.feed('to start:\nopencode # Run command'), undefined);
});

test('createCodingCliOutputScanner detects the ANSI-colored OpenCode TUI logo across chunks', () => {
  const scanner = createCodingCliOutputScanner();
  assert.equal(
    scanner.feed('\x1b[36m█▀▀█ █▀▀█ █▀▀█ █▀▀▄\x1b[0m █▀▀▀ █▀▀█ █▀▀█ █▀▀█\n'),
    undefined,
  );
  assert.equal(
    scanner.feed('\x1b[36m█  █ █  █ █▀▀▀ █  █\x1b[0m █    █  █ █  █ █▀▀▀\n'),
    'opencode',
  );
  assert.equal(
    scanner.feed('\x1b[36m▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀  ▀\x1b[0m ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀'),
    'opencode',
  );
});

test('createCodingCliOutputScanner preserves ANSI sequences split across chunks', () => {
  const scanner = createCodingCliOutputScanner();
  assert.equal(
    scanner.feed('\x1b[36m█▀▀█ █▀▀█ █▀▀█ █▀▀▄\x1b[0m █▀▀▀ █▀▀█ █▀▀█ █▀▀█\n'),
    undefined,
  );
  assert.equal(
    scanner.feed('\x1b[36m█  █ \x1b['),
    undefined,
  );
  assert.equal(
    scanner.feed('0m█  █ █▀▀▀ █  █\x1b[0m █    █  █ █  █ █▀▀▀'),
    'opencode',
  );
});

test('createCodingCliOutputScanner hides OSC payloads split before BEL or ST terminators', () => {
  const belScanner = createCodingCliOutputScanner();
  assert.equal(belScanner.feed('\x1b]0;Welcome to Claude Code'), undefined);
  assert.equal(belScanner.feed('\x07ordinary output'), undefined);

  const stScanner = createCodingCliOutputScanner();
  assert.equal(stScanner.feed('\x1b]0;GitHub Copilot CLI'), undefined);
  assert.equal(stScanner.feed('\x1b\\ordinary output'), undefined);
});

test('createCodingCliOutputScanner preserves visible output between ST-terminated OSC sequences', () => {
  const scanner = createCodingCliOutputScanner();
  assert.equal(
    scanner.feed('\x1b]0;first title\x1b\\Welcome to Claude '),
    undefined,
  );
  assert.equal(
    scanner.feed('Code\x1b]0;second title\x1b\\'),
    'claude',
  );
});

test('createCodingCliOutputScanner hides provider text in OSC payloads longer than the scan buffer', () => {
  const belScanner = createCodingCliOutputScanner();
  assert.equal(
    belScanner.feed(`\x1b]0;${'x'.repeat(9000)} Welcome to Claude Code`),
    undefined,
  );
  assert.equal(belScanner.feed('\x07ordinary output'), undefined);

  const stScanner = createCodingCliOutputScanner();
  assert.equal(
    stScanner.feed(`\x1b]0;${'x'.repeat(9000)} GitHub Copilot CLI`),
    undefined,
  );
  assert.equal(stScanner.feed('\x1b\\ordinary output'), undefined);
});

test('createCodingCliOutputScanner strips split ESC intermediate sequences inside banners', () => {
  const scanner = createCodingCliOutputScanner();
  assert.equal(scanner.feed('Welcome to Claude \x1b('), undefined);
  assert.equal(scanner.feed('BCode'), 'claude');
});

test('createCodingCliOutputScanner hides split DCS, SOS, PM, and APC payloads', () => {
  for (const introducer of ['P', 'X', '^', '_']) {
    const scanner = createCodingCliOutputScanner();
    assert.equal(
      scanner.feed(`\x1b${introducer}Welcome to Claude`),
      undefined,
    );
    assert.equal(scanner.feed(' Code\x1b\\ordinary output'), undefined);
  }
});

test('createCodingCliOutputScanner finds providers across chunked output', () => {
  const scanner = createCodingCliOutputScanner();
  assert.equal(scanner.feed('>_ Open'), undefined);
  assert.equal(scanner.feed('AI Codex (v0.141.0)'), 'codex');
  assert.equal(scanner.feed('more output'), 'codex');
});

test('stripTerminalControlSequences removes ANSI color codes', () => {
  const stripped = stripTerminalControlSequences('\x1b[1mOpenAI Codex\x1b[0m');
  assert.equal(stripped, 'OpenAI Codex');
});
