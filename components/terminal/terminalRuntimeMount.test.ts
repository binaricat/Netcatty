import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { foldTerminalPromptSecurityOutput, isConfirmedTerminalShellPrompt, isUntrustedTerminalInputPrompt } from '../../domain/terminalPromptSecurity.ts';
import { probeAltScreenScheduling } from './runtime/terminalWriteCoalescer.ts';
import type { SensitiveInputActiveRef } from './autocomplete/terminalAutocompletePrompt.ts';

import { applyTerminalKeywordHighlightRules } from './terminalKeywordHighlightRules.ts';

const effectsSource = readFileSync(new URL('./useTerminalEffects.ts', import.meta.url), 'utf8');
const terminalSource = readFileSync(new URL('../Terminal.tsx', import.meta.url), 'utf8');
const terminalViewSource = readFileSync(new URL('./TerminalView.tsx', import.meta.url), 'utf8');
const xtermRuntimeSource = readFileSync(new URL('./runtime/createXTermRuntime.ts', import.meta.url), 'utf8');
const providerHookSource = readFileSync(new URL('../../application/state/usePluginTerminalProviders.ts', import.meta.url), 'utf8');

test('hibernate runtime keyword setup restores plugin decoration rules', () => {
  let applied: { rules: unknown[]; enabled: boolean } | undefined;
  const runtime = {
    keywordHighlighter: {
      setRules(rules: unknown[], enabled: boolean) {
        applied = { rules, enabled };
      },
    },
  };
  applyTerminalKeywordHighlightRules(
    runtime as never,
    { current: { keywordHighlightEnabled: false, keywordHighlightRules: [] } } as never,
    { keywordHighlightEnabled: false, keywordHighlightRules: [] } as never,
    [{
      id: 'com.example.decorations:error',
      label: 'Error',
      patterns: ['\\berror\\b'],
      color: '#ff0000',
      enabled: true,
    }],
  );
  assert.deepEqual(applied, {
    enabled: true,
    rules: [{
      id: 'com.example.decorations:error',
      label: 'Error',
      patterns: ['\\berror\\b'],
      color: '#ff0000',
      enabled: true,
    }],
  });
});

test('cwd-triggered plugin decoration refresh reads the live connection status', () => {
  assert.match(
    providerHookSource,
    /if \(!registry \|\| metadata\.status !== 'connected'\)/,
  );
  assert.match(
    providerHookSource,
    /void refreshProviderOutputs\('session-state'\);/,
  );
});

