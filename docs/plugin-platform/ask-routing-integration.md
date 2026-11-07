# Managed-window Ask acceptance candidate

The dedicated branch is `integration/plugin-ask-routing-acceptance`. Its Draft
PR records the exact frozen integration head, CI and private renderer artifact
handoff. It starts from frozen #4001 at
`02049102b6732778adcd0f33b0a0ade6b4752327`; the old source checkout, QA workspace,
profile and renderer artifact remain unchanged.

## Exact inputs and ownership

The only new input is policy owner's reviewed Ask correction
`89beeb93749c751f255beb6d0e0f95d23bdd9a7b`, imported by ordinary merge
`1b21c41fa26c0173084c7ae75e640ef3274285dd`. There were no merge conflicts or
manual production edits. These seven production files exactly match that input:

| File | Owned production delta |
| --- | --- |
| `electron/bridges/windowManager.cjs` | Enumerate managed app windows, including Settings |
| `electron/main/registerBridges.cjs` | Supply the managed permission-window getter |
| `electron/plugins/hostService.cjs` | Pass that getter to the existing decision host |
| `electron/plugins/permissionDecisionHost.cjs` | Bind ready/focused/visible/unlocked managed renderer selection and request lifecycle to the chosen receiver |
| `electron/plugins/pluginBridge.cjs` | Guard permission readiness/replies by managed app window and main frame; reject plugin/foreign/subframe senders |
| `components/SettingsPage.tsx` | Mount the existing permission host for standalone Settings |
| `components/plugins/PluginPermissionHost.tsx` | Mark Ask with the existing host-security surface so attached native views yield |

The input also owns the Settings-installed-entrypoint regression, renderer test
updates and policy/security documentation. AI d33 startup wiring, sample assets,
the combined cold-start assertions and all earlier policy/transport history are
preserved from 020. `ModelSelector.tsx` is unchanged from 020; the separate
model-selector failure-loop repair is not imported. Diagnostic #3999 remains
excluded. No broker resource/source rules, stream restrictions, package/lock
inputs, native dependencies or sandbox configuration change in this integration.

## Frozen 020 native evidence

The parent closed that QA session and released the GUI. Its partial outcome is:

| Native case on 020 | Result |
| --- | --- |
| Default Allow cold Send and completion | Passed |
| Stop, AI Deny, restore without automatic replay | Passed |
| Themes in new views | Passed |
| Ask visible dialog | Failed: no visible dialog, timeout, zero new model requests |
| Ask acceptance/cancel and content-read matrix | Not run; remain pending |

The input's independent source-only delta review is scoped clean. Its installed
SDK/registered IPC test reproduces the old Settings-owned failure and passes with
the correction using represented Electron objects. That is not native Ask
success. No new native acceptance is claimed by this coding executor.

Earlier terminal solo/split core passes with corrected fixtures, unreliable/
unverified Focus and one QA Enter in A during a palette attempt remain historical
evidence. There is no global zero-input or full terminal native-pass claim. The
old Rfam run failed socket transport before connect resolved, without reaching
authentication/SELECT; its cause and auth/TLS compatibility remain unverified.
The next native priority is the new Ask path, not more old-baseline loops.

## Checks and retained CI history

| Local check | Result |
| --- | --- |
| Registered runtime | 696 tests: 695 passed, one native skip, zero failed/cancelled |
| Contract/SDK/CLI | 91 passed |
| Offline examples | Five passed, one Docker opt-in skip |
| Mounted cold-start AI/permission/selected-summary/Host group | 21 passed |
| Settings and security-surface visibility group | 37 passed |
| Contract/capability/Codex generation and drift | Clean |
| Lint | Zero errors, seven existing warnings |
| Five sample archives | Validated; two builds each are identical and match frozen 020 |

The exact integration production build, renderer inventory and final CI are
recorded in the Draft PR and artifact provenance. Local native packaging and
unpackaged GUI acceptance are not claimed. This environment uses locked
dependencies and standard patches; the official pinned Electron binary uses its
documented cache/proxy support. No header workaround, native shim, HOME change
or sandbox change is introduced.

Input89 [test CI 40453446775](https://github.com/binaricat/Netcatty/actions/runs/40453446775)
succeeded on the parent's single infrastructure-only rerun: 15,342 passed, 50
skipped, zero failed/cancelled. The original runner interruption remains evidence;
this worker did not duplicate its retry. Input89
[four-platform packages](https://github.com/binaricat/Netcatty/actions/runs/40453446781)
passed with release jobs skipped. Frozen 020's successful full/platform CI and
all earlier diagnosed/unexplained failures remain separate predecessor evidence.

The [sample manifest](ask-routing-packages.json) records exact IDs, versions,
features, permissions/resources and archive/content hashes. All five archives
are byte-identical to 020, including Assistant
`7943d4c3800914fe0acd3d0f3a3d7f7c1910c212a5dc58a044871a6a82485274`.
No archive was activated by this executor. Its unchanged owner README retains
old review wording; the current Allow/Ask/Deny procedure governs acceptance.

## Production-renderer preparation and native Ask recipe

1. Create a new isolated checkout at this Draft's exact head and a separate
   disposable synthetic QA profile. Keep the old 020 workspace/profile intact.
2. Match `package.json` and `package-lock.json` hashes to the renderer artifact's
   provenance and the independently normally rebuilt native dependencies. They
   are unchanged from 020. Prepare matching host workspace packages normally.
   **The complete backend checkout must match the new head:** the frontend-only
   bundle does not include the new CJS window-routing code or native binaries.
3. Materialize the exact private Library file/version in the consumer's own
   environment. Verify its archive SHA-256 and every dist file with the supplied
   inventory/verification script. Producer-local paths are not portable.
4. Use those verified production assets as a whole `dist/` in the matching
   checkout, with the ordinary Electron entrypoint, no Vite environment and
   normal sandbox/helper settings. This is native **unpackaged production-
   renderer QA**, not packaged-binary certification. Process-loss causality
   remains unclassified; no native build/header workaround is supplied.
5. Recreate only the synthetic provider/Note/sample setup. Verify Default Allow
   remains functional; then set the plugin operation to Ask in the active main
   or standalone Settings window. Keep the selected receiver visible, focused,
   ready and unlocked; opening Ask must not force focus back to main.
6. Record visible readable Ask and native-view yielding. Check cancellation and
   acceptance as separate explicit operations: cancel must send no model request;
   accept must authorize only the current bounded operation. Complete the
   content-read Allow/Ask/Deny matrix and lifecycle invalidation cases. Do not
   treat the earlier zero-request timeout as an Ask pass.
7. Record exact head, archive/sample hashes, request counters, prompt ownership,
   screenshots/video and any unrun cases. Report a model-selector failure
   separately rather than folding its other owner's repair into this candidate.

Hosting/distribution/deployment and remaining DB/terminal acceptance gates stay
parent-coordinated. No main merge, Ready transition or release is part of this
handoff.
