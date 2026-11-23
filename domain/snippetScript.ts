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

export const DEFAULT_SCRIPT_TEMPLATE = `// Netcatty automation script - async JS in the active terminal session
//
// nct.screen.waitForPrompt(ms?)          wait for shell prompt (# root / $ user)
// nct.screen.waitForText(text, ms?)       wait for exact output text
// nct.screen.waitForRegex(pattern, ms?)   wait for regex output, including multiline
// nct.screen.waitForAny([patterns], ms?) wait until any pattern matches
// nct.screen.sendLine(cmd)                type command + Enter; send(text) raw keys only
// nct.screen.getText(start?, end?) | clear()
// nct.session.connected | name | hostname | username (read-only metadata)
// nct.session.sleep(ms) | startLog(path) | stopLog() | disconnect()
// nct.dialog.confirm(msg)->bool | prompt(msg, def?)->string | alert(msg)
// nct.dialog.form({ fields })->object; fields: select/radio/checkbox/textarea/number, optional visibleWhen
// nct.dialog.select/radio/checkbox are convenience helpers
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