test('disabled or absent plugin hosts do not receive terminal completion requests', () => {
  const autocompleteSource = readFileSync(new URL('./TerminalAutocomplete.tsx', import.meta.url), 'utf8');
  assert.match(
    autocompleteSource,
    /const pluginRegistry = isPluginCompletionProviderAvailable\?\.\(\) === false[\s\S]*?options\.allowExternalProviders === false[\s\S]*?shouldUsePluginTerminalCompletionProvider[\s\S]*?\? null\s*\n\s*: getWindowPluginTerminalProviderRegistry\(\)/,
  );
  assert.match(
    terminalSource,
    /isPluginTerminalProviderAvailable,/,
  );
  assert.match(
    autocompleteSource,
    /shouldUsePluginTerminalCompletionProvider\(\{[\s\S]*?sensitiveInputActive:[\s\S]*?promptText:/,
  );
  assert.match(
    terminalSource,
    /passwordPromptActiveRef,/,
  );
});

test('plugin decoration requests retain the workspace identity', () => {
  assert.match(
    providerHookSource,
    /\.\.\.\(metadata\.workspaceId \? \{ workspaceId: metadata\.workspaceId \} : \{\}\),/,
  );
});

test('plugin decoration responses cannot apply after connection state invalidates the request', () => {
  assert.match(
    providerHookSource,
    /const refreshGenerationRef = useRef\(0\);/,
  );
  assert.match(
    providerHookSource,
    /const generation = \+\+refreshGenerationRef\.current;/,
  );
  assert.match(
    providerHookSource,
    /refreshGenerationRef\.current \+= 1;\s*refreshAbortRef\.current\?\.abort\(\);/,
  );
  assert.match(
    providerHookSource,
    /request\('terminal\.decoration',[\s\S]*?controller\.signal\)/,
  );
  assert.match(
    providerHookSource,
    /generation === refreshGenerationRef\.current[\s\S]*isPluginTerminalProviderRefreshCurrent\(metadata, current\)/,
  );
  assert.match(
    providerHookSource,
    /applyCurrentProviderResponse\(waitForProviderResponse\(/,
  );
});

test('terminal Provider snapshots use the selected ET or Mosh transport throughout renderer paths', () => {
  assert.match(terminalSource, /protocol: effectiveTerminalProtocol,/);
  assert.match(providerHookSource, /protocol: metadata\.protocol,/);
  assert.match(terminalSource, /protocol: effectiveTerminalProtocol,\s*terminalSettings,/);
  assert.match(terminalSource, /protocol: effectiveTerminalProtocol,\s*status,/);
});

test('session launch paths use the same effective protocol as Provider snapshots', () => {
  assert.match(
    terminalSource,
    /if \(effectiveTerminalProtocol === 'mosh'\)[\s\S]*?starters\.startMosh\(term\);[\s\S]*?if \(effectiveTerminalProtocol === 'et'\)/,
  );
  assert.match(
    terminalSource,
    /else if \(effectiveTerminalProtocol === 'mosh'\)[\s\S]*?sessionStarters\.startMosh\(term\);[\s\S]*?else if \(effectiveTerminalProtocol === 'et'\)/,
  );
  assert.match(
    effectsSource,
    /else if \(effectiveTerminalProtocol === "mosh"\)[\s\S]*?sessionStarters\.startMosh\(term, bootStartOptions\)[\s\S]*?else if \(effectiveTerminalProtocol === "et"\)/,
  );
  assert.match(
    terminalSource,
    /useState\(\(\) => effectiveTerminalProtocol !== 'mosh'\)/,
  );
  assert.match(
    terminalSource,
    /if \(effectiveTerminalProtocol !== 'mosh'\) \{[\s\S]*?onMoshSessionReady/,
  );
  assert.doesNotMatch(effectsSource, /effectiveTerminalProtocol === "local" \|\| host\.hostname === "localhost"/);
  assert.doesNotMatch(terminalSource, /host\.protocol === "local" \|\| host\.hostname === "localhost"/);
  assert.match(
    terminalSource,
    /if \(effectiveTerminalProtocol === 'mosh' && !moshShellReady\)[\s\S]*?\}, \[effectiveTerminalProtocol, host, isPendingScriptAlreadyHandled/,
  );
});

test('trusted command delivery reaches plugin providers without duplicating the host callback', () => {
  const callbackStart = terminalSource.indexOf('const pluginAwareOnCommandSubmitted = useCallback');
  const callbackEnd = terminalSource.indexOf('const cwdAwareOnCommandSubmitted = useCallback', callbackStart);
  assert.notEqual(callbackStart, -1);
  assert.notEqual(callbackEnd, -1);

  const callbackSource = terminalSource.slice(callbackStart, callbackEnd);
  assert.match(callbackSource, /pluginTerminalLifecycle\.onCommandSubmitted\(\)/);
  assert.match(callbackSource, /pluginProviderHost\?\.commandSubmitted\(command\)/);
  assert.doesNotMatch(callbackSource, /onCommandSubmitted\?\./);
});

test('password-prompt input is consumed before every semantic command callback', () => {
  assert.match(
    xtermRuntimeSource,
    /const sensitive = ctx\.passwordPromptActiveRef\?\.current === true[\s\S]*?recordTerminalCommandExecution\([\s\S]*?\{ sensitive, allowHostStyleGreaterThanPrompt: ctx\.allowHostStyleGreaterThanPrompt \},\s*\);/,
  );
  assert.match(
    terminalSource,
    /const sensitive = passwordPromptActiveRef\.current;[\s\S]*?recordTerminalCommandExecution\([\s\S]*?\{ sensitive, allowHostStyleGreaterThanPrompt: isNetworkDevice \}\);/,
  );
});

test('terminal output treats unknown prompt-shaped input boundaries as sensitive', () => {
  assert.match(
    terminalSource,
    /const promptSecurityOptions = \{\s*allowHostStyleGreaterThan: isNetworkDevice,\s*alternateScreen: promptSecurityScreenRef\.current\.active \|\| \(termRef\.current\s*\? isTerminalAlternateScreenActive\(termRef\.current\)\s*: false\),\s*\};/,
  );
  assert.match(terminalSource, /isUntrustedTerminalInputPrompt\([\s\S]*?promptSecurityOptions/);
  assert.match(terminalSource, /passwordPromptActiveRef\.current = true;[\s\S]*?autocompleteCloseRef\.current\?\.\(\);/);
});

test('terminal view derives the network-device prompt policy before autocomplete renders', () => {
  assert.match(
    terminalViewSource,
    /const isNetworkDevice = host\.deviceType === 'network'[\s\S]*?classifyDistroId\(host\.distro\) === 'network-device';/,
  );
  assert.match(terminalViewSource, /allowHostStyleGreaterThanPrompt=\{isNetworkDevice\}/);
  assert.match(terminalViewSource, /isNetworkDevice=\{isNetworkDevice\}/);
  assert.match(
    terminalSource,
    /xTermRuntimeContextRef\.current = \{[\s\S]*?allowHostStyleGreaterThanPrompt: isNetworkDevice,/,
  );
  assert.match(
    terminalSource,
    /resolveTerminalAutocompleteSettings\(\{[\s\S]*?isNetworkDevice: host\.deviceType === 'network'[\s\S]*?classifyDistroId\(host\.distro\) === 'network-device',\s*\}\);/,
  );
  assert.doesNotMatch(terminalSource, /singleChannelSsh/);
  const autocompleteSource = readFileSync(new URL('./TerminalAutocomplete.tsx', import.meta.url), 'utf8');
  assert.match(
    autocompleteSource,
    /useTerminalAutocomplete\(\{[\s\S]*?isNetworkDevice,/,
  );
});

test('backend exits are forwarded to the Provider lifecycle with their exit code', () => {
  assert.match(terminalSource, /pluginTerminalSessionExitRef\.current\(evt\.exitCode\);/);
  assert.match(terminalSource, /pluginTerminalLifecycle\.onSessionExited\(evt\.exitCode\);/);
});

test('normal boot and hibernate wake share the refresh-capable runtime cwd handler', () => {
  assert.match(
    terminalSource,
    /const pluginAwareOnRuntimeCwdChange = useCallback/,
  );
  assert.match(
    terminalSource,
    /refreshProviderOutputs\('cwd-changed'\)/,
  );
  assert.match(
    terminalSource,
    /onCwdChange: \(cwd: string\) => \{\s*pluginAwareOnRuntimeCwdChange\(cwd, \{ source: 'osc7' \}\);\s*},/,
  );
  assert.match(
    effectsSource,
    /onPluginRuntimeCwdChange\(cwd, \{ source: 'osc7' \}\);/,
  );
});

test('normal boot and hibernate wake share terminal link error feedback', () => {
  assert.match(
    terminalSource,
    /const onOpenExternalError = useCallback\([\s\S]*?toast\.error\(message\.body, message\.title\);/,
  );
  assert.match(
    terminalSource,
    /xTermRuntimeContextRef\.current = \{[\s\S]*?onOpenExternalError,/,
  );
  assert.match(
    effectsSource,
    /createXTermRuntime\(\{[\s\S]*?onOpenExternalError,/,
  );
});

// Exercise the actual observer without mounting the terminal renderer/addon stack.
const observerStart = terminalSource.indexOf('  const observeTerminalInputPrompt = useCallback(');
const observerEnd = terminalSource.indexOf('  const beginHibernatedSessionListeners', observerStart);
assert.ok(observerStart > 0 && observerEnd > observerStart);
const observerCode = ts.transpileModule(
  terminalSource.slice(observerStart, observerEnd) + '\nobserveTerminalInputPrompt;',
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

function promptObserver(bufferAlternate = false) {
  const latch: SensitiveInputActiveRef = { current: false, source: 'heuristic' };
  const screen = { current: { active: false, incomplete: null } };
  const observe = runInNewContext(observerCode, {
    useCallback: (callback: unknown) => callback,
    isNetworkDevice: false,
    promptSecurityScreenRef: screen,
    sensitivePromptOutputTailRef: { current: '' },
    heredocPromptOriginRef: { current: '' },
    promptSecurityPendingCrRef: { current: false },
    passwordPromptActiveRef: latch,
    autocompleteCloseRef: { current: () => {} },
    termRef: { current: {} },
    isTerminalAlternateScreenActive: () => bufferAlternate,
    probeAltScreenScheduling,
    foldTerminalPromptSecurityOutput,
    isConfirmedTerminalShellPrompt,
    isUntrustedTerminalInputPrompt,
  }) as (chunk: string, meta?: { pluginPipelineSensitiveInput: boolean }) => void;
  return { latch, screen, observe };
}

test('raw alternate-screen entry clears a sticky vim latch before xterm parses (#4107)', () => {
  for (const mode of ['47', '1047', '1049']) {
    const entry = `\x1b[?${mode}h`;
    for (let split = 1; split < entry.length; split++) {
      const { latch, screen, observe } = promptObserver();
      observe(':');
      assert.equal(latch.current, true, 'primary-screen sudo colon stays closed');
      observe(entry.slice(0, split));
      observe(entry.slice(split) + '\r:');
      assert.equal(screen.current.active, true);
      assert.equal(latch.current, false, `${mode} entry split at ${split}`);
      for (const output of ['q', '!', '\r:q:', '\r-- INSERT --', 'text']) {
        observe(output);
        assert.equal(latch.current, false, output);
      }
      observe(`\x1b[?${mode}l\rPassword:`);
      assert.equal(screen.current.active, false);
      assert.equal(latch.current, true, 'password protection resumes after vim exits');
    }
  }
});

test('parsed alternate-screen vim ex and redraws clear stale heuristic latches (#4107)', () => {
  for (const output of [':', ':q:', '\r-- INSERT --', '\r\x1b[2K']) {
    const alternate = promptObserver(true);
    alternate.latch.current = true;
    alternate.observe(output);
    assert.equal(alternate.latch.current, false, output);
  }
});

test('primary-screen colon prompts retain protection through unrelated echo', () => {
  const primary = promptObserver();
  primary.observe(':');
  assert.equal(primary.latch.current, true);
  primary.observe('q');
  assert.equal(primary.latch.current, true, 'unrelated echo must not clear primary-screen protection');
});

test('primary-screen background output retains sensitivity until a confirmed shell prompt', () => {
  const primary = promptObserver();
  for (const label of ['Password:', 'Token:']) {
    primary.observe('\r' + label);
    assert.equal(primary.latch.current, true);
    for (const output of ['secret', '\r\n[1] background job completed\r\n', '\x1b[2K', 'ordinary output']) {
      primary.observe(output);
      assert.equal(primary.latch.current, true, output);
    }
    primary.observe('\r\nuser@host:~$ ');
    assert.equal(primary.latch.current, false, 'a confirmed shell prompt clears the heuristic latch');
  }
});

test('alternate-screen password prompts retain heuristic protection while awaiting input', () => {
  for (const bufferAlternate of [false, true]) {
    const { latch, observe } = promptObserver(bufferAlternate);
    if (!bufferAlternate) observe('\x1b[?1049h');
    observe('\rPass');
    for (const output of ['word: ', 'secret']) {
      observe(output);
      assert.equal(latch.current, true, output);
      assert.equal(latch.source, 'heuristic');
    }
  }
});

test('explicit plugin sensitivity survives vim ex, redraws and shell prompts', () => {
  const { latch, screen, observe } = promptObserver();
  observe('Password:', { pluginPipelineSensitiveInput: true });
  for (const output of ['\x1b[?1049h\r:', 'q!', '\r-- INSERT --', '\x1b[?1049l\ruser@host:~$ ']) {
    observe(output);
    assert.equal(latch.current, true);
    assert.equal(latch.source, 'explicit');
  }
  assert.equal(screen.current.active, false, 'screen tracking also runs under explicit metadata');
  observe('', { pluginPipelineSensitiveInput: false });
  assert.equal(latch.current, false);
  observe(':');
  assert.equal(latch.current, true);
  assert.equal(latch.source, 'heuristic');
});
