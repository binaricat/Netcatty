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
| `AUTOMATION_OWN_ACTORS` | `binaricat` | Logins treated as first-party PR authors |

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
- Classify must research unknown product names and issue URLs before needs-info.
- Author replies on `needs-info` / `triage:bug-needs-info` re-run classify (same research bar).
