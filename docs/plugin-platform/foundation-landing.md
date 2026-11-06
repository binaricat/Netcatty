# Plugin foundation landing candidate

Draft #4011 is the single landing vehicle for the accumulated plugin foundation.
Earlier integration records describe frozen evidence, not the current acceptance
status. This candidate preserves their source history through ordinary merges.
The user cancelled the reference-driven row redesign. Installed grid and Settings
quick-toggle layout are restored exactly to b14, while author presentation and all
functional/security corrections remain. Cancelled visual commits stay in history
with attributable reverts; they are not effective changes in the landing tree.
It does not include global Agent/custom Chat #4006/#4012, model-picker #4002,
or terminal diagnostic #3999. No older source PR is closed by this preparation.

## Included commits

| Input | Exact input | Ordinary integration |
| --- | --- | --- |
| Prior #4011 | `d40b0d3c25ed00a33679e83be948fd1a5aa10bfa` | Starting point; all inherited contributions retained |
| Current main | `2796d1113a6310fae1779931f242e208a69b95a5` | `db1223d16`; Nginx #4010, macOS appearance #4013, closed-socket MCP reconnect #4016 |
| Author metadata and preserved visual history | `e4eb33856b335fe0b1d302827b1325ddfc23bdde` | `b3895a477`; preserves original avatar/badge, canonical v2 schema, b14 invalidation, visual-worker patch subsequently reverted |
| Directory availability | `a36a906292cbe8033bc19b596dcaf7f853a804c7` | `d035cbea3`; no native adapter or expanded permission |
| Two-profile sync composition | `14ed19d2ed7cd1ecc201c9c910b112e97cc098ff` | `fc37ac48e`; tests only |
| Restore pre-row layout | `7e7b05620ff800ae459d0bf007bbace6aaebbdbc` | Normal revert of e4 row commit; all six layout paths match parent `b14b65679ffd9c617bb0aa1215d8653c53430243` |
| Rejected-install catalog refresh | `50fda91424c915c1497e53a87a210e3943cb1e39` | Separate correction after bounded review; service and mounted-row regression only |

The separately published icon branch first reverted its outline correction
(`530ff0318`), then the e4 row commit (`6e4465f47`). Neither outline correction nor
those isolated reverts are imported here; foundation never included the outline.
The e4 and 1f renderer artifacts are historical pre-cancellation evidence, not
accepted final UI. No further cancelled-design build or screenshot is requested.

The only manual merge conflict was the end of `index.css`. Resolution retains
both the prior host-security theme block and main's window-background-blur block,
with their declarations unchanged. Automatic combinations retain main appearance
wiring alongside plugin settings/theme wiring, all five locales, preload methods,
the host services and SDK exports. No permission, source, endpoint, sandbox or
selected-resource restriction is relaxed. Package and lock inputs are unchanged.

`50fda9142` reuses the same selection-token comparison after an install-triggered
catalog refresh, including an install rejected for a changed/withdrawn selection.
The rejection is preserved; mounted authors no longer retain withdrawn enrichment.
The regression makes no package download or execution. It also preserves the
original synchronous unavailable-source rejection in `list()`: the first aggregate
runtime run caught that b14 changed it into a Promise rejection. The assertion was
not weakened. Corrected aggregate runtime: 711 pass, one native skip, zero failures
or cancellations. The original failed run and fail-before regression are retained.

## Checks and packages

Registered runtime, SDK/contract, Settings and actual connected host entrypoints,
changed-main MCP/appearance/editor regressions, example preparation, code generation,
lint and the normal production renderer build are run on this candidate. Exact
head, commands, counts and CI links are recorded in #4011. Package provenance is
in [the bounded sample manifest](foundation-packages.json): each archive is built
twice and whole-byte compared. Assistant is byte-identical to d40; Host changes
only README wording, with manifest/entrypoint unchanged. Database-owned, Rfam and
terminal archives change only `browser.js` minified bound identifier spelling.
Rebuilding the same sources with d40's generated SDK/contract artifacts reproduces
the exact old archive hashes. Parsing and normalizing lexical bindings yields
identical ASTs for all three bundles; manifests, protocol and permissions do not
change. Preparation does not connect, activate or query.

