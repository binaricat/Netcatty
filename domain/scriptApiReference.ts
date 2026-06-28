import { DEFAULT_SCRIPT_TEMPLATE } from './snippetScript.ts';

const WRAPPER_RULES = `## Script source wrapping

Netcatty executes scripts as async JavaScript in a Node vm sandbox:

- If the source is already an async IIFE or async arrow, it runs as-is.
- If the source contains \`async function main()\`, it is wrapped and \`await main()\` is called.
- Otherwise bare statements are wrapped in \`(async () => { ... })()\`.

Only JavaScript is executed. The \`language: python\` field is a UI label only — there is no Python runtime.`;

const TRIGGER_GUIDE = `## Triggers and host targeting

| trigger | Behavior |
|---------|----------|
| manual | Run from Vault or via scripts_run / snippets_run |
| onConnect | Runs after SSH connect (global targetsAllHosts scripts first, then host connectScriptIds queue) |
| onOutput | Runs when terminal output matches triggerPattern (regex) |

Use \`targets\` (host id array) or \`targetsAllHosts: true\` to scope manual/onOutput runs.
For per-host onConnect order, use \`host_connect_scripts_set\` or link targets and sync connect queue.`;

const NCT_API = `## nct API reference

Global \`nct.version\` exposes the runtime version.

### nct.screen
- \`await nct.screen.waitForPrompt(ms?)\` — wait for shell prompt (# root / $ user)
- \`await nct.screen.waitFor(pattern, ms?)\` — wait for output (string or RegExp, default 30s)
- \`await nct.screen.waitForAny(patterns, ms?)\` — wait until any pattern matches
- \`await nct.screen.sendLine(cmd)\` — type command + Enter
- \`await nct.screen.send(text)\` — raw keys without Enter
- \`await nct.screen.getText(start?, end?)\` — read terminal buffer
- \`await nct.screen.clear()\` — clear screen
- Properties: \`rows\`, \`cols\`, \`currentRow\`

### nct.session
- \`nct.session.connected\`, \`hostname\`, \`username\`
- \`await nct.session.sleep(ms)\` — alias \`await nct.sleep(ms)\`
- \`await nct.session.startLog(path)\` / \`stopLog()\`
- \`await nct.session.disconnect()\`

### nct.dialog (requires non-Observer permission mode)
- \`await nct.dialog.confirm(msg)\` → boolean
- \`await nct.dialog.prompt(msg, default?)\` → string
- \`await nct.dialog.alert(msg)\`

### nct.progress
- \`nct.progress.start(label, total)\` — opt-in determinate bar
- \`nct.progress.step(detail?)\` / \`set(n, detail?)\` / \`done()\`

### nct.log
- \`nct.log(message)\` — append to script run log panel`;

/** Markdown reference for AI agents — single source for scripts_reference tool and prompts. */
export function getScriptApiReference(): string {
  return [
    '# Netcatty automation script reference',
    '',
    'Automation scripts are Vault snippets with `kind: "script"`. They run in the active terminal session via the nct JavaScript API.',
    '',
    WRAPPER_RULES,
    '',
    TRIGGER_GUIDE,
    '',
    NCT_API,
    '',
    '## Minimal template',
    '',
    '```javascript',
    DEFAULT_SCRIPT_TEMPLATE.trim(),
    '```',
  ].join('\n');
}
