# Claude Code + Ollama Cloud 替换 Cursor 自动化 — 可行性调研

Date: 2026-08-27
Status: feasible for triage; keep the existing control plane
Scope: replace Cursor CLI as the agent runner, not rewrite GitHub routing

## Why this exists

The current pipeline is `.github/workflows/ai-automation.yml` plus
`scripts/ai-automation.cjs`. Live mode is `triage_only`: classify issues,
do not implement, do not run the Codex fix loop.

A production classify run failed because Cursor hit its usage limit:

```
ActionRequiredError: You've hit your usage limit Get Cursor Pro for more Agent usage
```

Example: https://github.com/binaricat/Netcatty/actions/runs/33050247387
(job `Classify issue`, step `Research external context for classification`).

The goal is to keep issue triage running by swapping the agent from Cursor CLI
to Claude Code, with Ollama Cloud as the Anthropic-compatible backend. Secrets
stay in GitHub Actions (set via `gh`), never in the repo.

## Verdict

**Yes, this is feasible.** Do not replace the workflow with
`anthropics/claude-code-action`. Keep the existing router, labels, rate limits,
bot identity, isolated research workspace, and publish steps. Only replace the
agent invocation.

| Layer | Keep or replace | Why |
|---|---|---|
| Event routing, labels, daily limits, handoff comments | Keep | Pure GitHub control plane in `ai-automation.cjs` |
| Codex `@codex review` loop | Keep | Independent of Cursor; currently paused by `triage_only` |
| Isolated research workspace + imgproxy screenshots | Keep | Safety contract is still needed |
| Frozen helper copy, leak scan, no `GITHUB_TOKEN` in agent | Keep | Same threat model |
| Cursor CLI install, AppArmor sandbox, API-key fd bridge | Replace | This is the part that is out of credits |
| `agent -p --sandbox enabled` | Replace | `claude --bare -p` with `dontAsk` + allowlist |

Current production path that must come back first: **research + classify**.
Implement / follow-up / Codex-fix jobs can stay paused until triage is green.

## How the current pipeline actually works

The YAML is large because it is an orchestrator, not “run an agent on the
issue”. Jobs:

1. `route` — decide `issue_classify` / `issue_followup` / `codex_loop` / skip
2. `classify` — prepare issue JSON, isolated web research, classify, apply labels
3. `implement` / `followup` / `codex_loop` — gated off in `triage_only`
4. Codex re-request and source-issue cleanup — GitHub-only, no Cursor

Classify currently shells out to Cursor like this:

```bash
sudo --preserve-env=HOME,RUNNER_TEMP,GITHUB_WORKSPACE \
  "$RUNNER_TEMP/ai-claude-authenticated" \
  -p --mode=ask --trust --sandbox enabled --model auto --output-format text \
  --workspace "$GITHUB_WORKSPACE" \
  "$PROMPT"
```

Research uses the same binary in an empty temp workspace, `--output-format
stream-json`, then `parseExternalResearchStream()` requires a real completed
WebSearch/WebFetch tool event. Classify must write
`.ai-runtime/classification.json` with `category`, `confidence`, `summary`,
`reasoning`, `reply`, `code_paths`, `code_findings`.

That JSON contract is owned by `normalizeClassification()` in
`scripts/ai-automation.cjs`, not by the checked-in
`.github/ai/schemas/classification.schema.json` (the schema file is stale:
it omits `already_available`, `code_paths`, and `code_findings`).

## Claude Code as a headless runner

