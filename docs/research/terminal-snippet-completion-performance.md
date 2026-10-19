# Terminal argument completion performance

Issue: #3715. This follows #3623's argument-position matching for #3622; it does not resolve #3622's remaining interactive-email UX request.

`matchesWordPrefixQuery` tried pinyin for every word after a failed literal prefix comparison. A large snippet library therefore repeated transliteration/cache work for ordinary ASCII command words on each completion query. Printable ASCII words cannot gain another pinyin prefix, so they now return a miss immediately after the literal check. Chinese and other non-ASCII words keep the existing path.

## Verification

The regression exercises the actual `getCompletions` argument path with 5,000 snippets. Before the fix, it fails because the pinyin cache contains 5,011 entries, including ASCII commands and numbers. Afterward, only the Chinese label is cached and its initials still find the snippet. Additional cases cover empty queries, case, fullwidth normalization, word boundaries, Chinese full pinyin/initials, and mixed ASCII/Chinese words.

Run the real Electron renderer measurement:

```sh
node_modules/.bin/electron scripts/terminal-snippet-completion-performance.live.test.cjs
```

This uses isolated application data and synthetic snippets, calls the production completion engine, measures completion time and a queued input timer, and checks that ASCII words bypass pinyin while Chinese initials still work. It prints timings; the regression gate is the unnecessary-work assertion, avoiding a machine-specific timing threshold.

On the audit machine, an initial fixture with Chinese labels and ASCII commands measured:

| Library | Before | After |
| --- | --- | --- |
| 100 snippets | 0.4–2.4 ms | 0.1–1.3 ms |
| 1,000 snippets | 4.2–7.0 ms | 1.7–2.3 ms |
| 5,000 snippets | 52.9–86.0 ms | 8.8–9.9 ms |

The corresponding 5,000-entry queued input delay fell from 53.1–86.1 ms to 8.8–9.9 ms. The committed fixture uses ASCII labels plus one Chinese label; the final three rounds measured 6.5–11.0 ms. These are local completion/render-thread measurements, not network or terminal throughput measurements.

An isolated real Electron window also mounted production `TerminalAutocomplete` with real xterm and 5,001 snippets. Typing `git pull yx` displayed the Chinese mailbox snippet; clicking it selected the correct snippet. No connected SSH server, personal snippets, or user settings were used.
