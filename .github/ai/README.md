# AI automation

GitHub Actions orchestration that uses **Claude Code** with an Ollama Cloud
Anthropic-compatible backend for issue triage and implementation of
high-confidence bugs / small features. Isolated research uses the Brave Search
API. Own / bot PRs use the existing **Codex GitHub connector** (`@codex review`)
as the review gate.

Default mode is `full`. Set repo variable `AI_AUTOMATION_MODE=triage_only` to
classify issues without implement or the Codex fix loop.

Third-party / fork PRs are **not** reviewed by this agent. Their initial Codex
review is assumed to be auto-configured on the repo; this workflow only
re-comments `@codex review` after the author pushes more commits
(`pull_request` synchronize).

## Required secrets

| Secret | Purpose |
|---|---|
| `ANTHROPIC_AUTH_TOKEN` | Ollama Cloud API key, sent as `Authorization: Bearer` |
| `BRAVE_API_KEY` | Brave Search API key for the isolated research pass |

Optional:

- `TRIAGE_GITHUB_TOKEN` — bot PAT (netcatty-bot) for opening PRs, labels, triage replies.
- `CODEX_REQUEST_GITHUB_TOKEN` — maintainer PAT used only for `@codex review`.
- `SLACK_WEBHOOK_URL` — status pings.

Do not put keys in the repository. Set them with `gh secret set`.

## Variables

| Variable | Default | Purpose |
|---|---|---|
| `AI_AUTOMATION_MODE` | `full` | `full` or `triage_only` |
| `AI_MODEL` | `glm-5.3-flash:cloud` | Ollama Cloud model id for Claude Code |
| `AI_ANTHROPIC_BASE_URL` | `https://ollama.com` | Anthropic-compatible API host |
| `AI_CODEX_FIX_MAX_ROUNDS` | `40` | Max fix ↔ `@codex review` loops on own/bot PRs |
| `AI_TRIAGE_DAILY_LIMIT` | `10` | Daily auto triage for non-collaborators |
| `AI_FOLLOWUP_DAILY_LIMIT` | `20` | Daily automatic follow-up runs per admitted issue |

## Manual retry

Actions → **AI automation** → Run workflow → provide an issue or PR number.

## Safety

- External / fork PRs: only re-trigger Codex; no agent review and no commits.
- Automation never publishes changes under `.github/` or automation scripts.
- Issue text is sanitized before prompts.
- Agent steps run without a GitHub token. Provider keys are staged to a file and
  injected only into the Claude Code launcher.
- Isolated research runs in an empty temp workspace and can only call the
  Brave `web-search` / `web-fetch` helpers. Classify/implement deny those tools.
- Research output must include real HTTPS sources from the helper log.

Existing HTML comment markers that still say `cursor-*` are still recognized so
in-flight issues and PRs are not reprocessed. New comments write `ai-*` markers.
