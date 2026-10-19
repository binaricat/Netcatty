# Catty prompt cache repair and verification

## Scope and issue history

- Original report: [#3545](https://github.com/binaricat/Netcatty/issues/3545), duplicate [#3546](https://github.com/binaricat/Netcatty/issues/3546).
- [#3547](https://github.com/binaricat/Netcatty/pull/3547) moved static guidelines before scope/session details. That repair remains valid, but its closing comment did not claim a measured DeepSeek result.
- This change starts from main `b5fee9632ea012e5c15fbdae454dec2aa7d32572` and repairs additional cache invalidation and usage-reporting paths.

## Confirmed defects and changes

1. Completed terminal results were rewritten when the next user turn rebuilt history. Keep the already bounded result, with secret redaction, and let context budgeting own necessary reductions.
2. Live SDK results use JSON while saved history uses text. Apply the same bounded compression to both before sending them, avoiding a second, different representation on the next turn.
3. Routine output cleanup inserted the latest goal and pending handles at the start of otherwise intact history. Reserve that reinjection for actual budget pressure or summarization.
4. Large-output handle notices were replaced at the front on every step. Results already containing a handle need no duplicate notice. Announce missing handles once at the tail and preserve prior notices; continue to reserve their budget if older results are pruned.
5. DeepSeek's documented `prompt_cache_hit_tokens` was lost when the OpenAI-compatible SDK parsed responses. Normalize it to the standard cached-token field before parsing, preserving an existing standard value, including zero. Cover streaming and non-streaming responses.
6. Catty omitted cache counts from its usage events and saved assistant messages. Preserve provider counts and attach aggregate usage after the final assistant message has been created.
7. Native Anthropic requests lacked cache breakpoints. Cache the static system block and a bounded conversation tail; leave implicit-cache OpenAI/Google requests untouched and preserve signed reasoning content. Enable these vendor fields only for the official HTTPS Anthropic endpoint (including the SDK's default endpoint), not third-party Messages-compatible gateways. Use the shared resolved SDK address, including OpenRouter/Ollama fallbacks when a stored URL is empty. Review follow-ups add endpoint gating and full-driver gateway/fallback regressions; they do not change the measured DeepSeek path.

## Comparison with mature agents and official guidance

- [Codex prompt-caching tests](https://github.com/openai/codex/blob/8c076942cb70fba8e5c4732c23f1faabc4aed484/codex-rs/core/tests/suite/prompt_caching.rs): exercise stable tools and append-only request prefixes. The new tests compare the actual serialized requests produced by Catty's driver, SDK and bridge adapter across consecutive turns.
- [OpenCode cache policy](https://github.com/anomalyco/opencode/blob/c38d83c0c4f92466ff9c8e12b8a741698e811012/packages/ai/src/cache-policy.ts): use provider-specific explicit cache boundaries where required and leave implicit-cache protocols alone.
- [DeepSeek context caching](https://api-docs.deepseek.com/guides/kv_cache/): exact shared prefixes, asynchronous/best-effort cache persistence and provider-reported hit/miss counts. Live probes wait between turns and use the official endpoint.
- [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching): explicit boundaries, tool/system/message ordering and a limit of four breakpoints. Catty uses at most three automatic markers.
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching): stable shared prefixes. No additional explicit cache-control fields are sent on this path.

## Live verification

The final fixed Catty driver was bundled from the isolated worktree and executed inside the running Electron renderer, using the app's existing IPC and configured `https://api.deepseek.com` service, model `deepseek-v4-flash`. The API key stayed inside the app's credential handling.

Each run contains six consecutive turns for each of three scenarios: plain chat, one command per turn, and a command producing 14,000 synthetic log lines followed by a bounded saved-output read. Model requests and usage are real. Tool execution uses an in-memory fixture; no command is sent to the user's connected SSH hosts. The prompts contain only synthetic session/host information.

The results file records every provider-reported input/cache/output count, per-step counts and errors. The rate is total cached input divided by total input, including all model calls in a turn. It is not an average of rounded percentages.

Two complete runs of the final source produced 36 turns / 72 real model requests, with zero errors:

| Scenario | Turns | Weighted cache hit rate | Per-turn range |
| --- | ---: | ---: | ---: |
| Plain chat | 12 | 98.55% | 98.19%-98.92% |
| Command execution | 12 | 98.59% | 98.12%-99.03% |
| Large command output + saved-output read | 12 | 97.80% | 97.30%-98.32% |

Raw per-turn and per-step counters are in [the JSON evidence file](./catty-prompt-cache-live-2026-10-18.json). These are warm-cache measurements; an earlier probe's first request correctly reported zero cached input before subsequent requests reached about 98%. The earlier probe is excluded from the final-source totals.

The production chat-message component was rendered with the live conversation in Electron. Its usage footer showed input, output, cache and reasoning counts; opening the command entry showed the expected fixture result. No product UI layout was changed.

Limits: live provider evidence covers the configured DeepSeek model. Native Anthropic request formatting and usage preservation are verified with the real SDK and a protocol fixture, not a paid Claude session. Cache hits remain provider-managed; a new prefix, necessary compaction or expired cache can legitimately miss.

## Automated verification

- Full AI/history/UI-related suite after the endpoint review follow-ups: 600 tests passed.
- New regression coverage includes six consecutive plain-chat turns, six command turns, six large-file turns, six large-terminal-output turns, long-output handles, streaming/non-streaming DeepSeek usage, aggregate multi-step usage and native Anthropic boundaries.
- Production build passed.
- Full lint passed with eight existing warnings; final changed-file lint passed without warnings.
- Type checking matches the untouched main baseline: 758 existing errors, zero additional errors after normalizing checkout paths and line numbers.

Full-repository verification also found setup and unrelated timing limits:

- The first run passed 13,968 tests and skipped 36, with one failed file caused by the fresh worktree missing the nested `plugin-cli/node_modules/yauzl` dependency. Linking the existing dependency directory repaired the setup; all 29 CLI tests then passed.
- A repeat full run hit the unchanged `large directory progress coalesces synchronous persistence work` timing assertion (2,638,624 characters persisted against a 588,644-character snapshot). That assertion passed in the prior full run. All 102 tests in its file passed on isolated rerun; the same assertion also passed on untouched main. This is an observed full-run timing fluctuation, not a claimed baseline reproduction or an SFTP repair.
- The Homebrew Node 22 binary is broken locally (missing shared library); verification uses an isolated official npm Node 22 runtime. `TMPDIR=/tmp` selects Netcatty's shorter private per-user temporary directory for Unix-socket tests. The default macOS path exceeded the FIDO test socket limit; no product source was changed to accommodate this environment.

The full suite is therefore not reported as unconditionally green. No Catty/cache test failed in the final implementation.
