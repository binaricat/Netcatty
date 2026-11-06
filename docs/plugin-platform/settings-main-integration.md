# Settings visibility and current-main acceptance candidate

This isolated branch, `integration/plugin-settings-main-acceptance`, starts at
frozen #4004 `2433cf0130d1c3274c56c39e5765349c2945de01`. Its Draft PR and private
renderer provenance record the final exact head and CI. Frozen2433 source,
artifact, QA workspace/profile and earlier evidence remain intact.

## Inputs and production ownership

Both inputs were ordinarily merged, without conflicts or manual production edits:

| Input | Import | Production files and behavior |
| --- | --- | --- |
| Current main `a0cf2b487c9ff0b0472d622e66bc5ee20de32c71` | Merge `c4aedfa9ed8c9f2647ac26f0e6e144edab341c2d` | `domain/workspaceAiScopeHandoff.ts` keeps inherited AI chat on a surviving owner when a workspace dissolves (#4003/e3e2dcfe); `electron/bridges/ai/shellUtils.cjs` narrowly recognizes Oh My Zsh ys two-line idle prompts (#4008/a0cf2b48) |
| Policy `1551fa8355021b5a811d737d16f81e8070f99f5d` | Merge `714e2397a43dc6c083dce8afeeb7a0475de11384` | `PluginLogSettings.tsx` removes the idle-row security marker and opts the nested verbose confirmation into it; `confirm-dialog.tsx` adds the optional host-only marker with default false |

All four production files exactly match their respective owners. Main has only
those two new commits since common base f0897c3c. Neither changed file overlaps
the prior plugin changes. The new prompt utility is not imported by plugin
production modules; plugin sensitive-input, selection and source guards remain
unchanged. Existing prompt and live-PTY-byte suffix tests still reject bare
markers and pending input. These are synthetic tests, not a new native SSH pass.

The input also owns its real Settings landing regression and documentation.
The existing observer, Ask marker, IPC/window authority, sandbox, resource/source
controls, AI d33 wiring, schemas, sample bytes and package/lock inputs are
unchanged. `ModelSelector.tsx` equals2433: separate #4002 is not included. Global
Agent/custom Chat #4006 and terminal diagnostic #3999 are excluded. No main merge,
Ready transition, original-PR closure or release is part of this handoff.

The parent reports the1551-vs89 independent delta review scoped clean: idle
Settings no longer requests suspension, the real logging dialog remains marked,
its nested verbose portal protects itself while the parent is accessibility-
hidden, closing the nested dialog leaves the parent protected, and closing all
dialogs permits restoration. This source-only result is not native resolution
of the recorded Settings blank body.

## Frozen2433 native results

The parent supplied these results; this coding executor did not run the GUI:

| Case | Result on2433 |
| --- | --- |
| Main Ask visible | Passed |
| Cancel | Passed; zero provider POSTs |
| Accept | Passed; one provider POST |
| Stream chunks | Passed; no repeated permission prompts |
| Content Deny | Passed |
| Real five-minute chat expiry | Passed |
| Settings sample body | Blank; not accepted |

The idle-row suppression defect is source-confirmed. The correction requires a
new native Settings recheck; no native success is inferred from the DOM regression.
A later GPU exit9 and incomplete cleanup were reported separately. Its cause is
unclassified; no source hotpatch or sandbox/GPU workaround was used here.

Consumer verification of2433's Library renderer is complete: the parent checked
the matching full source/backend and all1001 renderer hashes, with native inputs
unchanged. The earlier producer download failure remains historical evidence,
not an outstanding consumer transfer blocker. That verified artifact still
certifies2433 only; it does not include1551 or the new main renderer behavior.

Earlier020 Default Allow cold Send/completion, Stop/Deny/restore and themes,
677 Host core, and corrected-fixture terminal solo/split results remain scoped
historical evidence. Terminal Focus is unreliable/unverified and QA sent one
Enter inA during a palette attempt: no global zero-input/full-terminal-pass claim.
The historical Rfam attempt failed socket transport before connect resolved;
authentication/SELECT were not reached and cause/auth/TLS compatibility remain
unverified. Final source-policy, DB, placement/lifecycle and actual hosting/CDN
gates remain separately reconciled by the parent.

## Local checks and sample provenance

| Check | Result |
| --- | --- |
| Registered plugin runtime | 695 passed, one native skip; zero failed/cancelled |
| Contract/SDK/CLI | 91 passed |
| Offline examples | Five passed, one Docker opt-in skip |
| Changed main owner/scope/prompt/suffix and terminal lifecycle group | 139 passed |
| Actual mounted AI/permission/selected-context/Host group | 21 passed |
| Settings boundary and security visibility group | 38 passed |
| Contract/capability/Codex generation and committed drift | Clean |
| Lint | Zero errors, seven existing warnings |
| Five sample archives | Validated, built twice and byte-identical to2433 |

The final exact-head normal production build, renderer inventory, bounded
credential check, CI and Codex review are recorded in the Draft PR/artifact
handoff. Local full-suite, native packaging and GUI success are not claimed.
Locked dependencies, standard patches and the official pinned Electron binary
were prepared normally; no header, HOME, sandbox or native shim workaround.

[Exact sample IDs, permissions/resources and hashes](settings-main-packages.json)
preserve all prior provenance, including Assistant7943d4c3, ownedDBf01c6a24,
Rfamaaca5866, Hostcf04f82d and terminal4c9c2388. Whole archive equality was
asserted, rather than inferred from unchanged source. The owned10.77.0.20 endpoint
is packaging-only, not a running fixture. No package was activated or service
queried by this executor.

The owner's separate QA-only Settings Ask sample has reported SHA-256
`9502a58a4804862e4b13de9fc0d1baf6ad8c2bc681c08b5c0664b552ef0aafc4`.
It is not one of these five repository examples and was not rebuilt here. The
native owner must retain its exact verified manifest/source/permissions and
fixture provenance; no package ID, permission expansion or hash equivalence is
invented by this integration.

## Native preparation and bounded recheck

1. After the parent's GUI/Nginx slot is released, use a NEW isolated checkout of
   the final exact head and a separate synthetic QA profile. Preserve the old2433
   workspace/profile and recordings. Materialize the new private Library artifact
   in the consumer's own workspace and verify archive and every renderer hash.
2. Use the complete matching backend checkout: frontend-only dist does not carry
   the CJS prompt helper or native dependencies. Match package/lock hashes to
   independently normally rebuilt native inputs and prepare workspace packages
   normally. Install dist as a whole; use the ordinary Electron launch without
   Vite and with normal sandbox/helper settings. This is unpackaged native
   production-renderer QA, not packaged-binary certification.
3. Open the verified Settings sample through its existing supported settings
   entry. Check the idle body is visible/clickable with the logging row present.
   Open logging and the nested verbose confirmation separately; native content
   must yield to each, remain hidden after cancelling the nested confirmation,
   and restore only after the parent closes. Do not enable real verbose logging
   or collect real content for this check.
4. In the ready/focused/visible/unlocked Settings owner, exercise its synthetic
   own-setting Ask operation. Record visible Ask, explicit cancel/accept, exact
   current operation outcome and restoration. Recheck main Ask briefly. Preserve
   the2433 main/content/expiry counters and any unrun matrix cases separately.
5. Use owned synthetic A/B AI chats: form a workspace, prefer B, dissolve while A
   survives and confirm both histories stay with their owners. Remove A and
   check bounded fallback to B. Confirm handoff alone does not invoke a model or
   re-share content. Exercise selected-target invalidation across the transition
   with inert drafts and no PTY input. Do not treat earlier Focus uncertainty as
   resolved by this main domain fix.
6. Record exact source/artifact/sample identities, screenshots/video, request
   counters, cleanup and unrun cases. No fallback endpoint/probe, real credentials,
   paid API, security relaxation or unrecognized installation is authorized here.

If main advances after this pinned a0cf snapshot, compare the new delta and assess
its affected checks before landing. The current candidate deliberately does not
chase unrelated changes while native preparation is in progress.
