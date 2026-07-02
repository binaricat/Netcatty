import type { Monaco } from '@monaco-editor/react';

type CompletionDisposable = { dispose: () => void };

const NCT_API_COMPLETIONS = [
  {
    label: 'nct.screen.waitForPrompt',
    sortText: 'nct.screen.waitFor.00.prompt',
    insertText: 'await nct.screen.waitForPrompt(${1:30000});',
    detail: 'Wait for shell prompt',
    documentation: 'Wait until an interactive shell prompt appears (# for root, $ for regular user).',
  },
  {
    label: 'nct.screen.waitForText',
    sortText: 'nct.screen.waitFor.01.text',
    insertText: "await nct.screen.waitForText('${1:text}', ${2:30000});",
    detail: 'Wait for literal text',
    documentation: 'Wait until the exact text appears in session output. Regex characters are treated as normal text.',
  },
  {
    label: 'nct.screen.waitForRegex',
    sortText: 'nct.screen.waitFor.02.regex',
    insertText: "await nct.screen.waitForRegex('${1:pattern}', ${2:30000});",
    detail: 'Wait for regex match',
    documentation: 'Wait until session output matches a regular expression. String patterns use dotAll matching for multiline output.',
  },
  {
    label: 'nct.screen.waitFor',
    sortText: 'nct.screen.waitFor.03.legacy',
    insertText: "await nct.screen.waitFor('${1:text}', ${2:30000});",
    detail: 'Wait for terminal output (legacy)',
    documentation: 'Compatibility helper. Plain string patterns are literal; legacy /regex/flags strings still work, but prefer waitForText for text or waitForRegex for regular expressions.',
  },
  {
    label: 'nct.screen.waitForAny',
    insertText: "await nct.screen.waitForAny(['# ', '$ ', '~# ', '~$ '], ${1:30000});",
    detail: 'Wait for any pattern',
    documentation: 'Wait until any of the given patterns appears in session output.',
  },
  {
    label: 'nct.screen.sendLine',
    insertText: "await nct.screen.sendLine('${1:command}');",
    detail: 'Send line + Enter',
    documentation: 'Send text to the terminal followed by carriage return.',
  },
  {
    label: 'nct.screen.send',
    insertText: "await nct.screen.send('${1:text}');",
    detail: 'Send text',
    documentation: 'Send text to the terminal without pressing Enter.',
  },
  {
    label: 'nct.screen.getText',
    insertText: 'const output = await nct.screen.getText();',
    detail: 'Read terminal text',
    documentation: 'Read visible terminal buffer text or a row range.',
  },
  {
    label: 'nct.screen.clear',
    insertText: 'await nct.screen.clear();',
    detail: 'Clear terminal screen',
    documentation: 'Send a clear-screen sequence to the terminal.',
  },
  {
    label: 'nct.session.sleep',
    insertText: 'await nct.session.sleep(${1:1000});',
    detail: 'Pause script',
    documentation: 'Pause script execution for the given milliseconds.',
  },
  {
    label: 'nct.sleep',
    insertText: 'await nct.sleep(${1:1000});',
    detail: 'Pause script',
    documentation: 'Alias for nct.session.sleep.',
  },
  {
    label: 'nct.session.startLog',
    insertText: "await nct.session.startLog('${1:./script.log}');",
    detail: 'Start session log',
    documentation: 'Start writing session output to a local log file.',
  },
  {
    label: 'nct.session.stopLog',
    insertText: 'await nct.session.stopLog();',
    detail: 'Stop session log',
    documentation: 'Stop the active script log stream.',
  },
  {
    label: 'nct.session.disconnect',
    insertText: 'await nct.session.disconnect();',
    detail: 'Disconnect session',
    documentation: 'Close the current terminal session.',
  },
  {
    label: 'nct.dialog.confirm',
    insertText: "const ok = await nct.dialog.confirm('${1:Continue?}');",
    detail: 'Confirm dialog',
    documentation: 'Show a confirm dialog and return true when accepted.',
  },
  {
    label: 'nct.dialog.prompt',
    insertText: "const value = await nct.dialog.prompt('${1:Input}', '${2:}');",
    detail: 'Prompt dialog',
    documentation: 'Show an input dialog and return the entered string.',
  },
  {
    label: 'nct.dialog.alert',
    insertText: "await nct.dialog.alert('${1:Message}');",
    detail: 'Alert dialog',
    documentation: 'Show an informational alert dialog.',
  },
  {
    label: 'nct.log',
    insertText: "nct.log('${1:message}');",
    detail: 'Script log',
    documentation: 'Append a line to the script run log panel.',
  },
  {
    label: 'nct.progress.start',
    insertText: "nct.progress.start('${1:Phase name}', ${2:total});",
    detail: 'Start determinate progress',
    documentation: 'Opt in to a labeled X/Y progress bar for known-length loops.',
  },
  {
    label: 'nct.progress.step',
    insertText: "nct.progress.step('${1:detail}');",
    detail: 'Advance progress',
    documentation: 'Increment determinate progress by one step.',
  },
  {
    label: 'nct.progress.set',
    insertText: "nct.progress.set(${1:current}, '${2:detail}');",
    detail: 'Set progress position',
    documentation: 'Set determinate progress to a specific index.',
  },
  {
    label: 'nct.progress.done',
    insertText: 'nct.progress.done();',
    detail: 'Finish progress phase',
    documentation: 'Complete the current determinate progress phase.',
  },
];

let registered = false;
let disposable: CompletionDisposable | null = null;

export function registerNctMonacoCompletionProvider(monaco: Monaco): CompletionDisposable {
  if (registered && disposable) {
    return disposable;
  }

  disposable = monaco.languages.registerCompletionItemProvider('javascript', {
    triggerCharacters: ['.', '('],
    provideCompletionItems: (model, position) => {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const prefix = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });

      const suggestions = NCT_API_COMPLETIONS
        .filter((item) => {
          if (prefix.trim().length === 0) return true;
          return item.label.startsWith('nct') && prefix.includes('nct');
        })
        .map((item) => ({
          label: item.label,
          kind: monaco.languages.CompletionItemKind.Method,
          insertText: item.insertText,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          detail: item.detail,
          documentation: item.documentation,
          sortText: item.sortText ?? item.label,
          range,
        }));

      return { suggestions };
    },
  });

  registered = true;
  return disposable;
}

export function disposeNctMonacoCompletionProvider() {
  disposable?.dispose();
  disposable = null;
  registered = false;
}
