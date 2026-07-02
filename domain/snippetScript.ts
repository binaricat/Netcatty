import type { Snippet, SnippetKind } from './models';

export function getSnippetKind(snippet: Pick<Snippet, 'kind'>): SnippetKind {
  return snippet.kind === 'script' ? 'script' : 'snippet';
}

export function isScriptSnippet(snippet: Pick<Snippet, 'kind'>): boolean {
  return getSnippetKind(snippet) === 'script';
}

/** Common interactive shell prompts (root uses #, regular user uses $). */
export const DEFAULT_SHELL_PROMPT_PATTERNS = ['# ', '$ ', '~# ', '~$ ', '% '];

/** Default wait after each recorded command — matches waitForPrompt in generated scripts. */
export const DEFAULT_RECORDING_PROMPT_TIMEOUT_MS = 30000;

/** Regex matching a shell prompt on the last line (~# / ~$ / user@host:path#). */
export const SHELL_PROMPT_END_REGEX = /(?:~[#$]\s*|[@][^\n]{0,120}[:][^\n]{0,120}[#$%]\s*)$/m;

/** Minimal smoke script for verifying manual run and onOutput triggers. */
export const SCRIPT_SMOKE_TEST = `// === Smoke test ===
// Manual:  trigger=manual, pick a target host, click "Run now"
// onOutput: trigger=onOutput, pattern=NETCATTY_SMOKE, save, connect to target host, then run: echo NETCATTY_SMOKE
//
await nct.screen.waitForPrompt(30000);
await nct.screen.sendLine('echo netcatty-smoke-ok');
nct.log('Smoke test passed');
await nct.dialog.alert('Netcatty script smoke test OK');
`;

/** Full integration test for onConnect / manual run; dialog API enabled by default. */
export const SCRIPT_INTEGRATION_TEST = `// Netcatty Integration Test — onConnect / manual full API exercise
// Trigger: onConnect or Run now | Permission: Auto or Confirm (dialogs need non-Observer)

const CONFIG = {
  SAMPLE_COUNT: 8,
  SAMPLE_INTERVAL_MS: 2000,
  PROMPT_TIMEOUT_MS: 60000,
  STEP_TIMEOUT_MS: 20000,
  RUN_DIALOGS: true,
  RUN_SESSION_LOG: false,
  RUN_SCREEN_CLEAR: false,
};

async function main() {
  const tag = \`nc-it-\${Date.now().toString(36)}\`;
  nct.log('=== Netcatty Integration Test START ===');
  nct.log(\`tag=\${tag}  nct.version=\${nct.version}\`);
  nct.log(\`session: host=\${nct.session.hostname} user=\${nct.session.username} connected=\${nct.session.connected}\`);

  if (!nct.session.connected) {
    throw new Error('Session not connected');
  }

  nct.log('[1/12] waitForPrompt');
  await nct.screen.waitForPrompt(CONFIG.PROMPT_TIMEOUT_MS);

  nct.log('[2/12] sendLine + waitForText');
  await nct.screen.sendLine(\`echo "\${tag}_BOOTSTRAP_OK"\`);
  await nct.screen.waitForText(\`\${tag}_BOOTSTRAP_OK\`, CONFIG.STEP_TIMEOUT_MS);

  nct.log('[3/12] waitForAny');
  await nct.screen.sendLine('echo ANY_CHECK && uname -s');
  await nct.screen.waitForAny(['ANY_CHECK', /Linux/], CONFIG.STEP_TIMEOUT_MS);

  nct.log('[4/12] getText / rows / cols / currentRow');
  const text = await nct.screen.getText();
  const lineCount = text.split('\\n').filter(Boolean).length;
  nct.log(\`captured \${lineCount} lines, rows=\${nct.screen.rows} cols=\${nct.screen.cols} cursorRow=\${nct.screen.currentRow}\`);

  nct.log('[5/12] send raw + Enter');
  await nct.screen.send(\`echo -n "\${tag}_RAW"\`);
  await nct.screen.sendLine('');
  await nct.screen.waitForText(\`\${tag}_RAW\`, CONFIG.STEP_TIMEOUT_MS);

  nct.log('[6/12] waitForRegex');
  await nct.screen.sendLine(\`echo BUILD_ID=\${tag}\`);
  await nct.screen.waitForRegex(new RegExp(\`BUILD_ID=\${tag}\`), CONFIG.STEP_TIMEOUT_MS);

  nct.log('[7/12] session.sleep / nct.sleep');
  await nct.session.sleep(800);
  await nct.sleep(800);

  nct.log('[8/12] progress loop health sampling');
  nct.progress.start('Health sampling', CONFIG.SAMPLE_COUNT);
  for (let i = 1; i <= CONFIG.SAMPLE_COUNT; i += 1) {
    const cmd = [
      \`echo "== Sample \${i}/\${CONFIG.SAMPLE_COUNT} =="\`,
      'date',
      'uptime',
      "free -h | awk 'NR==2{print $1,$2,$3,$4,$7}'",
      "df -h / | awk 'NR==2{print $1,$2,$3,$5,$6}'",
      \`echo "\${tag}_SAMPLE_\${i}_DONE"\`,
    ].join(' && ');
    await nct.screen.sendLine(cmd);
    await nct.screen.waitForRegex(new RegExp(\`\${tag}_SAMPLE_\${i}_DONE\`), CONFIG.STEP_TIMEOUT_MS);
    await nct.screen.waitForPrompt(CONFIG.PROMPT_TIMEOUT_MS);
    nct.progress.step(\`sample \${i}/\${CONFIG.SAMPLE_COUNT}\`);
    nct.log(\`sample \${i}/\${CONFIG.SAMPLE_COUNT} ok\`);
    if (i < CONFIG.SAMPLE_COUNT) {
      await nct.session.sleep(CONFIG.SAMPLE_INTERVAL_MS);
    }
  }
  nct.progress.done();

  nct.log('[9/12] nested loop activity mode');
  const checks = ['whoami', 'id -u', 'pwd', 'echo $SHELL'];
  for (const check of checks) {
    await nct.screen.sendLine(check);
    await nct.screen.waitForPrompt(CONFIG.PROMPT_TIMEOUT_MS);
  }

  if (CONFIG.RUN_SESSION_LOG) {
    nct.log('[10/12] startLog / stopLog');
    await nct.session.startLog(\`./netcatty-it-\${tag}.log\`);
    await nct.screen.sendLine(\`echo "\${tag}_LOGGED"\`);
    await nct.screen.waitForText(\`\${tag}_LOGGED\`, CONFIG.STEP_TIMEOUT_MS);
    await nct.session.stopLog();
  } else {
    nct.log('[10/12] startLog/stopLog skipped');
  }

  if (CONFIG.RUN_SCREEN_CLEAR) {
    nct.log('[11/12] screen.clear');
    await nct.screen.clear();
    await nct.session.sleep(500);
    await nct.screen.waitForPrompt(CONFIG.PROMPT_TIMEOUT_MS);
  } else {
    nct.log('[11/12] screen.clear skipped');
  }

  if (CONFIG.RUN_DIALOGS) {
    nct.log('[12/12] dialog confirm / prompt / alert');
    const go = await nct.dialog.confirm(\`Integration test \${tag} finished OK. Continue to prompt/alert?\`);
    nct.log(\`confirm => \${go}\`);
    if (go) {
      const note = await nct.dialog.prompt('Optional note:', 'all-good');
      nct.log(\`prompt => \${note}\`);
      await nct.dialog.alert(\`Done. note=\${note}\`);
    } else {
      nct.log('confirm declined — skipping prompt/alert');
    }
  } else {
    nct.log('[12/12] dialog skipped');
  }

  await nct.screen.sendLine(\`echo "=== \${tag} ALL_PASSED ==="\`);
  await nct.screen.waitForText(\`\${tag} ALL_PASSED\`, CONFIG.STEP_TIMEOUT_MS);
  nct.log('=== Netcatty Integration Test PASSED ===');
}

await main();
`;

export const DEFAULT_SCRIPT_TEMPLATE = `// Netcatty automation script - async JS in the active terminal session
//
// nct.screen.waitForPrompt(ms?)          wait for shell prompt (# root / $ user)
// nct.screen.waitForText(text, ms?)       wait for exact output text
// nct.screen.waitForRegex(pattern, ms?)   wait for regex output, including multiline
// nct.screen.waitForAny([patterns], ms?) wait until any pattern matches
// nct.screen.sendLine(cmd)                type command + Enter; send(text) raw keys only
// nct.screen.getText(start?, end?) | clear()
// nct.session.sleep(ms) | startLog(path) | stopLog() | disconnect()
// nct.dialog.confirm(msg)->bool | prompt(msg, def?)->string | alert(msg)
// nct.progress.start(label, total)        opt-in determinate progress for loops
// nct.progress.step(detail?) | set(n, detail?) | done()
// nct.log(msg)  run log panel. Type "nct." in editor for autocomplete snippets.
//
await nct.screen.waitForPrompt(30000);
await nct.screen.sendLine('echo hello');
nct.log('Done');
`;

const SCRIPT_WRITE_PATTERN = /nct\.screen\.(send(?:Line)?|clear)\s*\(|nct\.session\.(disconnect|startLog)\s*\(/;

export function scriptContainsWriteOperations(content: string): boolean {
  return SCRIPT_WRITE_PATTERN.test(String(content || ''));
}
