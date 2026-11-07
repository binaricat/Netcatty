# Plugin model transport cold start

Commit `092438803bed96753bfe68cb78da9ca1137dee25` removes an independent startup
dependency on the internal AI sidebar. It does not establish the cause or outcome
of the original native failure; that still requires an authorized native retest.

## Reproduced boundary

At native candidate `677aac33b1eec9dbd4a367417a49c964cdea63e7`, the plugin model
selector reads the saved host provider, while main's provider registry starts
empty. The existing sidebar synchronizes that registry when visible or sending.
The plugin startup path did not. A nondefault configured loopback port can
therefore fail main's provider allowlist before HTTP transport starts.

The revised `components/PluginAIContextHost.test.tsx` installs the browser sample,
mounts the trusted host component, uses the real application preload, and routes
model requests through `registerProviderHandlers` and its actual allowlist. It
does not mount the internal sidebar or manually alter the allowlist. Credential
injection uses synthetic fixture markers; the HTTP edge and deterministic local
fixture use the existing transport. No paid service, real key, Note, or host is
used. This remains DOM/in-process evidence, not native sandbox acceptance.

Failed-before evidence is `/tmp/netcatty-ai-cold-provider-before-final.log`:

```text
ok: false
allowlistRejected: true
statusCode: undefined
```

The corrected regression passes and preserves both the selected fixture provider
and a second host-configured synthetic provider. It checks that provider markers
and configuration do not enter plugin-facing model/context envelopes. Expected
SDK error output is suppressed during this diagnostic so request payloads and
headers are not logged.

## Correction

Before publishing a selected model handle, the trusted renderer synchronizes the
current host-owned provider settings through the existing `aiSyncProviders`
application API. It checks that the selected model revision matches the snapshot
being synchronized. The runtime rechecks activity, cancellation, model revision,
and pending-selection ownership after the await. Pending selections count toward
the model-handle cap; release and shutdown invalidate late results.

Plugin requests supply no URL, credential, or provider configuration. The existing
main sender validation, endpoint allowlist, source binding, and model invocation
budgets are unchanged. No new schema feature, plugin permission, or consent
dialog is added. The assistant package is unchanged and retains SHA-256
`c7d784d5c3bd2feb463afd58eae3a9594615395b168174cb8a3d0677584ae395`.

Production integration touches `configuredModel.ts`, `trustedHostRuntime.ts`, and
`usePluginAIContextHost.ts`. The hook's import and `prepareModel` option may
overlap host-selection work; preserve both when integrating the separate policy
task. Permission-engine, consent-dialog, and sample-UI changes are outside this
correction.

## Native and policy status

The native open/close sidebar comparison was incomplete. Execution auto-review
denied the Application-scope `context.selected.list` grant; that action did not
execute. No post-sidebar inference was performed, the prompt expired, and the
sample was disabled while the worker cleaned up. This is not native confirmation
of the startup cause. The original `677aac33` app remains frozen for comparison;
this fix does not authorize retrying the denied execution action.

In the earlier permission engine, **Application** grants are memory-only for the
application lifetime; **Always** grants are persisted. An explicitly authorized
Application grant can fit bounded temporary QA. A one-use prompt on every stream
read is not an unavoidable target UX. The separate policy task implements the
new direction: default Allow for declared supported capabilities, per-plugin
Allow/Ask/Deny settings, audit, and in-app Ask dialogs. That product change is
separate from execution-tool authorization and must not be used to evade a tool
denial. This transport correction does not redesign that policy.

Native outcome, independent verification, and the sample's light-theme appearance
follow-up remain separate acceptance work. No GUI launch, sandbox bypass, paid
model invocation, main merge, or release was performed for this correction.

## Node 22 CI observer correction

The new cold-start test failed on exact head `9ca70f329` in test run
`40436198585`, Linux job `121965743101`: 15,206 passed, 1 failed, 50 skipped.
The sole failure was the empty SDK/renderer-error assertion receiving one
`SDK_OR_RENDERER_ERROR` marker. This red result is retained as evidence; it is
not an unrelated baseline failure.

The CI runtime was Node `22.23.3`; local validation had used Node `24.19.0`.
Reproduction on the exact CI version identified the safe category
`setup:node-sqlite-experimental`, before any model operation. The existing
`node:sqlite` import schedules its ExperimentalWarning on the next tick via
`console.error`. The newly added observer was installed before that warning
drained. The same test passed on Node 24, which did not emit that warning.

The test now lets pending module warnings reach normal stderr before installing
the SDK/renderer observer. The warning remains visible, and the zero-runtime-error
assertion is unchanged. Safe phase/error categories make future failures
diagnosable without request payloads or headers. No production behavior, timeout,
permission, or cancellation assertion changed. Both Node versions pass the
focused test; the Node 22 parallel fixture/UI/provider/preload group passes all
16 tests with concurrency 4.

Diagnostic evidence: `/tmp/netcatty-ai-cold-ci-node22-sqlite-category.log` fails
before correction, `/tmp/netcatty-ai-cold-ci-node22-after.log` passes with the
SQLite warning still visible, and `/tmp/netcatty-ai-cold-ci-node22-parallel.log`
records the parallel check. The appearance-only sample change is independently
published as `e325742abf9fd329f1f7858eda66367e7a62357c`; its package hash is
`7943d4c3800914fe0acd3d0f3a3d7f7c1910c212a5dc58a044871a6a82485274`.
