# Antigravity integration landscape

Date: 2026-07-27

## Conclusion

Most third-party integrations do not implement the Antigravity Python SDK or
talk to `localharness` directly. They install or discover Google's official
`agy` executable and invoke its non-interactive `--print` mode as a child
process. This lets users reuse the CLI's Google sign-in, models, settings,
permissions, MCP servers, plugins, and conversation store.

There are two common variants:

1. Thin wrappers capture `agy --print` output and expose it through another
   surface such as MCP, Telegram, Claude Code, or ACP.
2. Richer adapters also read Antigravity's local SQLite conversation store to
   reconstruct tool activity, incremental progress, errors, and conversation
   identity that the CLI's plain-text output does not expose.

The second variant provides a richer UI, but depends on private local database
formats. It is substantially more fragile than treating the official CLI as a
supported subprocess boundary.

## Representative implementations

| Project | Integration shape | Notable choices |
| --- | --- | --- |
| [agy-headless-bridge](https://github.com/rhishi99/agy-headless-bridge) | Python wrapper around the official `agy` CLI | Adds PTY/ConPTY handling, ANSI cleanup, executable discovery, idle and hard timeouts. It primarily compensates for early CLI print-mode problems. |
| [antigravity-acp](https://github.com/shubzkothekar/antigravity-acp) | TypeScript/Bun ACP adapter around `agy` | Launches `agy`, but reconstructs richer events and history from Antigravity's SQLite conversation database instead of relying only on stdout. |
| [agy-acp](https://github.com/hicder/agy-acp) | Rust ACP adapter around `agy` | Uses the official CLI for execution and reads the local conversation data for ACP-compatible session and event behavior. |
| [antigravity-for-claude-code](https://github.com/yuting0624/antigravity-for-claude-code) | Claude Code plugin that delegates tasks to `agy` | Handles model selection, timeout, empty output, authentication/quota errors, and permission-related failures around the CLI process. |
| [antigravity-cli-mcp-slim](https://github.com/tksfjt1024/antigravity-cli-mcp-slim) | Thin Python MCP server over `agy --print` | Uses a child process with an explicit working directory, timeout and process-group cancellation; exposes continuation and permission flags. |
| [tele-agy](https://github.com/startingfrom0rating/tele-agy) | Node.js Telegram bridge over `agy --print` | Streams stdout/stderr from the CLI and stops it with signals; keeps the integration intentionally thin. |
| [agy-bridge](https://github.com/sshahzaiib/agy-bridge) | Bridge around the installed Antigravity CLI | Follows the same CLI-delegation pattern rather than bundling the Python SDK runtime. |

The projects differ in protocol and user interface, but the repeated boundary
is the same: the official `agy` process owns the actual agent runtime.

## What changed in the official CLI

Several workarounds in early community wrappers were responses to real bugs in
the first `agy` releases, but should not automatically become part of a new
integration:

- Version 1.0.15 fixed Windows output being discarded when stdout was a pipe or
  subprocess.
- Version 1.1.1 made server-side failures write to stderr with a non-zero exit
  code and stopped print-mode subprocesses from hanging on inherited stdin.
- Version 1.1.3 made headless permission requests soft-deny with an actionable
  stderr message instead of hanging or silently approving them.
- Version 1.1.4 made headless runs honor persisted permission, sandbox and
  artifact-review settings.
- Versions 1.1.6 and 1.1.7 contain additional print-mode reliability fixes.

These fixes are documented in the official
[changelog](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md).
The original non-TTY output issue is now
[closed](https://github.com/google-antigravity/antigravity-cli/issues/76).

## Remaining integration gaps

The official CLI is now viable as a subprocess, but it is not yet a complete
application-facing SDK:

- `--print` returns final plain text, not a documented structured event stream.
  A wrapper cannot reliably render native tool calls, intermediate progress,
  usage, or file-change events from stdout alone.
- The CLI can resume a known conversation with `--conversation`, but a new
  print-mode run does not return its generated conversation ID. The upstream
  [conversation ID request](https://github.com/google-antigravity/antigravity-cli/issues/7)
  remains open. Global `--continue` is unsafe when an application has several
  independent chats running concurrently.
- Headless mode cannot show an interactive permission prompt. It follows saved
  policies and soft-denies anything still requiring confirmation. Passing
  `--dangerously-skip-permissions` would bypass Netcatty's expected safety
  model and should not be the default.
- Reading the SQLite store can recover richer data, but that store is not a
  documented external contract. It should be treated as a compatibility layer,
  not the primary boundary.

## Python SDK and `localharness`

Google's [Antigravity Python SDK](https://github.com/google-antigravity/antigravity-sdk-python)
is a different product boundary. Its wheel carries a large native
`localharness` runtime and exposes APIs for building an independent agent. It
does not simply embed the installed consumer `agy` experience, and it brings
runtime packaging, platform coverage, authentication, protocol, and update
responsibilities into the host application.

The similarly named community
[`antigravity-sdk` npm package](https://www.npmjs.com/package/antigravity-sdk)
targets Antigravity IDE extension/language-server integration. Its own scope is
not a general external-agent SDK, so it is not a replacement for the Python
agent SDK.

## Recommendation for Netcatty

If the product goal is "use Agy as a local assistant inside Netcatty," follow
the dominant ecosystem approach and integrate the official `agy` CLI through
Netcatty's existing external-agent framework:

1. Detect a user-installed `agy` first and show a guided official installation
   path when it is absent.
2. Require a recent minimum CLI version so old PTY and silent-output bugs do not
   need to be reimplemented in Netcatty.
3. Use `--print`, close stdin, capture stdout/stderr, enforce an external
   timeout, and terminate the full child process tree on cancellation.
4. Respect the CLI's saved permission policy; do not default to unrestricted
   permission bypass.
5. Initially describe the feature honestly as final-response integration. Do
   not fabricate structured tool activity from plain text.
6. Keep each Netcatty chat isolated. Until upstream exposes a newly created
   conversation ID, either treat turns as stateless or add a narrowly isolated,
   version-gated conversation-store adapter with explicit compatibility tests.

If the goal is instead to build a new Netcatty-owned agent powered by Google's
Antigravity runtime, then the Python SDK and bundled `localharness` are the
appropriate boundary. Translating that SDK to TypeScript would be a separate
SDK-maintenance project, not the normal way other Agy integrations are built.