Local checks at pre-restoration1f: runtime 711 pass/one existing native skip; SDK91; Settings and
connected host/security78; changed-main MCP/appearance/editor71; examples five
pass/one Docker opt-in skip. Contract/capability/Codex generation has no drift;
lint zero errors/seven existing warnings; normal production build36.13s. These
checks do not claim native UI, packaging or encrypted transport acceptance.
Restoration-focused layout/author tests: six pass; changed-file lint and diff
checks clean. Two broader Settings runs each had38pass/one PluginLogSettings
file-entry failure, without a detailed assertion; that file alone passed. Their
cause remains unclassified and both failed runs are retained. No production log
change or baseline attribution is made. Every one of the six layout paths exactly matches b14; fourteen functional
paths (identity/provenance, permissions, directory availability and sync included)
remain byte-identical to1f. The five sample records remain unchanged. Pre-restoration1f exact CI completed:
[test40505644082](https://github.com/binaricat/Netcatty/actions/runs/40505644082)
records15,372pass/50skip/zero failures or cancellations on its successful retry;
[packages40505644200](https://github.com/binaricat/Netcatty/actions/runs/40505644200)
passed all four platforms with release skipped. Its original runner shutdown is
retained. These results do not certify the restored head.

An earlier coding-executor full suite timed out after 15 minutes: 31 failures and
482 cancellations. Seven failures reproduced on unchanged d40; 24 were not probed
on that baseline. They remain unresolved evidence, not assumed baseline failures.
No additional long local full suite is used to conceal them. Clean-run exact-head
CI is a separate aggregate check and does not diagnose that historical run.

## Acceptance and landing order

1. Foundation: keep #4011 Draft until integrated CI/review and affected native UI
   acceptance settle. d40 Settings, Host/Vault policy, terminal A/B selection and
   inert multiline draft isolation, and native chat split/drag ownership passes
   are historical evidence at their stated heads. They do not certify this new
   current-main merge tree. The e4/07b reference-driven row design is cancelled;
   stop its native visual work. Restored layout retains author/avatar presentation.
   Avatar/catalog behavior and the final install-refresh correction still require
   their scoped review/acceptance; cancellation does not erase functional gates.
2. Marketplace distribution: retain static-source identity and v2 delivery checks,
   but track reviewed registry data, actual hosting/CDN and install/update/source
   replacement/withdrawal acceptance separately. Current live source-only viewing
   is not installation or deployment acceptance. Never weaken admitted-source or
   destination guards to manufacture a pass.
3. Global Agent: #4006/#4012 remain a separate later increment, with their own
   scope, review, CI and actual sample smoke. #4002 is also separate.

Historical integration vehicles #3967/#3989/#3993/#3997/#4001/#4004 are superseded
as landing vehicles, not discarded contributions. Their ancestors and native
receipts stay available. Unique source PRs remain intact; no premature closures.

Directory enumeration is intentionally unavailable in the default production
composition until a same-handle adapter exists. The advertised feature now tells
SDK callers the truth; filesystem permission alone does not enable it. The new
sync composition test proves local collect/apply/hydrate with real databases, not
encrypted cloud transport or native cloud-account sync. A native compatibility
transition needs two properly versioned builds; two 0.0.0 checkouts do not qualify.

Public database acceptance remains blocked by the retained TCP refusal before
protocol payload; the separately owned local fixture is pending. Source-policy,
compatibility and database gates must be explicitly reconciled by the parent,
not silently removed from requirements. Nested log-dialog overlap has source
coverage but no normal native route in the tested UI. This is code-readiness work,
not a claim that deployment, every original requirement or the whole project is
complete. No main merge, Ready transition, release or live metadata publication.
