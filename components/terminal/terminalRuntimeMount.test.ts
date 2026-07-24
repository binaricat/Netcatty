import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

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
    /const pluginRegistry = isPluginCompletionProviderAvailable\?\.\(\) === false[\s\S]*?shouldUsePluginTerminalCompletionProvider[\s\S]*?\? null\s*\n\s*: getWindowPluginTerminalProviderRegistry\(\)/,
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
    /else if \(effectiveTerminalProtocol === "mosh"\)[\s\S]*?sessionStarters\.startMosh\(term\)[\s\S]*?else if \(effectiveTerminalProtocol === "et"\)/,
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
  const callbackEnd = terminalSource.indexOf('const pluginAwareOnCommandCompleted = useCallback', callbackStart);
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
    /const sensitive = ctx\.passwordPromptActiveRef\?\.current === true;[\s\S]*?recordTerminalCommandExecution\([\s\S]*?\{ sensitive, allowHostStyleGreaterThanPrompt: ctx\.allowHostStyleGreaterThanPrompt \},\s*\);/,
  );
  assert.match(
    terminalSource,
    /const sensitive = passwordPromptActiveRef\.current;[\s\S]*?recordTerminalCommandExecution\([\s\S]*?\{ sensitive, allowHostStyleGreaterThanPrompt: isNetworkDevice \}\);/,
  );
});

test('terminal output treats unknown prompt-shaped input boundaries as sensitive', () => {
  assert.match(terminalSource, /const promptSecurityOptions = \{ allowHostStyleGreaterThan: isNetworkDevice \};/);
  assert.match(terminalSource, /isUntrustedTerminalInputPrompt\([\s\S]*?promptSecurityOptions/);
  assert.match(terminalSource, /passwordPromptActiveRef\.current = true;[\s\S]*?autocompleteCloseRef\.current\?\.\(\);/);
  assert.match(terminalSource, /isConfirmedTerminalShellPrompt\([\s\S]*?passwordPromptActiveRef\.current = false;/);
});

test('terminal view derives the network-device prompt policy before autocomplete renders', () => {
  assert.match(
    terminalViewSource,
    /const isNetworkDevice = host\.deviceType === 'network'[\s\S]*?classifyDistroId\(host\.distro\) === 'network-device';/,
  );
  assert.match(terminalViewSource, /allowHostStyleGreaterThanPrompt=\{isNetworkDevice\}/);
  assert.match(
    terminalSource,
    /xTermRuntimeContextRef\.current = \{[\s\S]*?allowHostStyleGreaterThanPrompt: isNetworkDevice,/,
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