Official headless mode is `claude -p` ([docs](https://code.claude.com/docs/en/headless)):

- Exit 0 / non-zero for scripts
- `--bare` skips hooks, skills, plugins, MCP, CLAUDE.md (recommended for CI)
- `--output-format json` or `stream-json`
- `--json-schema` can enforce the classification object
- `--permission-mode dontAsk` is the documented “locked-down CI” mode:
  only pre-allowed tools run; everything else is denied, never prompted
- `--allowedTools` / `--disallowedTools` for the allowlist
- Auth in `-p` / `--bare` is `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`,
  not a Claude.ai subscription login

Do **not** use `--dangerously-skip-permissions` for classify. Classify is
read-only. `dontAsk` plus Read/Grep/Glob (and maybe `Bash(rg *)`) is enough.

Do **not** adopt `anthropics/claude-code-action` as the new workflow. That
action is built for `@claude` mentions, the Claude GitHub App, and posting
its own comments. This repo already has `netcatty-bot`, admission quotas,
untrusted-issue sanitization, and a separate research pass. The official
action would fight that control plane. Invoke the CLI the same way Cursor is
invoked today.

## Ollama Cloud as the Anthropic endpoint

Ollama documents an Anthropic Messages compatibility layer, including tools,
streaming, vision, and thinking
([docs](https://docs.ollama.com/api/anthropic-compatibility)).

Two ways to reach cloud models:

1. **Local Ollama proxying `:cloud` models** — `ANTHROPIC_BASE_URL=http://localhost:11434`.
   Needs a local Ollama daemon and sign-in. Wrong for GitHub-hosted runners.
2. **Direct ollama.com API** — `ANTHROPIC_BASE_URL=https://ollama.com` plus an
   Ollama Cloud API key. This is the CI path.

Ollama Cloud’s native auth is `Authorization: Bearer $OLLAMA_API_KEY` against
`https://ollama.com`. Claude Code maps:

| Claude Code env | HTTP header | Use with Ollama Cloud |
|---|---|---|
| `ANTHROPIC_BASE_URL` | API host | `https://ollama.com` |
| `ANTHROPIC_AUTH_TOKEN` | `Authorization: Bearer …` | **the Ollama Cloud key** |
| `ANTHROPIC_API_KEY` | `X-Api-Key` | leave empty, or same key if a probe requires it |

A user-reported Ollama docs bug ([#13854](https://github.com/ollama/ollama/issues/13854))
says setting `ANTHROPIC_API_KEY` alone is **not** enough for cloud; the Bearer
token (`ANTHROPIC_AUTH_TOKEN`) plus `https://ollama.com` is.

Must pin the model. Claude Code defaults to Anthropic IDs such as
`claude-sonnet-4-6`. Ollama Cloud will 404 those. Also set the Haiku/Sonnet/Opus
alias env vars so background/compaction calls do not fall back to Claude names:

```
ANTHROPIC_MODEL=<ollama-cloud-id>
ANTHROPIC_DEFAULT_HAIKU_MODEL=<same or cheaper cloud id>
ANTHROPIC_DEFAULT_SONNET_MODEL=<same>
ANTHROPIC_DEFAULT_OPUS_MODEL=<same>
```

Ollama’s Claude Code page recommends coding cloud models such as
`glm-4.7:cloud`, `minimax-m2.1:cloud`, and shows
`kimi-k2.7-code:cloud` in the manual example. Pick one coding model and keep
it in a **repo variable**, not hardcoded in YAML, so it can change without a
workflow PR.

Ollama does **not** support prompt caching, `/v1/messages/count_tokens`, or
forcing `tool_choice`. Fine for classify. Token counts are approximations.

## Web research gap (the one real risk)

Cursor research depends on Cursor’s built-in WebSearch/WebFetch, then the
helper asserts a completed web-tool event in the stream.

Claude Code’s WebSearch/WebFetch are Anthropic server-side tools. They are
**not** guaranteed to work when `ANTHROPIC_BASE_URL` is `https://ollama.com`.
Ollama has its own REST APIs instead:

- `POST https://ollama.com/api/web_search`
- `POST https://ollama.com/api/web_fetch`

Those use the same Cloud API key. `ollama launch claude` wires them for local
use; a raw `claude -p` on a GHA runner may not.

Recommended research strategy for this repo:

1. Keep the empty-temp-workspace + imgproxy design.
2. Prefer a **control-plane** research helper that calls Ollama
   `web_search` / `web_fetch` (or Claude Code WebSearch if a smoke test proves
   it works against ollama.com).
3. Rewrite `parseExternalResearchStream()` to accept Claude `stream-json`
   **or** a small JSONL log from the control-plane helper. Do not drop the
   “must have a real source URL” check.
4. Classify still runs with WebSearch/WebFetch denied.

If research cannot get a source for a needed external fact, keep today’s
behavior: `RESEARCH_BLOCKED` → maintainer handoff. Do not invent sources.

## Security mapping

Keep these invariants from `.github/ai/README.md`:

- Agent steps get no GitHub token
- Automation never publishes `.github/` or automation scripts
- Issue text is sanitized before prompts
- Output is scanned for the provider secret
- External research has no repo checkout and no GitHub credentials

Cursor-specific pieces we will **not** copy 1:1:

- AppArmor profile from `downloads.cursor.com`
- fd-preload that injects `--api-key` without putting it in env/argv

Claude Code **requires** `ANTHROPIC_AUTH_TOKEN` in the process environment.
Mitigations:

- Stage the key the same way (`install -m 0400` into `RUNNER_TEMP`), export
  only on the `claude` invocation, never as a job-wide `env:`
- `--bare` so project `.mcp.json` / hooks cannot run
- `--permission-mode dontAsk` + deny `WebSearch` / `WebFetch` / `Edit` /
  `Write` on classify
- Claude sandbox (`sandbox.enabled`) if the GHA image can load it; if not,
  fail closed for implement later, but classify can ship on `dontAsk` +
  no GitHub token
- Continue leak scans against `ANTHROPIC_AUTH_TOKEN`

Do not run `claude` as root/`sudo`. Cursor’s launcher used `setpriv` to drop
privileges after reading the key. Claude Code refuses
`--dangerously-skip-permissions` as root; classify should run as the runner
user.

## What to change (phased)

### Phase 0 — secrets, no YAML behavior change

Set via `gh` against `binaricat/Netcatty`. Values never land in git.

```bash
# Key: GitHub secret (Bearer token for ollama.com)
printf '%s' "$OLLAMA_API_KEY" | gh secret set ANTHROPIC_AUTH_TOKEN -R binaricat/Netcatty

# Host: repo variable is enough (not a credential)
gh variable set ANTHROPIC_BASE_URL -R binaricat/Netcatty --body 'https://ollama.com'

# Model: repo variable so it can change without rotating the key
gh variable set CLAUDE_CODE_MODEL -R binaricat/Netcatty --body 'kimi-k2.7-code:cloud'
```

Optional aliases, same key:

```bash
gh variable set ANTHROPIC_DEFAULT_HAIKU_MODEL  -R binaricat/Netcatty --body 'kimi-k2.7-code:cloud'
gh variable set ANTHROPIC_DEFAULT_SONNET_MODEL -R binaricat/Netcatty --body 'kimi-k2.7-code:cloud'
gh variable set ANTHROPIC_DEFAULT_OPUS_MODEL   -R binaricat/Netcatty --body 'kimi-k2.7-code:cloud'
```

Do **not** commit the key, put it in `.github/workflows/*.yml` literals, or
paste it into issues/PRs.

Existing `ANTHROPIC_AUTH_TOKEN` can stay until Cursor jobs are deleted.

### Phase 1 — restore triage (this unblocks production)

In `.github/workflows/ai-automation.yml` classify job:

1. Install Claude Code: `curl -fsSL https://claude.ai/install.sh | bash`
2. Drop Cursor CLI install, credential bridge, AppArmor sandbox host
3. Research step: isolated workspace + Ollama web APIs or proven Claude
   WebSearch; parse a Claude/control-plane research envelope
4. Classify step:

```bash
claude --bare -p "$PROMPT" \
  --permission-mode dontAsk \
  --allowedTools "Read,Grep,Glob" \
  --disallowedTools "WebSearch,WebFetch,Edit,Write,NotebookEdit" \
  --output-format json \
  --json-schema "$(cat "$RUNNER_TEMP/classification.schema.json")" \
  --model "$CLAUDE_CODE_MODEL"
```

5. Point prompts at `.ai-runtime/issue.json` still (runtime path rename
   can wait)
6. Update `parseClassificationFile` to read Claude `--output-format json`
   (`structured_output` or `result`) in addition to raw JSON files
7. Keep `applyClassification`, daily limits, Slack, failure handoff
8. Replace `sandbox_smoke` with a cheap authenticated `claude -p` ping
   against Ollama Cloud

Also refresh `.github/ai/schemas/classification.schema.json` so it matches
`CATEGORIES` + `code_paths` / `code_findings`. Use that schema with
`--json-schema`.

Helper script: add `prepareClaudeCliSettings()` next to
`prepareAiCliSettings()`. Do not rename `ai-automation.cjs` in this
phase (issue-format, markers, tests all import that path).

### Phase 2 — implement / follow-up (only after triage is stable)

Same CLI, wider allowlist (`Edit`, `Write`, `Bash` for tests), still no GitHub
token, still deny `.github/` publishes. Restore `AI_AUTOMATION_MODE=full`
only after classify quality looks acceptable on real issues.

### Out of scope unless asked

- Installing the Claude GitHub App / `@claude` comments
- Switching review from Codex to Claude
- Running a local Ollama daemon on GHA
- Paying Anthropic first-party API (the point of Ollama Cloud)

## Suggested classify invocation contract

Env on the agent step only:

```
ANTHROPIC_BASE_URL: ${{ vars.ANTHROPIC_BASE_URL }}
ANTHROPIC_AUTH_TOKEN: (staged file, not a job-wide secret expansion in logs)
ANTHROPIC_API_KEY: ''
ANTHROPIC_MODEL: ${{ vars.CLAUDE_CODE_MODEL }}
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
GITHUB_TOKEN: ''
GH_TOKEN: ''
```

Prompt files stay under `.github/ai/prompts/` for now. Swap the one
Cursor-specific sentence in `research.md` (“Use only Cursor's built-in
WebSearch and WebFetch tools”) to the new research tools.

## Sources

- Claude Code headless / `-p`: https://code.claude.com/docs/en/headless
- Claude Code GitHub Actions (why we are **not** using the Action as the
  orchestrator): https://code.claude.com/docs/en/github-actions.md
- Permission mode `dontAsk`: https://code.claude.com/docs/en/permission-modes.md
- Env vars `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`:
  https://code.claude.com/docs/en/env-vars
- Ollama Anthropic compatibility: https://docs.ollama.com/api/anthropic-compatibility
- Ollama Claude Code integration: https://docs.ollama.com/integrations/claude-code
- Ollama Cloud API host: https://docs.ollama.com/cloud
- Ollama web_search / web_fetch: https://docs.ollama.com/capabilities/web-search
- Cloud auth token vs API key: https://github.com/ollama/ollama/issues/13854
- Live Cursor failure: GitHub Actions run 33050247387,
  `ActionRequiredError: You've hit your usage limit`
