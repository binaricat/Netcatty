# Cursor CLI automation

GitHub Actions orchestration that uses **Cursor CLI** for issue triage and
implementation of high-confidence bugs / small features. Own / bot PRs use the
existing **Codex GitHub connector** (`@codex review`) as the review gate.

Third-party / fork PRs are **not** reviewed by Cursor CLI. Their initial Codex
review is assumed to be auto-configured on the repo; this workflow only
re-comments `@codex review` after the author pushes more commits
(`pull_request` synchronize).

## Required secret

| Secret | Purpose |
|---|---|
| `CURSOR_API_KEY` | Cursor CLI authentication (issue classify/implement + own PR fix loop) |

Optional:

- `TRIAGE_GITHUB_TOKEN` — bot PAT (netcatty-bot) for opening PRs, labels, triage replies.
- `CODEX_REQUEST_GITHUB_TOKEN` — **maintainer PAT (binaricat)** used only for
  `@codex review` comments so the Codex GitHub connector sees a human identity.
  Falls back to `TRIAGE_GITHUB_TOKEN` / `GITHUB_TOKEN` if unset.
- `SLACK_WEBHOOK_URL` — status pings.

Fork re-`@codex` uses `pull_request_target` (default-branch checkout only) so
`GITHUB_TOKEN` can write comments. Write tokens are step-scoped only (never
workflow-wide). Agent steps run without git credentials; publish uses a fresh
clone.

## Variables

| Variable | Default | Purpose |
|---|---|---|
| `CURSOR_CODEX_FIX_MAX_ROUNDS` | `40` | Max Cursor fix ↔ `@codex review` loops on own/bot PRs |
| `CURSOR_TRIAGE_DAILY_LIMIT` | `10` | Daily auto triage for non-collaborators |
| `CURSOR_FOLLOWUP_DAILY_LIMIT` | `20` | Daily automatic follow-up runs per admitted issue before maintainer handoff |
| `AUTOMATION_OWN_ACTORS` | `binaricat` | Logins treated as first-party PR authors |
| `AUTOMATION_ISSUE_BOT_LOGINS` | `netcatty-bot,github-actions[bot]` | Bot logins ignored as issue follow-up authors and recognized in `@bot` mentions |

## Manual retry

Actions → **Cursor automation** → Run workflow → provide an issue or PR number.

## Format recovery → triage

`issue-format` and triage share the same title/body rules in
`scripts/cursor-automation.cjs` (CJK-friendly `[Bug]`/`[Feature]` summaries).

When a closed `invalid-format` issue is fixed, `issue-format` reopens it and
**dispatches** `cursor-automation` via `workflow_dispatch` (GITHUB_TOKEN cannot
silently chain `issues.reopened`, but `workflow_dispatch` is allowed).

## Bot PR titles and bodies

Implement agents write:

- `TITLE:` in `.cursor-runtime/implement-status.txt` → draft PR title
  (`selectBotPrTitle`, with short `fix(#N): …` fallback)
- `.cursor-runtime/implement-pr-body.md` → full maintainer-style PR body
  (`buildPullRequestBody` prefers this; short template only if missing/thin)

Bodies always get bot markers + `Fixes #N` + an Automation footer when needed.

## Codex label handoffs

Terminal codex_loop outcomes always drop `automation:codex-loop`:

| Outcome | Labels |
|---|---|
| clean / mark_ready | `automation:codex-clean` (+ bot-pr), no loop/human |
| give_up / verify fail / empty fix | `ready-for-human`, no loop/clean |

## Safety

- External / fork PRs: only re-trigger Codex; **no** Cursor CLI review and **no** commits.
- Own / bot PR Codex findings: Cursor CLI may push fixes (max rounds).
- Automation never publishes changes under `.github/` or automation scripts.
- Issue text is sanitized before prompts.
- Cursor credentials are exchanged before agent execution; agent tools receive
  no API key or GitHub token and must run inside Cursor's command sandbox.
- Linux jobs install Cursor's versioned AppArmor profile after verifying its
  pinned SHA-256. If the profile cannot be loaded or the sandbox preflight
  fails, the job stops; it never falls back to an unsandboxed agent run.
- External facts are gathered in a separate read-only WebSearch pass running in
  an empty temporary workspace. It has no repository, GitHub token, or raw
  Cursor API key; shell network access remains blocked. Only its bounded,
  source-linked notes are passed to classify, implement, or follow-up agents.
  The workflow also verifies the CLI stream contains a real WebSearch/WebFetch
  tool event; an answer that merely prints a URL is rejected.
- GitHub user-attachment images are fetched before that pass through a
  digest-pinned imgproxy container. The proxy accepts only GitHub attachment
  sources, blocks local/private destinations, bounds redirects, bytes, pixels,
  and animation frames, and rasterizes successful results to temporary PNGs.
  Cursor sees only those PNGs and a rewritten input without the source image
  URL; any other URL still requires sourced external research. Proxy failures
  stop the run and use the normal maintainer handoff.
- User-level WebSearch/WebFetch denials are written only after that research
  pass (or in implement/fix jobs that never research). Pre-research sandbox
  setup enables the command sandbox without denying web tools, so research is
  not blocked by the later classify/follow-up denylist.
- WebSearch and WebFetch are explicitly denied again for classify, implement,
  follow-up, and fix agents. Those stages cannot silently perform another web
  request outside the isolated research pass.
- If needed WebSearch/WebFetch is unavailable or returns no source, automation
  stops and hands the issue to a maintainer instead of inventing research.
- Author replies on `needs-info` / `triage:bug-needs-info` re-run classify with
  the same dedupe, daily limit, and maintainer handoff rules.

## Continuous issue follow-up

Issue automation is not limited to the opening report. After an issue has been
admitted, new comments from the issue author are reviewed as additions to the
same work. The issue author can also explicitly mention `@netcatty-bot`; trusted
repository members may do the same. Untrusted bystanders cannot trigger code
changes by mentioning the bot, and an unadmitted issue cannot use a bot mention
to bypass normal triage. A per-issue daily limit hands unusually busy threads to
a maintainer instead of allowing unbounded agent runs.

Follow-ups are coalesced and recorded by comment ID so queued runs do not reply
or edit twice. When an automation PR is open, it is kept draft while Cursor
compares the new information with the current diff:

- already covered: acknowledge the reporter and keep the existing PR unchanged;
- focused correction: update the same PR, run the full verification gate, then
  restart Codex review on the new head;
- contradiction, larger scope, unsafe update, or no active PR needing work:
  acknowledge the reporter and hand the issue/PR to a maintainer.

Every clean-to-ready transition re-checks the source issue for automation bot
PRs only (`automation:bot-pr` / bot PR marker). A maintainer PR that merely
says `Fixes #N` is not kept draft solely because issue comments lack automation
processed markers. Patch publication also verifies the PR head has not moved,
so a follow-up update never overwrites a concurrent maintainer or automation
push.
