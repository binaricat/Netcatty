# Verify AI Tool Access

The fixture replaces IPC in the real settings renderer. It records mutations in
`window.__aiToolQa.calls`. It never starts MCP or HTTP, writes client configuration,
or creates a real token. Paths and tokens are synthetic.

Use a fresh browser context or a disposable Electron profile. The initializer
clears that context's local storage. Never inject it into a personal profile.

## Browser interaction checks

Start Vite with `npx vite --host 127.0.0.1`. In a runner with Playwright and Chromium,
run `node scripts/fixtures/ai-tool-access/browser-qa.cjs`. Set `CHROMIUM_PATH` if the
browser binary is elsewhere. `NETCATTY_QA_URL` defaults to `http://127.0.0.1:5173`.
`NETCATTY_QA_OUTPUT` selects the directory for browser screenshots.

These checks use the production settings components and theme stylesheet.
Browser screenshots are not native Electron acceptance.

## Native screenshot fixture

Inject `installAiToolAccessFixture` from `bridge.cjs` into the main world before
loading `/#/settings` in a disposable Electron window. Do not launch Netcatty's
real main-process bridges. Options are `locale`, `theme`, and `enabled`.
The supported test locales include `zh-CN` and `en`. Themes are `dark` and `light`.

Open **AI**, then **Tool Access**. Capture the full settings chrome and modal edges.
Name each original screenshot with its state, locale, theme, and commit SHA.

Capture these states:

1. Main page, top and lower sections, in Chinese and dark theme.
2. Main page with Skills + CLI selected.
3. MCP connection guide, including the disabled prerequisite state.
4. Skills + CLI connection guide.
5. Client configuration for Codex, Cursor, and Other. Include manual format
   selection and the Other setup prompt.
6. MCP behavior with persistent and temporary availability modes.
7. HTTP disabled, then custom wildcard binding with a client address and masked
   synthetic token. Expand connection details for the latter.
8. Privacy configuration, then rejected input. Set
   `window.__aiToolQa.rejectPrivacy = true` to reject Apply.
9. A narrow or short dialog with its footer visible.
10. Main page and the densest dialog in English and light theme.

All created dialog types need native evidence. Preserve the original images even
if a contact sheet is also produced. Do not reveal synthetic tokens in delivered
screenshots; the masking behavior has separate interaction assertions.

## Commit semantics

Privacy is one draft, including both switches. Apply validates before persistence.
Cancel, Escape, and X discard the draft. Rejected values stay in the dialog.
Dirty drafts survive cross-window changes and show a conflict notice.

MCP behavior keeps immediate persistence. HTTP switches commit immediately, and
HTTP inputs commit on blur or Enter. These dialogs explicitly say that changes
apply immediately and use Close. Closing them does not undo saved changes.
Client registration and token regeneration require their own explicit actions.
